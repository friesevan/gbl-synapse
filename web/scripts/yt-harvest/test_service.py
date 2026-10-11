"""Offline lifecycle/security tests. No downloads or dependency installation."""
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from email.message import Message
from types import SimpleNamespace
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent.parent))
import service as S
import harvest as H
import run_app as A


class Services(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.work = Path(self.tmp.name) / 'PoGo Recorder/work'
        self.web = Path(self.tmp.name) / 'GBL Synapse/web'
        self.rows = []
        self.calls = []
        self.children = []
        def spawn(command, **kwargs):
            self.calls.append((command, kwargs))
            row = {'pid': 9001, 'identity': 'Sun Oct 11 01:30:00 2026', 'command': ' '.join(command)}
            self.rows.append(row)
            child = SimpleNamespace(pid=9001, poll=lambda: None)
            self.children.append(child)
            return child
        self.service = S.HarvestService(self.work, self.web, popen=spawn,
            processes=lambda: self.rows, dependency_probe=lambda: {'ready': True, 'missing': [], 'python': '/existing/bin/python'})

    def tearDown(self):
        self.tmp.cleanup()

    def test_spaces_identity_restart_duplicate_and_graceful_stop(self):
        with patch('service.shutil.which', return_value=None):
            started = self.service.start({'hours': 2, 'workers': 1})
        self.assertTrue(started['harvest']['running'])
        self.assertEqual(started['harvest']['phase'], 'running')
        self.assertTrue(S.is_harvester(self.rows[0], self.work, self.service.script))
        # Separate API instance recognizes a detached process started by the first API instance.
        other = S.HarvestService(self.work, self.web, processes=lambda: self.rows,
                                 dependency_probe=self.service.dependency_probe, popen=lambda *_: self.fail('duplicate spawn'))
        other.start({'hours': 3, 'workers': 1})
        self.assertEqual(len(self.calls), 1)
        result = other.stop()['harvest']
        self.assertTrue((self.work / 'STOP').exists())
        self.assertEqual(result['phase'], 'stopping')
        self.assertIn('--respect-stop', self.calls[0][0])
        self.assertNotIn('pip', ' '.join(self.calls[0][0]))
        self.assertTrue(self.calls[0][1]['start_new_session'])

    def test_existing_unmanaged_cli_spaces(self):
        self.rows.append({'pid': 321, 'identity': 'old cli', 'command': f'/venv/bin/python -I {self.service.script} overnight --hours 9 --work-dir {self.work} --extract-jobs 4'})
        result = self.service.start({'hours': 2, 'workers': 1})['harvest']
        self.assertTrue(result['running'])
        self.assertFalse(result['managed'])
        self.assertEqual(len(self.calls), 0)
        self.service.stop()
        self.assertTrue((self.work / 'STOP').exists())

    def test_stale_recycled_pid_cannot_block_start(self):
        self.work.mkdir(parents=True)
        S.atomic_json(self.work/'run.json', {'pid': 55, 'identity': 'previous', 'phase': 'running'})
        S.atomic_json(self.work/'launch.json', {'pid': 55, 'identity': 'previous'})
        self.rows.append({'pid': 55, 'identity': 'new process', 'command': '/bin/sleep 100'})
        status = self.service.status()['harvest']
        self.assertFalse(status['running'])
        self.assertEqual(status['phase'], 'interrupted')
        self.service.stop()
        self.assertFalse((self.work/'STOP').exists())

    def test_bad_numbers_missing_deps_and_fail_closed_process_inspection(self):
        for data in ({'hours': float('nan')}, {'hours': True}, {'hours': 100}, {'workers': 0}, {'workers': True}):
            with self.assertRaises(ValueError):
                self.service.start(data)
        self.service.dependency_probe=lambda: {'ready': False, 'missing': ['yt-dlp'], 'message': 'Setup in terminal.'}
        with self.assertRaisesRegex(RuntimeError, 'yt-dlp'):
            self.service.start({})
        self.assertFalse(self.calls)
        self.service.processes=lambda: (_ for _ in ()).throw(OSError('cannot inspect'))
        with self.assertRaises(OSError):
            self.service.start({})
        self.assertFalse(self.calls)

    def test_caffeinate_wrapper_and_unrelated_command_are_not_harvesters(self):
        script=str(self.service.script)
        for command in (f'caffeinate -i /bin/python {script} overnight --work-dir {self.work}',
                        f'/bin/echo {script} overnight --work-dir {self.work}',
                        f'/bin/python {script} status --work-dir {self.work}',
                        f'/bin/python {script} overnight --work-dir /somewhere/else'):
            self.assertFalse(S.is_harvester({'command':command},self.work,self.service.script))

    def test_bounded_database_and_logs(self):
        self.work.mkdir(parents=True)
        state=H.State(str(self.work/'state.sqlite'))
        for n in range(60):
            state.x("INSERT INTO videos(id,title,meta_status,err,updated) VALUES(?,?,'working',?,?)", (str(n),'title','failure'*200,n))
        (self.work/'harvest.log').write_text(('line\n'*10000)+'end\n')
        status=self.service.status()['harvest']
        self.assertEqual(status['counts']['discovered'],60)
        self.assertEqual(len(status['activeJobs']),32)
        self.assertEqual(len(status['errors']),10)
        self.assertLessEqual(len(status['errors'][0]['error']),500)
        self.assertLessEqual(len(status['log']),35)
        self.assertEqual(status['log'][-1],'end')
        state.db.close()

    def test_exclusive_lifecycle_lock(self):
        with S.file_lock(self.work/'harvest.lock'):
            with self.assertRaises(BlockingIOError):
                with S.file_lock(self.work/'harvest.lock',blocking=False):
                    self.fail('duplicate acquired lock')


class Handler(A.LocalHandler):
    def _json(self,status,value):
        self.response=(status,value)


class API(unittest.TestCase):
    def request(self,path,method='GET',headers=None,body=None):
        handler=Handler.__new__(Handler)
        handler.path=path
        handler.server=SimpleNamespace(server_port=8000)
        handler.headers=Message()
        for key,value in (headers or {'Host':'localhost:8000'}).items():
            handler.headers[key]=value
        data=json.dumps(body or {}).encode()
        if method=='POST' and 'Content-Length' not in handler.headers:
            handler.headers['Content-Length']=str(len(data))
        handler.rfile=io.BytesIO(data)
        handler.service=SimpleNamespace(status=lambda:{'available':True},start=lambda b:{'started':b},stop=lambda:{'stopped':True},feedback=lambda:SimpleNamespace(state=lambda:{'questions':[]},answer_many=lambda a:{'answers':a},retrain=lambda:{'learning':{}},reopen=lambda q:{'qid':q}))
        getattr(handler,'do_'+method)()
        return handler.response

    def test_get_and_post_contract(self):
        self.assertEqual(self.request('/api/harvest/status'),(200,{'available':True}))
        headers={'Host':'localhost:8000','Origin':'http://localhost:8000','Content-Type':'application/json'}
        self.assertEqual(self.request('/api/harvest/start','POST',headers,{'hours':2})[0],200)
        self.assertEqual(self.request('/api/validation/answers','POST',headers,{'answers':[{'qid':'a','value':True}]})[0],200)
        self.assertEqual(self.request('/api/validation/reopen','POST',headers,{'qid':'a'}),(200,{'qid':'a'}))

    def test_origin_host_content_and_body_guards(self):
        self.assertEqual(self.request('/api/harvest/status',headers={'Host':'attacker.test:8000'})[0],403)
        for origin in (None,'https://attacker.test','http://localhost:8001'):
            headers={'Host':'localhost:8000','Content-Type':'application/json'}
            if origin:
                headers['Origin']=origin
            self.assertEqual(self.request('/api/harvest/stop','POST',headers)[0],403)
        headers={'Host':'localhost:8000','Origin':'http://localhost:8000'}
        self.assertEqual(self.request('/api/harvest/stop','POST',headers)[0],415)
        headers['Content-Type']='application/json';headers['Content-Length']=str(2*1024*1024)
        self.assertEqual(self.request('/api/harvest/stop','POST',headers)[0],400)
        headers['Content-Length']='invalid'
        self.assertEqual(self.request('/api/harvest/stop','POST',headers)[0],400)


class Pipeline(unittest.TestCase):
    def fake(self,directory):
        h=H.Harvester.__new__(H.Harvester)
        h.a=SimpleNamespace(work_dir=directory,download_dir=directory,keep=True,inbox='',registry=None,no_probe=True)
        h.state=H.State(os.path.join(directory,'state.sqlite'))
        h.inflight=set();h.registry={};h.validation_lock=threading.RLock()
        h.stop=threading.Event();h.deadline=0;h.schedule={'cups':{}}
        h.inc=lambda *_:None
        h.clock=threading.Lock();h.c={'xVideoS':0.0,'xBusyS':0.0}
        return h

    def test_deleted_video_requeues_persistently_and_waits_for_active_work(self):
        with tempfile.TemporaryDirectory() as directory:
            h=self.fake(directory);vid='abcdefghijk'
            h.state.x("INSERT INTO videos(id,dl_status,x_status,deleted_date) VALUES(?,'done','done','today')",(vid,))
            requeue=Path(directory)/'requeue';requeue.mkdir()
            (requeue/'request.json').write_text(json.dumps({'videoId':vid}))
            h.inflight.add(vid);h.consume_requeues()
            self.assertTrue((requeue/'request.json').exists())
            h.inflight.clear();h.consume_requeues()
            row=h.state.q('SELECT * FROM videos')[0]
            self.assertIsNone(row['dl_status']);self.assertIsNone(row['x_status']);self.assertIsNone(row['deleted_date'])
            self.assertTrue(h.state.q('SELECT * FROM reprocess'))
            self.assertFalse((requeue/'request.json').exists())
            h.state.db.close()

    def test_stop_drains_active_extractor_and_preserves_learning_context(self):
        with tempfile.TemporaryDirectory() as directory:
            h=self.fake(directory);vid='abcdefghijk';path=Path(directory)/'video.mp4';path.write_bytes(b'fake')
            (Path(directory)/'results').mkdir()
            h.a.registry=str(Path(directory)/'registry.json')
            S.atomic_json(h.a.registry,[{'id':vid,'reviewerLeague':True,'leagueId':'ultra','leagueGuess':'Ultra League'}])
            h.state.x('INSERT INTO videos(id) VALUES(?)',(vid,))
            h.export_validation=lambda *a,**kw:0
            class Process:
                def __init__(self,command,**kwargs):
                    assert kwargs['env']['LEAGUE']=='2500', 'Extraction ignored the human league prior'
                    Path(command[-1]).write_text('{"battles":[]}')
                    self.calls=0;self.returncode=None
                def poll(self):
                    self.calls+=1
                    h.stop.set()
                    if self.calls>=2:self.returncode=0
                    return self.returncode
                def terminate(self):raise AssertionError('STOP killed active extraction')
            with patch('harvest.subprocess.Popen',Process),patch('harvest.time.sleep',return_value=None),patch('harvest.gamemaster_for',return_value='historical.json'),patch('harvest.write_league_refinement',return_value=None):
                h.extract_one({'id':vid,'dl_path':str(path),'league':'{}','duration':600,'upload_date':'20200101','meta':'{}'})
            result=json.loads((Path(directory)/'results'/f'{vid}.json').read_text())
            self.assertEqual(result['learningContext'],{'gamemaster':'historical.json','league':2500,'uploadDate':'20200101'})
            self.assertEqual(h.state.q('SELECT x_status FROM videos')[0][0],'done')
            h.state.db.close()

    def test_probe_without_hud_skips_full_analysis_and_ranges_are_passed_on(self):
        with tempfile.TemporaryDirectory() as directory:
            h=self.fake(directory);h.a.no_probe=False;h.a.keep=False;vid='abcdefghijk'
            path=Path(directory)/(vid+'.mp4');path.write_bytes(b'fake');(Path(directory)/'results').mkdir()
            h.state.x("INSERT INTO videos(id,dl_status,dl_path) VALUES(?,'done',?)",(vid,str(path)))
            seen={}
            h.export_validation=lambda vid,res,*a,**kw:seen.setdefault('result',json.loads(Path(res).read_text())) and 1
            def popen(*a,**kw):raise AssertionError('full analysis must be skipped')
            no_hud={'box':[0,0,10,20],'ranges':[],'samples':90,'hits':0,'coverage':0,'duration':600,'keyInterval':6}
            with patch.object(H.Harvester,'run_probe',lambda self,*a:no_hud),patch('harvest.subprocess.Popen',popen),\
                 patch('harvest.gamemaster_for',return_value=''),patch('harvest.write_league_refinement',return_value=None):
                h.extract_one({'id':vid,'dl_path':str(path),'league':'{}','duration':600,'upload_date':'20200101','meta':'{}'})
            self.assertEqual(seen['result']['battles'],[]);self.assertEqual(seen['result']['probe']['samples'],90)
            self.assertFalse(path.exists(),'the video is deleted once it is no longer needed')
            self.assertEqual(h.state.q('SELECT x_status FROM videos')[0][0],'done')
            # Battles in part of the video: only those ranges are decoded, on the located screen.
            path.write_bytes(b'fake');h.state.x("UPDATE videos SET x_status=NULL,deleted_date=NULL");(Path(directory)/'results'/(vid+'.json')).unlink()
            ranged=dict(no_hud,ranges=[{'start':30.0,'end':400.0,'hits':40}],hits=40,coverage=.6)
            class Process:
                def __init__(self,command,**kwargs):
                    seen['env']=kwargs['env'];Path(command[-1]).write_text('{"battles":[]}');self.returncode=0
                def poll(self):return 0
            with patch.object(H.Harvester,'run_probe',lambda self,*a:ranged),patch('harvest.subprocess.Popen',Process),\
                 patch('harvest.gamemaster_for',return_value=''),patch('harvest.write_league_refinement',return_value=None):
                h.extract_one({'id':vid,'dl_path':str(path),'league':'{}','duration':600,'upload_date':'20200101','meta':'{}'})
            self.assertEqual((seen['env']['RANGES'],seen['env']['CROP'],seen['env']['FFMPEG_THREADS']),('30.0-400.0','0,0,10,20','1'))
            h.state.db.close()

    def test_confirmed_league_survives_registry_export_and_retry(self):
        prior={'reviewerLeague':True,'leagueId':'ultra','leagueGuess':'Ultra League',
               'leagueConfidence':1,'leagueEvidence':[{'source':'reviewer'}]}
        row={'id':'abcdefghijk','meta':'{}','league':json.dumps({'leagueId':'great','leagueGuess':'Great League','leagueConfidence':.4}),'allowed':True}
        entry=H.registry_entry(row,prior)
        self.assertEqual(entry['leagueConfidence'],1)
        self.assertEqual(entry['leagueEvidence'],prior['leagueEvidence'])
        self.assertEqual(entry['leagueId'],'ultra')
        with tempfile.TemporaryDirectory() as directory:
            h=self.fake(directory)
            h.a.registry=str(Path(directory)/'registry.json')
            S.atomic_json(h.a.registry,[dict(prior,id='abcdefghijk')])
            learned=h._reviewed_league('abcdefghijk',{'leagueId':'great'})
            self.assertEqual(learned['leagueId'],'ultra')
            self.assertEqual(learned['leagueConfidence'],1)
            h.state.x('INSERT INTO videos(id) VALUES(?)',('abcdefghijk',))
            h.a.cc_only=False;h.a.max_duration_min=180
            h.relevance_of=lambda *a,**kwargs:(5,'relevant')
            h.apply_meta('abcdefghijk',H.extract_meta({'id':'abcdefghijk','title':'Great League battle',
                'duration':600,'upload_date':'20200101','channel_id':'channel','channel':'Creator'}))
            stored=json.loads(h.state.q('SELECT league FROM videos')[0][0])
            self.assertEqual(stored['leagueId'],'ultra')
            self.assertEqual(stored['leagueConfidence'],1)
            # A pending label works even before a registry entry was created.
            S.atomic_json(Path(directory)/'labels'/'differentid.json',{'leagueId':'master'})
            pending=h._reviewed_league('differentid',{'leagueId':'great'})
            self.assertEqual(pending['leagueId'],'master')
            self.assertEqual(H.L.get_format(pending['leagueId'],{})[1]['cp'],10000)
            h.state.db.close()

    def test_export_samples_two_confident_audits_and_respects_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            h=self.fake(directory);result=Path(directory)/'result.json';result.write_text('{"battles":[]}')
            calls=[]
            def run(command,**kwargs):
                calls.append(kwargs['env'])
                return SimpleNamespace(returncode=0)
            with patch('harvest.subprocess.run',run),patch('harvest.V.harvest_questions',return_value=[]),patch('harvest.V.write_inbox',return_value=0):
                with patch.dict(os.environ,{},clear=True):
                    h.export_validation('abcdefghijk',str(result),'video.mp4','historical.json',{}, {},None)
                with patch.dict(os.environ,{'AUDIT':'5'},clear=True):
                    h.export_validation('abcdefghijk',str(result),'video.mp4','historical.json',{}, {},None)
                with patch.dict(os.environ,{'AUDIT':'0'},clear=True):
                    h.export_validation('abcdefghijk',str(result),'video.mp4','historical.json',{}, {},None)
            self.assertEqual([e['AUDIT'] for e in calls],['2','5','0'])
            self.assertTrue(all(e['NO_FRAMES']=='1' for e in calls))
            h.state.db.close()


if __name__=='__main__':
    unittest.main()

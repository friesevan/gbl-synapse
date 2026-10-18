import contextlib
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
import media_cache as M

VID = 'abcdefghijk'
OTHER = 'lmnopqrstuv'


class RetainedMediaTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.downloads = self.root / 'videos'; self.downloads.mkdir()
        self.work = self.root / 'work'; self.work.mkdir()

    def db(self, **values):
        with sqlite3.connect(self.work / 'state.sqlite') as conn:
            conn.execute('CREATE TABLE videos(id TEXT,dl_path TEXT,sha256 TEXT,league TEXT,x_status TEXT,deleted_date TEXT,title TEXT,upload_date TEXT,duration REAL)')
            row = dict(id=VID, dl_path=str(self.downloads / (VID + '.mp4')), sha256=None, league='{}', x_status='done', deleted_date=None, title='Battle', upload_date='20261010', duration=100)
            row.update(values)
            conn.execute('INSERT INTO videos VALUES (?,?,?,?,?,?,?,?,?)', tuple(row[k] for k in ('id','dl_path','sha256','league','x_status','deleted_date','title','upload_date','duration')))

    def test_retention_exact_complete_media_only_and_opt_out(self):
        for ext in ('mp4', 'webm', 'mkv', 'mov', 'm4v'):
            self.assertTrue(M.retained_file(VID + '.' + ext))
            self.assertFalse(M.retained_file(VID + '.' + ext, keep=False))
        for name in (VID+'.mp4.part', VID+'.f137.mp4', '../'+VID+'.mp4', VID+'.info.json', 'short.mp4'):
            self.assertFalse(M.retained_file(name))

    def test_inventory_preserves_deleted_marker_media_and_original_context_read_only(self):
        video = self.downloads / (VID+'.mp4'); video.write_bytes(b'video')
        sha = hashlib.sha256(b'video').hexdigest()
        self.db(sha256=sha[:16], deleted_date='2026-10-09')
        results = self.work / 'results'; results.mkdir()
        (results/(VID+'.json')).write_text(json.dumps({'learningContext':{'league':1500,'gamemaster':'/historical/gm.json'},'probe':{'box':[1,2,3,4],'ranges':[{'start':100,'end':200}]}}))
        before = (self.work/'state.sqlite').read_bytes()
        report = M.inventory(self.downloads,self.work,verify_sha=True)
        item = report['items'][0]
        self.assertEqual(item['status'],'available'); self.assertTrue(item['previouslyMarkedDeleted'])
        self.assertEqual(item['sha256'],sha); self.assertTrue(item['hashVerified'])
        self.assertEqual(item['recordedHashScope'],'sha256-prefix-16')
        self.assertEqual(item['ranges'],[{'start':100,'end':200}])
        text, skipped = M.batch_jobs(report)
        self.assertEqual(text,f'{video}|1500|/historical/gm.json|1,2,3,4\n')
        self.assertFalse(skipped)
        self.assertEqual((self.work/'state.sqlite').read_bytes(),before)
        self.assertEqual(video.read_bytes(),b'video')

    def test_missing_source_explicit_no_silent_replacement(self):
        self.db(dl_path=str(self.downloads/(VID+'.mp4')))
        (self.downloads/(VID+'.webm')).write_bytes(b'different encode')
        report=M.inventory(self.downloads,self.work)
        self.assertEqual(report['items'][0]['status'],'missing')
        self.assertEqual(len(report['items'][0]['alternatives']),1)
        self.assertEqual(M.batch_jobs(report,1500)[0],'')

    def test_unsafe_outside_source_and_symlink_are_not_followed(self):
        outside=self.root/(VID+'.mp4');outside.write_bytes(b'secret')
        self.db(dl_path=str(outside))
        item=M.inventory(self.downloads,self.work)['items'][0]
        self.assertEqual(item['status'],'unsafe');self.assertIsNone(item['sizeBytes'])
        (self.downloads/(OTHER+'.webm')).symlink_to(outside)
        other=M.inventory(self.downloads,self.work,video_ids=[OTHER])['items'][0]
        self.assertEqual(other['status'],'unsafe')
        with self.assertRaises(ValueError):M.inventory(self.downloads,self.work,video_ids=['../x'])

    def test_full_hash_mismatch_excluded_and_unknown_league_requires_explicit_default(self):
        (self.downloads/(VID+'.mp4')).write_bytes(b'changed')
        self.db(sha256='0'*16)
        report=M.inventory(self.downloads,self.work,verify_sha=True)
        self.assertEqual(report['items'][0]['status'],'hash-mismatch')
        self.assertFalse(report['items'][0]['hashVerified'])
        self.assertEqual(M.batch_jobs(report,1500)[0],'')
        report=M.inventory(self.downloads,self.work)
        self.assertEqual(M.batch_jobs(report)[1][0]['reason'],'league-unknown; provide --default-cp')
        self.assertIn('|2500||auto',M.batch_jobs(report,2500)[0])

    def test_inventory_without_database_and_explicit_cli_output(self):
        (self.downloads/(VID+'.mp4')).write_bytes(b'video')
        output=self.root/'jobs.txt'
        args=['--download-dir',str(self.downloads),'--work-dir',str(self.work),'--jobs',str(output),'--default-cp','1500']
        with contextlib.redirect_stdout(io.StringIO()):M.main(args)
        self.assertTrue(output.exists());self.assertTrue(Path(str(output)+'.manifest.json').exists())
        self.assertFalse((self.work/'state.sqlite').exists())
        before=output.read_bytes()
        with contextlib.redirect_stderr(io.StringIO()),self.assertRaises(SystemExit):M.main(args)
        self.assertEqual(output.read_bytes(),before)

    def test_saved_ranges_opt_in_requires_verified_recorded_source_hash(self):
        item = {'videoId':VID, 'path':'/video.mp4', 'status':'available', 'cp':1500,
                'crop':'0,0,560,1080', 'ranges':'20-40,35-60,90-100'}
        report = {'items':[item]}
        self.assertEqual(M.batch_jobs(report,use_saved_ranges=True)[0],'/video.mp4|1500||0,0,560,1080|\n')
        item.update(hashVerified=True, recordedHashScope='sha256-prefix-16', sha256='a'*64,rangeSourceSha256='a'*16)
        self.assertTrue(M.batch_jobs(report,use_saved_ranges=True)[0].endswith('|[[20.0,60.0],[90.0,100.0]]\n'))
        self.assertEqual(len(M.batch_jobs(report)[0].strip().split('|')),4)
        for ranges in ([], [[20,10]], '20-40,garbage', [[0,float('nan')]]):
            item['ranges']=ranges
            self.assertTrue(M.batch_jobs(report,use_saved_ranges=True)[0].endswith('|\n'))
        item.update(ranges=[[20,40]],rangeSourceSha256='b'*16)
        self.assertTrue(M.batch_jobs(report,use_saved_ranges=True)[0].endswith('|\n'))

    def test_placements_become_the_sixth_job_column(self):
        # The phone placed differently per clip (run-node CROPS): kept with the crop it was planned for.
        (self.downloads/(VID+'.mp4')).write_bytes(b'video');self.db()
        results=self.work/'results';results.mkdir();crops='0,0,560,1080@0-100;12,0,572,1080@100-200'
        (results/(VID+'.json')).write_text(json.dumps({'media':{'crop':'0,0,560,1080','crops':crops,'ranges':''},'learningContext':{'league':1500}}))
        item=M.inventory(self.downloads,self.work)['items'][0];self.assertEqual((item['crop'],item['crops']),('0,0,560,1080',crops))
        self.assertEqual(M.batch_jobs({'items':[item]})[0].strip().split('|')[3:],['0,0,560,1080','',crops])
        self.assertEqual(M.batch_jobs({'items':[item]},use_saved_ranges=True)[0].strip().split('|')[3:],['0,0,560,1080','',crops])
        (results/(VID+'.json')).write_text(json.dumps({'media':{'crop':'0,0,560,1080','ranges':''},'learningContext':{'league':1500}}))
        item=M.inventory(self.downloads,self.work)['items'][0];self.assertNotIn('crops',item);self.assertEqual(len(M.batch_jobs({'items':[item]})[0].strip().split('|')),4)

    def test_explicit_full_source_context_does_not_inherit_old_probe_ranges(self):
        (self.downloads/(VID+'.mp4')).write_bytes(b'video');self.db()
        results=self.work/'results';results.mkdir()
        (results/(VID+'.json')).write_text(json.dumps({'media':{'ranges':'','sha256':'a'*16},'probe':{'ranges':[[20,40]]}}))
        item=M.inventory(self.downloads,self.work)['items'][0]
        self.assertEqual(item['ranges'],'');self.assertEqual(item['rangeSourceSha256'],'a'*16)

    def test_saved_ranges_cli_requires_verification(self):
        args=['--download-dir',str(self.downloads),'--work-dir',str(self.work),'--use-saved-ranges']
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):M.main(args)


class TieredRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.dl = self.root / 'dl'; self.dl.mkdir()
        self.work = self.root / 'work'; (self.work / 'results').mkdir(parents=True)
        self.conn = sqlite3.connect(self.work / 'state.sqlite')
        self.conn.execute('CREATE TABLE videos(id TEXT,dl_status TEXT,x_status TEXT,upload_date TEXT,league TEXT,dl_path TEXT,sha256 TEXT,deleted_date TEXT,title TEXT,duration REAL)')
        self.conn.execute('CREATE TABLE reprocess(id TEXT PRIMARY KEY, requested REAL)')
        self.n = 0

    def video(self, date='20260101', battles=1, size=1000, dl='done', x='done', name=None):
        self.n += 1
        vid = 'vid%08d' % self.n
        self.conn.execute('INSERT INTO videos(id,dl_status,x_status,upload_date) VALUES (?,?,?,?)', (vid, dl, x, date))
        self.conn.commit()
        (self.dl / (name or vid + '.mp4')).write_bytes(b'x' * size)
        if battles is not None:
            (self.work / 'results' / (vid + '.json')).write_text(json.dumps({'battles': [{}] * battles}))
        return vid

    def answers(self, *items):
        data = {'answers': {'q%d' % i: {'kind': k, 'source': src, 'video': {'id': v}} for i, (v, k, src) in enumerate(items)}}
        (self.work / 'feedback.json').write_text(json.dumps(data))

    def plan(self, **kw):
        kw.setdefault('free_bytes', 10**12)
        plan = M.plan_retention(self.dl, self.work, **kw)
        return {i['id']: i for i in plan['items']}, plan

    def test_tiers(self):
        a1, a2, b, zero, nof = (self.video() for _ in range(5))
        zero = self.video(battles=0)
        self.answers((a1, 'shadow', 'reviewer'), (nof, 'footage', 'reviewer'), (b, 'footage', 'llm'))
        (self.work / 'feedback.json').write_text(json.dumps({'answers': {
            'a': {'kind': 'shadow', 'source': 'reviewer', 'video': {'id': a1}},
            'f': {'kind': 'footage', 'value': 'none', 'source': 'reviewer', 'video': {'id': nof}},
            'm': {'kind': 'shadow', 'source': 'local-llm', 'video': {'id': b}}}}))
        self.conn.execute('INSERT INTO reprocess VALUES (?,0)', (a2,)); self.conn.commit()
        failed = self.video(dl='error', x=None)
        part = self.video(name='zzzzzzzzzzz.mp4.part')
        pend = self.video(x=None)
        items, plan = self.plan()
        self.assertEqual((items[a1]['tier'], items[a2]['tier']), ('A', 'A'))
        self.assertEqual(items[b]['tier'], 'B')   # a model answer is not a human label
        self.assertEqual((items[zero]['tier'], items[zero]['action']), ('C', 'evict'))
        self.assertEqual((items[nof]['tier'], items[nof]['action']), ('C', 'evict'))
        self.assertEqual(items[failed]['action'], 'evict')
        self.assertEqual(items[pend]['action'], 'keep')
        self.assertTrue(any(i['name'].endswith('.part') and i['action'] == 'evict' for i in plan['items']))
        self.assertEqual(plan['totals']['tierA']['count'], 2)

    def test_label_wins_over_zero_battles_and_no_footage(self):
        v = self.video(battles=0)
        self.answers((v, 'footage', 'reviewer'), (v, 'result', 'reviewer'))
        self.assertEqual(self.plan()[0][v]['tier'], 'A')
        (self.work / 'labels').mkdir(); (self.work / 'labels' / 'abcdefghijk.json').write_text('{}')
        self.assertIn('abcdefghijk', M.labelled_ids(self.work)[0])

    def test_budget_evicts_oldest_tier_b_and_never_tier_a(self):
        old = self.video(date='20250101', size=600)
        mid = self.video(date='20260101', size=600)
        new = self.video(date='20261001', size=600)
        lab = self.video(date='20240101', size=5000)
        self.answers((lab, 'lead', 'reviewer'))
        items, plan = self.plan(budget_gb=1500e-9)   # 1500 bytes: two newest fit
        self.assertEqual([items[v]['action'] for v in (new, mid, old)], ['keep', 'keep', 'evict'])
        self.assertEqual(items[lab]['action'], 'keep')
        self.assertEqual(plan['totals']['tierB']['count'], 2)

    def test_min_free_evicts_more_oldest(self):
        old = self.video(date='20250101', size=600); new = self.video(date='20261001', size=600)
        items, _ = self.plan(budget_gb=1, min_free_gb=1000e-9, free_bytes=500)
        self.assertEqual((items[old]['action'], items[new]['action']), ('evict', 'keep'))

    def test_apply_deletes_only_planned_evictions_in_download_dir(self):
        old = self.video(date='20250101', size=600); new = self.video(date='20261001', size=600)
        lab = self.video(battles=0); self.answers((lab, 'form', 'reviewer'))
        outside = self.root / 'outside.mp4'; outside.write_bytes(b'x')
        (self.dl / 'link12345678.mp4').symlink_to(outside)
        _, plan = self.plan(budget_gb=700e-9)
        seen = []
        n = M.apply_plan(plan, self.dl, on_evict=seen.append)
        self.assertEqual(n, 1)
        self.assertFalse((self.dl / (old + '.mp4')).exists())
        self.assertTrue((self.dl / (new + '.mp4')).exists() and (self.dl / (lab + '.mp4')).exists() and outside.exists())
        self.assertEqual([i['id'] for i in seen], [old])

    def test_dry_run_cli_changes_nothing(self):
        import harvest as H
        v = self.video(battles=0)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            H.main(['retention', '--dry-run', '--download-dir', str(self.dl), '--work-dir', str(self.work)])
        self.assertIn('EVICT', buf.getvalue()); self.assertIn(v + '.mp4', buf.getvalue())
        self.assertTrue((self.dl / (v + '.mp4')).exists())

    def test_discard_mode_deletes_analysed_but_not_tier_a_or_pending(self):
        done = self.video(); pend = self.video(x=None); lab = self.video(); self.answers((lab, 'result', 'reviewer'))
        items, _ = self.plan(discard=True)
        self.assertEqual((items[done]['action'], items[pend]['action'], items[lab]['action']), ('evict', 'keep', 'keep'))

    def test_merge_moves_skips_duplicates_keeps_conflicts_and_removes_empty_src(self):
        src, dst = self.root / 'relabel', self.root / 'dl2'; src.mkdir(); dst.mkdir()
        (src / 'aaaaaaaaaaa.mp4').write_bytes(b'one'); (src / 'bbbbbbbbbbb.mp4').write_bytes(b'same'); (dst / 'bbbbbbbbbbb.mp4').write_bytes(b'same')
        (src / 'ccccccccccc.mp4').write_bytes(b'AAA'); (dst / 'ccccccccccc.mp4').write_bytes(b'BBB')
        quiet = lambda *_: None
        dry = M.merge_dirs(src, dst, apply=False, log=quiet)
        self.assertEqual((dry['moved'], dry['duplicates'], dry['conflicts']), (1, 1, ['ccccccccccc.mp4']))
        self.assertTrue((src / 'aaaaaaaaaaa.mp4').exists())
        M.merge_dirs(src, dst, apply=True, log=quiet)
        self.assertEqual((dst / 'aaaaaaaaaaa.mp4').read_bytes(), b'one')
        self.assertEqual((dst / 'ccccccccccc.mp4').read_bytes(), b'BBB')
        self.assertEqual([p.name for p in src.iterdir()], ['ccccccccccc.mp4'])   # conflict stays, folder kept
        (src / 'ccccccccccc.mp4').unlink()
        M.merge_dirs(src, dst, apply=True, log=quiet)
        self.assertFalse(src.exists())


if __name__=='__main__':unittest.main()

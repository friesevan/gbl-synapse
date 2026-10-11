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

    def test_explicit_full_source_context_does_not_inherit_old_probe_ranges(self):
        (self.downloads/(VID+'.mp4')).write_bytes(b'video');self.db()
        results=self.work/'results';results.mkdir()
        (results/(VID+'.json')).write_text(json.dumps({'media':{'ranges':'','sha256':'a'*16},'probe':{'ranges':[[20,40]]}}))
        item=M.inventory(self.downloads,self.work)['items'][0]
        self.assertEqual(item['ranges'],'');self.assertEqual(item['rangeSourceSha256'],'a'*16)

    def test_saved_ranges_cli_requires_verification(self):
        args=['--download-dir',str(self.downloads),'--work-dir',str(self.work),'--use-saved-ranges']
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):M.main(args)


if __name__=='__main__':unittest.main()

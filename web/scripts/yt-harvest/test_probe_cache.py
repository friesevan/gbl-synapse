import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('probe_cache', Path(__file__).with_name('probe_cache.py'))
C=importlib.util.module_from_spec(spec);spec.loader.exec_module(C)
class Cache(unittest.TestCase):
 def test_identity_invalidates_on_source_code_and_options(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);video=root/'source.mp4';video.write_bytes(b'a')
   for n in C.DEPENDENCIES:
    p=root/n;p.parent.mkdir(parents=True,exist_ok=True);p.write_text('original')
   a=C.identity(video,root,{'PROBE_PRE':'30'});self.assertEqual(a,C.identity(video,root,{'PROBE_PRE':'30'}))
   self.assertNotEqual(a,C.identity(video,root,{'PROBE_PRE':'60'}));video.write_bytes(b'changed');self.assertNotEqual(a,C.identity(video,root,{'PROBE_PRE':'30'}))
   (root/C.DEPENDENCIES[0]).write_text('new');self.assertNotEqual(a,C.identity(video,root,{'PROBE_PRE':'30'}))
 def test_corrupt_data_or_stale_key_misses(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d)/'cache.json';key={'schema':1};probe={'box':[0,0,10,20],'ranges':[]};p.write_text(json.dumps(C.document(key,probe)))
   self.assertEqual(C.load(p,key),probe);self.assertIsNone(C.load(p,{'schema':2}));doc=json.loads(p.read_text());doc['probe']['box'][0]=9;p.write_text(json.dumps(doc));self.assertIsNone(C.load(p,key));p.write_text('bad');self.assertIsNone(C.load(p,key))
if __name__=='__main__':unittest.main()

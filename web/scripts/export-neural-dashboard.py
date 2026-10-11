"""Export a compact public report; never publish checkpoints or machine paths."""
import argparse, json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('run',type=Path);p.add_argument('--output',type=Path,default=Path('includes/pro/data/team-search.json'));a=p.parse_args()
def read(name):return json.loads((a.run/name).read_text())
r=read('recommendations.json');s=read('checkpoint.json');process=read('process.json');history=[json.loads(x) for x in (a.run/'history.jsonl').read_text().splitlines() if x.strip()]
def compact_eval(e):return {k:v for k,v in e.items() if k not in ['pairs','team']}
rows=[]
for row in r['rows']:
 if not row.get('validation'):continue
 rows.append({k:(compact_eval(v) if k in ['screen','validation'] else v) for k,v in row.items()})
assert len(rows)==8 and all(x['validation']['games']==1024 for x in rows)
for row in rows:
 v=row['validation'];assert v['score']==(v['wins']+v['draws']/2)/v['games']
assert all(x['validation']['fixtureSeed']==rows[0]['validation']['fixtureSeed'] for x in rows)
assert all(x['screen']['fixtureSeed']!=x['validation']['fixtureSeed'] for x in rows)
assert all(y['battles']>x['battles'] and y['elapsedSeconds']>x['elapsedSeconds'] for x,y in zip(history,history[1:]))
assert process['exitCode']==0 and s['runtime']['phase']=='finished'
baselines=[]
for kind,comparison in r['comparisons'].items():
 b=[x for x in r['baselineResults'] if x['kind']==kind];assert len(b)==4
 baselines.append({'kind':kind,'score':sum(x['score'] for x in b)/len(b),**comparison})
runtime={k:s['runtime'][k] for k in ['workers','elapsedSeconds','newBattles','averageCoresUsed','peakRssMB']}
report={'version':1,'startedAt':process['startedAt'],'endedAt':process['endedAt'],'runtime':runtime,'totalBattles':r['battles'],'totalTeams':len(s['records']),'fixtures':len(s['observations']),'history':history,'teams':rows,'baselines':baselines,'pool':{'species':300,'movesets':5,'cp':1500},'latestDiagnostics':s['latestDiagnostics']}
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps(report,separators=(',',':'))+'\n');print(f'Exported {len(history)} rounds and {len(rows)} finalists ({a.output.stat().st_size:,} bytes).')

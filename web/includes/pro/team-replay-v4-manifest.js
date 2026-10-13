globalThis.NeuralReplayV4={"engine":"neural-team-search-v4","mechanicsHash":"1b33a32b427cf1fb1a775193c20b2895cea23b3cfa6f1daf13178ba1210754d9","dataHash":"ec96d756d6e5d5d63fb3c3f7b52411b4d1f85a3a3c170261caadeb4cb3a43528","legacyMechanicsHash":"a0aa220e681b1c4af6fabbdef934d1c191f200101e95388f62fd322dff6b7c20"};
globalThis.NeuralReplayV4.controllerSuffix=(function(){
// <controller-options>
// Controller options (OBSERVATION_CONTROLLER.md, "Controller options"). The defaults are the v4 controller
// exactly; any other setting is a different controller. teamControllerSuffix() gives it its own mechanics
// identity, so its labels, warm starts and replays never mix with the default's. This section uses no other
// global: next/controller-options.cjs (Node) and scripts/build-neural-replay-v4.cjs (browser) load it as is.
function teamControllerDefaults(){return {replyModel:'worst',replyTemperature:.25,rolloutContinuation:0,switchMargin:.08,shieldPolicy:'default'};}
// A switch margin at or above this never switches voluntarily (forced replacements still happen).
function teamControllerNeverSwitch(){return 1e9;}
function teamControllerPick(o,strict,where){
 const d=teamControllerDefaults(),out={};if(o==null)return out;
 if(typeof o!=='object'||Array.isArray(o))throw Error(where+': controller options must be an object');
 for(const k of Object.keys(o)){
  const v=o[k];if(!(k in d)){if(strict)throw Error(where+': unknown controller option '+k);continue;}if(v===undefined)continue;
  if(k==='replyModel'&&v!=='worst'&&v!=='weighted')throw Error(where+': replyModel must be worst or weighted');
  if(k==='replyTemperature'&&!(typeof v==='number'&&Number.isFinite(v)&&v>0&&v<=10))throw Error(where+': replyTemperature must be a number in (0, 10]');
  if(k==='rolloutContinuation'&&!(Number.isInteger(v)&&v>=0&&v<=24))throw Error(where+': rolloutContinuation must be an integer from 0 to 24');
  if(k==='switchMargin'&&!(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=teamControllerNeverSwitch()))throw Error(where+': switchMargin must be a number from 0 to 1e9');
  if(k==='shieldPolicy'&&v!=='default'&&v!=='always'&&v!=='never')throw Error(where+': shieldPolicy must be default, always or never');
  out[k]=v;
 }
 return out;
}
// Physical side `side`: the defaults, then the battle-wide options, then that side's controllerTeams entry.
function teamControllerSettings(options,side){
 const o=options||{},sides=o.controllerTeams;
 if(sides!=null&&(!Array.isArray(sides)||sides.length!==2))throw Error('controllerTeams must hold one entry per side');
 return Object.assign(teamControllerDefaults(),teamControllerPick(o,false,'controller'),teamControllerPick(sides?.[side],true,'controllerTeams['+side+']'));
}
// The settings that differ from the defaults, in a fixed order (null for the default controller). The reply
// temperature only matters, and is only recorded, for weighted replies.
function teamControllerIdentity(options){
 const d=teamControllerDefaults(),s=Object.assign(teamControllerDefaults(),teamControllerPick(options,false,'controller')),out={};
 if(s.replyModel!==d.replyModel){out.replyModel=s.replyModel;out.replyTemperature=s.replyTemperature;}
 for(const k of ['rolloutContinuation','switchMargin','shieldPolicy'])if(s[k]!==d[k])out[k]=s[k];
 return Object.keys(out).length?out:null;
}
// Appended to the v4 mechanics id of a run whose two sides share a non-default controller, e.g.
// '+controller:replyModel=weighted,replyTemperature=0.25'. Per-side controllers are evaluation-only.
function teamControllerSuffix(options){
 if(options?.controllerTeams?.some(o=>o&&Object.keys(o).length))throw Error('Per-side controllers (controllerTeams) have no single mechanics identity');
 const id=teamControllerIdentity(options);return id?'+controller:'+Object.keys(id).map(k=>k+'='+id[k]).join(','):'';
}
// Each side's controller identity when the two sides differ, else [null,null]: battles where both sides share a
// controller (every search label) keep the orientation and mirrored-team rule of the default controller.
function teamControllerSideKeys(options){
 const ids=[0,1].map(i=>teamControllerIdentity(teamControllerSettings(options,i)));
 return JSON.stringify(ids[0])===JSON.stringify(ids[1])?[null,null]:ids;
}
// Weighted replies: the expected value when the opponent picks each reply with probability proportional to
// exp(u/T), where u is the reply's value for the opponent (the rollout value negated). An exact expectation, so
// deterministic; T -> 0 recovers the worst case. No reply (a finished game) is +Infinity, as in the worst case.
function teamWeightedReply(values,temperature){
 let low=Infinity;for(const v of values)if(v<low)low=v;if(!values.length||low===-Infinity||low===Infinity)return low;
 let total=0,sum=0;for(const v of values){const w=Math.exp((low-v)/temperature);if(w>0){total+=w;sum+=w*v;}}
 return sum/total;
}
// </controller-options>
return teamControllerSuffix;})();

const {test}=require('node:test'),assert=require('node:assert/strict');
const Timeline=require('../includes/meta/timeline.js');
class Element {
 constructor(tag){this.tag=tag;this.attributes={};this.children=[];this.style={};this._text='';}
 setAttribute(k,v){this.attributes[k]=v;}
 append(...nodes){this.children.push(...nodes);}
 get textContent(){return this._text+this.children.map(n=>typeof n==='string'?n:n.textContent).join('');}
 set textContent(v){this._text=String(v);}
}
test('harvest graph makes creator result and both sides explicit without changing private recording labels',()=>{
 const original=global.document;global.document={createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t)};
 try{
  const battle={duration:60,result:'Loss',ending:'you-forfeit',my:[{key:'a',label:'Pikachu'}],opponent:[{key:'b',label:'Raichu'}],events:[],hp:{step:30,my:{a:[100,50,0]},opponent:{b:[100,80,70]}}};
  const labels={my:'Creator',opponent:'Opponent'};
  const graph=Timeline.render(battle,{sideLabels:labels});
  assert.match(graph.textContent,/Creator: Loss \(Creator forfeited\)/);
  assert.match(Timeline.legend(battle,{sideLabels:labels}).textContent,/Creator: Pikachu/);
  assert.match(Timeline.render(battle).textContent,/you forfeited/);
  assert.match(Timeline.legend(battle).textContent,/You: Pikachu/);
 }finally{global.document=original;}
});

'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {Network,gradient,matchup,train}=require('./interaction.cjs');
test('interaction gradients respect antisymmetric paired parameters and swapping teams',()=>{
 const n=new Network(3,4,79);for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){n.interaction[i*4+j]=.2;n.interaction[j*4+i]=-.2;}const a=[.2,.1,.9],b=[.6,.4,.1],y=.8,{g}=gradient(n,a,b,y),arrays=[n.w1,n.b1,n.w2,n.b2];
 for(let k=0;k<arrays.length;k++)for(let i=0;i<arrays[k].length;i++){const old=arrays[k][i],eps=1e-5;arrays[k][i]=old+eps;const plus=gradient(n,a,b,y).loss;arrays[k][i]=old-eps;const minus=gradient(n,a,b,y).loss;arrays[k][i]=old;assert.ok(Math.abs(g[k][i]-(plus-minus)/(2*eps))<1e-7);}
 for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){const upper=i*4+j,lower=j*4+i,old=n.interaction[upper],eps=1e-5;n.interaction[upper]=old+eps;n.interaction[lower]=-old-eps;const plus=gradient(n,a,b,y).loss;n.interaction[upper]=old-eps;n.interaction[lower]=-old+eps;const minus=gradient(n,a,b,y).loss;n.interaction[upper]=old;n.interaction[lower]=-old;assert.ok(Math.abs(g[4][upper]-(plus-minus)/(2*eps))<1e-7);}
 assert.ok(Math.abs(matchup(n,a,b)+matchup(n,b,a)-1)<1e-12);
});
test('neural matchup interactions learn cyclic counters that a scalar strength model cannot represent',()=>{
 const x=[[1,0,0],[0,1,0],[0,0,1]],samples=x.flatMap((a,i)=>x.map((b,j)=>({a,b,y:i===j?.5:(i+1)%3===j?.9:.1})));const n=train(new Network(3,8,41),samples,{epochs:600,rate:.01,batch:9,seed:29});
 const mse=samples.reduce((sum,s)=>sum+(matchup(n,s.a,s.b)-s.y)**2,0)/samples.length;assert.ok(mse<.005,'Cyclic matchup MSE '+mse);const loaded=Network.fromJSON(JSON.parse(JSON.stringify(n)));assert.equal(matchup(loaded,x[0],x[1]),matchup(n,x[0],x[1]));
});

test('training rejects zero batches and invalid optimization limits instead of hanging or skipping fitting',()=>{
 const n=new Network(2,3,10),samples=[{a:[1,0],b:[0,1],y:.5}];
 for(const opts of [{batch:0},{batch:1.5},{epochs:0},{epochs:NaN},{rate:0},{rate:Infinity}])assert.throws(()=>train(n,samples,opts),/configuration/);
});

test('empty or nonfinite inference references fail instead of returning a NaN score',()=>{
 const {reference,predict}=require('./interaction.cjs'),models=[new Network(2,3,8)];
 assert.throws(()=>reference(models,[]),/reference opponents/);
 assert.throws(()=>predict(models,[1,0],[]),/reference panel/);
 assert.throws(()=>predict(models,[1,0],[[]]),/reference panel/);
 assert.throws(()=>predict(models,[1,0],[[{h:[0,0,0],z:NaN}]]),/Nonfinite/);
});

// Low-rank antisymmetric interaction (opt-in): K = A Bᵀ − B Aᵀ with A and B of size hidden × rank.
test('low-rank interaction gradients match numerical gradients for the factors and the shared weights', () => {
 const {gradient: grad} = require('./interaction.cjs'), H = 5, R = 2, n = new Network(3, H, 11, R);
 const seeded = (arr, scale) => arr.forEach((_, i) => { arr[i] = scale * Math.sin(1.7 * i + 0.3); });
 seeded(n.ka, .6); seeded(n.kb, .5); seeded(n.w1, .7); seeded(n.w2, .6); n.syncInteraction();
 const a = [.2, .1, .9], b = [.6, .4, .1], y = .8, {g} = grad(n, a, b, y);
 assert.equal(g.length, 7);
 const check = (array, analytic, tag) => { for (let i = 0; i < array.length; i++) { const old = array[i], eps = 1e-5; array[i] = old + eps; n.syncInteraction(); const plus = grad(n, a, b, y).loss; array[i] = old - eps; n.syncInteraction(); const minus = grad(n, a, b, y).loss; array[i] = old; n.syncInteraction(); assert.ok(Math.abs(analytic[i] - (plus - minus) / (2 * eps)) < 1e-7, tag + '[' + i + ']'); } };
 check(n.ka, g[5], 'A'); check(n.kb, g[6], 'B'); check(n.w1, g[0], 'w1'); check(n.b1, g[1], 'b1'); check(n.w2, g[2], 'w2'); check(n.b2, g[3], 'b2');
 // The pair gradient of the free matrix stays exactly antisymmetric; the factor gradients are derived from it.
 for (let i = 0; i < H; i++) for (let j = 0; j < H; j++) assert.ok(Math.abs(g[4][i * H + j] + g[4][j * H + i]) < 1e-15);
});
test('low-rank interaction is exactly antisymmetric, complements swapped teams and has the stated rank', () => {
 const H = 6, n = new Network(3, H, 5, 1);n.ka.forEach((_, i) => { n.ka[i] = Math.cos(i + 1); n.kb[i] = Math.sin(2 * i + 1); });n.syncInteraction();
 for (let i = 0; i < H; i++) { assert.equal(n.interaction[i * H + i], 0); for (let j = 0; j < H; j++) assert.equal(n.interaction[i * H + j] + n.interaction[j * H + i], 0); }
 // Rank 1 factors give K = a bᵀ − b aᵀ, an antisymmetric matrix of rank 2: every 3×3 minor vanishes.
 const minor = (r, c) => r.map(i => c.map(j => n.interaction[i * H + j]));
 const det3 = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
 assert.ok(Math.abs(det3(minor([0, 1, 2], [3, 4, 5]))) < 1e-12);assert.ok(Array.from(n.interaction).some(v => Math.abs(v) > 1e-3));
 assert.ok(Math.abs(matchup(n, [.2, .5, .1], [.9, .1, .4]) + matchup(n, [.9, .1, .4], [.2, .5, .1]) - 1) < 1e-12);
 assert.ok(Math.abs(matchup(n, [.3, .3, .3], [.3, .3, .3]) - .5) < 1e-12);
});
test('a low-rank model learns the cyclic counter fixture and survives serialisation; inconsistent factors are rejected', () => {
 const x = [[1, 0, 0], [0, 1, 0], [0, 0, 1]], samples = x.flatMap((a, i) => x.map((b, j) => ({a, b, y: i === j ? .5 : (i + 1) % 3 === j ? .9 : .1})));
 const n = train(new Network(3, 8, 41, 2), samples, {epochs: 600, rate: .01, batch: 9, seed: 29}), mse = samples.reduce((sum, s) => sum + (matchup(n, s.a, s.b) - s.y) ** 2, 0) / samples.length;
 assert.ok(mse < .01, 'Low-rank cyclic MSE ' + mse);
 const json = JSON.parse(JSON.stringify(n)), loaded = Network.fromJSON(json);assert.equal(loaded.rank, 2);assert.equal(matchup(loaded, x[0], x[1]), matchup(n, x[0], x[1]));
 assert.deepEqual(Array.from(loaded.ka), Array.from(n.ka));assert.deepEqual(Array.from(loaded.interaction), Array.from(n.interaction));
 const bad = JSON.parse(JSON.stringify(n));bad.ka[0] += .5;assert.throws(() => Network.fromJSON(bad), /does not match its factors/);
 const short = JSON.parse(JSON.stringify(n));short.kb.pop();assert.throws(() => Network.fromJSON(short), /factors/);
 // Without rank nothing new is serialised and the interaction matrix stays a free parameter.
 const plain = new Network(3, 4, 2).toJSON();assert.equal('rank' in plain, false);assert.equal('ka' in plain, false);
 for (const rank of [-1, 1.5, 5]) assert.throws(() => new Network(3, 4, 1, rank), /interaction rank/);
});
test('the weight-decay multiplier is optional, validated, and the default reproduces the unscaled fit exactly', () => {
 const samples = Array.from({length: 40}, (_, i) => ({a: [i % 3, 1, (i * 7) % 5 / 5], b: [(i + 1) % 4 / 4, i % 2, .5], y: i % 3 === 0 ? 1 : i % 3 === 1 ? .5 : 0}));
 const fit = opts => JSON.stringify(train(new Network(3, 5, 9), samples, {epochs: 3, seed: 4, batch: 8, ...opts}).toJSON());
 assert.equal(fit({}), fit({l2: 1}));assert.notEqual(fit({}), fit({l2: 3}));assert.notEqual(fit({}), fit({l2: 0}));
 for (const l2 of [-1, NaN, Infinity]) assert.throws(() => fit({l2}), /configuration/);
 // Stronger decay shrinks the weights.
 const norm = opts => { const n = train(new Network(3, 5, 9), samples, {epochs: 30, seed: 4, batch: 8, ...opts}); return Array.from(n.interaction).reduce((s, v) => s + v * v, 0) + Array.from(n.w1).reduce((s, v) => s + v * v, 0); };
 assert.ok(norm({l2: 200}) < norm({l2: 1}));
});

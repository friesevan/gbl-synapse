'use strict';
// The real search loop with --observed-moves and --alternate-panel. Battles are replaced by a deterministic hash of (team,
// opponent, seed) that includes the opponents' movesets, so a different moveset is a different outcome.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const {BattlePool} = require('../pool.cjs'), {search} = require('./search.cjs'), A = require('./alternate-panel.cjs'), O = require('./observed-moves.cjs'), {createMeta} = require('./meta.cjs');
const core = require('../../includes/pro/neural-report-core.js'), {VERSION, dataHash, digest, teamKey, screeningSeed} = require('./common.cjs'), S = require('./sensitivity.cjs'), confirmation = require('./confirmation.cjs');
const ctx = require('node:vm').createContext({});
require('node:vm').runInContext(fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8'), ctx);

function testPool(poolPath) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [], variants = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);if (!p || used.has(p.dex) || row.moveset.length !== 3 || [...O.movePools(p.speciesId).charged].filter(m => !row.moveset.includes(m)).length < 4) continue;used.add(p.dex);
  const s = {speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: Array(97).fill(.5), scoutByType: Array(18).fill(.5), scoutScore: .6, ivs: {atk: 0, def: 15, hp: 15}, cp: 1500, level: 30};
  species.push(s);
  // Three retained variants per species: the recommended moveset, then two others by scout score.
  const others = [...O.movePools(s.speciesId).charged].filter(m => !s.moveset.includes(m)).sort();
  variants.push({...s, recommended: true}, {...s, moveset: [s.moveset[0], others[0], others[1]], scoutScore: .5, recommended: false}, {...s, moveset: [s.moveset[0], others[2], others[3]], scoutScore: .4, recommended: false});
  if (species.length === 6) break;
 }
 variants.forEach((v, i) => { v.index = i; });
 const prepared = {config: {version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 3}, species, variants};prepared.hash = digest(prepared);fs.writeFileSync(poolPath, JSON.stringify(prepared));return {species, variants, prepared};
}
// Observed opponents: two teams with observed movesets for some members, one without.
function writeUsage(file, species) {
 const [a, b, c, d, e, f] = species, rock = x => ({fast: null, charged: [[...O.movePools(x.speciesId).charged].filter(m => !x.moveset.includes(m)).sort()[0]]});
 fs.writeFileSync(file, JSON.stringify({source: 'test usage', cp: 1500, cup: 'all', collectedAt: '2026-10-09', teams: [
  {members: [a.speciesId, b.speciesId, c.speciesId], count: 6, movesets: [rock(a), null, {fast: [...O.movePools(c.speciesId).fast].find(m => m !== c.moveset[0]), charged: []}]},
  {members: [d.speciesId, e.speciesId, f.speciesId], count: 4, movesets: [null, rock(e), null]},
  {members: [a.speciesId, e.speciesId, f.speciesId], count: 2},
 ]}));
}
const movesOf = rows => rows.map(p => p.moveset.join('/'));
const REAL_MAP = BattlePool.prototype.map;
const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
const dropListeners = () => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };
const read = (out, name = 'checkpoint.json') => JSON.parse(fs.readFileSync(path.join(out, name)));

function mockBattles({interrupt = null, throwAt = Infinity} = {}) {
 const log = {calls: [], played: 0};
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return REAL_MAP.call(this, jobs, options);
  const {onResult = () => {}, shouldStop = () => false} = options, results = [], call = {size: jobs.length, jobs: []};
  log.calls.push(call);
  for (let i = 0; i < jobs.length; i++) {
   if (shouldStop()) return null;
   const [team, opponent, , , settings] = jobs[i], id = digest([team.map(p => [p.speciesId, p.moveset]), opponent.map(p => [p.speciesId, p.moveset]), settings.seed]);
   call.jobs.push({team: team.map(p => p.speciesId), opponent: opponent.map(p => p.speciesId), opponentMoves: movesOf(opponent), seed: settings.seed});
   const result = {score: parseInt(id.slice(0, 2), 16) % 3 / 2};results.push(result);onResult(result, i);
   if (++log.played === throwAt) throw Error('Injected interruption');
   if (interrupt && jobs.length === interrupt.jobs && i + 1 === interrupt.after) process.emit('SIGINT');
  }
  return results;
 };
 return {log, restore: () => { BattlePool.prototype.map = REAL_MAP; }};
}
const base = poolPath => ({pool: poolPath, hours: 1, workers: 1, initialTeams: 8, batchTeams: 4, opponents: 6, acquisitionFixtures: 1, promotionFraction: .5, screenTeams: 3, screenOpponents: 2, validationTeams: 2, validationOpponents: 4, baselineCount: 3, candidates: 8, epochs: 1, hidden: 4, ensemble: 1, referenceOpponents: 2, fitFixtures: 16, seed: 123, validationSeed: 902, rounds: 1, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1, confirmationOpponents: 0});

test('--observed-moves: observed opponents play their movesets everywhere, are identified by them, and replay with them in the report', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moves-search-')), poolPath = path.join(directory, 'source-pool.json'), usagePath = path.join(directory, 'usage.json'), {species, prepared} = testPool(poolPath);writeUsage(usagePath, species);
 try {
  const opts = {...base(poolPath), meta: 'observed', usageFile: usagePath, sensitivityFixtures: 2, alternatePanel: 3}, recommended = new Map(species.map(p => [p.speciesId, p.moveset.join('/')]));
  let mock = mockBattles();const plain = path.join(directory, 'plain');await search({...opts, out: plain, alternatePanel: 0});dropListeners();const reference = read(plain), plainCalls = mock.log.calls.slice();mock.restore();
  assert.equal('observedMoves' in reference.config, false);assert.equal('observedMoves' in reference.config.meta, false);assert.equal('alternatePanel' in reference.config, false);
  assert.ok(reference.observations.every(o => o.opponent.every(id => !id.includes('@'))), 'without the option the opponent ids are plain species ids');
  for (const call of plainCalls) for (const job of call.jobs) assert.deepEqual(job.opponentMoves, job.opponent.map(id => recommended.get(id)), 'recommended movesets');
  mock = mockBattles();const out = path.join(directory, 'moves');await search({...opts, out, observedMoves: true});dropListeners();const state = read(out), calls = mock.log.calls.slice();mock.restore();
  // The checkpoint says so, and the meta records what the observations cover.
  assert.equal(state.config.observedMoves, true);
  const coverage = state.config.meta.observedMoves;
  assert.ok(coverage.fastShare > 0 && coverage.chargedShare > 0 && coverage.differingMemberShare > 0 && coverage.differingTeamShare > .5);
  assert.deepEqual(coverage.featureMatch, {distinctMovesets: 3, exact: 0, approximate: 3});
  assert.match(state.config.meta.movesets, /^Observed movesets/);
  // Everything the search simulates against an observed team uses the usage file's movesets (completed from the recommendation); the species, order and seeds are the plain run's.
  const rows = require('./meta.cjs').loadUsage(usagePath, species, {observedMoves: true}).rows, expected = new Map(rows.map(r => [r.team.map(p => p.speciesId).join(','), r.team.map((p, i) => (r.movesets[i] || p.moveset).join('/'))]));
  assert.ok(rows.some(r => r.movesets.some(Boolean)) && rows.some(r => !r.movesets.some(Boolean)));
  const seen = new Set();
  for (const call of calls.slice(0, -2)) for (const job of call.jobs) { const key = job.opponent.join(',');assert.ok(expected.has(key), 'only observed teams are drawn in an observed meta');seen.add(key);assert.deepEqual(job.opponentMoves, expected.get(key), key); }
  assert.equal(seen.size, 3);
  const fixtureList = list => [...new Set(list.map(o => [o.seed, o.opponent.map(id => O.parseTag(id).speciesId).join(',')].join('|')))].sort();assert.deepEqual(fixtureList(state.observations), fixtureList(reference.observations), 'the same opponent fixtures (species and seeds) as the plain run');
  // Stored observations name an observed member by its tag; the tag is the moveset the battle used, so no two fixtures collide.
  const tagged = state.observations.filter(o => o.opponent.some(id => id.includes('@')));
  assert.ok(tagged.length > 0 && tagged.some(o => o.opponent.some(id => !id.includes('@'))), 'observed members are tagged, members without an observation stay plain');
  for (const o of tagged) for (const id of o.opponent) { const {speciesId, moveset} = O.parseTag(id);if (moveset) assert.notEqual(moveset.join('/'), recommended.get(speciesId)); }
  assert.equal(new Set(state.observations.map(o => digest([o.team, [o.opponent[0], ...o.opponent.slice(1).sort()], o.seed]))).size, state.observations.length);
  // The sealed panels keep the fixture rows: observed members are flagged and carry their moveset and the recommended one.
  const flagged = Object.values(state.fixturePanels).flat().flatMap(c => c.team).filter(p => p.observedMoveset);
  assert.ok(flagged.length > 0);assert.ok(flagged.every(p => p.moveset.join('/') !== recommended.get(p.speciesId) && p.recommendedMoveset.join('/') === recommended.get(p.speciesId)));
  // opponent-analysis.json lists the movesets the primary actually faced.
  const analysis = read(out, 'opponent-analysis.json'), bySeed = new Map(calls.flatMap(c => c.jobs).map(j => [j.seed, j.opponentMoves]));
  for (const f of analysis.fixtures) assert.deepEqual(f.opponents.map(p => p.moveset.join('/')), bySeed.get(f.battleSeed));
  // The portable report gives each observed (species, moveset) its own opponent row, so the browser replays the moves the battle used.
  const report = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(out, 'report.pvpteams.json.gz'))));
  assert.equal(core.validate(report), report);
  const extras = report.table.opponents.slice(prepared.species.length);
  assert.ok(extras.length > 0 && extras.every(p => p.moveset.join('/') !== recommended.get(p.speciesId) && p.recommended.join('/') === recommended.get(p.speciesId)));
  assert.equal(report.table.opponents.slice(0, prepared.species.length).every((p, i) => p.speciesId === prepared.species[i].speciesId && p.moveset.join('/') === recommended.get(p.speciesId)), true, 'the pool\'s species rows are unchanged');
  let checked = 0;
  for (const row of report.table.rows) for (const stage of ['training', 'screen', 'test', 'baseline']) for (const [ids, seed] of report.table.matches[row.id][stage]) {
   const played = bySeed.get(seed);if (!played) continue;
   assert.deepEqual(ids.map(i => report.table.opponents[i].moveset.join('/')), played);checked++;
  }
  assert.ok(checked > 50, 'checked ' + checked + ' matches');
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(plain, 'report.pvpteams.json.gz')))).table.opponents.length, prepared.species.length, 'a plain report has no extra opponent rows');
  // Absorbing the run's sealed evaluations as evidence keeps the tags, so an observed fixture stays distinct from the plain fixture of the same species.
  const absorbed = require('./absorb-evaluation.cjs').absorb(state, prepared), absorbedTags = absorbed.observations.filter(o => o.opponent.some(id => id.includes('@')));
  assert.ok(absorbedTags.length > tagged.length);assert.equal(new Set(absorbed.observations.map(o => digest([teamKey(o.team), [o.opponent[0], ...o.opponent.slice(1).sort()], o.seed]))).size, absorbed.observations.length);
  for (const o of absorbedTags) for (const id of o.opponent) if (id.includes('@')) assert.ok(O.parseTag(id).moveset.length === 3);
  // The model audits encode tagged opponents like the search does.
  const auditRow = O.rowResolver(new Map(prepared.species.map(p => [p.speciesId, p])), prepared.variants), tag = tagged[0].opponent.find(id => id.includes('@'));
  assert.equal(auditRow(tag).moveset.join('/'), O.parseTag(tag).moveset.join('/'));
  // The alternate panel ran on the run's own meta (observed movesets in the reference arm), with the pool's alternates in the others.
  const panel = state.alternatePanel, seed = state.config.alternatePanelSeed;
  assert.equal(panel.fixtures, 3);assert.equal(panel.complete, true);assert.equal(state.config.alternatePanel, 3);
  const meta = createMeta(prepared.species, {mode: 'observed', usageFile: usagePath, observedMoves: true}), info = A.plan(prepared, meta, {fixtures: 3, seed, observed: true}), call = calls.at(-2);
  assert.equal(call.size, 2 * 3 * 3);assert.equal(calls.at(-1).size, 2 * 5 * 2, 'the sensitivity panel runs after it');
  call.jobs.forEach((job, index) => { const team = index % 2, position = Math.floor(index / 2), c = info.interleaved[position];
   assert.equal(job.seed, c.seed);assert.deepEqual(job.opponent, c.team.map(p => p.speciesId));assert.deepEqual(job.opponentMoves, movesOf(c.team));assert.deepEqual(job.team, state.validations[team].team.map(i => prepared.variants[i].speciesId)); });
  assert.ok(info.levels.every(l => l.changedMembers > 0));
  assert.ok(panel.levels.every((l, k) => l.changedMembers === info.levels[k].changedMembers));
  assert.match(panel.reference.label, /observed movesets where recorded/);
  // Sensitivity metas are built without the option, so their opponents play recommended movesets (documented limitation).
  for (const job of calls.at(-1).jobs) assert.deepEqual(job.opponentMoves, job.opponent.map(id => recommended.get(id)));
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('--alternate-panel runs after the final test and the other panels, changes nothing before it, and lands in the checkpoint, reports and viewer', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moves-search-')), poolPath = path.join(directory, 'source-pool.json'), {species, variants, prepared} = testPool(poolPath);
 try {
  const opts = {...base(poolPath), sensitivityFixtures: 2, confirmationOpponents: 4, policyPanel: 2};
  let mock = mockBattles();const without = path.join(directory, 'without');await search({...opts, out: without});dropListeners();const reference = read(without), referenceCalls = mock.log.calls.slice();mock.restore();
  for (const key of ['alternatePanel', 'alternateScores']) assert.equal(reference[key] ?? null, null, key);
  assert.equal('alternatePanel' in reference.config, false);assert.equal('alternatePanelSeed' in reference.config, false);assert.equal('observedMoves' in reference.config, false);
  assert.equal('alternatePanel' in read(without, 'recommendations.json'), false);
  assert.doesNotMatch(fs.readFileSync(path.join(without, 'report.html'), 'utf8'), /Alternate opponent movesets/);assert.doesNotMatch(fs.readFileSync(path.join(without, 'findings.md'), 'utf8'), /Alternate opponent movesets/);
  mock = mockBattles();const withPanel = path.join(directory, 'with');await search({...opts, out: withPanel, alternatePanel: 3});dropListeners();const state = read(withPanel), calls = mock.log.calls.slice();mock.restore();
  // Same training, screening, final test, confirmation and policy panel; one extra call, before the sensitivity panel.
  const stable = h => h.map(r => ({round: r.round, battles: r.battles, teams: r.teams, bestTraining: r.bestTraining, proposalScores: r.proposalScores, acquisition: r.acquisition}));assert.deepEqual(stable(state.history), stable(reference.history));
  for (const key of ['observations', 'records', 'screenResults', 'validations', 'baselineResults', 'finalistTeams', 'finalPanel', 'comparisons', 'finalistComparisons', 'fixturePanels', 'confirmation']) assert.deepEqual(state[key], reference[key], key);assert.deepEqual(state.policyPanel.teams.map(t => t.scores), reference.policyPanel.teams.map(t => t.scores));
  assert.equal(calls.length, referenceCalls.length + 1);
  const index = calls.length - 2;assert.deepEqual(calls.slice(0, index), referenceCalls.slice(0, index));
  assert.equal(calls[index].size, 2 * 3 * 3);assert.equal(calls.at(-1).size, referenceCalls.at(-1).size);assert.equal(state.battles, reference.battles + 18);
  // Seeds: derived, distinct from every sealed or derived seed, and passed to the sensitivity panel as reserved.
  const config = state.config, seed = config.alternatePanelSeed, others = [902, screeningSeed(902), confirmation.confirmationSeed(902), config.policyPanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed, ...state.sensitivity.metas.map(m => m.seed), state.confirmation?.seed].filter(Number.isInteger);
  assert.equal(config.alternatePanel, 3);assert.equal(seed, A.panelSeed(123, [screeningSeed(902), 902, confirmation.confirmationSeed(902), config.policyPanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed]));
  assert.ok(!others.includes(seed));
  assert.deepEqual(Object.fromEntries(state.sensitivity.metas.map(m => [m.id, m.seed])), S.sensitivitySeeds(902, state.sensitivity.metas.map(m => m.id), [config.retestPanelSeed, config.referenceFixtureSeed, config.beliefFixtureSeed, config.baselineFixtureSeed, seed, config.confirmationSeed].filter(Number.isInteger)));
  // The arms: fixture by fixture, the run's opponent, the best alternate, the second alternate, on the same species and seeds.
  const meta = createMeta(prepared.species, {mode: 'independent'}), info = A.plan(prepared, meta, {fixtures: 3, seed});
  calls[index].jobs.forEach((job, i) => { const team = i % 2, position = Math.floor(i / 2), c = info.interleaved[position];
   assert.equal(job.seed, c.seed);assert.deepEqual(job.opponent, c.team.map(p => p.speciesId));assert.deepEqual(job.opponentMoves, movesOf(c.team));assert.deepEqual(job.team, state.validations[team].team.map(k => variants[k].speciesId));
   if (position % 3 === 0) assert.deepEqual(job.opponentMoves, job.opponent.map(id => species.find(p => p.speciesId === id).moveset.join('/')), 'the reference arm is the recommended movesets'); });
  const alternates = A.alternates(prepared);
  calls[index].jobs.forEach((job, i) => { const arm = Math.floor(i / 2) % 3;if (!arm) return;
   job.opponent.forEach((id, member) => { assert.equal(job.opponentMoves[member], alternates.get(id)[arm - 1].join('/')); }); });
  const block = state.alternatePanel;
  assert.deepEqual([block.version, block.requestedFixtures, block.fixtures, block.complete, block.seed], [1, 3, 3, true, seed]);
  assert.deepEqual(block.teams.map(t => teamKey(t.team)), state.validations.map(v => teamKey(v.team)));assert.deepEqual(block.teams.map(t => t.primary), [true, false]);
  block.teams.forEach((t, i) => { assert.equal(t.finalScore, state.validations[i].score);assert.equal(t.deltas.length, 2);assert.ok(t.deltas.every(d => Number.isFinite(d.delta) && d.interval95[0] <= d.delta + 1e-12 && d.delta <= d.interval95[1] + 1e-12));
   const raw = state.alternateScores[teamKey(t.team)];assert.equal(raw.run.length, 3);assert.ok(Math.abs(raw['alternate-1'].reduce((a, b) => a + b, 0) / 3 - raw.run.reduce((a, b) => a + b, 0) / 3 - t.deltas[0].delta) < 1e-12);
   assert.equal(t.scores.run, raw.run.reduce((a, b) => a + b, 0) / 3); });
  assert.ok(block.levels.every(l => l.changedMembers > 0 && l.members === 9));
  // recommendations.json, report.html, findings.md and the portable report carry it.
  const recommendations = read(withPanel, 'recommendations.json');assert.deepEqual(recommendations.alternatePanel, block);
  const html = fs.readFileSync(path.join(withPanel, 'report.html'), 'utf8'), findings = fs.readFileSync(path.join(withPanel, 'findings.md'), 'utf8'), pool = JSON.parse(fs.readFileSync(path.join(withPanel, 'pool.json')));
  assert.match(html, /<h2>Alternate opponent movesets<\/h2>/);assert.match(html, /Second alternate moveset/);assert.match(html, /after the final test/);
  assert.match(findings, /Alternate opponent movesets \(3 common fixtures, after the final test\)/);
  const report = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(withPanel, 'report.pvpteams.json.gz'))));
  assert.deepEqual(report.alternatePanel, block);assert.equal(core.validate(report), report);
  assert.equal(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(without, 'report.pvpteams.json.gz')))).alternatePanel, undefined);
  // The viewer's caption line is the text the report carries.
  const names = team => team.map(i => report.table.variants[i].speciesName).join(' / ');
  assert.equal(ctx.NeuralPortable.alternatePanelCaption(report, names), A.caption(block, names));
  assert.equal(ctx.NeuralPortable.alternatePanelCaption({}, names), '');
  assert.equal(A.html(state, pool, {escape: s => s, pct: x => x}).includes(A.caption(block, team => team.map(i => pool.variants[i].speciesName).join(' · '))), true);
  // A tampered report is refused.
  const broken = JSON.parse(JSON.stringify(report));broken.alternatePanel.teams[0].deltas[0].verdict = 'better';assert.throws(() => core.validate(broken), /invalid alternate panel teams/);
  const unknown = JSON.parse(JSON.stringify(report));unknown.alternatePanel.teams[0].team[0] = 99999;assert.throws(() => core.validate(unknown), /invalid alternate panel teams/);
  const noFixtures = JSON.parse(JSON.stringify(report));noFixtures.alternatePanel.fixtures = 0;assert.throws(() => core.validate(noFixtures), /invalid alternate panel/);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('a deadline leaves whole fixtures on every arm; stopped before one finishes, nothing is recorded', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moves-search-')), poolPath = path.join(directory, 'source-pool.json');testPool(poolPath);
 try {
  const opts = {...base(poolPath), alternatePanel: 3};
  let mock = mockBattles({interrupt: {jobs: 2 * 3 * 3, after: 13}});const cut = path.join(directory, 'cut');await search({...opts, out: cut});dropListeners();const partial = read(cut);mock.restore();
  // 13 of 18 jobs finished: 6 whole positions (2 teams each), so 2 whole fixtures of 3 arms.
  assert.deepEqual([partial.alternatePanel.fixtures, partial.alternatePanel.requestedFixtures, partial.alternatePanel.complete], [2, 3, false]);
  assert.equal(partial.alternateScores[teamKey(partial.validations[0].team)].run.length, 2);
  assert.match(read(cut, 'recommendations.json').alternatePanel.method, /replayed 2 sealed fixtures/);
  mock = mockBattles({interrupt: {jobs: 2 * 3 * 3, after: 5}});const none = path.join(directory, 'none');await search({...opts, out: none});dropListeners();mock.restore();
  assert.equal(read(none).alternatePanel, null);assert.equal('alternatePanel' in read(none, 'recommendations.json'), false);
  assert.doesNotMatch(fs.readFileSync(path.join(none, 'report.html'), 'utf8'), /Alternate opponent movesets/);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('invalid options and reused seeds are refused before any battle', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moves-search-')), poolPath = path.join(directory, 'source-pool.json'), {species} = testPool(poolPath);
 try {
  const opts = base(poolPath);
  for (const [name, extra, pattern] of [['n1', {alternatePanel: -1}, /alternate-panel/], ['n2', {alternatePanel: 2.5}, /alternate-panel/], ['n3', {alternatePanel: 5000}, /alternate-panel/], ['n4', {observedMoves: true}, /Observed movesets require --usage-file/]]) await assert.rejects(search({...opts, ...extra, out: path.join(directory, name)}), pattern);
  dropListeners();
  // A first run tells us the panel's seed; a warm start whose evidence used it is refused.
  let mock = mockBattles();const first = path.join(directory, 'first');await search({...opts, out: first, alternatePanel: 3});dropListeners();const config = read(first).config;mock.restore();
  const old = {config: {version: VERSION, mechanicsHash: require('./common.cjs').mechanicsHash({version: 'v4'}), meta: createMeta(species, {mode: 'independent'}).description, poolHash: JSON.parse(fs.readFileSync(poolPath)).hash, seed: 123}, observations: [{team: [0, 1, 2], opponent: [], score: 1, seed: 1, round: 0}], records: [], battles: 1, round: 1, evaluationEvidence: {fixtureSeeds: [config.alternatePanelSeed]}};
  const warm = path.join(directory, 'old-checkpoint.json');fs.writeFileSync(warm, JSON.stringify(old));
  mock = mockBattles();
  try { await assert.rejects(search({...opts, out: path.join(directory, 'warm'), alternatePanel: 3, warmStart: warm}), /absorbed evidence/); } finally { mock.restore();dropListeners(); }
  assert.equal(mock.log.calls.length, 0);
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

test('an interrupted run with observed moves and the alternate panel resumes to exactly the uninterrupted result', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-moves-search-')), poolPath = path.join(directory, 'source-pool.json'), usagePath = path.join(directory, 'usage.json'), {species} = testPool(poolPath);writeUsage(usagePath, species);
 try {
  const opts = {...base(poolPath), meta: 'observed', usageFile: usagePath, observedMoves: true, alternatePanel: 3, rounds: 2};
  let mock = mockBattles();const whole = path.join(directory, 'whole');await search({...opts, out: whole});dropListeners();const reference = read(whole), total = mock.log.played;mock.restore();
  const stable = state => ({observations: state.observations, records: state.records, round: state.round, validations: state.validations, screenResults: state.screenResults, alternatePanel: state.alternatePanel, alternateScores: state.alternateScores, history: state.history.map(h => ({round: h.round, bestTraining: h.bestTraining, acquisition: h.acquisition}))});
  assert.ok(reference.observations.some(o => o.opponent.some(id => id.includes('@'))));assert.ok(reference.alternatePanel.complete);
  // One stop inside the training rounds, one inside the alternate panel (the last 18 battles).
  for (const stopAt of [9, 40, total - 6]) {
   const out = path.join(directory, 'stop' + stopAt);mock = mockBattles({throwAt: stopAt});
   await assert.rejects(search({...opts, out}), /Injected interruption/);dropListeners();mock.restore();
   const resumed = mockBattles();await search({...opts, out, resume: true});dropListeners();resumed.restore();
   assert.deepEqual(stable(read(out)), stable(reference), 'stop at ' + stopAt);
  }
 } finally { fs.rmSync(directory, {recursive: true, force: true}); }
});

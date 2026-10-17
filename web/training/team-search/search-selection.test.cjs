'use strict';
// The real search loop with the selection protocol: --min-lead-fixtures, --confirmation-opponents and
// --validation-opponents-max. Battles are replaced by a deterministic hash of (team, opponent, seed), optionally overridden
// per team and per phase (screening, final, extension, confirmation) so that a challenger-better case can be forced rather
// than hoped for. Training and screening outcomes are never overridden, so a second pass picks the same finalists.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const { BattlePool } = require('../pool.cjs'), { search } = require('./search.cjs'), { createMeta } = require('./meta.cjs');
const { VERSION, dataHash, digest, teamKey, screeningSeed } = require('./common.cjs'), { opponentFixtureKey } = require('./acquisition.cjs');
const C = require('./confirmation.cjs'), core = require('../../includes/pro/neural-report-core.js'), { orderRecords, leadPool } = require('./selection.cjs'), { auditSelection } = require('./audit-selection.cjs');

function testPool(poolPath) {
 const gm = require('../../includes/pro/data/gamemaster.json'), published = require('../../includes/pro/data/league-1500.json').overall, used = new Set(), species = [];
 for (const row of published) {
  const p = gm.pokemon.find(p => p.speciesId === row.speciesId);
  if (!p || used.has(p.dex)) continue; used.add(p.dex);
  species.push({ speciesId: p.speciesId, speciesName: p.speciesName, dex: p.dex, types: p.types, moveset: row.moveset, weight: 1, features: [.5], scoutByType: Array(18).fill(.5), scoutScore: .5, ivs: { atk: 0, def: 15, hp: 15 }, cp: 1500, level: 30 });
  if (species.length === 8) break;
 }
 const prepared = { config: { version: VERSION, cp: 1500, inputHash: dataHash(), movesets: 1 }, species, variants: species }; prepared.hash = digest(prepared); fs.writeFileSync(poolPath, JSON.stringify(prepared));
 return prepared;
}
const REAL_MAP = BattlePool.prototype.map, identityOf = (team, opponent, seed) => digest([team.map(p => p.speciesId), opponent.map(p => p.speciesId), seed]);
const listeners = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, process.listeners(signal)]));
const dropListeners = () => { for (const signal of ['SIGINT', 'SIGTERM']) for (const listener of process.listeners(signal)) if (!listeners[signal].includes(listener)) process.removeListener(signal, listener); };
const read = (out, name = 'checkpoint.json') => JSON.parse(fs.readFileSync(path.join(out, name)));
const lineup = (pool, ...i) => i.map(k => ({ speciesId: pool.species[k].speciesId, speciesName: pool.species[k].speciesName, moveset: pool.species[k].moveset }));

const options = poolPath => ({ pool: poolPath, hours: 1, workers: 1, initialTeams: 16, batchTeams: 4, opponents: 6, acquisitionFixtures: 2, promotionFraction: .5, screenTeams: 4, screenOpponents: 6, validationTeams: 3, validationOpponents: 8, baselineCount: 3, candidates: 16, epochs: 1, hidden: 4, ensemble: 1, referenceOpponents: 2, fitFixtures: 32, seed: 123, validationSeed: 902, rounds: 2, meta: 'independent', lookaheadTurns: 4, decisionInterval: 4, beliefSamples: 1, confirmationOpponents: 8 });

// Which sealed phase a fixture's battle seed belongs to: screening, final (base panel), extension (final fixtures past the base) or confirmation.
function phaseMap(pool, opts, extensionMax = 0) {
 const meta = createMeta(pool.species, { mode: 'independent', weightPower: 1.25, halfLifeDays: 0, asOf: '', priorStrength: 500 }), map = new Map();
 const add = (phase, rows, from = 0) => rows.forEach((c, i) => map.set(c.seed, i < from ? map.get(c.seed) : phase));
 add('screening', meta.fixtures(opts.screenOpponents, screeningSeed(opts.validationSeed)));
 add('final', meta.fixtures(opts.validationOpponents, opts.validationSeed));
 if (extensionMax > opts.validationOpponents) add('extension', meta.fixtures(extensionMax, opts.validationSeed), opts.validationOpponents);
 add('confirmation', meta.fixtures(opts.confirmationOpponents, C.confirmationSeed(opts.validationSeed)));
 return { phaseOf: seed => map.get(seed) || null, meta };
}

function mockBattles(pool, { interruptAt = Infinity, phaseOf = () => null, override = null } = {}) {
 const log = { played: [], phases: [] }, indexOf = new Map(pool.species.map((s, i) => [s.speciesId, i]));
 BattlePool.prototype.map = async function (jobs, options = {}) {
  if (jobs.length && !Array.isArray(jobs[0][0])) return REAL_MAP.call(this, jobs, options);
  const { onResult = () => {} } = options, results = [];
  for (let i = 0; i < jobs.length; i++) {
   const [team, opponent, , , settings] = jobs[i], id = identityOf(team, opponent, settings.seed), phase = phaseOf(settings.seed);
   log.played.push(id);log.phases.push(phase);
   const forced = override ? override(teamKey(team.map(p => indexOf.get(p.speciesId))), phase) : undefined;
   const result = { score: forced ?? parseInt(id.slice(0, 2), 16) % 3 / 2 };results.push(result);onResult(result, i);
   if (log.played.length === interruptAt) throw Error('Injected interruption');
  }
  return results;
 };
 return { log, restore: () => { BattlePool.prototype.map = REAL_MAP; } };
}

// Pass 1 learns the finalists (and the base-phase facts); the forced passes then override only sealed final-test phases.
async function discover(directory, pool, opts, extra = {}) {
 const out = path.join(directory, 'discover-' + Math.random().toString(36).slice(2)), { phaseOf } = phaseMap(pool, opts, extra.extensionMax), mock = mockBattles(pool, { phaseOf });
 try { await search({ ...opts, ...extra.options, out }); } finally { mock.restore();dropListeners(); }
 return { out, state: read(out), log: mock.log };
}

test('the default run records the new settings, needs no confirmation without a resolved challenger, and the off switch restores the old run', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-selection-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = options(poolPath);
 try {
  // Everything ties on the sealed final panel, so no finalist is clearly above the primary.
  const tie = () => (key, phase) => phase === 'final' ? .5 : undefined;
  const run = await forced(directory, pool, opts, tie), { state } = run;
  const confirmSeed = C.confirmationSeed(opts.validationSeed);
  assert.equal(state.config.confirmationOpponents, 8);assert.equal(state.config.confirmationSeed, confirmSeed);
  assert.ok(!('minLeadFixtures' in state.config) && !('validationOpponentsMax' in state.config), 'the off-by-default options leave the config as it was');
  assert.ok(![opts.validationSeed, screeningSeed(opts.validationSeed)].includes(confirmSeed));
  assert.equal(state.confirmation, undefined);assert.equal(state.selection, undefined);assert.equal(state.finalPanel.extension, undefined);
  assert.equal(state.validations.length, 3);assert.ok(state.finalistComparisons.comparisons.every(c => c.distinguishable === 'unresolved'));
  const recommendations = read(run.out, 'recommendations.json');assert.equal(recommendations.confirmation, null);assert.ok(!('selection' in recommendations));
  const report = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(run.out, 'report.pvpteams.json.gz'))));core.validate(report);assert.equal(report.confirmation, null);assert.equal(report.search.confirmationOpponents, 8);assert.ok(!('minLeadFixtures' in report.search));
  const html = fs.readFileSync(path.join(run.out, 'report.html'), 'utf8');assert.match(html, /Sealed confirmation test \(8 fixtures\) was enabled and not needed/);assert.doesNotMatch(html, /<h2>Sealed confirmation test<\/h2>/);
  assert.match(fs.readFileSync(path.join(run.out, 'findings.md'), 'utf8'), /was enabled and not needed/);
  // The seed is not used by any training stream.
  assert.ok(!state.observations.some(o => o.seed === confirmSeed));assert.equal(run.log?.phases?.includes('confirmation') ?? false, false);
  // Disabled: no seed in the config, the search seeds are exactly what they were, and the run is otherwise the same run.
  const off = await forced(directory, pool, opts, tie, { options: { confirmationOpponents: 0 } });
  assert.ok(!('confirmationOpponents' in off.state.config) && !('confirmationSeed' in off.state.config));
  assert.deepEqual(off.state.records, state.records);assert.deepEqual(off.state.validations, state.validations);assert.equal(off.state.battles, state.battles);assert.equal(off.state.confirmation, undefined);
  assert.doesNotMatch(fs.readFileSync(path.join(off.out, 'report.html'), 'utf8'), /Sealed confirmation test/);
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('invalid selection settings are rejected before any battle', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-selection-options-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = options(poolPath);
 try {
  for (const [changes, message] of [[{ minLeadFixtures: -1 }, /min-lead-fixtures/], [{ minLeadFixtures: 2.5 }, /min-lead-fixtures/], [{ confirmationOpponents: -1 }, /confirmation-opponents/], [{ confirmationOpponents: 1.5 }, /confirmation-opponents/],
   [{ validationOpponentsMax: 4 }, /validation-opponents-max/], [{ validationOpponentsMax: 9.5 }, /validation-opponents-max/]]) {
   await assert.rejects(search({ ...opts, ...changes, out: path.join(directory, 'bad-' + Math.random().toString(36).slice(2)) }), message, JSON.stringify(changes));dropListeners();
  }
  assert.ok(pool);
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a minimum number of fixtures keeps thin teams from leading and from being screened', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-minlead-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = { ...options(poolPath), rounds: 3 }, N = 8;
 try {
  const plain = await discover(directory, pool, opts), ruled = await discover(directory, pool, opts, { options: { minLeadFixtures: N } });
  assert.equal(ruled.state.config.minLeadFixtures, N);assert.ok(!('minLeadFixtures' in plain.state.config));
  const fixturesOf = state => new Map(state.records.map(r => [teamKey(r.team), r.fixtures])), screened = state => state.screenResults.map(s => teamKey(s.team));
  // Canary: without the rule the screening set does contain teams below N, so the rule has something to do.
  const plainAudit = auditSelection(plain.state, { minLead: N, samples: 200 });
  assert.equal(plainAudit.selection.recomputedScreeningSetMatchesRun, true, 'the default ranking is the cautious selection score alone');
  assert.ok(plainAudit.selection.screened.belowThreshold > 0 && plainAudit.selection.screeningSetChangedByRule, 'thin teams were screened without the rule');
  // With the rule: the screened teams are the head of the ruled ranking, and none is below N unless no team reached N.
  const rows = state => state.records.map(r => { const n = r.fixtures, mean = (r.reward / r.games * n + 4) / (n + 8); return { ...r, score: r.reward / r.games, selectionScore: mean - 1.28 * Math.sqrt(mean * (1 - mean) / (n + 9)) }; });
  const head = leadPool(orderRecords(rows(ruled.state), N), N).slice(0, 4).map(r => teamKey(r.team));
  assert.deepEqual(screened(ruled.state), head);
  const info = ruled.state.selection, counts = fixturesOf(ruled.state);
  assert.equal(info.minLeadFixtures, N);assert.equal(info.teams, ruled.state.records.length);assert.equal(info.teamsAtOrAboveThreshold + info.teamsBelowThreshold, info.teams);
  assert.equal(info.teamsAtOrAboveThreshold, [...counts.values()].filter(n => n >= N).length);
  if (info.fallback) assert.equal(info.teamsAtOrAboveThreshold, 0);
  else { assert.ok(info.teamsAtOrAboveThreshold >= 1);assert.equal(info.screeningCandidatesBelowThreshold, 0);assert.ok(screened(ruled.state).every(k => counts.get(k) >= N), 'no screened team is below the threshold');assert.equal(info.screeningCandidates, Math.min(4, info.teamsAtOrAboveThreshold)); }
  // The training leader after every round is the leader of the ranking with the rule (history.bestTraining), and of the plain ranking without it.
  const history = state => state.history.map(h => h.bestTraining);
  assert.deepEqual(history(plain.state), plainAudit.trajectory.scores.plain, 'plain run: the leader is the top of the cautious-score ranking');
  assert.deepEqual(history(ruled.state), auditSelection(ruled.state, { minLead: N, samples: 200 }).trajectory.scores.ruled, 'ruled run: the leader is the top of the ranking with the rule');
  // A threshold no team reaches falls back to the ranking as before (a run too short for the rule still completes, identically).
  const unreachable = await discover(directory, pool, opts, { options: { minLeadFixtures: 1000 } });
  assert.equal(unreachable.state.selection.fallback, true);assert.deepEqual(screened(unreachable.state), screened(plain.state));assert.deepEqual(unreachable.state.records, plain.state.records);assert.deepEqual(history(unreachable.state), history(plain.state));
  // The rule is part of the reports and the exports.
  const recommendations = read(ruled.out, 'recommendations.json');assert.deepEqual(recommendations.selection, ruled.state.selection);
  assert.match(fs.readFileSync(path.join(ruled.out, 'report.html'), 'utf8'), /Minimum evidence before leading: a team needed at least 8 fixtures/);
  const portable = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ruled.out, 'report.pvpteams.json.gz'))));core.validate(portable);assert.equal(portable.search.minLeadFixtures, N);assert.deepEqual(portable.search.selection, ruled.state.selection);
  // recommendations.json lists screened/finalist teams first and then the training ranking, in which thin teams come last.
  const listed = recommendations.rows.filter(r => !r.validation && !r.screen).map(r => counts.get(teamKey(r.variantIndices)));
  const firstThin = listed.findIndex(n => n < N);assert.ok(firstThin === -1 || listed.slice(firstThin).every(n => n < N), 'thin teams only after every team with enough fixtures');
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

// The forced scenarios share one discovery pass.
async function forced(directory, pool, opts, scenario, extra = {}) {
 const first = await discover(directory, pool, opts, extra), finalists = first.state.finalistTeams.map(t => teamKey(t)), species = first.state.finalistTeams.map(t => t.map(i => pool.species[i].speciesId));
 assert.equal(finalists.length, 3);
 const out = path.join(directory, 'forced-' + Math.random().toString(36).slice(2)), { phaseOf } = phaseMap(pool, opts, extra.extensionMax), override = scenario(finalists, first.state);
 const mock = mockBattles(pool, { phaseOf, override, interruptAt: extra.interruptAt });
 try { await search({ ...opts, ...extra.options, out }); } finally { mock.restore();dropListeners(); }
 return { first, out, state: read(out), log: mock.log, finalists, species, override, phaseOf };
}
test('a challenger that beats the primary on the final panel is confirmed on a sealed panel; the primary stays the primary', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-confirm-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = { ...options(poolPath), retestPanel: 3 };
 try {
  const run = await forced(directory, pool, opts, ([primary, challenger]) => (key, phase) => {
   if (!['final', 'confirmation'].includes(phase)) return undefined;
   return key === primary ? 0 : key === challenger ? 1 : phase === 'final' ? 0 : undefined;
  });
  const { state, finalists } = run, c = state.confirmation, [primary, challenger] = finalists;
  assert.deepEqual(state.finalistTeams.map(teamKey), finalists, 'forcing only sealed final phases leaves the finalists as discovered');
  assert.equal(teamKey(state.validations[0].team), primary);
  assert.equal(state.finalistComparisons.comparisons.find(x => teamKey(x.team) === challenger).distinguishable, 'challenger-better');
  // The record: a fresh seed, a sealed panel of the planned size, the primary and exactly the resolved challenger(s).
  const confirmSeed = C.confirmationSeed(opts.validationSeed);
  assert.equal(c.seed, confirmSeed);assert.equal(state.config.confirmationSeed, confirmSeed);assert.equal(c.requestedFixtures, 8);assert.equal(c.completedFixtures, 8);assert.equal(c.complete, true);
  assert.deepEqual(c.teams.map(t => [t.role, teamKey(t.team)]).slice(0, 2), [['primary', primary], ['challenger', challenger]]);
  assert.equal(c.outcome, 'challenger-confirmed');assert.equal(c.comparisons.find(x => teamKey(x.team) === challenger).verdict, 'challenger-better');assert.equal(c.triggers[0].stage, 'final-panel');
  assert.equal(c.teams[0].score, 0);assert.equal(c.teams[1].score, 1);assert.deepEqual(c.scores[primary], Array(8).fill(0));
  // Distinct from every other stream: screening, final, retest panel, training, and nothing in the evidence uses it.
  const others = [opts.validationSeed, screeningSeed(opts.validationSeed), state.config.retestPanelSeed >>> 0, state.config.referenceFixtureSeed, state.config.beliefFixtureSeed, state.config.baselineFixtureSeed];
  assert.ok(!others.includes(confirmSeed));
  const panel = state.fixturePanels[confirmSeed];assert.equal(panel.length, 8);
  const sealedKeys = new Set(panel.map(f => opponentFixtureKey(f.team, f.seed)));assert.ok(state.observations.every(o => !sealedKeys.has(opponentFixtureKey(o.opponent, o.seed))), 'never used for training');
  assert.ok(![...state.observations].some(o => panel.some(f => f.seed === o.seed && opponentFixtureKey(f.team, f.seed) === opponentFixtureKey(o.opponent, o.seed))));
  for (const other of [screeningSeed(opts.validationSeed), opts.validationSeed]) { const keys = state.fixturePanels[other].map(f => opponentFixtureKey(f.team, f.seed));assert.ok(keys.every(k => !sealedKeys.has(k))); }
  // The confirmation battles are counted but are not labelled fixtures: the confirmed team has no training record from them.
  const confirmationBattles = run.log.phases.filter(p => p === 'confirmation').length;assert.equal(confirmationBattles, 16, 'two teams on eight sealed fixtures');
  assert.ok(state.battles >= confirmationBattles);
  // recommendations.json, report.html, findings.md and the portable report all carry it.
  const recommendations = read(run.out, 'recommendations.json');assert.equal(recommendations.confirmation.outcome, 'challenger-confirmed');assert.ok(!('scores' in recommendations.confirmation));assert.equal(recommendations.confirmation.comparisons.length, 1);
  const html = fs.readFileSync(path.join(run.out, 'report.html'), 'utf8'), md = fs.readFileSync(path.join(run.out, 'findings.md'), 'utf8');
  assert.match(html, /<h2>Sealed confirmation test<\/h2>/);assert.match(html, /challenger better: confirmed/);assert.match(html, /8 of 8 sealed fixtures, seed /);assert.match(md, /Sealed confirmation test: 1 of 1 challenger scored clearly above/);
  const portable = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(run.out, 'report.pvpteams.json.gz'))));core.validate(portable);
  assert.equal(portable.confirmation.outcome, 'challenger-confirmed');assert.equal(portable.confirmation.seed, confirmSeed);assert.ok(!('scores' in portable.confirmation));
  const corrupted = JSON.parse(JSON.stringify(portable));corrupted.confirmation.comparisons[0].verdict = 'maybe';assert.throws(() => core.validate(corrupted), /invalid confirmation/);
  // The viewer shows it.
  const ctx = require('node:vm').createContext({});require('node:vm').runInContext(fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8'), ctx);
  const view = ctx.NeuralPortable.confirmationView(portable, t => t.join('/'));assert.equal(view.outcome, 'challenger-confirmed');assert.equal(view.rows.length, c.teams.length);assert.equal(view.rows[0][1], 'primary');assert.match(view.rows[1][6], /confirmed/);
  // Absorbing the finished run makes its confirmation seed a used seed for any later run.
  const { absorb } = require('./absorb-evaluation.cjs'), absorbed = absorb(state, pool);
  assert.ok(absorbed.evaluationEvidence.fixtureSeeds.includes(confirmSeed) && absorbed.evaluationEvidence.fixtureSeeds.includes(opts.validationSeed));
  // ...and a new run whose own confirmation seed collides with absorbed evidence is refused before any battle.
  const collision = { ...state, evaluationEvidence: { fixtureSeeds: [C.confirmationSeed(7001)], requiresFreshValidationSeed: true } }, warm = path.join(directory, 'warm.json');fs.writeFileSync(warm, JSON.stringify(collision));
  await assert.rejects(search({ ...opts, validationSeed: 7001, out: path.join(directory, 'collide'), warmStart: warm }), /Confirmation seed was used by absorbed evaluation evidence/);dropListeners();
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a challenger that does not reappear on the sealed panel is reported as not confirmed, and the primary stands', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-notconfirm-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = options(poolPath);
 try {
  const run = await forced(directory, pool, opts, ([primary, challenger]) => (key, phase) => {
   if (phase === 'final') return key === primary ? 0 : key === challenger ? 1 : 0;
   if (phase === 'confirmation') return key === primary ? 1 : key === challenger ? 0 : undefined;
   return undefined;
  });
  const c = run.state.confirmation;
  assert.equal(c.outcome, 'not-confirmed');assert.equal(c.comparisons[0].verdict, 'primary-better');assert.match(c.summary, /was not confirmed/);
  assert.equal(teamKey(run.state.validations[0].team), run.finalists[0], 'the screening-selected primary is still the primary');
  assert.match(fs.readFileSync(path.join(run.out, 'report.html'), 'utf8'), /1 with the primary clearly ahead/);
  const portable = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(run.out, 'report.pvpteams.json.gz'))));core.validate(portable);assert.equal(portable.confirmation.outcome, 'not-confirmed');
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a previous champion that beats the primary on the final panel triggers the confirmation too; unresolved differences do not', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-champion-confirm-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = options(poolPath);
 try {
  const first = await discover(directory, pool, opts), finalistKeys = new Set(first.state.finalistTeams.map(teamKey));
  // A champion composition that is not a finalist.
  const champion = [0, 1, 2, 3, 4, 5, 6, 7].map(i => [i, (i + 1) % 8, (i + 2) % 8]).find(t => !finalistKeys.has(teamKey(t))), file = path.join(directory, 'champions.json');
  fs.writeFileSync(file, JSON.stringify({ rows: [{ team: lineup(pool, ...champion), validation: { score: .8 } }] }));
  const championKey = teamKey(champion);
  // Unresolved first: everyone ties on the final panel, so there is nothing to confirm.
  const tied = await forced(directory, pool, { ...opts, champions: file }, () => (key, phase) => phase === 'final' ? .5 : undefined);
  assert.equal(tied.state.confirmation, undefined);
  assert.ok(tied.state.championComparisons.entries.every(e => e.verdict !== 'challenger-better'));
  assert.equal(tied.log.phases.filter(p => p === 'confirmation').length, 0, 'no confirmation battle was played');
  // The champion clearly above the primary.
  const run = await forced(directory, pool, { ...opts, champions: file }, ([primary]) => (key, phase) => {
   if (phase === 'final') return key === championKey ? 1 : 0;
   if (phase === 'confirmation') return key === championKey ? 1 : key === primary ? 0 : undefined;
   return undefined;
  });
  const entry = run.state.championComparisons.entries.find(e => teamKey(e.team) === championKey);
  assert.equal(entry.verdict, 'challenger-better');
  const c = run.state.confirmation;
  assert.ok(c, 'a champion above the primary needs confirming');assert.equal(c.outcome, 'challenger-confirmed');
  const row = c.comparisons.find(x => teamKey(x.team) === championKey);assert.equal(row.kind, 'previous-champion');assert.equal(row.confirmed, true);
  assert.ok(c.teams.some(t => teamKey(t.team) === championKey && t.role === 'challenger' && t.sources.includes('previous-champion')));
  const html = fs.readFileSync(path.join(run.out, 'report.html'), 'utf8');assert.match(html, /previous champion challenger/);
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a run interrupted while the sealed panel is being played resumes to the uninterrupted result, with the panel never used for training', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-confirm-resume-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = options(poolPath);
 const scenario = ([primary, challenger]) => (key, phase) => (['final', 'confirmation'].includes(phase) ? (key === challenger ? 1 : 0) : undefined);
 try {
  const whole = await forced(directory, pool, opts, scenario), reference = whole.log.played.slice(), firstConfirmation = whole.log.phases.indexOf('confirmation');
  assert.ok(firstConfirmation > 0);assert.equal(whole.state.confirmation.outcome, 'challenger-confirmed');
  const stable = state => ({ observations: state.observations, records: state.records, round: state.round, history: state.history.map(h => [h.round, h.battles, h.teams, h.bestTraining]), screenResults: state.screenResults, validations: state.validations, baselineResults: state.baselineResults, finalPanel: state.finalPanel, comparisons: state.comparisons, finalistComparisons: state.finalistComparisons, confirmation: state.confirmation, fixturePanels: state.fixturePanels });
  for (const offset of [1, 5, 12]) {
   const out = path.join(directory, 'stop' + offset), { phaseOf } = phaseMap(pool, opts), override = scenario(whole.finalists);
   let mock = mockBattles(pool, { phaseOf, override, interruptAt: firstConfirmation + offset + 1 });
   await assert.rejects(search({ ...opts, out }), /Injected interruption/);dropListeners();mock.restore();
   const partial = read(out);
   assert.equal(partial.confirmation, undefined, 'a confirmation interrupted before it finished leaves no half-written record');
   assert.equal(partial.validations.length, 3, 'the final test itself was complete and saved');
   assert.ok(partial.fixturePanels[C.confirmationSeed(opts.validationSeed)], 'the sealed panel was drawn from the same seed');
   mock = mockBattles(pool, { phaseOf, override });
   await search({ ...opts, out, resume: true });dropListeners();mock.restore();
   const resumed = read(out);
   assert.deepEqual(stable(resumed), stable(whole.state), 'stop at confirmation battle ' + offset);
   assert.equal(resumed.config.confirmationSeed, whole.state.config.confirmationSeed);
   // Training evidence is untouched by the interrupted and the resumed confirmation battles.
   const sealed = new Set(resumed.fixturePanels[resumed.config.confirmationSeed].map(f => opponentFixtureKey(f.team, f.seed)));
   assert.ok(resumed.observations.every(o => !sealed.has(opponentFixtureKey(o.opponent, o.seed))));
   assert.equal(mock.log.phases.filter(p => p === 'confirmation').length, 16, 'the resumed run plays the whole panel once');
  }
  assert.ok(reference.length > firstConfirmation);
  // Resuming the FINISHED run replays the final stage from the saved training state: the old record is dropped, the panel is played again
  // (nothing is skipped because a record was already there) and the result is identical.
  const finished = path.join(directory, 'finished');fs.cpSync(whole.out, finished, { recursive: true });
  const { phaseOf } = phaseMap(pool, opts), again = mockBattles(pool, { phaseOf, override: scenario(whole.finalists) });
  await search({ ...opts, out: finished, resume: true });dropListeners();again.restore();
  assert.deepEqual(stable(read(finished)), stable(whole.state));assert.equal(again.log.phases.filter(p => p === 'confirmation').length, 16, 'the sealed panel was played again');
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a longer final panel extends every team on the same fixtures when time allows, and the base panel is the common prefix', async () => {
 const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-extend-')), poolPath = path.join(directory, 'source-pool.json'), pool = testPool(poolPath), opts = { ...options(poolPath), validationOpponents: 4, confirmationOpponents: 4 };
 try {
  const plain = await discover(directory, pool, opts), extra = { extensionMax: 4 + 64, options: { validationOpponentsMax: 68 } };
  const longer = await discover(directory, pool, opts, extra);
  assert.equal(longer.state.config.validationOpponentsMax, 68);assert.equal(plain.state.config.validationOpponentsMax, undefined);
  const base = plain.state.validations, grown = longer.state.validations;
  assert.deepEqual(grown.map(v => teamKey(v.team)), base.map(v => teamKey(v.team)), 'the same finalists');
  grown.forEach((v, i) => { assert.equal(v.pairs.length, 68);assert.deepEqual(v.pairs.slice(0, 4), base[i].pairs, 'the base panel is the common prefix');assert.equal(v.fixtureSeed, opts.validationSeed);assert.equal(v.games, 68); });
  longer.state.baselineResults.forEach((b, i) => { assert.equal(b.pairs.length, 68);assert.deepEqual(b.pairs.slice(0, 4), plain.state.baselineResults[i].pairs); });
  const panel = longer.state.finalPanel;
  assert.equal(panel.requestedFixtures, 4);assert.equal(panel.completedFixtures, 68);assert.equal(panel.complete, true);
  assert.deepEqual({ ...panel.extension, steps: undefined }, { baseFixtures: 4, requestedMax: 68, step: 64, completedFixtures: 68, steps: undefined, stoppedBecause: 'target-reached' });
  assert.equal(panel.extension.steps.length, 1);assert.equal(panel.extension.steps[0].added, 64);assert.equal(panel.extension.steps[0].battles, 64 * panel.teams);
  assert.equal(longer.state.finalistComparisons.fixtures, 68);assert.equal(plain.state.finalistComparisons.fixtures, 4);
  assert.equal(longer.state.battles, plain.state.battles + 64 * panel.teams + (longer.state.confirmation ? 4 * longer.state.confirmation.teams.length : 0) - (plain.state.confirmation ? 4 * plain.state.confirmation.teams.length : 0), 'the extension adds one battle per team and new fixture');
  // The saved sealed fixtures cover the extension, and the exports use them.
  assert.equal(longer.state.fixturePanels[opts.validationSeed].length, 68);
  const recommendations = read(longer.out, 'recommendations.json');assert.equal(recommendations.finalPanel.completedFixtures, 68);assert.equal(recommendations.finalPanel.extension.requestedMax, 68);
  const portable = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(longer.out, 'report.pvpteams.json.gz'))));core.validate(portable);
  assert.equal(portable.finalPanel.completedFixtures, 68);assert.equal(portable.finalPanel.extension.completedFixtures, 68);assert.equal(portable.search.validationOpponentsMax, 68);
  const primaryRow = portable.table.rows.find(r => r.primary);assert.equal(primaryRow.matchCounts.test, 68);
  assert.match(fs.readFileSync(path.join(longer.out, 'report.html'), 'utf8'), /Final panel: 68 of 68 common fixtures \(base 4, extended in steps of 64/);
  // Absorbing the finished run reconstructs the longer panel from the saved fixtures.
  const { absorb } = require('./absorb-evaluation.cjs'), absorbed = absorb(longer.state, pool);assert.ok(absorbed.observations.length >= 68 * 3);
 } finally { BattlePool.prototype.map = REAL_MAP;dropListeners();fs.rmSync(directory, { recursive: true, force: true }); }
});

test('the launcher accepts the three new flags', () => {
 const launch = fs.readFileSync(path.join(__dirname, 'launch.cjs'), 'utf8');
 for (const flag of ['validationOpponentsMax:0', 'confirmationOpponents:256', 'minLeadFixtures:0']) assert.ok(launch.includes(flag), flag);
 assert.ok(launch.includes('freshConfirmationSeed'), 'validation seeds are drawn so that the derived confirmation seed is also fresh');
 const search = fs.readFileSync(path.join(__dirname, 'search.cjs'), 'utf8');
 for (const flag of ['--validation-opponents-max', '--confirmation-opponents', '--min-lead-fixtures']) assert.ok(search.includes(flag), flag);
});

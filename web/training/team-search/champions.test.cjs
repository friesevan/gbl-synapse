'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), zlib = require('node:zlib');
const C = require('./champions.cjs'), { summarize, compare, baselineTeams } = require('./evaluation.cjs'), { teamKey, digest } = require('./common.cjs');

// A small pool: three species with two or three movesets each, plus one species with a single charged move.
const V = (speciesId, dex, ...moveset) => ({ speciesId, speciesName: speciesId[0].toUpperCase() + speciesId.slice(1), dex, moveset, scoutScore: .5 });
function pool() {
 const variants = [
  V('alpha', 1, 'F1', 'A1', 'A2'), V('alpha', 1, 'F1', 'A1', 'A3'), V('alpha', 1, 'F2', 'A1', 'A2'),
  V('beta', 2, 'F3', 'B1', 'B2'), V('beta', 2, 'F3', 'B1', 'B3'),
  V('gamma', 3, 'F4', 'G1', 'G2'), V('gamma_shadow', 3, 'F4', 'G1', 'G2'),
  V('delta', 4, 'F5', 'D1', 'none'),
 ];
 const p = { species: variants.map(v => ({ speciesId: v.speciesId, dex: v.dex, weight: 1 })), variants }; p.hash = digest(variants.map(v => [v.speciesId, v.moveset]));
 return p;
}
const m = (speciesId, ...moveset) => ({ speciesId, moveset });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pvp-champions-'));
const write = (dir, name, data, gz) => { const file = path.join(dir, name); fs.writeFileSync(file, gz ? zlib.gzipSync(JSON.stringify(data)) : JSON.stringify(data)); return file; };
const row = (members, score) => ({ team: members.map(x => ({ ...x, speciesName: x.speciesId })), validation: score == null ? null : { score, fixtureSeed: 7 }, screen: score == null ? null : { fixtureSeed: 3 } });

test('mapToPool resolves species and moveset into the pool, lead first, and reports how each member matched', () => {
 const p = pool(), r = C.mapToPool([m('alpha', 'F1', 'A1', 'A3'), m('beta', 'F3', 'B1', 'B2'), m('gamma_shadow', 'F4', 'G1', 'G2')], p);
 assert.deepEqual(r.team, [1, 3, 6]);assert.deepEqual(r.mapping.map(x => x.match), ['exact', 'exact', 'exact']);
 // Charged-move order is not an alternate moveset (README section 11); a swapped order still maps, and says so.
 const swapped = C.mapToPool([m('alpha', 'F1', 'A2', 'A1'), m('beta', 'F3', 'B1', 'B2'), m('gamma', 'F4', 'G1', 'G2')], p);
 assert.deepEqual(swapped.team, [0, 3, 5]);assert.equal(swapped.mapping[0].match, 'charged-order');
 // A single-charged-move species written with or without the 'none' filler.
 assert.deepEqual(C.mapToPool([m('delta', 'F5', 'D1'), m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B2')], p).team, [7, 0, 3]);
});

test('mapToPool skips with a reason when a species, a moveset or the team shape is not usable', () => {
 const p = pool();
 const missingSpecies = C.mapToPool([m('alpha', 'F1', 'A1', 'A2'), m('zeta', 'F9', 'Z1', 'Z2'), m('beta', 'F3', 'B1', 'B2')], p);
 assert.equal(missingSpecies.team, undefined);assert.equal(missingSpecies.reason, 'species-not-in-pool');assert.match(missingSpecies.detail, /zeta is not in the current pool/);
 assert.equal(missingSpecies.mapping[1].variant, null);assert.equal(missingSpecies.mapping[0].variant, 0);
 const missingMoveset = C.mapToPool([m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B9'), m('gamma', 'F4', 'G1', 'G2')], p);
 assert.equal(missingMoveset.reason, 'moveset-not-in-pool');assert.match(missingMoveset.detail, /beta with F3 \/ B1 \/ B9 is not among the pool's 2 retained movesets/);
 // Different forms of one species (gamma and gamma_shadow share a dex) violate the Species Clause.
 assert.equal(C.mapToPool([m('gamma', 'F4', 'G1', 'G2'), m('gamma_shadow', 'F4', 'G1', 'G2'), m('beta', 'F3', 'B1', 'B2')], p).reason, 'species-clause');
 assert.equal(C.mapToPool([m('alpha', 'F1', 'A1', 'A2')], p).reason, 'not-a-team');
});

test('compositions are read from recommendations.json, the v1 archive and run directories; an unvalidated lead is not a champion', () => {
 const dir = tmp(), p = pool();
 try {
  const a = [m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B2'), m('gamma', 'F4', 'G1', 'G2')], b = [m('alpha', 'F1', 'A1', 'A3'), m('beta', 'F3', 'B1', 'B3'), m('delta', 'F5', 'D1', 'none')];
  const rec = write(dir, 'recommendations.json', { version: 'x', poolHash: p.hash, finalPanel: { complete: true }, rows: [row(a, .7), row(b, .65), row(a.slice().reverse(), null)] });
  const one = C.loadChampions(rec, p);
  assert.deepEqual(one.teams.map(t => t.team), [[0, 3, 5]]);assert.equal(one.teams[0].sources[0].finalScore, .7);assert.equal(one.sources[0].kind, 'recommendations');assert.equal(one.sources[0].poolHashMatches, true);assert.deepEqual(one.sources[0].usedSeeds.sort(), [3, 7]);
  const all = C.loadChampions(rec, p, { scope: 'finalists' });
  assert.deepEqual(all.teams.map(t => t.team), [[0, 3, 5], [1, 4, 7]]);assert.deepEqual(all.teams.map(t => t.sources[0].role), ['primary', 'finalist']);
  // v1 archive: teams[] with validation; the first is the primary.
  const archive = write(dir, 'team-search.json', { version: 'v1', teams: [{ team: a, validation: { score: .68 } }, { team: b, validation: { score: .6 } }] });
  const arch = C.loadChampions(archive, p);assert.deepEqual(arch.teams.map(t => t.team), [[0, 3, 5]]);assert.equal(arch.sources[0].kind, 'archive');assert.equal(arch.teams[0].label, 'v1-published');
  // A run directory prefers recommendations.json; a run whose lead was not final-tested has no champion.
  const run = path.join(dir, 'my-run');fs.mkdirSync(run);write(run, 'recommendations.json', { rows: [row(a, null)] });
  const none = C.loadChampions(run, p);assert.equal(none.teams.length, 0);assert.equal(none.skipped[0].reason, 'no-champion');assert.match(none.skipped[0].detail, /training leader is not a champion/);
  const full = path.join(dir, 'full-run');fs.mkdirSync(full);write(full, 'recommendations.json', { rows: [row(b, .6)] });
  assert.equal(C.loadChampions(full, p).teams[0].label, 'full-run');
  assert.throws(() => C.loadChampions(path.join(dir, 'missing.json'), p), /not found/);
  assert.throws(() => C.loadChampions(write(dir, 'junk.json', { hello: 1 }), p), /Unrecognised champion file/);
  assert.throws(() => C.extractCompositions({}, 'recommendations', 'everyone'), /scope/);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('identical compositions from several sources merge and keep every source; unmappable teams are reported, not silently dropped', () => {
 const dir = tmp(), p = pool();
 try {
  const a = [m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B2'), m('gamma', 'F4', 'G1', 'G2')], sameBenchOtherOrder = [m('alpha', 'F1', 'A1', 'A2'), m('gamma', 'F4', 'G1', 'G2'), m('beta', 'F3', 'B1', 'B2')], otherLead = [m('beta', 'F3', 'B1', 'B2'), m('alpha', 'F1', 'A1', 'A2'), m('gamma', 'F4', 'G1', 'G2')];
  const bad = [m('alpha', 'F1', 'A1', 'A2'), m('zeta', 'F9', 'Z1', 'Z2'), m('beta', 'F3', 'B1', 'B2')];
  const one = write(dir, 'one.json', { rows: [row(a, .7), row(bad, .6)] }), two = write(dir, 'two.json', { rows: [row(sameBenchOtherOrder, .72), row(otherLead, .5)] });
  const r = C.loadChampions([one, two].join(','), p, { scope: 'finalists' });
  // Bench order does not matter (canonical bench); a different lead is a different team.
  assert.equal(r.teams.length, 2);assert.deepEqual(r.teams[0].sources.map(s => s.source), ['one', 'two']);assert.deepEqual(r.teams[1].sources.map(s => s.source), ['two']);
  assert.equal(teamKey(r.teams[0].team), teamKey([0, 5, 3]));
  assert.equal(r.skipped.length, 1);assert.equal(r.skipped[0].reason, 'species-not-in-pool');assert.equal(r.skipped[0].label, 'one#2');assert.equal(r.skipped[0].members.length, 3);
  assert.equal(r.fingerprint, C.loadChampions([one, two], p, { scope: 'finalists' }).fingerprint);assert.notEqual(r.fingerprint, C.loadChampions([one], p).fingerprint);
  assert.equal(C.loadChampions('none', p).teams.length, 0);assert.equal(C.loadChampions('', p).fingerprint, null);
  assert.deepEqual(C.loadChampions(['none', one], p).teams.map(t => t.team), [[0, 3, 5]]);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('portable reports are validated with neural-report-core and their primary and finalists are read', () => {
 const reportFile = path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz');
 const data = C.readJson(reportFile), kind = C.detectKind(data);
 assert.equal(kind, 'report');
 const primary = C.extractCompositions(data, kind, 'primary'), finalists = C.extractCompositions(data, kind, 'finalists');
 assert.equal(primary.entries.length, 1);assert.equal(primary.entries[0].role, 'primary');
 assert.deepEqual(primary.entries[0].members.map(x => x.speciesId), ['houndoom_shadow', 'melmetal', 'mimikyu']);
 assert.equal(finalists.entries.length, 8);assert.ok(finalists.entries.slice(1).every((e, i, all) => i === 0 || all[i - 1].finalScore >= e.finalScore));
 assert.equal(finalists.entries[0].finalScore, primary.entries[0].finalScore);
 // A report that fails validation is refused rather than guessed at.
 assert.throws(() => C.extractCompositions({ ...data, schemaVersion: 2 }, 'report'), /Invalid neural report/);
 // The incomplete v2 archive has no final-tested team: it is skipped with its own explanation.
 const v2 = C.extractCompositions(C.readJson(path.join(__dirname, '../../includes/pro/data/team-v2-overnight.pvpteams.json.gz')), 'report');
 assert.equal(v2.entries.length, 0);assert.match(v2.note, /no final-tested primary/);
});

test('discoverRuns picks completed, large, pool-matching runs and ignores smoke runs, other pools and unvalidated leaders', () => {
 const dir = tmp(), p = pool(), a = [m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B2'), m('gamma', 'F4', 'G1', 'G2')];
 const run = (name, extra) => { const d = path.join(dir, name); fs.mkdirSync(d); write(d, 'recommendations.json', { poolHash: p.hash, finalPanel: { complete: true, completedFixtures: 512 }, rows: [row(a, .7)], ...extra }); return d; };
 try {
  const good = run('good', {}), late = run('late', {});fs.utimesSync(path.join(late, 'recommendations.json'), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  run('smoke', { finalPanel: { complete: true, completedFixtures: 16 } });run('other-pool', { poolHash: 'zzz' });run('partial', { finalPanel: { complete: false, completedFixtures: 300 } });run('unvalidated', { rows: [row(a, null)] });
  fs.mkdirSync(path.join(dir, 'empty'));fs.mkdirSync(path.join(dir, 'broken'));fs.writeFileSync(path.join(dir, 'broken', 'recommendations.json'), '{not json');
  assert.deepEqual(C.discoverRuns(dir, p).map(r => path.basename(r.dir)), ['good', 'late']);
  assert.deepEqual(C.discoverRuns(dir, p, { exclude: [good] }).map(r => path.basename(r.dir)), ['late']);
  assert.deepEqual(C.discoverRuns(dir, p, { minFixtures: 8 }).map(r => path.basename(r.dir)).sort(), ['good', 'late', 'smoke']);
  assert.deepEqual(C.discoverRuns(path.join(dir, 'nowhere'), p), []);
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the previous-champions group joins the baselines as extra teams without disturbing the generated groups', () => {
 const species = [1, 2, 3, 4, 5].map(dex => ({ speciesId: 'p' + dex, dex, weight: 1 })), variants = species.flatMap(s => [{ ...s, scoutScore: .3 }, { ...s, scoutScore: .7 }]), p = { species, variants };
 const plain = baselineTeams(p, 12, 22), withChampions = baselineTeams(p, 12, 22, { champions: [[0, 2, 4], { team: [6, 2, 4], label: 'x' }, [0, 4, 2], [2, 0, 4]] });
 assert.equal(plain.length, 12);assert.ok(plain.every(r => r.kind !== 'previous-champions'));
 // Same stream: the 12 generated teams are identical whether or not champions are supplied.
 assert.deepEqual(withChampions.slice(0, 12), plain);
 const champions = withChampions.filter(r => r.kind === 'previous-champions');
 // [0,2,4] and [0,4,2] are one team (bench order is canonical); a different lead [2,0,4] is another team.
 assert.deepEqual(champions.map(r => r.team), [[0, 2, 4], [6, 2, 4], [2, 0, 4]]);
 assert.throws(() => baselineTeams(p, 12, 22, { champions: [[0, 1, 4]] }), /not a legal team/);
 assert.throws(() => baselineTeams(p, 12, 22, { champions: [[0, 2, 99]] }), /not a legal team/);
 assert.deepEqual(baselineTeams(p, 3, 22, { champions: null }).map(r => r.kind), ['uniform-random', 'weight-sampled-best-moves', 'greedy-scout-coverage']);
});

test('compare() treats previous-champions like the other groups: a paired bootstrap over whole fixtures, matched by seed', () => {
 const primary = summarize([1, 1, 1, 0, .5, 1, 0, 1], { team: [0, 1, 2], fixtureSeed: 9, paired: false }), c1 = summarize([1, 0, 0, 0, .5, 1, 0, 0], { team: [3, 4, 5], fixtureSeed: 9, paired: false, kind: 'previous-champions' }), c2 = summarize([0, 0, 1, 0, .5, 0, 0, 1], { team: [6, 7, 8], fixtureSeed: 9, paired: false, kind: 'previous-champions' });
 const group = compare(primary, [c1, c2], { seed: 5, samples: 1000 });
 const expected = primary.score - (c1.score + c2.score) / 2;assert.ok(Math.abs(group.delta - expected) < 1e-12);assert.equal(group.baselineTeams, 2);assert.equal(group.fixtures, 8);
 assert.ok(group.interval95[0] <= group.delta && group.interval95[1] >= group.delta);
 assert.throws(() => compare(primary, [{ ...c1, fixtureSeed: 10 }]), /same opponent fixtures/);
});

function panel(seedScores, seed = 11) { return seedScores.map(([team, scores, kind]) => summarize(scores, { team, fixtureSeed: seed, paired: false, kind })); }
const many = (v, n) => Array.from({ length: n }, () => v);
test('championComparisons says primary-better, tie-rediscovered, champion-better or unresolved, champion by champion', () => {
 const champions = { teams: [{ team: [3, 4, 5], label: 'old-a', sources: [{ source: 'old-a', role: 'primary', rank: 1 }] }, { team: [6, 7, 8], label: 'old-b', sources: [{ source: 'old-b', role: 'primary', rank: 1 }] }] };
 const wins = Array.from({ length: 64 }, (_, i) => i % 4 === 0 ? 0 : 1), lose = Array.from({ length: 64 }, (_, i) => i % 4 === 0 ? 1 : 0);
 // Primary far above both champions.
 let [primary, a, b] = panel([[[0, 1, 2], wins], [[3, 4, 5], lose, 'previous-champions'], [[6, 7, 8], many(0, 64), 'previous-champions']]);
 let r = C.championComparisons(primary, [a, b], champions, { seed: 3, samples: 500 });
 assert.equal(r.outcome, 'primary-better');assert.equal(r.fixtures, 64);assert.equal(r.rediscovered, false);assert.deepEqual(r.entries.map(e => e.verdict), ['primary-better', 'primary-better']);assert.deepEqual(r.entries.map(e => e.label), ['old-a', 'old-b']);assert.match(r.summary, /clearly above every previous champion/);
 // The primary is a previous champion again: a tie by construction, and the other champion is beaten.
 [primary, a, b] = panel([[[3, 4, 5], wins], [[3, 5, 4], wins, 'previous-champions'], [[6, 7, 8], many(0, 64), 'previous-champions']]);
 r = C.championComparisons(primary, [a, b], champions, { seed: 3, samples: 500 });
 assert.equal(r.outcome, 'tie-rediscovered');assert.equal(r.rediscovered, true);assert.deepEqual(r.entries.map(e => e.verdict), ['same-team', 'primary-better']);assert.equal(r.entries[0].delta, 0);assert.deepEqual(r.entries[0].interval95, [0, 0]);assert.match(r.summary, /selected a previous champion again/);
 // A champion clearly stronger than the primary.
 [primary, a, b] = panel([[[0, 1, 2], lose], [[3, 4, 5], wins, 'previous-champions'], [[6, 7, 8], many(0, 64), 'previous-champions']]);
 r = C.championComparisons(primary, [a, b], champions, { seed: 3, samples: 500 });
 assert.equal(r.outcome, 'champion-better');assert.equal(r.entries[0].verdict, 'challenger-better');
 // Inside the interval: unresolved is a tie, never a win.
 const noisy = Array.from({ length: 64 }, (_, i) => i % 2), noisy2 = Array.from({ length: 64 }, (_, i) => (i + (i % 7 === 0 ? 1 : 0)) % 2);
 [primary, a, b] = panel([[[0, 1, 2], noisy], [[3, 4, 5], noisy2, 'previous-champions'], [[6, 7, 8], many(0, 64), 'previous-champions']]);
 r = C.championComparisons(primary, [a, b], champions, { seed: 3, samples: 500 });
 assert.equal(r.outcome, 'unresolved');assert.equal(r.entries[0].verdict, 'unresolved');
 // No champions, or no champion rows in the baseline results: nothing to report.
 assert.equal(C.championComparisons(primary, [a, b], { teams: [] }), null);assert.equal(C.championComparisons(primary, [], champions), null);assert.equal(C.championComparisons(null, [a], champions), null);
 // Same members, different lead: flagged, not called the same team.
 [primary, a] = panel([[[3, 4, 5], wins], [[4, 3, 5], lose, 'previous-champions']]);
 assert.equal(C.championComparisons(primary, [a], { teams: [champions.teams[0]] }, { samples: 200 }).entries[0].sameMembers, true);
});

test('championRows names every team for the report and is empty without champions', () => {
 const p = pool(), champions = { teams: [{ team: [0, 3, 5], label: 'old-a', sources: [] }], skipped: [] };
 const primary = summarize(many(1, 8), { team: [1, 4, 6], fixtureSeed: 1, paired: false }), row = summarize(many(0, 8), { team: [0, 3, 5], fixtureSeed: 1, paired: false, kind: 'previous-champions' });
 const state = { champions, championComparisons: C.championComparisons(primary, [row], champions, { samples: 200 }) };
 const rows = C.championRows(state, p);
 assert.equal(rows.length, 1);assert.deepEqual(rows[0].names, ['Alpha', 'Beta', 'Gamma']);assert.equal(rows[0].label, 'old-a');
 assert.deepEqual(C.championRows({}, p), []);
});

test('defaultChampionSources lists the published v1 and v3 primaries, then completed matching runs; launchers accept --champions', () => {
 const dir = tmp(), p = pool(), a = [m('alpha', 'F1', 'A1', 'A2'), m('beta', 'F3', 'B1', 'B2'), m('gamma', 'F4', 'G1', 'G2')];
 try {
  const data = path.join(dir, 'includes/pro/data'), runs = path.join(dir, 'training/runs');
  fs.mkdirSync(data, { recursive: true });
  for (const name of ['v4-run', 'new-run', 'smoke']) fs.mkdirSync(path.join(runs, name), { recursive: true });
  for (const name of ['team-search.json', 'team-v3-refined.pvpteams.json.gz', 'team-v2-overnight.pvpteams.json.gz']) fs.writeFileSync(path.join(data, name), '');
  const rec = (name, completed) => fs.writeFileSync(path.join(runs, name, 'recommendations.json'), JSON.stringify({ poolHash: p.hash, finalPanel: { complete: true, completedFixtures: completed }, rows: [row(a, .7)] }));
  rec('v4-run', 512); rec('new-run', 512); rec('smoke', 16);
  const list = C.defaultChampionSources(dir, p, { exclude: [path.join(runs, 'new-run')] });
  // The v2 archive never has a final-tested team and is not listed; the run being (re)launched is excluded; smoke runs never qualify.
  assert.deepEqual(list.map(f => path.relative(dir, f)), ['includes/pro/data/team-search.json', 'includes/pro/data/team-v3-refined.pvpteams.json.gz', 'training/runs/v4-run']);
  assert.deepEqual(C.defaultChampionSources(path.join(dir, 'empty'), p), []);
  // Both the detached launcher and the search accept the options (an unknown option would exit non-zero).
  for (const script of ['launch.cjs', 'search.cjs']) {
   const out = require('node:child_process').spawnSync(process.execPath, [path.join(__dirname, script), '--champions', 'a,b', '--champions-scope', 'finalists', '--help'], { encoding: 'utf8' });
   assert.equal(out.status, 0, script + ': ' + out.stderr);
  }
 } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

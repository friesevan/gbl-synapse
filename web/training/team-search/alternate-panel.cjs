'use strict';
// Alternate-moveset stress panel (README sections 4, 8 and 12; findings/opponent-movesets.md).
//
// The search tests its opponents-as-modelled: recommended movesets, or observed ones with --observed-moves. A team that wins
// because the opponents never carry the counter move is not robust, and one search cannot show it. After the final test
// (and the confirmation and the policy panel, before the sensitivity panel) this panel replays the finalists on one sealed
// panel of N fixtures drawn from the run's own meta, three ways, on the same opponent species, order and battle seeds:
//   run          the opponents as the run models them (the reference)
//   alternate-1  every opponent member plays its best scouted moveset other than the recommended one
//   alternate-2  every opponent member plays its second best such moveset
// "Scouted" ranks the pool's retained variants of a species by their 1-v-1 scout score (prepare.cjs keeps five per species).
// The comparison is paired by fixture, with a simultaneous 95% band over the three arms (paired-stats.cjs). It is a read-out
// that follows the final test; it never changes the primary. Jobs are fixture-major, so a deadline leaves a common prefix of
// whole fixtures.
const {teamKey, guardedSeed} = require('./common.cjs');
const {opponentFixtureKey} = require('./acquisition.cjs');
const {sameMoveset} = require('./observed-moves.cjs');
const {summarizeTeam: summarizeStyles} = require('../next/policy-panel.cjs');

const SEED_OFFSET = 840001, BOOTSTRAP_OFFSET = 840002, MAX_FIXTURES = 4096, SCHEMA = 1, RANKS = [1, 2], RUN = 'run';
const LEVEL_LABEL = {1: 'Best alternate moveset', 2: 'Second alternate moveset'};

function checkSize(n) {
 if (!Number.isInteger(n) || n < 0 || n > MAX_FIXTURES) throw Error('alternate-panel must be an integer from 0 to ' + MAX_FIXTURES + ' (0 disables)');
 return n;
}
// Guarded against every sealed or derived seed the search holds (screening, final, confirmation, policy panel, retest panel, the
// reference, belief and baseline streams); the sensitivity panel derives its seeds guarded against this one.
function panelSeed(seed, reserved = []) { return guardedSeed(seed + SEED_OFFSET, reserved.filter(Number.isInteger)); }

// speciesId -> alternate movesets, best first: the species' retained variants by scout score, without the recommended moveset.
function alternates(prepared) {
 const recommended = new Map(prepared.species.map(p => [p.speciesId, p.moveset])), by = new Map();
 prepared.variants.forEach((v, i) => { if (!by.has(v.speciesId)) by.set(v.speciesId, []); by.get(v.speciesId).push({v, i}); });
 const out = new Map();
 for (const [id, rows] of by) {
  const rec = recommended.get(id);
  out.set(id, rows.filter(({v}) => !(rec && sameMoveset(v.moveset, rec))).sort((a, b) => b.v.scoutScore - a.v.scoutScore || a.i - b.i).map(({v}) => v.moveset.slice()));
 }
 return out;
}
// The rank-th alternate of a species; a species with fewer alternates uses its last one, and one with none keeps its moveset.
const pick = (list, rank) => list?.length ? list[Math.min(rank, list.length) - 1] : null;

// Level `rank` of a fixture: every member plays its rank-th alternate. Returns the new case and how many members changed.
function swapCase(c, alts, rank) {
 let changed = 0;
 const team = c.team.map(m => {
  const alt = pick(alts.get(m.speciesId), rank);
  if (!alt || sameMoveset(alt, m.moveset)) return m;   // the same moves in another charged order are the same moveset
  changed++;
  const {observedMoveset, recommendedMoveset, ...rest} = m;
  return {...rest, moveset: alt.slice(), alternateRank: rank};
 });
 return {case: {...c, team}, changed};
}

// The search's view. `cases` are drawn from the run's meta on a sealed seed; `sealed` lists panels that must not share a
// fixture with this one (screening, final, confirmation, retest), `observations` the training evidence. Returns the
// interleaved list the search plays (fixture 0 at every arm, fixture 1, ...) and what the swaps changed.
function plan(prepared, meta, {fixtures, seed, observed = false, sealed = [], observations = [], evidenceSeeds = []} = {}) {
 checkSize(fixtures);
 if ((evidenceSeeds || []).map(s => s >>> 0).includes(seed >>> 0)) throw Error('Alternate-panel seed ' + seed + ' was an evaluation seed of absorbed evidence; choose a fresh validation-seed');
 const cases = meta.fixtures(fixtures, seed), keys = new Set(cases.map(c => opponentFixtureKey(c.team, c.seed)));
 for (const panel of sealed) for (const c of panel) if (keys.has(opponentFixtureKey(c.team, c.seed))) throw Error('Alternate-panel fixtures overlap a sealed or retest panel; choose another validation-seed');
 const battleSeeds = new Set(cases.map(c => c.seed)); // compare the cheap per-fixture seed first: a completed run holds hundreds of thousands of observations
 for (const o of observations) if (battleSeeds.has(o.seed) && keys.has(opponentFixtureKey(o.opponent, o.seed))) throw Error('Alternate-panel fixtures overlap inherited training evidence; choose a fresh validation-seed');
 const alts = alternates(prepared), arms = [RUN, ...RANKS.map(r => 'alternate-' + r)], interleaved = [], stats = RANKS.map(rank => ({rank, id: 'alternate-' + rank, label: LEVEL_LABEL[rank], members: 0, changedMembers: 0, changedFixtures: 0}));
 const swapped = cases.map(c => RANKS.map((rank, k) => { const s = swapCase(c, alts, rank); stats[k].members += c.team.length; stats[k].changedMembers += s.changed; if (s.changed) stats[k].changedFixtures++; return s.case; }));
 cases.forEach((c, f) => { interleaved.push(c, ...swapped[f]); });
 return {fixtures, seed, observed, arms, levels: stats, cases, interleaved, armCount: arms.length, battles: teamCount => teamCount * fixtures * arms.length};
}

// Search side: `rows` are the common-panel scores of evaluate() over the interleaved list. Returns {block, raw} or null when not even
// one whole fixture finished on every arm. `teams` = [{team, primary, finalScore}].
function assemble(info, teams, rows, {seed = 1, samples = 5000} = {}) {
 const A = info.armCount, total = teams.length && rows?.length === teams.length ? Math.min(...rows.map(r => r.scores.length)) : 0, n = Math.floor(total / A);
 if (!n) return null;
 const byKey = new Map(rows.map(r => [teamKey(r.team), r])), styles = info.arms.map(name => ({name}));
 const raw = {}, out = teams.map((t, ti) => {
  const row = byKey.get(teamKey(t.team)), arm = info.arms.map((_, k) => Array.from({length: n}, (__, f) => row.scores[f * A + k]));
  raw[teamKey(t.team)] = Object.fromEntries(info.arms.map((name, k) => [name, arm[k]]));
  const s = summarizeStyles(arm, styles, {seed: (seed + ti) >>> 0, samples}), deltas = s.versusDefault.map(v => ({level: v.style, delta: v.delta, interval95: v.interval95, verdict: v.verdict}));
  let worst = deltas[0];for (const d of deltas) if (d.delta < worst.delta) worst = d;
  return {team: t.team, primary: !!t.primary, finalScore: Number.isFinite(t.finalScore) ? t.finalScore : null, scores: s.scores, deltas, worstLevel: worst.level, worstDelta: worst.delta, bandRadius: s.bandRadius};
 });
 const block = {
  version: SCHEMA, requestedFixtures: info.fixtures, fixtures: n, complete: n === info.fixtures, seed: info.seed, exploratory: n < 256,
  reference: {id: RUN, label: info.observed ? 'Run opponents (observed movesets where recorded, recommended otherwise)' : 'Recommended movesets'},
  levels: info.levels.map(l => ({...l, changedMemberShare: l.members ? l.changedMembers / l.members : 0, changedFixtureShare: info.fixtures ? l.changedFixtures / info.fixtures : 0})),
  teams: out,
  method: 'The finalists replayed ' + n + ' sealed fixtures of the run\'s own opponent meta (a seed derived from the run seed and guarded against every other panel) three ways on the same opponent species, order and battle seeds: with the opponents as the run models them, and with every opponent member playing its best, and second best, scouted moveset other than the recommended one (the pool\'s 1-v-1 scout ranking). Differences are paired by fixture; the bands are a paired bootstrap, simultaneous over the three arms. It ran after the final test and did not affect selection.',
 };
 return {block, raw};
}

// ---- text (neural-portable.js keeps an identical caption; a test compares them) ------------------------------------

const pct = x => Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '—';
const signed = x => (x >= 0 ? '+' : '−') + (100 * Math.abs(x)).toFixed(1);
const band = i => '[' + signed(i[0]) + ', ' + signed(i[1]) + ']';
function caption(block, nameOf = () => '') {
 const first = block.teams[0];if (!first) return '';
 const share = block.levels.map(l => Math.round(100 * l.changedMemberShare) + '%').join(' and ');
 const worst = block.teams.map(t => t.worstDelta);
 return 'Alternate opponent movesets (' + block.fixtures + ' common fixtures, after the final test): with the opponents\' members on their best and second best scouted alternate moveset (' + share + ' of members changed), ' + nameOf(first.team) + ' scored '
  + pct(first.scores[RUN]) + ' with the modelled movesets, ' + block.levels.map(l => pct(first.scores[l.id]) + ' (' + signed(first.deltas.find(d => d.level === l.id).delta) + ' pp) with the ' + (l.rank === 1 ? 'best' : 'second') + ' alternate').join(' and ')
  + (block.teams.length > 1 ? '; across finalists the worst arm changed the score by ' + signed(Math.min(...worst)) + ' to ' + signed(Math.max(...worst)) + ' pp' : '') + '. ' + (block.exploratory ? 'Exploratory: fewer than 256 fixtures. ' : '')
  + 'A score that stays close to the modelled one does not hinge on the opponents carrying the recommended moves.';
}
// Rows for report.html, findings.md and the CLI.
function describe(block, nameOf) {
 const header = ['Finalist', block.reference.label, ...block.levels.flatMap(l => [l.label, 'Change (simultaneous 95%)'])];
 const rows = block.teams.map(t => [(t.primary ? 'Primary · ' : '') + nameOf(t.team), pct(t.scores[RUN]), ...block.levels.flatMap(l => { const d = t.deltas.find(x => x.level === l.id);return [pct(t.scores[l.id]), signed(d.delta) + ' pp ' + band(d.interval95) + (d.verdict === 'unresolved' ? '' : ' ' + d.verdict)]; })]);
 return {header, rows};
}
function html(state, pool, {escape, pct: percent}) {
 const block = state.alternatePanel;if (!block?.teams?.length) return '';
 const {header, rows} = describe(block, team => team.map(i => pool.variants[i].speciesName).join(' · '));
 return '<h2>Alternate opponent movesets</h2><p>' + escape(caption(block, team => team.map(i => pool.variants[i].speciesName).join(' · '))) + '</p><div class="scroll"><table><thead><tr>' + header.map(h => '<th>' + escape(h) + '</th>').join('') + '</tr></thead><tbody>'
  + rows.map((r, i) => '<tr class="' + (i === 0 ? 'primary' : '') + '">' + r.map(c => '<td>' + escape(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div><p>' + escape(block.method) + '</p>';
}
function markdown(state, pool) {
 const block = state.alternatePanel;if (!block?.teams?.length) return '';
 const name = team => team.map(i => pool.variants[i].speciesName).join(' / ');
 return '\n' + caption(block, name) + '\n' + block.teams.map(t => '- ' + (t.primary ? 'Primary · ' : '') + name(t.team) + ': ' + pct(t.scores[RUN]) + ' modelled; ' + t.deltas.map(d => d.level + ' ' + signed(d.delta) + ' pp ' + band(d.interval95)).join('; ')).join('\n') + '\n';
}

// search.cjs: the finalists, in order, with the primary first.
const teamsFor = state => state.validations.map((v, i) => ({team: v.team, primary: i === 0, finalScore: v.score}));

// ---- standalone: the panel for a finished run's finalists ----------------------------------------------------------
//
//   node training/team-search/alternate-panel.cjs RUN_OR_REPORT[,…] [--scope finalists|primary] [--fixtures 64] [--workers 4]
//        [--pool FILE] [--meta hybrid] [--usage-file F --usage-half-life-days N --usage-as-of D --usage-prior-strength N]
//        [--observed-moves] [--seed N] [--out FILE.json]
//   node training/team-search/alternate-panel.cjs --print SAVED.json
//
// Sources are what rematch.cjs and --champions accept (run directories, recommendations.json, portable reports); only
// compositions are read and every score is re-simulated, with the current engine, on a fresh sealed panel that none of the
// sources used and a fresh belief bank. Give the meta the run used (its launch.json lists the flags) to stress the opponents
// the run was made against; --observed-moves needs --usage-file.
const DEFAULTS = {pool: 'training/runs/team-search/pool.json', scope: 'finalists', meta: 'hybrid', usageFile: '', usageHalfLifeDays: 0, usageAsOf: '', usagePriorStrength: 500, metaWeightPower: 1.25, fixtures: 64, seed: 0, workers: 4, beliefSamples: 3, lookaheadTurns: 24, decisionInterval: 4, bootstrap: 5000, out: '', print: ''};
const NUMBERS = new Set(Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'number'));
function parseArgs(argv) {
 const opts = {...DEFAULTS, observedMoves: false, help: false}, sources = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help') { opts.help = true;continue; }
  if (a === '--observed-moves') { opts.observedMoves = true;continue; }
  if (!a.startsWith('--')) { sources.push(...a.split(',').filter(Boolean));continue; }
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in DEFAULTS) || argv[i + 1] === undefined) throw Error('Unknown argument ' + a);
  opts[key] = NUMBERS.has(key) ? Number(argv[++i]) : argv[++i];
 }
 return {opts, sources};
}
async function standalone(opts, sources, {play = null, log = console.log} = {}) {
 const fs = require('node:fs'), path = require('node:path'), {defaults} = require('../utils.cjs'), {digest, dataHash, mechanicsHash} = require('./common.cjs');
 const {loadChampions} = require('./champions.cjs'), {panelSeed: freshSeed, defaultPlay} = require('./rematch.cjs'), {createMeta} = require('./meta.cjs');
 checkSize(opts.fixtures);
 if (opts.fixtures < 2) throw Error('fixtures must be at least 2');
 if (!sources.length) throw Error('Give a run directory, recommendations.json or portable report');
 if (!['finalists', 'primary'].includes(opts.scope)) throw Error('scope must be finalists or primary');
 const pool = JSON.parse(fs.readFileSync(path.resolve(opts.pool), 'utf8')), check = {...pool};delete check.hash;
 if (digest(check) !== pool.hash) throw Error('Pool hash mismatch');
 if (pool.config.inputHash !== dataHash()) throw Error('Pool data differs from bundled rankings, weights or Game Master');
 const found = loadChampions(sources, pool, {scope: opts.scope});
 if (!found.teams.length) throw Error('No team could be mapped into the pool' + (found.skipped.length ? ': ' + found.skipped.map(s => s.label + ': ' + s.reason).join('; ') : ''));
 const seed = freshSeed(opts.seed, found.sources.flatMap(s => s.usedSeeds));
 const meta = createMeta(pool.species, {mode: opts.meta, usageFile: opts.usageFile, weightPower: opts.metaWeightPower, halfLifeDays: opts.usageHalfLifeDays, asOf: opts.usageAsOf, priorStrength: opts.usagePriorStrength, observedMoves: opts.observedMoves, variants: pool.variants});
 const info = plan(pool, meta, {fixtures: opts.fixtures, seed, observed: opts.observedMoves});
 const {guardedSeed} = require('./common.cjs'), beliefSeed = guardedSeed((seed + 620001) >>> 0, [seed]);
 const engine = {cp: 1500, beliefRoster: pool.species.map(p => ({speciesId: p.speciesId, dex: p.dex, moveset: p.moveset, weight: p.weight ** opts.metaWeightPower})), beliefTeams: meta.fixtures(2048, beliefSeed).map(c => c.team.map(p => p.speciesId)), beliefSamples: opts.beliefSamples, horizon: opts.lookaheadTurns, interval: opts.decisionInterval};
 // Fixture-major, arm, then team: a stopped run keeps a common prefix of whole fixtures.
 const teams = found.teams, jobs = [];
 for (const c of info.interleaved) for (const t of teams) jobs.push([t.team.map(i => pool.variants[i]), c.team, defaults, defaults, {...engine, seed: c.seed}]);
 log('Alternate-moveset panel · ' + teams.length + ' teams × ' + info.fixtures + ' fixtures × ' + info.armCount + ' arms = ' + jobs.length + ' battles · ' + opts.workers + ' workers · meta ' + opts.meta + (opts.observedMoves ? ' with observed movesets' : '') + ' · panel seed ' + seed);
 const started = Date.now(), results = await (play || defaultPlay)(jobs, {workers: opts.workers, log, label: 'alternate-panel'});
 if (!results || results.length !== jobs.length) throw Error('The panel did not complete every battle');
 const rows = teams.map((t, ti) => ({team: t.team, scores: info.interleaved.map((_, p) => results[p * teams.length + ti].score)}));
 const assembled = assemble(info, teams.map((t, i) => ({team: t.team, primary: i === 0, finalScore: null})), rows, {seed: (seed + 1) >>> 0, samples: opts.bootstrap});
 return {
  format: 'pvp-team-alternate-panel', schemaVersion: 1, createdAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000, ...assembled.block,
  labels: teams.map(t => t.label + ': ' + t.members.map(m => m.speciesName).join(' / ')), engine: {version: 'neural-team-search-v4', mechanicsHash: mechanicsHash({version: 'v4'}), lookaheadTurns: opts.lookaheadTurns, decisionInterval: opts.decisionInterval, beliefSamples: opts.beliefSamples},
  pool: {file: path.resolve(opts.pool), hash: pool.hash}, meta: meta.description, observedMoves: !!opts.observedMoves, sources: found.sources.map(s => ({file: s.file, label: s.label, kind: s.kind})), skipped: found.skipped, workers: opts.workers, raw: assembled.raw,
 };
}
function formatTable(result) {
 const {header, rows} = describe(result, team => (result.labels?.[result.teams.findIndex(t => t.team === team)]) || team.join(','));
 const widths = header.map((_, j) => Math.max(header[j].length, ...rows.map(r => String(r[j]).length))), line = r => r.map((v, j) => String(v).padEnd(widths[j])).join('  ').trimEnd();
 const out = [caption(result, team => (result.labels?.[result.teams.findIndex(t => t.team === team)]) || team.join(',')), '', line(header), ...rows.map(line)];
 out.push('', result.levels.map(l => l.label + ': ' + l.changedMembers + ' of ' + l.members + ' opponent members changed (' + l.changedFixtures + ' of ' + result.requestedFixtures + ' fixtures)').join(' · '));
 if (result.skipped?.length) { out.push('', 'Skipped (not mappable into the pool):');for (const s of result.skipped) out.push('  ' + s.label + ': ' + s.reason); }
 out.push('', 'Panel seed ' + result.seed + ' · meta ' + (result.meta?.mode || '?') + (result.observedMoves ? ' with observed movesets' : '') + (result.seconds ? ' · ' + result.seconds.toFixed(0) + ' s' : ''));
 return out.join('\n');
}
async function main(argv) {
 const fs = require('node:fs'), path = require('node:path'), {atomic} = require('./common.cjs'), {opts, sources} = parseArgs(argv);
 if (opts.print) { console.log(formatTable(JSON.parse(fs.readFileSync(path.resolve(opts.print), 'utf8'))));return; }
 if (opts.help || !sources.length) { console.log('node training/team-search/alternate-panel.cjs RUN_OR_REPORT[,…] [--scope finalists|primary] [--fixtures 64] [--workers 4] [--pool FILE] [--meta hybrid|independent|observed] [--usage-file JSON] [--usage-half-life-days N] [--usage-as-of YYYY-MM-DD] [--usage-prior-strength 500] [--meta-weight-power 1.25] [--observed-moves] [--seed N] [--belief-samples 3] [--lookahead-turns 24] [--decision-interval 4] [--bootstrap 5000] [--out FILE.json] | --print SAVED.json');return; }
 const result = await standalone(opts, sources);
 const out = path.resolve(opts.out || path.join('training/runs', 'alternate-panel-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json'));
 atomic(out, result);console.log('\n' + formatTable(result) + '\n\nSaved ' + out);
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message || e);process.exitCode = 1; });

module.exports = {SEED_OFFSET, BOOTSTRAP_OFFSET, MAX_FIXTURES, SCHEMA, RANKS, RUN, checkSize, panelSeed, alternates, swapCase, plan, assemble, caption, describe, html, markdown, teamsFor, parseArgs, standalone, formatTable, DEFAULTS};

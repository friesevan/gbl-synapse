'use strict';
// Previous champions: compositions of earlier winning teams, mapped into the current pool and tested as a
// fixed baseline group (`previous-champions`) on the new run's sealed final panel.
//
// A source is one of
//   - a portable report (.pvpteams.json.gz or .json; validated with neural-report-core.js): the primary is the
//     row with `primary`, other finalists are rows with `finalist`;
//   - the published v1 archive (web/includes/pro/data/team-search.json): teams[0] is the primary;
//   - a recommendations.json written by search.cjs: rows[0] is the primary when it was final-tested;
//   - a run directory (recommendations.json first, else report.pvpteams.json.gz).
// Only compositions travel: species and moveset. No score, label, seed or model from the source run is reused.
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const { digest, teamKey, validTeam } = require('./common.cjs');
const { compareFinalists } = require('./evaluation.cjs');
const reportCore = require('../../includes/pro/neural-report-core.js');

const GROUP = 'previous-champions';
const MAX_EXPANDED = 512 * 1024 * 1024;

function readJson(file) {
 const raw = fs.readFileSync(file);
 const text = /\.gz$/i.test(file) || (raw[0] === 0x1f && raw[1] === 0x8b) ? zlib.gunzipSync(raw, { maxOutputLength: MAX_EXPANDED }) : raw;
 return JSON.parse(text.toString('utf8'));
}

// A run directory prefers the small recommendations.json; a portable report is the fallback.
function resolveSource(file) {
 const resolved = path.resolve(file);
 if (!fs.existsSync(resolved)) throw Error('Champion source not found: ' + file);
 if (!fs.statSync(resolved).isDirectory()) return { file: resolved, label: labelOf(resolved) };
 for (const name of ['recommendations.json', 'report.pvpteams.json.gz'])
  if (fs.existsSync(path.join(resolved, name))) return { file: path.join(resolved, name), label: path.basename(resolved) };
 throw Error('No recommendations.json or report.pvpteams.json.gz in ' + file);
}
// The three published archives get the names the README uses; anything else is named after its file or directory.
const KNOWN = { 'team-search': 'v1-published', 'team-v3-refined': 'v3-refined', 'team-v2-overnight': 'v2-overnight' };
function labelOf(file) {
 const base = path.basename(file).replace(/\.pvpteams\.json\.gz$|\.json\.gz$|\.json$/i, '');
 return KNOWN[base] || (['recommendations', 'report'].includes(base) ? path.basename(path.dirname(file)) : base);
}

function detectKind(data) {
 if (data?.format === 'pvp-team-report') return 'report';
 if (Array.isArray(data?.rows) && data.rows.length && Array.isArray(data.rows[0].team)) return 'recommendations';
 if (Array.isArray(data?.teams) && data.teams.length && Array.isArray(data.teams[0].team)) return 'archive';
 throw Error('Unrecognised champion file: expected a portable report, a v1 archive (team-search.json) or recommendations.json');
}

const member = p => ({ speciesId: p.speciesId, speciesName: p.speciesName || null, moveset: (p.moveset || []).slice() });
const scoreOf = x => Number.isFinite(x) ? x : null;

// Entries are ordered primary first, then (scope finalists) the other final-tested teams, best final score first.
function extractCompositions(data, kind, scope = 'primary') {
 if (!['primary', 'finalists'].includes(scope)) throw Error('champions scope must be primary or finalists');
 let primary = null, others = [], note = null, info = {};
 if (kind === 'report') {
  reportCore.validate(data);
  const variants = data.table.variants, make = r => ({ members: r.team.map(i => member(variants[i])), finalScore: scoreOf(r.test), team: r.team });
  const rows = data.table.rows, finalists = rows.filter(r => r.finalist && Number.isFinite(r.test));
  const lead = finalists.find(r => r.primary);
  primary = lead ? make(lead) : null;
  others = finalists.filter(r => r !== lead).sort((a, b) => b.test - a.test).map(make);
  if (!primary) note = 'report has no final-tested primary team' + (data.archiveNotice ? ' (' + data.archiveNotice + ')' : '');
  info = { engineVersion: data.engineVersion, finalPanel: data.finalPanel || null, mechanicsHash: data.mechanicsHash, meta: data.meta || null };
 } else if (kind === 'recommendations') {
  const tested = data.rows.filter(r => r.validation);
  primary = data.rows[0].validation ? { members: data.rows[0].team.map(member), finalScore: scoreOf(data.rows[0].validation.score) } : null;
  others = tested.filter(r => r !== data.rows[0]).sort((a, b) => b.validation.score - a.validation.score).map(r => ({ members: r.team.map(member), finalScore: scoreOf(r.validation.score) }));
  if (!primary) note = 'the first recommended team was not final-tested; a training leader is not a champion';
  const seeds = data.rows.flatMap(r => [r.validation?.fixtureSeed, r.screen?.fixtureSeed]).concat((data.baselineResults || []).map(b => b.fixtureSeed));
  info = { engineVersion: data.version || null, poolHash: data.poolHash || null, finalPanel: data.finalPanel || null, usedSeeds: [...new Set(seeds.filter(Number.isInteger))] };
 } else {
  const tested = data.teams.filter(t => t.validation);
  primary = data.teams[0].validation ? { members: data.teams[0].team.map(member), finalScore: scoreOf(data.teams[0].validation.score) } : null;
  others = tested.slice(1).sort((a, b) => b.validation.score - a.validation.score).map(t => ({ members: t.team.map(member), finalScore: scoreOf(t.validation.score) }));
  if (!primary) note = 'the first archived team was not final-tested';
  info = { engineVersion: data.version || null, usedSeeds: [...new Set(data.teams.flatMap(t => [t.validation?.fixtureSeed, t.screen?.fixtureSeed]).filter(Number.isInteger))] };
 }
 const entries = [];
 if (primary) entries.push({ ...primary, role: 'primary', rank: 1 });
 if (scope === 'finalists') others.forEach((o, i) => entries.push({ ...o, role: 'finalist', rank: i + 2 }));
 return { entries, note, info };
}

const normalMoves = moveset => {
 const moves = (moveset || []).filter(id => id && id !== 'none');
 return { fast: moves[0] || '', charged: moves.slice(1).sort() };
};
const exactSignature = p => p.speciesId + '|' + (p.moveset || []).join('|');
const looseSignature = p => { const m = normalMoves(p.moveset); return p.speciesId + '|' + m.fast + '|' + m.charged.join('|'); };

// Index the pool's variants once; mapMembers() then resolves a composition in constant time per member.
function indexPool(pool) {
 if (pool._championIndex) return pool._championIndex;
 const exact = new Map(), loose = new Map(), species = new Map();
 pool.variants.forEach((v, i) => {
  if (!exact.has(exactSignature(v))) exact.set(exactSignature(v), i);
  const k = looseSignature(v); if (!loose.has(k)) loose.set(k, i);
  species.set(v.speciesId, (species.get(v.speciesId) || 0) + 1);
 });
 const index = { exact, loose, species };
 Object.defineProperty(pool, '_championIndex', { value: index, enumerable: false });
 return index;
}

// Map one composition (three {speciesId, moveset}) to the pool's variant indices, lead first.
// Returns {team, mapping} or {reason, detail, mapping} when a species or moveset is not retained in the pool.
function mapToPool(members, pool) {
 const index = indexPool(pool), mapping = [], team = [];
 if (!Array.isArray(members) || members.length !== 3) return { reason: 'not-a-team', detail: 'a team has three members', mapping };
 for (const m of members) {
  const base = { speciesId: m.speciesId, moveset: m.moveset };
  if (!index.species.has(m.speciesId)) { mapping.push({ ...base, variant: null, match: 'species-not-in-pool' }); continue; }
  let i = index.exact.get(exactSignature(m)), match = 'exact';
  if (i === undefined) { i = index.loose.get(looseSignature(m)); match = 'charged-order'; }
  if (i === undefined) { mapping.push({ ...base, variant: null, match: 'moveset-not-in-pool', retained: index.species.get(m.speciesId) }); continue; }
  mapping.push({ ...base, variant: i, match }); team.push(i);
 }
 const missing = mapping.filter(x => x.variant === null);
 if (missing.length) {
  const first = missing[0];
  return { reason: first.match, detail: first.match === 'species-not-in-pool' ? first.speciesId + ' is not in the current pool' : first.speciesId + ' with ' + (first.moveset || []).filter(id => id !== 'none').join(' / ') + ' is not among the pool\'s ' + first.retained + ' retained movesets for that species', mapping };
 }
 if (!validTeam(team, pool.variants)) return { reason: 'species-clause', detail: 'two members share a Pokédex number', mapping };
 return { team, mapping };
}

const specList = spec => (Array.isArray(spec) ? spec : String(spec || '').split(',')).map(s => s.trim()).filter(Boolean);

// Resolve a --champions specification against the current pool. Identical compositions (same lead, same bench
// set, same variants) are merged and keep every source that supplied them.
function loadChampions(spec, pool, { scope = 'primary' } = {}) {
 const teams = [], skipped = [], sources = [], byKey = new Map();
 for (const item of specList(spec)) {
  if (item === 'none') continue;
  const source = resolveSource(item), data = readJson(source.file), kind = detectKind(data), { entries, note, info } = extractCompositions(data, kind, scope);
  sources.push({ file: source.file, label: source.label, kind, engineVersion: info.engineVersion || null, poolHash: info.poolHash || null, poolHashMatches: info.poolHash ? info.poolHash === pool.hash : null, candidates: entries.length, usedSeeds: info.usedSeeds || [], note });
  if (!entries.length) skipped.push({ source: source.label, label: source.label, role: 'primary', reason: 'no-champion', detail: note || 'source has no final-tested team' });
  for (const e of entries) {
   const label = e.role === 'primary' ? source.label : source.label + '#' + e.rank, mapped = mapToPool(e.members, pool);
   if (!mapped.team) { skipped.push({ source: source.label, label, role: e.role, reason: mapped.reason, detail: mapped.detail, members: mapped.mapping }); continue; }
   const key = teamKey(mapped.team), origin = { source: source.label, role: e.role, rank: e.rank, finalScore: e.finalScore };
   if (byKey.has(key)) { byKey.get(key).sources.push(origin); continue; }
   const champion = { team: mapped.team, label, sources: [origin], members: mapped.mapping.map((m, i) => ({ ...m, speciesName: pool.variants[mapped.team[i]].speciesName })) };
   byKey.set(key, champion); teams.push(champion);
  }
 }
 return { scope, teams, skipped, sources, fingerprint: teams.length ? digest(teams.map(c => teamKey(c.team))).slice(0, 16) : null };
}

// Completed runs under runsDir whose pool matches and whose final panel is large enough to be a real result
// (smoke-scale runs never become champions). Oldest first, so the list is stable between launches.
function discoverRuns(runsDir, pool, { minFixtures = 256, exclude = [] } = {}) {
 if (!fs.existsSync(runsDir)) return [];
 const skip = new Set(exclude.map(d => path.resolve(d))), found = [];
 for (const name of fs.readdirSync(runsDir)) {
  const dir = path.join(runsDir, name), file = path.join(dir, 'recommendations.json');
  if (skip.has(path.resolve(dir)) || !fs.existsSync(file)) continue;
  let rec; try { rec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
  if (rec.poolHash !== pool.hash || !rec.finalPanel?.complete || !(rec.finalPanel.completedFixtures >= minFixtures) || !rec.rows?.[0]?.validation) continue;
  found.push({ dir, file, mtime: fs.statSync(file).mtimeMs });
 }
 return found.sort((a, b) => a.mtime - b.mtime || a.dir.localeCompare(b.dir));
}

// What launch-next.cjs supplies: the published v1 and v3 primaries, then every completed matching run.
function defaultChampionSources(webRoot, pool, { exclude = [], minFixtures = 256 } = {}) {
 const data = path.join(webRoot, 'includes/pro/data'), list = [];
 for (const name of ['team-search.json', 'team-v3-refined.pvpteams.json.gz']) if (fs.existsSync(path.join(data, name))) list.push(path.join(data, name));
 for (const run of discoverRuns(path.join(webRoot, 'training/runs'), pool, { exclude, minFixtures })) list.push(run.dir);
 return list;
}

const names = (team, variants) => team.map(i => variants[i].speciesName);
const sameMembers = (a, b) => [...a].sort().join() === [...b].sort().join();

// The previous champions against the primary on the same sealed final panel. The group comparison in
// state.comparisons answers "is the primary above the champions on average"; this answers it champion by champion,
// with one simultaneous band, and says plainly when the primary is a champion again (rediscovery is a tie).
function championComparisons(primary, baselineResults, champions, { seed = 1, samples = 5000 } = {}) {
 if (!primary || !champions?.teams?.length) return null;
 const rows = (baselineResults || []).filter(b => b.kind === GROUP);
 if (!rows.length) return null;
 const info = new Map(champions.teams.map(c => [teamKey(c.team), c])), primaryKey = teamKey(primary.team);
 const distinct = [...new Map(rows.filter(r => teamKey(r.team) !== primaryKey).map(r => [teamKey(r.team), r])).values()];
 const simultaneous = distinct.length ? compareFinalists(primary, distinct, { seed, samples }) : null;
 const entries = rows.map(row => {
  const key = teamKey(row.team), c = info.get(key) || {}, base = { team: row.team, label: c.label || null, sources: c.sources || [], score: row.score, games: row.games };
  if (key === primaryKey) return { ...base, sameTeam: true, sameMembers: true, delta: 0, interval95: [0, 0], verdict: 'same-team' };
  const found = simultaneous.comparisons.find(x => teamKey(x.team) === key);
  return { ...base, sameTeam: false, sameMembers: sameMembers(row.team, primary.team), delta: found.delta, interval95: found.interval95, verdict: found.distinguishable };
 });
 const worse = entries.some(e => e.verdict === 'challenger-better'), unresolved = entries.some(e => e.verdict === 'unresolved'), same = entries.some(e => e.sameTeam);
 const outcome = worse ? 'champion-better' : unresolved ? 'unresolved' : same ? 'tie-rediscovered' : 'primary-better';
 const summary = {
  'champion-better': 'At least one previous champion scored clearly above the new primary on this panel.',
  unresolved: 'The new primary is not clearly separated from at least one previous champion on this panel; a difference inside the interval is a tie.',
  'tie-rediscovered': 'The search selected a previous champion again (a tie by construction); the other champions are clearly below it.',
  'primary-better': 'The new primary scored clearly above every previous champion on this panel.',
 }[outcome];
 return { fixtures: simultaneous?.fixtures ?? primary.pairs.length, outcome, summary, entries, rediscovered: same, method: 'simultaneous paired opponent-fixture bootstrap against each distinct previous champion; same sealed final panel as the primary; champions were fixed before the test' };
}

// Rows for report.html / findings.md.
function championRows(state, pool) {
 const comparison = state.championComparisons;
 if (!state.champions?.teams?.length || !comparison) return [];
 return comparison.entries.map(e => ({ ...e, names: names(e.team, pool.variants) }));
}

module.exports = { GROUP, readJson, resolveSource, detectKind, extractCompositions, mapToPool, loadChampions, discoverRuns, defaultChampionSources, championComparisons, championRows, indexPool };

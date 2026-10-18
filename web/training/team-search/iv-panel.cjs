'use strict';
// IV-build panel (README sections 7 and 12; findings/moveset-iv.md).
//
// The search plays every Pokemon on the engine's default IVs for the league (PvPoke's default spread). A finalist whose
// score depends on that spread is less robust than its number says, and a different spread within the CP cap might be better.
// After the final test and every other post-final panel (confirmation, policy panel, alternate panel, sensitivity; this panel
// runs last) --iv-panel N replays the final-tested finalists on one sealed panel of N fixtures drawn from the run's own meta,
// once per IV build, on the same opponents and battle seeds:
//   default   the engine's own spread (the reference; no override is sent, so it reproduces the final test's engine path)
//   rank1     rank-1 stat product within the 1,500 CP cap
//   attack    the highest attack stat the cap allows (ties by stat product)
//   bulk      the highest defence times HP the cap allows (ties by stat product)
// Every member of the team plays the same build kind; builds come from the engine's own IV combinations (level cap, IV floors),
// so each is at or under the cap. The comparison is paired by fixture with a simultaneous 95% band over the arms
// (next/policy-panel.cjs summarizeTeam). It is a read-out; it never changes the primary. Opponents stay on default IVs.
const {teamKey, guardedSeed} = require('./common.cjs');
const {opponentFixtureKey} = require('./acquisition.cjs');
const {summarizeTeam: summarizeStyles} = require('../next/policy-panel.cjs');
const pools = require('./engine-pools.cjs');

const SEED_OFFSET = 850001, BOOTSTRAP_OFFSET = 850002, MAX_FIXTURES = 4096, SCHEMA = 1, DEFAULT = 'default', ARMS = pools.BUILD_IDS;
const LABEL = {default: 'Default IVs', rank1: 'Rank-1 stat product', attack: 'Attack-weighted', bulk: 'Bulk-weighted (defence x HP)'};

function checkSize(n) {
 if (!Number.isInteger(n) || n < 0 || n > MAX_FIXTURES) throw Error('iv-panel must be an integer from 0 to ' + MAX_FIXTURES + ' (0 disables)');
 return n;
}
function panelSeed(seed, reserved = []) { return guardedSeed(seed + SEED_OFFSET, reserved.filter(Number.isInteger)); }
// The mechanics id of a run with the option on; the default adds nothing, so the registered v4 id is unchanged.
function suffix(opts = {}) { return opts.ivPanel ? '+iv-panel:builds=' + ARMS.join('|') : ''; }

const cache = new Map();
const buildsOf = speciesId => { if (!cache.has(speciesId)) cache.set(speciesId, pools.builds(speciesId));return cache.get(speciesId); };
const sameBuild = (a, b) => a.atk === b.atk && a.def === b.def && a.hp === b.hp && a.level === b.level;

// Sealed fixtures from the run's meta; none may share a fixture with another panel or the training evidence.
function plan(meta, {fixtures, seed, sealed = [], observations = [], evidenceSeeds = []} = {}) {
 checkSize(fixtures);
 if ((evidenceSeeds || []).map(s => s >>> 0).includes(seed >>> 0)) throw Error('IV-panel seed ' + seed + ' was an evaluation seed of absorbed evidence; choose a fresh validation-seed');
 const cases = meta.fixtures(fixtures, seed), keys = new Set(cases.map(c => opponentFixtureKey(c.team, c.seed)));
 for (const panel of sealed) for (const c of panel) if (keys.has(opponentFixtureKey(c.team, c.seed))) throw Error('IV-panel fixtures overlap a sealed or retest panel; choose another validation-seed');
 const battleSeeds = new Set(cases.map(c => c.seed));
 for (const o of observations) if (battleSeeds.has(o.seed) && keys.has(opponentFixtureKey(o.opponent, o.seed))) throw Error('IV-panel fixtures overlap inherited training evidence; choose a fresh validation-seed');
 return {fixtures, seed, cases, arms: ARMS.slice(), armCount: ARMS.length, battles: teamCount => teamCount * fixtures * ARMS.length};
}

// The teams to play: for every finalist (in order) one team per arm, arms in ARMS order. The `default` arm is the finalist's own
// team; the others are copies of its variants carrying `ivBuild`, appended to `variants` (the caller truncates them afterwards).
// Returns {teams, members}: teams.length === finalists.length * ARMS.length; members[f] describes finalist f's builds.
function armTeams(finalists, variants, builds = buildsOf) {
 const teams = [], members = [], made = new Map();
 const variantFor = (index, arm, build) => {
  const key = index + '|' + arm;
  if (!made.has(key)) { const base = variants[index];made.set(key, variants.length);variants.push({...base, index: variants.length, ivs: {atk: build.atk, def: build.def, hp: build.hp}, level: build.level, cp: build.cp, ivBuild: {...build}, ivBuildId: arm}); }
  return made.get(key);
 };
 finalists.forEach(team => {
  const info = team.map(i => ({variant: i, speciesId: variants[i].speciesId, builds: builds(variants[i].speciesId)}));
  for (const m of info) for (const arm of ARMS) if (m.builds[arm] && !(m.builds[arm].cp <= pools.CP)) throw Error('IV build ' + arm + ' of ' + m.speciesId + ' exceeds the CP cap');
  members.push(info.map(m => ({variant: m.variant, speciesId: m.speciesId, builds: Object.fromEntries(ARMS.filter(a => m.builds[a]).map(a => [a, m.builds[a]])), changed: Object.fromEntries(ARMS.slice(1).map(a => [a, !!m.builds[a] && !sameBuild(m.builds[a], m.builds[DEFAULT])]))})));
  for (const arm of ARMS) teams.push(arm === DEFAULT ? team.slice() : team.map((i, s) => info[s].builds[arm] ? variantFor(i, arm, info[s].builds[arm]) : i));
 });
 return {teams, members};
}

// Search side: `rows` are the common-panel scores of evaluate() over `armTeams().teams` on the plan's cases. Returns {block, raw} or
// null when not even one whole fixture finished on every team. `finalists` = [{team, primary, finalScore}].
function assemble(info, finalists, members, rows, {seed = 1, samples = 5000} = {}) {
 const A = info.armCount, total = rows?.length === finalists.length * A ? Math.min(...rows.map(r => r.scores.length)) : 0;
 if (!total) return null;
 const styles = ARMS.map(name => ({name})), raw = {};
 const teams = finalists.map((t, ti) => {
  const arm = ARMS.map((_, k) => rows[ti * A + k].scores.slice(0, total));
  raw[teamKey(t.team)] = Object.fromEntries(ARMS.map((name, k) => [name, arm[k]]));
  const s = summarizeStyles(arm, styles, {seed: (seed + ti) >>> 0, samples}), deltas = s.versusDefault.map(v => ({arm: v.style, delta: v.delta, interval95: v.interval95, verdict: v.verdict}));
  let worst = deltas[0], best = deltas[0];for (const d of deltas) { if (d.delta < worst.delta) worst = d;if (d.delta > best.delta) best = d; }
  return {team: t.team, primary: !!t.primary, finalScore: Number.isFinite(t.finalScore) ? t.finalScore : null, members: members[ti], scores: s.scores, deltas, worstArm: worst.arm, worstDelta: worst.delta, bestArm: best.arm, bestDelta: best.delta, bandRadius: s.bandRadius};
 });
 const block = {
  version: SCHEMA, requestedFixtures: info.fixtures, fixtures: total, complete: total === info.fixtures, seed: info.seed, exploratory: total < 256,
  reference: {id: DEFAULT, label: LABEL[DEFAULT]}, arms: ARMS.slice(1).map(id => ({id, label: LABEL[id]})), cpCap: pools.CP, teams,
  method: 'The finalists replayed ' + total + ' sealed fixtures of the run\'s own opponent meta (a seed derived from the run seed and guarded against every other panel) once per IV build on the same opponents and battle seeds: the engine\'s default spread, the rank-1 stat product, the highest attack and the highest defence times HP that the ' + pools.CP + ' CP cap allows, every member of the team on the same build kind (opponents stay on default IVs). Differences are paired by fixture with a simultaneous 95% band over the arms. It is a read-out after the final test and every other panel; it does not change the primary.',
 };
 return {block, raw};
}

// ---- text ------------------------------------------------------------------------------------------------------------
const pct = x => Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '—';
const signed = x => (x >= 0 ? '+' : '−') + (100 * Math.abs(x)).toFixed(1);
const band = i => '[' + signed(i[0]) + ', ' + signed(i[1]) + ']';
function caption(block, nameOf = () => '') {
 const first = block.teams[0];if (!first) return '';
 const changed = block.arms.map(a => a.id + ' ' + first.members.filter(m => m.changed[a.id]).length + '/' + first.members.length).join(', ');
 const gains = block.teams.map(t => t.bestDelta), losses = block.teams.map(t => t.worstDelta);
 return 'IV builds (' + block.fixtures + ' common fixtures, after every other panel): ' + nameOf(first.team) + ' scored ' + pct(first.scores[DEFAULT]) + ' on the default IVs, ' + block.arms.map(a => pct(first.scores[a.id]) + ' (' + signed(first.deltas.find(d => d.arm === a.id).delta) + ' pp) on the ' + a.id + ' build').join(', ')
  + ' (members whose build differs from the default: ' + changed + ')' + (block.teams.length > 1 ? '; across finalists the best arm changed the score by ' + signed(Math.min(...gains)) + ' to ' + signed(Math.max(...gains)) + ' pp and the worst by ' + signed(Math.min(...losses)) + ' to ' + signed(Math.max(...losses)) + ' pp' : '') + '. '
  + (block.exploratory ? 'Exploratory: fewer than 256 fixtures. ' : '') + 'A score that holds across builds does not depend on the default spread; a gain is a candidate for a build recommendation, not a finding, until it is resolved.';
}
function describe(block, nameOf) {
 const header = ['Finalist', block.reference.label, ...block.arms.flatMap(a => [a.label, 'Change (simultaneous 95%)'])];
 const rows = block.teams.map(t => [(t.primary ? 'Primary · ' : '') + nameOf(t.team), pct(t.scores[DEFAULT]), ...block.arms.flatMap(a => { const d = t.deltas.find(x => x.arm === a.id);return [pct(t.scores[a.id]), signed(d.delta) + ' pp ' + band(d.interval95) + (d.verdict === 'unresolved' ? '' : ' ' + d.verdict)]; })]);
 return {header, rows};
}
function html(state, pool, {escape}) {
 const block = state.ivPanel;if (!block?.teams?.length) return '';
 const name = team => team.map(i => pool.variants[i].speciesName).join(' · '), {header, rows} = describe(block, name);
 return '<h2>IV builds</h2><p>' + escape(caption(block, name)) + '</p><div class="scroll"><table><thead><tr>' + header.map(h => '<th>' + escape(h) + '</th>').join('') + '</tr></thead><tbody>'
  + rows.map((r, i) => '<tr class="' + (i === 0 ? 'primary' : '') + '">' + r.map(c => '<td>' + escape(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div><p>' + escape(block.method) + '</p>';
}
function markdown(state, pool) {
 const block = state.ivPanel;if (!block?.teams?.length) return '';
 const name = team => team.map(i => pool.variants[i].speciesName).join(' / ');
 return '\n' + caption(block, name) + '\n' + block.teams.map(t => '- ' + (t.primary ? 'Primary · ' : '') + name(t.team) + ': ' + pct(t.scores[DEFAULT]) + ' default; ' + t.deltas.map(d => d.arm + ' ' + signed(d.delta) + ' pp ' + band(d.interval95)).join('; ')).join('\n') + '\n';
}
// search.cjs: the finalists, in order, with the primary first.
const teamsFor = state => state.validations.map((v, i) => ({team: v.team, primary: i === 0, finalScore: v.score}));
module.exports = {checkSize, panelSeed, suffix, plan, armTeams, assemble, caption, describe, html, markdown, teamsFor, buildsOf, sameBuild, SEED_OFFSET, BOOTSTRAP_OFFSET, SCHEMA, ARMS, LABEL};

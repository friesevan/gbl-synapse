'use strict';
// Moveset mutation (README sections 7 and 12; findings/moveset-iv.md).
//
// Preparation scouts every legal moveset 1-v-1 and keeps the best five per species. A moveset that is only good inside a
// particular team can therefore never be played. With --moveset-mutation N the search tries, for each of the best
// --mutation-teams screened teams, N swaps of one member's moveset to a legal combination outside that species' retained five:
//   * the combination comes from the engine's own pools (engine-pools.cjs, the source of preparation's 12,335 combinations);
//   * the proposal changes one move of the member (the fast move, or one charged move), spread round-robin over the members,
//     in an order fixed by the run seed;
//   * the swapped team plays the same screening fixtures as its parent, so the comparison is paired by fixture;
//   * a swap is kept only if the paired mean difference exceeds --mutation-margin (default 0), and at most the best kept swap
//     of a parent enters the screened set. Every proposal is recorded with its paired interval, kept or not.
// Screening is a selection stage: the finalists still play the sealed final panel, so a swap that only won by luck on the
// screening fixtures is measured honestly there (finalCheck compares a kept swap with its parent when both are finalists).
// Mutated variants are appended after the pool's own variants (indices at or beyond the pool size) and are stored in the
// checkpoint, so reports and replays read them like any other variant. Off by default; nothing here runs without the flag.
const {teamKey, digest} = require('./common.cjs');
const {sameMoveset} = require('./observed-moves.cjs');
const {summarize, compare} = require('./evaluation.cjs');
const {random} = require('../utils.cjs');
const pools = require('./engine-pools.cjs');

const SCHEMA = 1, MAX_SWAPS = 64, BOOTSTRAP_OFFSET = 850101, DEFAULT_TEAMS = 4;

function checkOptions(opts = {}, screenTeams = Infinity) {
 const swaps = opts.movesetMutation ?? 0, teams = opts.mutationTeams ?? DEFAULT_TEAMS, margin = opts.mutationMargin ?? 0;
 if (!Number.isInteger(swaps) || swaps < 0 || swaps > MAX_SWAPS) throw Error('moveset-mutation must be an integer from 0 to ' + MAX_SWAPS + ' (0 disables)');
 if (!Number.isInteger(teams) || teams < 1 || teams > 24) throw Error('mutation-teams must be an integer from 1 to 24');
 if (!Number.isFinite(margin) || margin < 0 || margin > .25) throw Error('mutation-margin must be a number from 0 to 0.25 (a score difference, 0.01 = one point)');
 return {swaps, teams: Math.min(teams, screenTeams), margin};
}
// The mechanics id of a run with the option on; the default adds nothing, so the registered v4 id is unchanged.
function suffix(opts = {}) {
 const swaps = opts.movesetMutation ?? 0;
 if (!swaps) return '';
 return '+moveset-mutation:swaps=' + swaps + ',teams=' + (opts.mutationTeams ?? DEFAULT_TEAMS) + ',margin=' + (opts.mutationMargin ?? 0);
}

// Moves that differ between two movesets of one species: the fast move counts one, the charged moves are compared as a set.
function distance(a, b) {
 const charged = m => m.slice(1).filter(x => x && x !== 'none');
 const ca = charged(a), cb = charged(b);
 return (a[0] === b[0] ? 0 : 1) + cb.filter(x => !ca.includes(x)).length;
}
// Legal movesets of the member's species outside the retained variants, nearest to its own moveset first-class (one move different).
function alternatives(retained, variant) {
 const own = retained.filter(v => v.speciesId === variant.speciesId).map(v => v.moveset);
 return pools.legalMovesets(variant.speciesId).filter(m => !own.some(o => sameMoveset(o, m)) && !sameMoveset(m, variant.moveset));
}
// Seeded Fisher-Yates over a copy.
function shuffled(list, r) {
 const out = list.slice();
 for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
 return out;
}
// Up to `count` swaps for one team: [{slot, to}] with one move changed, round-robin over the members. A member with no
// single-move neighbour outside its retained five falls back to any legal alternative.
function propose(team, variants, poolSize, {seed = 1, count = 1} = {}) {
 const retained = variants.slice(0, poolSize), r = random(parseInt(digest(['moveset-mutation', seed, teamKey(team)]).slice(0, 8), 16) >>> 0);
 const lists = team.map(i => { const v = variants[i], all = alternatives(retained, v), near = all.filter(m => distance(v.moveset, m) === 1);return shuffled(near.length ? near : all, r); });
 const out = [], cursor = team.map(() => 0);
 while (out.length < count && lists.some((l, s) => cursor[s] < l.length)) for (let s = 0; s < team.length && out.length < count; s++) if (cursor[s] < lists[s].length) out.push({slot: s, to: lists[s][cursor[s]++]});
 return out;
}
// A new variant: the parent's member with another moveset. Its scout score was never measured, so it is null.
function mutant(base, moveset, index) {
 return {...base, index, moveset: moveset.slice(), recommended: false, projection: null, scoutScore: null, mutated: true, mutatedFrom: base.index};
}

// The search stage. `parents` = [{team, scores}] in order of screening score; `variants` is the search's variant list, which the
// stage extends. `evaluate(teams, cases, limit, onTeam, {commonPanel:true})` is the search's evaluator.
async function refine({variants, poolSize, parents, screening, screenSeed, evaluate, limit, seed, swaps, margin, bootstrapSeed, log = () => {}}) {
 const candidates = [], seen = new Set(parents.map(p => teamKey(p.team)));
 parents.forEach((parent, pi) => {
  for (const {slot, to} of propose(parent.team, variants, poolSize, {seed, count: swaps})) {
   const from = variants[parent.team[slot]], team = parent.team.slice();
   const key = from.speciesId + '|' + to.join('|');
   let index = candidates.find(c => c.variantKey === key && c.baseIndex === from.index)?.variantIndex;
   if (index === undefined) { index = variants.length;variants.push(mutant(from, to, index)); }
   team[slot] = index;
   const k = teamKey(team);
   if (seen.has(k)) continue;
   seen.add(k);
   candidates.push({parent: pi, slot, team, variantIndex: index, variantKey: key, baseIndex: from.index, from: from.moveset.slice(), to: to.slice(), speciesId: from.speciesId});
  }
 });
 const block = {version: SCHEMA, requested: {swaps, teams: parents.length, margin}, proposals: candidates.length, kept: 0, selected: 0, fixtures: 0, complete: false, events: [], variants: [], accepted: []};
 if (!candidates.length) { block.variants = variants.slice(poolSize);return {block, accepted: []}; }
 log('Moveset mutation: ' + candidates.length + ' swaps of ' + parents.length + ' screened teams on ' + screening.length + ' screening fixtures…');
 const rows = await evaluate(candidates.map(c => c.team), screening, limit, () => {}, {commonPanel: true}), byKey = new Map(rows.map(r => [teamKey(r.team), r]));
 const best = new Map();
 candidates.forEach(c => {
  const row = byKey.get(teamKey(c.team)), parent = parents[c.parent], n = row ? Math.min(row.scores.length, parent.scores.length) : 0;
  const event = {parent: parent.team.slice(), slot: c.slot, speciesId: c.speciesId, from: c.from, to: c.to, team: c.team.slice(), fixtures: n, delta: null, interval95: null, kept: false, selected: false, final: null};
  if (n) {
   const a = summarize(row.scores.slice(0, n), {team: c.team, fixtureSeed: screenSeed, kind: 'mutation', paired: false}), b = summarize(parent.scores.slice(0, n), {team: parent.team, fixtureSeed: screenSeed, kind: 'mutation', paired: false});
   const cmp = compare(a, [b], {seed: bootstrapSeed + c.parent});
   Object.assign(event, {delta: cmp.delta, interval95: cmp.interval95, kept: cmp.delta > margin, scores: row.scores.slice(0, n)});
   block.fixtures = Math.max(block.fixtures, n);
   if (event.kept && (!best.has(c.parent) || event.delta > best.get(c.parent).delta)) best.set(c.parent, event);
  }
  block.events.push(event);
 });
 block.kept = block.events.filter(e => e.kept).length;block.complete = block.fixtures === screening.length;
 const accepted = [...best.values()].map(e => { e.selected = true;return {team: e.team, scores: e.scores}; });
 block.selected = accepted.length;
 for (const e of block.events) delete e.scores;
 block.variants = variants.slice(poolSize);
 block.method = 'Each of the ' + parents.length + ' best screened teams tried up to ' + swaps + ' swaps of one member to a legal moveset outside the species\' retained five, one move different from the member\'s own, chosen in an order fixed by the run seed. The swapped team replayed the parent\'s ' + block.fixtures + ' screening fixtures (paired by fixture); a swap was kept if its mean difference exceeded ' + (100 * margin).toFixed(1) + ' points, and the best kept swap of each parent joined the screened set. Screening is a selection stage: the kept swaps\' interval is not corrected for the number tried, and the sealed final panel is the measurement.';
 return {block, accepted};
}

// After the final test: a kept swap whose parent was also a finalist is compared with it on the sealed final fixtures.
function finalCheck(block, validations, {seed = 1} = {}) {
 if (!block?.events) return block;
 const byKey = new Map(validations.map(v => [teamKey(v.team), v]));
 block.events.forEach((e, i) => {
  const a = byKey.get(teamKey(e.team)), b = byKey.get(teamKey(e.parent));
  if (!e.selected || !a || !b || a.pairs.length !== b.pairs.length) { e.final = null;return; }
  const c = compare(a, [b], {seed: seed + i});
  e.final = {delta: c.delta, interval95: c.interval95, fixtures: c.fixtures, resolved: c.interval95[0] > 0 ? 'swap-better' : c.interval95[1] < 0 ? 'parent-better' : 'unresolved'};
 });
 block.finalists = block.events.filter(e => e.final).length;
 return block;
}
// The compact record for recommendations.json and reports (the variants live in the checkpoint).
const compact = block => { if (!block) return null;const {variants, accepted, ...rest} = block;return rest; };

const signed = x => Number.isFinite(x) ? (x >= 0 ? '+' : '−') + (100 * Math.abs(x)).toFixed(1) : '—';
const band = i => Array.isArray(i) ? '[' + signed(i[0]) + ', ' + signed(i[1]) + ']' : '';
function caption(block) {
 if (!block?.events?.length) return '';
 const withFinal = block.events.filter(e => e.final);
 return 'Moveset mutation (' + block.proposals + ' swaps of one member to a legal moveset outside the retained five, on ' + block.fixtures + ' screening fixtures): ' + block.kept + ' kept, ' + block.selected + ' entered the screened set'
  + (withFinal.length ? '; on the sealed final panel ' + withFinal.map(e => signed(e.final.delta) + ' pp ' + band(e.final.interval95) + ' against its parent').join(', ') : '; no kept swap reached the final panel beside its parent')
  + '. ' + (block.fixtures < 256 ? 'Exploratory: fewer than 256 screening fixtures. ' : '') + 'A kept swap is the best of several noisy looks; only the sealed comparison counts.';
}
function rows(block, nameOf) {
 return block.events.map(e => [nameOf(e.team[e.slot]) + ' (slot ' + (e.slot + 1) + ')', e.from.join(' / '), e.to.join(' / '), signed(e.delta) + ' pp ' + band(e.interval95), e.kept ? (e.selected ? 'kept, entered screening' : 'kept') : 'dropped', e.final ? signed(e.final.delta) + ' pp ' + band(e.final.interval95) : '—']);
}
const HEADER = ['Member', 'Retained moveset', 'Swapped to', 'Screening change (paired 95%)', 'Decision', 'Final panel vs parent (paired 95%)'];
function html(state, pool, {escape}) {
 const block = state.movesetMutation;if (!block?.events?.length) return '';
 const name = i => pool.variants[i].speciesName;
 return '<h2>Moveset mutation</h2><p>' + escape(caption(block)) + '</p><div class="scroll"><table><thead><tr>' + HEADER.map(h => '<th>' + escape(h) + '</th>').join('') + '</tr></thead><tbody>'
  + rows(block, name).map(r => '<tr>' + r.map(c => '<td>' + escape(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div><p>' + escape(block.method || '') + '</p>';
}
function markdown(state, pool) {
 const block = state.movesetMutation;if (!block?.events?.length) return '';
 return '\n' + caption(block) + '\n' + rows(block, i => pool.variants[i].speciesName).map(r => '- ' + r[0] + ': ' + r[1] + ' → ' + r[2] + '; screening ' + r[3] + '; ' + r[4] + '; final vs parent ' + r[5]).join('\n') + '\n';
}
module.exports = {checkOptions, suffix, distance, alternatives, propose, mutant, refine, finalCheck, compact, caption, html, markdown, SCHEMA, BOOTSTRAP_OFFSET, DEFAULT_TEAMS, MAX_SWAPS};

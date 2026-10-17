'use strict';
// Observed opponent movesets (README section 4, findings/opponent-movesets.md).
//
// The usage file may carry, per team row, `movesets`: for each member (lead first, the same order as `members`) null or
// {fast, charged}: the fast move the Meta Extractor observed and the charged moves it saw that Pokemon use. With
// --observed-moves the opponents of the observed component play those movesets (missing slots filled from the published
// recommended moveset); everything else, and every run without the flag, keeps the recommended movesets.
//
// This module holds the pure parts: the legal move pools, turning an observation into a full moveset, the identity tag
// that keeps fixtures with different movesets apart, and the model features of an opponent with an observed moveset.
const {TYPES} = require('./common.cjs');
const TAG = '@';
const STAB = 1.2000000476837158203125, SHADOW_ATK = 1.2;
let book;

function gameMaster() {
 if (!book) {
  const gm = require('../../includes/pro/data/gamemaster.json');
  book = {moves: new Map(gm.moves.map(m => [m.moveId, m])), species: new Map(gm.pokemon.map(p => [p.speciesId, p])), pools: new Map()};
 }
 return book;
}

// The legal pools of one species, built the way vendor/Pokemon.js builds them: fastMoves; chargedMoves and
// extraChargedMoves; Return for a Shadow-eligible species that reaches level 25 by 1,500 CP; Frustration for a Shadow
// species. Returns {fast:Set, charged:Set} or null for an unknown species.
function movePools(speciesId) {
 const {moves, species, pools} = gameMaster();
 if (pools.has(speciesId)) return pools.get(speciesId);
 const p = species.get(speciesId);
 let out = null;
 if (p) {
  const tags = p.tags || [], charged = [...(p.chargedMoves || []), ...(p.extraChargedMoves || [])];
  if (tags.includes('shadoweligible') && p.level25CP <= 1500) charged.push('RETURN');
  if (tags.includes('shadow')) charged.push('FRUSTRATION');
  const fast = new Set((p.fastMoves || []).filter(id => moves.has(id))), strong = new Set(charged.filter(id => moves.has(id)));
  out = {fast, charged: strong};
 }
 pools.set(speciesId, out);
 return out;
}

const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
const sameMoveset = (a, b) => a[0] === b[0] && sameSet(a.slice(1).filter(m => m && m !== 'none'), b.slice(1).filter(m => m && m !== 'none'));

// Structure and legality of one member's observation: null, or {fast: id|null, charged: [ids]}. Throws on anything else.
function validateEntry(speciesId, entry, label = 'Observed moveset') {
 if (entry === null || entry === undefined) return null;
 const pools = movePools(speciesId);
 if (!pools) throw Error(label + ' for unknown species ' + speciesId);
 if (typeof entry !== 'object' || Array.isArray(entry)) throw Error(label + ' for ' + speciesId + ' must be null or {fast, charged}');
 const {fast = null, charged = []} = entry;
 if (fast !== null && typeof fast !== 'string') throw Error(label + ' for ' + speciesId + ': fast must be a move id or null');
 if (!Array.isArray(charged) || charged.length > 3 || charged.some(m => typeof m !== 'string')) throw Error(label + ' for ' + speciesId + ': charged must be an array of at most three move ids');
 if (fast !== null && !pools.fast.has(fast)) throw Error(label + ' for ' + speciesId + ': ' + fast + ' is not a legal fast move');
 for (const m of charged) if (!pools.charged.has(m)) throw Error(label + ' for ' + speciesId + ': ' + m + ' is not a legal charged move');
 const unique = [...new Set(charged)];
 if (unique.length > 2) throw Error(label + ' for ' + speciesId + ': more than two distinct charged moves');
 return {fast, charged: unique};
}

// A full moveset from an observation and the published recommended moveset ([fast, charged, charged]): the observed fast
// move (else the recommended one), the observed charged moves, and the first recommended charged moves not already present
// for the remaining slots. Charged moves are in alphabetical order, except that a result with the recommended pair keeps the
// recommended order, so an observation equal to the recommendation is the recommended moveset itself.
function resolveMoveset(recommended, entry) {
 if (!entry || (entry.fast === null && !entry.charged.length)) return recommended.slice();
 const chargedRec = recommended.slice(1, 3).filter(m => m && m !== 'none'), charged = entry.charged.slice(0, 2);
 for (const m of chargedRec) if (charged.length < 2 && !charged.includes(m)) charged.push(m);
 const ordered = sameSet(charged, chargedRec) ? chargedRec : charged.sort();
 return [entry.fast ?? recommended[0], ...ordered, ...recommended.slice(3)];
}

// Identity: a fixture opponent member with an observed moveset is "speciesId@FAST/CHARGED/CHARGED". A member that plays the
// recommended moveset is its plain species id, so fixtures without observed moves keep their identity.
const tag = (speciesId, moveset) => speciesId + TAG + moveset.join('/');
function parseTag(id) {
 const at = String(id).indexOf(TAG);
 return at < 0 ? {speciesId: String(id), moveset: null} : {speciesId: id.slice(0, at), moveset: id.slice(at + 1).split('/')};
}
// The identity string of a fixture opponent member (a species row, or an id string already).
const memberId = p => typeof p === 'string' ? p : p.observedMoveset ? tag(p.speciesId, p.moveset) : p.speciesId;
const opponentIds = team => team.map(memberId);

// meta.cjs: one usage row. `team` holds the row's species rows in file order, `canonical` the same rows lead first with the
// bench sorted by species id, `movesets` the row's optional per-member observations in file order. Returns the movesets in
// canonical order as {movesets: null | full moveset (null = plays the recommended moveset), entries: the validated observation}.
function arrange(team, canonical, movesets) {
 if (movesets === undefined || movesets === null) return {movesets: canonical.map(() => null), entries: canonical.map(() => null)};
 if (!Array.isArray(movesets) || movesets.length !== 3) throw Error('Usage row movesets must list three members, lead first, each null or {fast, charged}');
 const entries = canonical.map(p => validateEntry(p.speciesId, movesets[team.indexOf(p)]));
 const resolved = canonical.map((p, i) => { const full = resolveMoveset(p.moveset, entries[i]); return full.join('|') === p.moveset.join('|') ? null : full; });
 return {movesets: resolved, entries};
}
// Weighted coverage of the observed movesets among the usage rows (weights are the decayed appearance counts the sampler uses).
function tally() {
 const t = {weight: 0, members: 0, withFast: 0, withCharged: 0, differing: 0, teamsDiffering: 0};
 const share = (a, b) => b > 0 ? a / b : 0;
 return {
  add(arranged, count) {
   t.weight += count; t.members += 3 * count;
   t.withFast += count * arranged.entries.filter(e => e && e.fast).length; t.withCharged += count * arranged.entries.filter(e => e && e.charged.length).length;
   const differing = arranged.movesets.filter(Boolean).length; t.differing += count * differing; if (differing) t.teamsDiffering += count;
  },
  summary: () => ({fastShare: share(t.withFast, t.members), chargedShare: share(t.withCharged, t.members), differingMemberShare: share(t.differing, t.members), differingTeamShare: share(t.teamsDiffering, t.weight)}),
 };
}

// ---- model features -------------------------------------------------------------------------------------------------

// A species row's `features` (prepare-worker.cjs) has these move-dependent blocks at [25, 73): fast-move type (18), fast
// damage per turn / energy per turn / duration (3), charged-move types (18), the charged moves' costs (3), powers (3)
// and buff chances (3). Everything else is the species' (types, stats, CP, published score, weight) or its scout
// profile against 24 opponents, which needs simulation and is kept from the recommended variant.
const MOVE_BLOCK = {from: 25, length: 48};
function moveBlock(speciesId, moveset) {
 const {moves, species} = gameMaster(), p = species.get(speciesId), types = p.types || [], shadow = (p.tags || []).includes('shadow');
 const fast = moves.get(moveset[0]), atk = shadow ? SHADOW_ATK : 1, stab = m => m.type === types[0] || m.type === types[1] ? STAB : 1;
 // Pokemon.activeChargedMoves: ascending energy; on equal energy the buffing or harder-hitting move is tried later.
 const charged = moveset.slice(1).filter(id => id && id !== 'none').map(id => moves.get(id)).filter(Boolean).sort((a, b) => a.energy - b.energy);
 if (charged.length > 1 && charged[1].energy === charged[0].energy && !(charged[1].buffTarget === 'self' && charged[1].buffs?.some(v => v < 0)) && (charged[1].buffs || charged[1].power * stab(charged[1]) > charged[0].power * stab(charged[0]))) charged.push(charged.shift());
 const turns = fast.cooldown / 500;
 return [...TYPES.map(t => fast.type === t ? 1 : 0), fast.power * stab(fast) * atk / turns / 20, fast.energyGain / turns / 10, fast.cooldown / 500 / 5,
  ...TYPES.map(t => charged.some(m => m.type === t) ? 1 : 0), ...Array.from({length: 3}, (_, i) => charged[i] ? charged[i].energy / 100 : 0),
  ...Array.from({length: 3}, (_, i) => charged[i] ? charged[i].power * stab(charged[i]) * atk / 200 : 0), ...Array.from({length: 3}, (_, i) => charged[i] ? Number(charged[i].buffApplyChance || 0) : 0)];
}

// The model row of an opponent species playing `moveset`. If the pool kept that moveset as a variant, its scouted features
// are used exactly. Otherwise the species' recommended row supplies the scout profile and coverage, and the move-dependent
// blocks are recomputed from the observed moves: an approximation, because the scout profile (24 matchups) and the
// per-type coverage describe the recommended moveset.
function featureRow(row, moveset, variants = null) {
 const exact = variants?.find(v => v.speciesId === row.speciesId && sameMoveset(v.moveset, moveset));
 if (exact) return {row: {...row, moveset: exact.moveset, features: exact.features, scoutByType: exact.scoutByType}, exact: true};
 const features = row.features.slice();
 features.splice(MOVE_BLOCK.from, MOVE_BLOCK.length, ...moveBlock(row.speciesId, moveset));
 return {row: {...row, moveset, features}, exact: false};
}
// search.cjs: resolves an opponent id (plain or tagged) to the row the model encodes; plain ids return the species row itself.
function rowResolver(speciesMap, variants) {
 const cache = new Map();
 return id => {
  const at = String(id).indexOf(TAG);
  if (at < 0) return speciesMap.get(id);
  if (!cache.has(id)) { const {speciesId, moveset} = parseTag(id), row = speciesMap.get(speciesId); if (!row) throw Error('Unknown observed opponent ' + id); cache.set(id, featureRow(row, moveset, variants).row); }
  return cache.get(id);
 };
}

// export-report.cjs: the portable report names an opponent by its index in table.opponents (the pool's species, in order). An
// observed-moveset opponent (a tagged id, or a fixture row flagged observedMoveset) is appended after them as a row that plays
// that moveset (the species' recommended moveset stays in its `recommended` field), so the browser replays it with the moves it
// was simulated with. Plain opponents keep their species index.
function opponentIndexer(species, compact) {
 const base = new Map(species.map((p, i) => [p.speciesId, i])), extra = [], at = new Map();
 const index = x => {
  const parsed = typeof x === 'string' ? parseTag(x) : x.observedMoveset ? {speciesId: x.speciesId, moveset: x.moveset} : {speciesId: x.speciesId, moveset: null};
  if (!base.has(parsed.speciesId)) throw Error('Unknown observed opponent ' + parsed.speciesId);
  if (!parsed.moveset) return base.get(parsed.speciesId);
  const key = tag(parsed.speciesId, parsed.moveset);
  if (!at.has(key)) { at.set(key, species.length + extra.length); extra.push(compact({...species[base.get(parsed.speciesId)], moveset: parsed.moveset.slice()})); }
  return at.get(key);
 };
 return {index, extra};
}

module.exports = {opponentIndexer, TAG, movePools, sameMoveset, validateEntry, resolveMoveset, arrange, tally, tag, parseTag, memberId, opponentIds, moveBlock, featureRow, rowResolver, MOVE_BLOCK};

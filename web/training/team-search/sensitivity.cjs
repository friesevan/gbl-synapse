#!/usr/bin/env node
'use strict';
// Meta-sensitivity panel: how much does a team's score depend on the opponent distribution it is tested against?
//
// The search optimises a best response to ONE modelled meta, so the final score of its primary is conditional on that
// assumption (README section 4). This module re-simulates the finalists (optionally the baseline and champion teams too)
// on K alternative opponent metas built by meta.cjs from the same pool, each on its own sealed panel, with the run's
// own controller and belief prior. It is a read-out, not a selector: the primary stays the team screening chose.
//
// Library use (search.cjs):   plan() before the search, teamsFor() + assemble() after the final test.
// Standalone (a finished run or report):
//
//   node training/team-search/sensitivity.cjs RUN_OR_REPORT [RUN_OR_REPORT ...] [--scope finalists|primary] [--baselines]
//        [--fixtures 128] [--metas all|id,id,...] [--seed N] [--workers 4] [--pool FILE]
//        [--usage-file F --usage-half-life-days N --usage-as-of D --usage-prior-strength N] [--meta-weight-power 1.25]
//        [--belief-from RUN_OR_REPORT] [--resamples 2000] [--out FILE.json]
//   node training/team-search/sensitivity.cjs --print SAVED.json
//
// Sources are run directories, recommendations.json files or portable reports; only compositions (species and
// moveset) are read, and every score is re-simulated. Usage options default to the run's own (launch.json).
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { createMeta, loadUsage } = require('./meta.cjs');
const { digest, guardedSeed, screeningSeed, teamKey, atomic, mechanicsHash, dataHash } = require('./common.cjs');
const { opponentFixtureKey } = require('./acquisition.cjs');
const { random, defaults } = require('../utils.cjs');

const SEED_TAG = 'sensitivity', BOOTSTRAP_OFFSET = 800004, SCHEMA = 1;
const GROUPS = ['finalists', 'all'];

// The alternatives, in report order. Independent draws at three exponents isolate the popularity assumption (the synthetic
// half of the run's meta is half coherent draws, which depend on the weights too); coherent shows the hand-designed shapes
// alone; the observed pair needs a usage file. Ids are stable so reports can be compared across runs.
const CATALOG = [
 { id: 'independent-1.25', label: 'Independent draws, weight power 1.25', mode: 'independent', weightPower: 1.25 },
 { id: 'coherent', label: 'Coherent draws only (shared-type backlines)', mode: 'coherent', runWeightPower: true },
 { id: 'observed', label: 'Observed teams only', mode: 'observed', usage: true },
 { id: 'observed-without-top-creator', label: 'Observed teams without the largest creator', mode: 'observed', usage: true, dropTopCreator: true },
 { id: 'independent-1.0', label: 'Independent draws, weight power 1.0', mode: 'independent', weightPower: 1 },
 { id: 'independent-1.5', label: 'Independent draws, weight power 1.5', mode: 'independent', weightPower: 1.5 },
];
const ID_ORDER = CATALOG.map(c => c.id);

const pct = x => Number.isFinite(x) ? (100 * x).toFixed(1) + '%' : '—';
const pts = x => Number.isFinite(x) ? (100 * x).toFixed(1) : '—';
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];

// ---- seeds ---------------------------------------------------------------------------------------------------------

// One sealed seed per meta, derived from the validation seed (like screeningSeed) and guarded so that no two coincide and none
// aliases the validation seed, the screening seed or any other panel or stream seed passed in `reserved` (retest panel,
// reference, belief and baseline streams, and any confirmation panel a caller adds). Deterministic: the same validation seed
// and ids always give the same seeds, whatever the other ids are.
function sensitivitySeeds(validationSeed, ids, reserved = []) {
 if (!Number.isInteger(validationSeed)) throw Error('Seed must be a finite integer');
 const taken = [validationSeed, screeningSeed(validationSeed), ...reserved], out = {};
 for (const id of ids) {
  const seed = guardedSeed(parseInt(digest([SEED_TAG, validationSeed, id]).slice(0, 8), 16) || 1, taken);
  out[id] = seed; taken.push(seed);
 }
 return out;
}
// A panel seed used by an absorbed or merged earlier run is refused: its fixtures were already looked at (and may have trained a model).
function assertFreshSeeds(seeds, evidenceSeeds = []) {
 const used = new Set((evidenceSeeds || []).map(s => s >>> 0));
 for (const [id, seed] of Object.entries(seeds)) if (used.has(seed >>> 0)) throw Error('Sensitivity panel seed ' + seed + ' (' + id + ') was an evaluation seed of absorbed evidence; choose a fresh validation-seed');
}

// ---- metas ---------------------------------------------------------------------------------------------------------

// Resolves the catalog against what the run has: observed metas need a usage file, and the leave-one-creator-out meta needs at
// least two creators in it. Returns [{id,label,options,...}] where options are createMeta arguments.
function metaSpecs(species, { usageFile = '', halfLifeDays = 0, asOf = '', priorStrength = 500, weightPower = 1.25, only = null } = {}) {
 let usage = null;
 if (only) for (const id of only) if (!ID_ORDER.includes(id)) throw Error('Unknown meta ' + id + '; choose from ' + ID_ORDER.join(', '));
 if (usageFile) usage = loadUsage(usageFile, species, { halfLifeDays, asOf });
 const specs = [], skipped = [];
 for (const c of CATALOG) {
  if (only && !only.includes(c.id)) continue;
  if (c.usage && !usage) { skipped.push({ id: c.id, reason: 'needs --usage-file' }); continue; }
  const spec = { id: c.id, label: c.label, mode: c.mode, weightPower: c.runWeightPower ? weightPower : c.weightPower ?? weightPower };
  const options = { mode: c.mode, weightPower: spec.weightPower };
  if (c.usage) Object.assign(options, { usageFile, halfLifeDays, asOf, priorStrength });
  if (c.dropTopCreator) {
   const top = usage.topCreator;
   if (!top || !(usage.creators >= 2)) { skipped.push({ id: c.id, reason: 'the usage file does not name at least two creators' }); continue; }
   options.excludeCreator = top.creator;
   spec.excludedCreator = top.creator; // never written to a report: see publicMeta
   spec.excludedCreatorShare = top.share;
   spec.excludedCreatorHash = digest(['creator', top.creator]).slice(0, 12);
   spec.label += ' (' + pct(top.share) + ' of the observed weight)';
  }
  specs.push({ ...spec, options });
 }
 return { specs, skipped };
}

// What a report may carry about a meta: no creator name, only its weight share and a short hash.
function publicMeta(spec, panel, fixtures) {
 const d = panel.meta.description, components = {};
 for (const c of panel.cases.slice(0, fixtures)) components[c.component] = (components[c.component] || 0) + 1;
 return {
  id: spec.id, label: spec.label, mode: spec.mode, weightPower: spec.weightPower, observedShare: d.observedShare, seed: panel.seed, fixtures, components,
  ...(d.observedCount ? { observedCount: d.observedCount, distinctTeams: d.distinctTeams ?? null, creators: d.creators ?? null } : {}),
  ...(spec.excludedCreatorHash ? { excludedCreatorShare: spec.excludedCreatorShare, excludedCreatorHash: spec.excludedCreatorHash } : {}),
 };
}

// Builds every meta's panel with its sealed seed. `sealedKeys` holds the opponent-fixture keys of panels that must not be
// reused (screening, final, retest panel, any training evidence); an overlap throws.
function buildPanels(species, specs, fixtures, seeds, { sealedKeys = null } = {}) {
 if (!Number.isInteger(fixtures) || fixtures < 1) throw Error('sensitivity fixtures must be a positive integer');
 return specs.map(spec => {
  const meta = createMeta(species, spec.options), cases = meta.fixtures(fixtures, seeds[spec.id]);
  if (sealedKeys) for (const c of cases) if (sealedKeys.has(opponentFixtureKey(c.team, c.seed))) throw Error('Sensitivity panel ' + spec.id + ' overlaps a sealed or training fixture; choose another validation-seed');
  return { spec, meta, cases, seed: seeds[spec.id] };
 });
}

// Inherited training evidence (a warm start or resume) must not contain a sensitivity fixture. Compares the per-fixture battle seed first, so
// hundreds of thousands of observations cost one set lookup each.
function assertNoTrainingOverlap(panels, observations) {
 if (!observations?.length) return;
 const seeds = new Set(), keys = new Set();
 for (const p of panels) for (const c of p.cases) { seeds.add(c.seed); keys.add(opponentFixtureKey(c.team, c.seed)); }
 for (const o of observations) if (seeds.has(o.seed) && keys.has(opponentFixtureKey(o.opponent, o.seed))) throw Error('Sensitivity fixtures overlap inherited training evidence; choose a fresh validation-seed');
}

// The search's view: panels for every meta, one interleaved list (fixture 0 of each meta, then fixture 1, ...) so that a
// deadline leaves every meta with the same prefix, and the battle count the budget needs.
function plan(prepared, { fixtures, groups = 'finalists', validationSeed, reserved = [], evidenceSeeds = [], sealedKeys = null, observations = [], usage = {}, weightPower = 1.25, only = null } = {}) {
 if (!GROUPS.includes(groups)) throw Error('sensitivity-groups must be finalists or all');
 const { specs, skipped } = metaSpecs(prepared.species, { ...usage, weightPower, only }), seeds = sensitivitySeeds(validationSeed, specs.map(s => s.id), reserved);
 assertFreshSeeds(seeds, evidenceSeeds);
 const panels = buildPanels(prepared.species, specs, fixtures, seeds, { sealedKeys }), interleaved = [];
 assertNoTrainingOverlap(panels, observations);
 for (let f = 0; f < fixtures; f++) for (const p of panels) interleaved.push(p.cases[f]);
 return { fixtures, groups, seeds, specs, panels, skipped, interleaved, metaCount: panels.length, battles: teamCount => teamCount * fixtures * panels.length };
}

// ---- teams ---------------------------------------------------------------------------------------------------------

// The final-tested finalists (primary first) and, with groups 'all', the baseline and previous-champion teams, each once.
function teamsFor(state, { groups = 'finalists' } = {}) {
 const seen = new Set(), out = [], primaryKey = state.finalistTeams?.length ? teamKey(state.finalistTeams[0]) : null;
 const add = (team, kind, extra) => { const key = teamKey(team); if (!seen.has(key)) { seen.add(key); out.push({ team, kind, ...extra }); } };
 (state.validations || []).forEach((v, i) => add(v.team, 'finalist', { primary: primaryKey ? teamKey(v.team) === primaryKey : i === 0, finalScore: v.score }));
 if (groups === 'all') for (const b of state.baselineResults || []) add(b.team, b.kind, { primary: false, finalScore: b.score });
 return out;
}

// ---- statistics ----------------------------------------------------------------------------------------------------

function summarizeTeam(scoresByMeta, { seed = 1, resamples = 1000 } = {}) {
 const K = scoresByMeta.length, n = scoresByMeta[0].length;
 const means = scoresByMeta.map(mean), se = scoresByMeta.map((s, k) => n > 1 ? Math.sqrt(s.reduce((a, v) => a + (v - means[k]) ** 2, 0) / (n - 1) / n) : null);
 let lo = 0, hi = 0; means.forEach((v, k) => { if (v < means[lo]) lo = k; if (v > means[hi]) hi = k; });
 const spread = means[hi] - means[lo], r = random(seed);
 let interval = null, noise = null;
 if (K > 1 && n > 1 && resamples > 0) {
  // Metas use different fixtures, so each is resampled on its own; the spread of the resampled means is its interval.
  const spreads = new Float64Array(resamples), pooled = new Float64Array(resamples), draw = new Float64Array(K);
  for (let b = 0; b < resamples; b++) {
   let min = Infinity, max = -Infinity;
   for (let k = 0; k < K; k++) { let sum = 0; const s = scoresByMeta[k]; for (let i = 0; i < n; i++) sum += s[Math.floor(r() * n)]; const m = sum / n; if (m < min) min = m; if (m > max) max = m; }
   spreads[b] = max - min;
   // The null: the team scores the same everywhere and only fixture noise (the observed standard errors) separates the metas.
   min = Infinity; max = -Infinity;
   for (let k = 0; k < K; k++) { const z = Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r()), v = se[k] * z; draw[k] = v; if (v < min) min = v; if (v > max) max = v; }
   pooled[b] = max - min;
  }
  const sorted = Array.from(spreads).sort((a, b) => a - b), nullSorted = Array.from(pooled).sort((a, b) => a - b);
  interval = [quantile(sorted, .025), quantile(sorted, .975)]; noise = quantile(nullSorted, .5);
 }
 const avg = mean(means);
 return { scores: means, standardErrors: se, mean: avg, min: means[lo], minIndex: lo, max: means[hi], maxIndex: hi, spread, spreadInterval95: interval, noiseSpread: noise, meanMinusSpread: avg - spread };
}

// Rank (1 = best) of every team within each meta; ties share the better rank.
function ranksByMeta(rows) {
 return rows.map((_, t) => rows[0].scores.map((__, k) => 1 + rows.filter(o => o.scores[k] > rows[t].scores[k] + 1e-12).length));
}

// scores[metaIndex][teamIndex] = array of fixture scores. Returns the block recorded beside finalPanel.
function buildBlock({ metas, teams, scores, requested, groups, seed = 1, resamples = 1000 }) {
 const fixtures = scores[0][0].length, rows = teams.map((t, ti) => ({ t, ...summarizeTeam(scores.map(m => m[ti]), { seed: seed + ti * 7919, resamples }) }));
 const ranks = ranksByMeta(rows);
 return {
  version: SCHEMA, requestedFixtures: requested, fixtures, complete: fixtures === requested, groups, resamples, seed,
  metas: metas.map(m => ({ ...m, fixtures })),
  teams: rows.map((r, ti) => ({
   team: r.t.team, kind: r.t.kind, primary: !!r.t.primary, finalScore: Number.isFinite(r.t.finalScore) ? r.t.finalScore : null,
   scores: r.scores, standardErrors: r.standardErrors, ranks: ranks[ti], mean: r.mean, min: r.min, minMeta: metas[r.minIndex].id, max: r.max, maxMeta: metas[r.maxIndex].id,
   spread: r.spread, spreadInterval95: r.spreadInterval95, noiseSpread: r.noiseSpread, meanMinusSpread: r.meanMinusSpread,
  })),
  summary: { topByMeta: metas.map((_, k) => rows.reduce((best, r, ti) => r.scores[k] > rows[best].scores[k] ? ti : best, 0)) },
  method: 'The teams were re-simulated on ' + fixtures + ' fixtures under each of ' + metas.length + ' alternative opponent metas (sealed seeds derived from the validation seed; each meta has its own panel, shared by every team) with the run\'s controller and belief prior. Mean, min and spread (max minus min) are over the per-meta means; the run meta\'s final-panel score is shown for reference and is not part of them. The spread interval resamples fixtures within each meta; noiseSpread is the median spread that fixture noise alone would produce if the team scored the same under every meta. meanMinusSpread is recorded for study and is not used for selection.',
 };
}

// Search side: rows are the common-panel scores of evaluate() over the interleaved list (one array of scores per team).
// Returns {block, raw} or null when no meta has a single complete fixture. The common prefix per meta is the shortest one.
function assemble(info, teams, rows, { seed = 1, resamples = 1000 } = {}) {
 const K = info.metaCount, total = teams.length && rows?.length === teams.length ? Math.min(...rows.map(r => r.scores.length)) : 0, n = Math.floor(total / K);
 if (!n) return null;
 const byKey = new Map(rows.map(r => [teamKey(r.team), r])), scores = info.panels.map((_, k) => teams.map(t => {
  const row = byKey.get(teamKey(t.team)); return Array.from({ length: n }, (__, f) => row.scores[f * K + k]);
 }));
 const metas = info.panels.map(p => publicMeta(p.spec, p, n));
 const block = buildBlock({ metas, teams, scores, requested: info.fixtures, groups: info.groups, seed, resamples });
 return { block, raw: Object.fromEntries(info.panels.map((p, k) => [p.spec.id, Object.fromEntries(teams.map((t, ti) => [teamKey(t.team), scores[k][ti]]))])) };
}

// ---- text ----------------------------------------------------------------------------------------------------------

// The finalist-card line the viewer shows (neural-portable.js keeps an identical copy; a test compares them).
const line = (t, block) => 'across ' + block.metas.length + ' metas: min ' + pct(t.min) + ', spread ' + pts(t.spread) + ' points';

// Rows for report.html, findings.md and the CLI: teams down, metas across, then run-meta reference, mean, min, spread, noise.
function describe(block, nameOf) {
 const header = ['Team', 'Kind', ...block.metas.map(m => m.id), 'Run meta (final test)', 'Mean', 'Min', 'Spread (points)', 'Noise alone (points)'];
 const rows = block.teams.map(t => [(t.primary ? 'Primary · ' : '') + nameOf(t.team), t.kind, ...t.scores.map(pct), pct(t.finalScore), pct(t.mean), pct(t.min) + ' (' + t.minMeta + ')', pts(t.spread) + (t.spreadInterval95 ? ' [' + pts(t.spreadInterval95[0]) + ', ' + pts(t.spreadInterval95[1]) + ']' : ''), pts(t.noiseSpread)]);
 return { header, rows };
}
function caption(block) {
 const fx = block.fixtures + (block.complete ? '' : ' of ' + block.requestedFixtures + ' (partial: the run ran out of time)');
 return block.metas.length + ' alternative metas × ' + fx + ' fixtures per team. Scores under different metas are not comparable as strength; the spread shows how much the result depends on the assumed opponents. With ' + block.fixtures + ' fixtures per meta, fixture noise alone gives a spread of about ' + pts(median(block.teams.map(t => t.noiseSpread).filter(Number.isFinite))) + ' points, so only spreads clearly above that mean a real dependence. Exploratory: the primary was not selected for robustness.';
}
const median = a => a.length ? a.slice().sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)] : null;

// ---- standalone ----------------------------------------------------------------------------------------------------

const DEFAULTS = { pool: 'training/runs/team-search/pool.json', fixtures: 128, metas: 'all', scope: 'finalists', seed: 0, workers: 4, usageFile: '', usageHalfLifeDays: -1, usageAsOf: '', usagePriorStrength: -1, metaWeightPower: 0, beliefFrom: '', beliefSamples: 0, lookaheadTurns: 0, decisionInterval: 0, resamples: 2000, bootstrap: 5000, out: '', print: '' };
const NUMBERS = new Set(Object.keys(DEFAULTS).filter(k => typeof DEFAULTS[k] === 'number'));
function parseArgs(argv) {
 const opts = { ...DEFAULTS, baselines: false, help: false }, sources = [];
 for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--help') { opts.help = true; continue; }
  if (a === '--baselines') { opts.baselines = true; continue; }
  if (!a.startsWith('--')) { sources.push(a); continue; }
  const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  if (!(key in DEFAULTS) || argv[i + 1] === undefined) throw Error('Unknown argument ' + a);
  opts[key] = NUMBERS.has(key) ? Number(argv[++i]) : argv[++i];
 }
 return { opts, sources };
}
function validate(opts, sourceCount) {
 for (const k of ['fixtures', 'workers', 'resamples', 'bootstrap']) if (!Number.isInteger(opts[k]) || opts[k] < 1) throw Error(k + ' must be a positive integer');
 if (opts.fixtures < 8) throw Error('fixtures must be at least 8; below about 64 only large spreads are visible');
 if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 0xffffffff) throw Error('seed must fit an unsigned 32-bit integer (0 draws a fresh one)');
 if (!['finalists', 'primary'].includes(opts.scope)) throw Error('scope must be finalists or primary');
 if (sourceCount < 1) throw Error('Give a run directory, recommendations.json or portable report');
}
const flagValue = (command, name) => { const i = (command || []).indexOf(name); return i >= 0 ? command[i + 1] : undefined; };

// The engine context a source carries: belief prior, controller settings and (for a run directory) the meta options it used.
function readContext(source, cache = {}) {
 const champions = require('./champions.cjs'), resolved = path.resolve(source);
 let dir = null, file = resolved;
 if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) dir = resolved;
 else if (/recommendations\.json$/.test(resolved)) dir = path.dirname(resolved);
 const context = { source, dir };
 // Belief prior and controller settings: the checkpoint of a run directory, else a portable report (in the directory or given).
 const report = dir ? path.join(dir, 'report.pvpteams.json.gz') : file;
 if (dir && fs.existsSync(path.join(dir, 'checkpoint.json'))) {
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  Object.assign(context, { beliefRoster: state.beliefPrior?.roster, beliefTeams: state.beliefPrior?.teams, beliefSamples: state.config.beliefSamples, horizon: state.config.lookaheadTurns, interval: state.config.decisionInterval, config: state.config });
 } else if (fs.existsSync(report) && !/recommendations\.json$/.test(report)) {
  const data = champions.readJson(report);
  if (data.format === 'pvp-team-report' && data.engineOptions?.beliefRoster) Object.assign(context, { beliefRoster: data.engineOptions.beliefRoster, beliefTeams: data.engineOptions.beliefTeams, beliefSamples: data.engineOptions.beliefSamples, horizon: data.engineOptions.horizon, interval: data.engineOptions.interval, config: { meta: data.meta } });
 }
 if (dir && fs.existsSync(path.join(dir, 'launch.json'))) { try { context.command = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8')).command; } catch { /* optional */ } }
 if (dir && fs.existsSync(path.join(dir, 'recommendations.json'))) { try { const rec = JSON.parse(fs.readFileSync(path.join(dir, 'recommendations.json'), 'utf8')); context.recommendations = { poolHash: rec.poolHash, baselineResults: rec.baselineResults || [], sensitivity: rec.sensitivity || null }; } catch { /* optional */ } }
 return context;
}

function resolveOptions(opts, context) {
 const meta = context.config?.meta || {}, command = context.command;
 const pick = (given, unset, ...fallbacks) => given !== unset ? given : fallbacks.find(v => v !== undefined && v !== null && v !== '' && !Number.isNaN(v));
 return {
  usageFile: opts.usageFile || flagValue(command, '--usage-file') || '',
  halfLifeDays: pick(opts.usageHalfLifeDays, -1, meta.usageHalfLifeDays, Number(flagValue(command, '--usage-half-life-days')), 0),
  asOf: opts.usageAsOf || meta.usageAsOf || flagValue(command, '--usage-as-of') || '',
  priorStrength: pick(opts.usagePriorStrength, -1, meta.usagePriorStrength, Number(flagValue(command, '--usage-prior-strength')), 500),
  weightPower: pick(opts.metaWeightPower, 0, meta.weightPower, Number(flagValue(command, '--meta-weight-power')), 1.25),
 };
}

async function sensitivityRun(opts, sources, { play = null, log = console.log } = {}) {
 validate(opts, sources.length);
 const poolFile = path.resolve(opts.pool), pool = JSON.parse(fs.readFileSync(poolFile, 'utf8')), check = { ...pool };
 delete check.hash;
 if (digest(check) !== pool.hash) throw Error('Pool hash mismatch');
 if (pool.config.inputHash !== dataHash()) throw Error('Pool data differs from bundled rankings, weights or Game Master');
 const champions = require('./champions.cjs'), found = champions.loadChampions(sources, pool, { scope: opts.scope });
 if (!found.teams.length) throw Error('No team could be mapped into the pool' + (found.skipped.length ? ': ' + found.skipped.map(s => s.label + ': ' + s.reason).join('; ') : ''));
 // Engine context: the first source (or --belief-from) that carries a belief prior.
 const contexts = [opts.beliefFrom, ...sources].filter(Boolean).map(s => readContext(s)), context = contexts.find(c => c.beliefRoster && c.beliefTeams);
 if (!context) throw Error('No source carries the controller\'s belief prior (a v4 run directory with checkpoint.json, or a v4 portable report); pass --belief-from');
 const meta = resolveOptions(opts, contexts.find(c => c.config?.meta) || context), only = opts.metas === 'all' ? null : opts.metas.split(',').map(s => s.trim()).filter(Boolean);
 let usageHashMatches = null;
 const expectedHash = (contexts.find(c => c.config?.meta?.usageHash) || {}).config?.meta?.usageHash;
 if (meta.usageFile && expectedHash) { usageHashMatches = crypto.createHash('sha256').update(fs.readFileSync(meta.usageFile, 'utf8')).digest('hex') === expectedHash; if (!usageHashMatches) log('Note: the usage file differs from the one the run used (it has been regenerated since); the observed metas describe the file as it is now.'); }
 const { specs, skipped } = metaSpecs(pool.species, { ...meta, only });
 if (!specs.length) throw Error('No meta to test' + (skipped.length ? ': ' + skipped.map(s => s.id + ' ' + s.reason).join('; ') : ''));
 for (const s of specs) if (s.excludedCreator) log('Leave-one-creator-out meta drops "' + s.excludedCreator + '" (' + pct(s.excludedCreatorShare) + ' of the observed weight).');
 // Teams: the sources' finalists, plus (opt-in) the baseline and previous-champion teams of run directories.
 const teams = found.teams.map(c => ({ team: c.team, kind: 'finalist', label: c.label, primary: false, finalScore: c.sources[0]?.finalScore ?? null, origins: c.sources }));
 if (teams.length && found.teams[0].sources[0]?.role === 'primary') teams[0].primary = true;   // a source whose first team was not final-tested has no primary
 if (opts.baselines) for (const c of contexts) for (const b of c.recommendations?.baselineResults || []) if (c.recommendations.poolHash === pool.hash && !teams.some(t => teamKey(t.team) === teamKey(b.team))) teams.push({ team: b.team, kind: b.kind, label: c.source + ' · ' + b.kind, primary: false, finalScore: b.score ?? null, origins: [] });
 const used = [...found.sources.flatMap(s => s.usedSeeds || []), ...contexts.flatMap(c => [c.config?.validationSeed, c.config?.screenSeed, ...(c.recommendations?.sensitivity?.metas || []).map(m => m.seed)].filter(Number.isInteger))];
 const base = panelBase(opts.seed, used), seeds = sensitivitySeeds(base, specs.map(s => s.id), used.flatMap(s => [s, screeningSeed(s)]));
 const panels = buildPanels(pool.species, specs, opts.fixtures, seeds), K = panels.length;
 const engine = { beliefRoster: context.beliefRoster, beliefTeams: context.beliefTeams, beliefSamples: opts.beliefSamples || context.beliefSamples || 3, horizon: opts.lookaheadTurns || context.horizon || 24, interval: opts.decisionInterval || context.interval || 4 };
 const jobs = [];
 for (let f = 0; f < opts.fixtures; f++) for (const p of panels) for (const t of teams) jobs.push([t.team.map(i => pool.variants[i]), p.cases[f].team, defaults, defaults, { seed: p.cases[f].seed, cp: 1500, ...engine }]);
 log('Sensitivity · ' + teams.length + ' teams × ' + K + ' metas × ' + opts.fixtures + ' fixtures = ' + jobs.length + ' battles · ' + opts.workers + ' workers · base seed ' + base);
 const started = Date.now(), runner = play || require('./rematch.cjs').defaultPlay, results = await runner(jobs, { workers: opts.workers, log, label: 'sensitivity' });
 if (!results || results.length !== jobs.length) throw Error('Sensitivity run did not complete every battle');
 const T = teams.length, scores = panels.map(() => teams.map(() => []));
 results.forEach((r, index) => { const t = index % T, k = Math.floor(index / T) % K; scores[k][t].push(r.score); });
 const metas = panels.map(p => publicMeta(p.spec, p, opts.fixtures)), block = buildBlock({ metas, teams, scores, requested: opts.fixtures, groups: opts.baselines ? 'all' : 'finalists', seed: base + BOOTSTRAP_OFFSET, resamples: opts.resamples });
 const { pairwiseBands } = require('./paired-stats.cjs'), perMeta = panels.map((p, k) => {
  const rows = teams.map((t, ti) => ({ id: 't' + (ti + 1), scores: scores[k][ti] })), bands = T > 1 ? pairwiseBands(rows, { seed: base + 1 + k, samples: opts.bootstrap }) : null;
  const ref = bands?.pairs.filter(x => x.a === 't1').map(x => ({ id: x.b, delta: x.delta, simultaneous95: x.simultaneous95, verdict: x.verdict === 'a-better' ? 'reference-better' : x.verdict === 'b-better' ? 'team-better' : 'unresolved' })) || [];
  return { id: p.spec.id, fixtures: opts.fixtures, radius: bands?.radius ?? null, ranking: rows.map(r => r.id).sort((a, b) => mean(scores[k][+b.slice(1) - 1]) - mean(scores[k][+a.slice(1) - 1])), versusReference: ref };
 });
 return {
  format: 'pvp-team-sensitivity', schemaVersion: SCHEMA, createdAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000, exploratory: opts.fixtures < 256,
  engine: { version: 'neural-team-search-v4', mechanicsHash: mechanicsHash({ version: 'v4' }), lookaheadTurns: engine.horizon, decisionInterval: engine.interval, beliefSamples: engine.beliefSamples, beliefSource: context.source },
  pool: { file: poolFile, hash: pool.hash }, usage: { file: meta.usageFile || null, halfLifeDays: meta.halfLifeDays, asOf: meta.asOf || null, hashMatchesRun: usageHashMatches }, baseSeed: base,
  scope: opts.scope, sources: found.sources, skipped: found.skipped, skippedMetas: skipped, reference: 't1',
  teams: teams.map((t, i) => ({ id: 't' + (i + 1), label: t.label || null, kind: t.kind, team: t.team, key: teamKey(t.team), members: found.teams.find(c => teamKey(c.team) === teamKey(t.team))?.members || t.team.map(v => ({ speciesName: pool.variants[v].speciesName, speciesId: pool.variants[v].speciesId, moveset: pool.variants[v].moveset })), origins: t.origins })),
  sensitivity: block, perMeta, scores: Object.fromEntries(panels.map((p, k) => [p.spec.id, Object.fromEntries(teams.map((t, ti) => ['t' + (ti + 1), scores[k][ti]]))])),
 };
}
// A base seed no source's own panels used (its seeds are blocked by sensitivitySeeds' reserved list as well).
function panelBase(requested, used) {
 const blocked = new Set(used.flatMap(s => [s >>> 0, screeningSeed(s)]));
 if (requested) { if (blocked.has(requested >>> 0)) throw Error('seed ' + requested + ' was a panel seed of one of the sources; choose a fresh seed'); return requested >>> 0; }
 let seed; do { seed = crypto.randomBytes(4).readUInt32LE(0) || 1; } while (blocked.has(seed));
 return seed;
}

function table(rows) {
 const widths = rows[0].map((_, j) => Math.max(...rows.map(r => String(r[j]).length)));
 return rows.map(r => r.map((v, j) => String(v).padEnd(widths[j])).join('  ').trimEnd());
}
function formatTable(result) {
 const b = result.sensitivity, byKey = new Map(result.teams.map(t => [teamKey(t.team), t]));
 const nameOf = team => (byKey.get(teamKey(team))?.members || []).map(m => m.speciesName || m.speciesId).join(' / ');
 const lines = ['Meta sensitivity · ' + b.fixtures + ' fixtures per meta · ' + b.metas.length + ' metas · base seed ' + result.baseSeed + (result.exploratory ? ' · EXPLORATORY: fewer than 256 fixtures per meta' : ''),
  'Simulated expected scores under each meta and the run\'s v4 controller; scores under different metas are not comparable as strength.', ''];
 const d = describe(b, nameOf), head = ['#', ...d.header], rows = [head, ...d.rows.map((r, i) => ['t' + (i + 1), ...r])];
 lines.push(...table(rows));
 lines.push('', 'Metas:');
 for (const m of b.metas) { const pm = result.perMeta.find(p => p.id === m.id); lines.push('  ' + m.id.padEnd(30) + m.label + ' · seed ' + m.seed + ' · ' + Object.entries(m.components).map(([c, n]) => n + ' ' + c).join(', ') + (pm?.radius != null ? ' · simultaneous 95% half-width over all pairs ±' + pts(pm.radius) + ' points' : '')); }
 lines.push('', 'Best team per meta: ' + b.metas.map((m, k) => m.id + ' → t' + (b.summary.topByMeta[k] + 1)).join('; '));
 const order = b.teams.map((t, i) => ({ id: 't' + (i + 1), v: t.meanMinusSpread })).sort((x, y) => y.v - x.v);
 lines.push('Order by mean − spread (exploratory objective, not used for selection): ' + order.map(o => o.id + ' ' + pct(o.v)).join(' > '));
 if (result.skippedMetas?.length) lines.push('Not run: ' + result.skippedMetas.map(s => s.id + ' (' + s.reason + ')').join('; '));
 if (result.skipped?.length) lines.push('Skipped teams (not mappable into the pool): ' + result.skipped.map(s => s.label + ': ' + s.reason).join('; '));
 lines.push('', caption(b));
 return lines.join('\n');
}

async function main(argv) {
 const { opts, sources } = parseArgs(argv);
 if (opts.print) { console.log(formatTable(JSON.parse(fs.readFileSync(path.resolve(opts.print), 'utf8')))); return; }
 if (opts.help) { console.log('node training/team-search/sensitivity.cjs RUN_OR_REPORT [...] [--scope finalists|primary] [--baselines] [--fixtures 128] [--metas all|' + ID_ORDER.join(',') + '] [--seed N] [--workers 4] [--pool FILE] [--usage-file JSON] [--usage-half-life-days N] [--usage-as-of YYYY-MM-DD] [--usage-prior-strength N] [--meta-weight-power 1.25] [--belief-from RUN_OR_REPORT] [--resamples 2000] [--bootstrap 5000] [--out FILE.json] | --print SAVED.json'); return; }
 const result = await sensitivityRun(opts, sources);
 const out = path.resolve(opts.out || path.join('training/runs', 'sensitivity-' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '.json'));
 atomic(out, result);
 console.log('\n' + formatTable(result) + '\n\nSaved ' + out);
}
if (require.main === module) main(process.argv.slice(2)).catch(e => { console.error(e.message || e); process.exitCode = 1; });
module.exports = { CATALOG, ID_ORDER, GROUPS, BOOTSTRAP_OFFSET, sensitivitySeeds, assertFreshSeeds, assertNoTrainingOverlap, metaSpecs, publicMeta, buildPanels, plan, teamsFor, summarizeTeam, ranksByMeta, buildBlock, assemble, line, describe, caption, parseArgs, resolveOptions, readContext, sensitivityRun, panelBase, formatTable, DEFAULTS };

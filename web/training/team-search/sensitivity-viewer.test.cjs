'use strict';
// The viewer's meta-sensitivity table and finalist lines (includes/pro/neural-portable.js) and the report validator for `sensitivity`.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const core = require('../../includes/pro/neural-report-core.js'), S = require('./sensitivity.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8');
const ctx = vm.createContext({});vm.runInContext(source, ctx);
const P = ctx.NeuralPortable, v3 = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz'))));
const plain = x => x == null ? x : JSON.parse(JSON.stringify(x)), names = team => Array.from(team).map(i => 'M' + i).join(' / ');

// A sensitivity block for a report's finalists, built by the same code the search uses.
function blockFor(report, { baseline = false, complete = true } = {}) {
 const finalists = report.table.rows.filter(r => r.finalist && Number.isFinite(r.test)), teams = finalists.map(r => ({ team: r.team, kind: 'finalist', primary: !!r.primary, finalScore: r.test }));
 if (baseline) teams.push({ team: report.table.rows.find(r => r.baseline).team, kind: 'uniform-random', primary: false, finalScore: .2 });
 const metas = [['independent-1.25', 'Independent draws, weight power 1.25'], ['coherent', 'Coherent draws only (shared-type backlines)'], ['observed', 'Observed teams only'], ['independent-1.5', 'Independent draws, weight power 1.5']].map(([id, label], k) => ({ id, label, mode: 'independent', weightPower: 1.25, observedShare: 0, seed: 1000 + k, fixtures: 40, components: { independent: 40 }, ...(id === 'observed' ? { observedCount: 540, distinctTeams: 489, creators: 35 } : {}) }));
 const scores = metas.map((_, k) => teams.map((t, ti) => Array.from({ length: 40 }, (__, f) => ((f * 7 + ti * 3 + k * 5) % 10) < 6 + (ti === 0 ? 2 : 0) - k ? 1 : 0)));
 const block = S.buildBlock({ metas, teams, scores, requested: complete ? 40 : 64, groups: baseline ? 'all' : 'finalists', seed: 5, resamples: 100 });
 return block;
}

test('the finalist line, table and caption are the module\'s own wording, and only finalists get a line', () => {
 const d = v3(), block = blockFor(d, { baseline: true });d.sensitivity = block;core.validate(d);
 const t = plain(P.sensitivityTable(d, names));
 assert.equal(t.rows.length, block.teams.length);assert.equal(t.header.length, 1 + 4 + 5);
 assert.deepEqual(t.header.slice(0, 5), ['Team', 'Independent, power 1.25', 'Coherent only', 'Observed only', 'Independent, power 1.5']);
 assert.deepEqual(t.header.slice(5), ['Run meta (final test)', 'Mean', 'Min', 'Spread (points)', 'Fixture noise alone (points)']);
 const pct = x => (100 * x).toFixed(1) + '%', first = block.teams.find(x => x.primary);
 const row = t.rows[block.teams.indexOf(first)];
 assert.equal(row[0], 'Primary · ' + names(first.team));
 assert.deepEqual(row.slice(1, 5), first.scores.map(pct));assert.equal(row[5], pct(first.finalScore));assert.equal(row[6], pct(first.mean));assert.equal(row[7], pct(first.min));
 assert.match(row[8], /^\d+\.\d \[\d+\.\d, \d+\.\d\]$/);assert.match(row[9], /^\d+\.\d$/);
 assert.equal(t.rows.filter(r => r[0].startsWith('Primary')).length, 1);
 assert.match(t.rows.at(-1)[0], / \(Random teams\)$/);assert.equal(t.rows.at(-1)[0].startsWith('Primary'), false);assert.equal(t.rows.filter(r => /\(Random teams\)/.test(r[0])).length, 1);
 // The wording matches sensitivity.cjs exactly (the module cannot be loaded in the browser, so the text is duplicated).
 assert.equal(t.caption, S.caption(block));
 for (const row of block.teams) assert.equal(P.sensitivityLine(row, block), S.line(row, block));
 assert.match(P.sensitivityLine(first, block), /^across 4 metas: min \d+\.\d%, spread \d+\.\d points$/);
 assert.deepEqual(t.metas[2], 'Observed only: Observed teams only (540 observed teams) · 40 fixtures');
 const notes = P.sensitivityNotes(d);
 assert.equal(notes.size, block.teams.filter(x => x.kind === 'finalist').length);
 assert.equal([...notes.values()].every(v => /^across 4 metas: min /.test(v)), true);
 // A partial panel says so.
 const cut = blockFor(d, { complete: false });cut.fixtures = 40;d.sensitivity = cut;assert.match(P.sensitivityTable(d, names).caption, /of 64 \(partial: the run ran out of time\)/);
 // Nothing without the field.
 assert.equal(P.sensitivityTable(v3(), names), null);assert.equal(P.sensitivityTable({ sensitivity: { teams: [] } }, names), null);assert.equal(P.sensitivityNotes(v3()).size, 0);
});

// A just-enough DOM to run the viewer's real render() on a report and read back what it would show.
function renderText(report) {
 class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.text = ''; this.className = ''; this.attrs = {}; this.style = { setProperty() {} }; this.hidden = false; this.namespaceURI = 'x'; }
  append(...nodes) { for (const n of nodes) this.children.push(typeof n === 'string' ? Object.assign(new Node('#text'), { text: n }) : n); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(k, v) { this.attrs[k] = v; }
  set textContent(v) { this.text = String(v); }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(' '); }
 }
 const host = new Node('div'), document = { createElement: t => new Node(t), createElementNS: (_, t) => new Node(t), getElementById: id => id === 'nnReport' ? host : null, dispatchEvent() {} };
 const c = vm.createContext({ document, Event, TeamBrowser: { mount() {} } });
 vm.runInContext(source, c);
 c.NeuralPortable.render(report);
 return { text: host.textContent, host };
}
function find(node, test, out = []) { if (test(node)) out.push(node); node.children.forEach(c => find(c, test, out)); return out; }

test('the viewer renders the sensitivity table in Search Performance and one line under each finalist, and nothing for older reports', () => {
 const d = v3(), before = renderText(JSON.parse(JSON.stringify(d))).text;
 assert.doesNotMatch(before, /Meta sensitivity/);assert.doesNotMatch(before, /across \d+ metas/);
 d.sensitivity = blockFor(d);core.validate(d);
 const { text, host } = renderText(d), block = d.sensitivity, finalists = block.teams.length;
 assert.match(text, /Meta sensitivity · the same teams under other opponent metas/);assert.match(text, /4 alternative metas × 40 fixtures per team/);
 assert.match(text, /Independent, power 1\.25/);assert.match(text, /Observed only/);assert.match(text, /Run meta \(final test\)/);assert.match(text, /Spread \(points\)/);
 assert.match(text, /Observed teams only \(540 observed teams\)/);assert.match(text, /not selected for robustness/);
 // One "across N metas" line per finalist, each directly under its bar.
 const lines = find(host, n => n.className === 'nn-caption nn-bar-note' && /^across 4 metas: min /.test(n.text));
 assert.equal(lines.length, finalists);
 const card = find(host, n => n.tag === 'section' && n.className === 'nn-card' && n.children[0]?.text === 'Finalists on the same final opponents')[0];
 assert.ok(card, 'the finalists chart');
 const kinds = card.children.slice(1, 1 + 2 * finalists).map(n => n.className);
 assert.deepEqual(kinds, Array.from({ length: finalists }, () => ['nn-bar-row', 'nn-caption nn-bar-note']).flat());
 // The table has a header cell per column and a row per team; the page text is otherwise what it was.
 const table = find(host, n => n.tag === 'table').find(t => /Fixture noise alone/.test(t.textContent));
 assert.equal(find(table, n => n.tag === 'th').length, 1 + 4 + 5);assert.equal(find(table, n => n.tag === 'tr').length, 1 + finalists);
 assert.match(text, /It beat the tested simple baseline groups\./);
});

test('report validation accepts the sensitivity block and refuses a malformed one', () => {
 // Validation walks every saved matchup, so the report is trimmed to a few rows after the blocks are built from its finalists.
 const trim = x => { x.table.rows = x.table.rows.slice(0, 3);x.table.matches = Object.fromEntries(x.table.rows.map(r => [r.id, x.table.matches[r.id]]));return x; };
 const d = v3(), blocks = { plain: blockFor(d), baseline: blockFor(d, { baseline: true }) };trim(d);core.validate(d);
 d.sensitivity = blocks.plain;assert.equal(core.validate(d), d);
 const withBaseline = JSON.parse(JSON.stringify(d));withBaseline.sensitivity = blocks.baseline;assert.equal(core.validate(withBaseline), withBaseline);
 for (const empty of [null, undefined]) { const x = JSON.parse(JSON.stringify(d));x.sensitivity = empty;assert.equal(core.validate(x), x); }
 const mutations = [
  x => { x.sensitivity.metas = []; }, x => { x.sensitivity.metas = 'all'; }, x => { x.sensitivity.metas[0].id = 7; }, x => { x.sensitivity.metas[1].id = x.sensitivity.metas[0].id; },
  x => { x.sensitivity.metas[0].fixtures = 0; }, x => { x.sensitivity.metas[0].seed = -1; }, x => { x.sensitivity.metas[0].seed = 2 ** 32; }, x => { x.sensitivity.metas[0].label = 'x'.repeat(301); },
  x => { x.sensitivity.fixtures = 0; }, x => { x.sensitivity.teams = {}; },
  x => { x.sensitivity.teams[0].team = [0, 1]; }, x => { x.sensitivity.teams[0].team = [0, 1, 99999999]; }, x => { x.sensitivity.teams[0].kind = 3; },
  x => { x.sensitivity.teams[0].scores = x.sensitivity.teams[0].scores.slice(1); }, x => { x.sensitivity.teams[0].scores[0] = 1.5; }, x => { x.sensitivity.teams[0].scores[0] = NaN; },
  x => { x.sensitivity.teams[0].mean = null; }, x => { x.sensitivity.teams[0].spread = -.1; }, x => { x.sensitivity.teams[0].min = 1; x.sensitivity.teams[0].mean = .2; },
  x => { x.sensitivity.teams[0].spreadInterval95 = [0]; }, x => { x.sensitivity.teams[0].noiseSpread = 2; }, x => { x.sensitivity.teams[0].finalScore = 'high'; }, x => { x.sensitivity.teams[0].ranks = [1, 2]; },
 ];
 mutations.forEach((mutate, i) => { const bad = JSON.parse(JSON.stringify(d));mutate(bad);assert.throws(() => core.validate(bad), /invalid sensitivity panel/, 'mutation ' + i); });
 // A hundred thousand teams cannot hide in a report.
 const huge = JSON.parse(JSON.stringify(d));huge.sensitivity.teams = Array.from({ length: 501 }, () => huge.sensitivity.teams[0]);assert.throws(() => core.validate(huge), /invalid sensitivity panel/);
});

'use strict';
// The viewer's alternate-moveset caption (includes/pro/neural-portable.js) and the report validator for `alternatePanel`.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const core = require('../../includes/pro/neural-report-core.js'), A = require('./alternate-panel.cjs'), {createMeta} = require('./meta.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8');
const ctx = vm.createContext({});vm.runInContext(source, ctx);
const P = ctx.NeuralPortable, v3 = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz'))));
const names = team => Array.from(team).map(i => 'M' + i).join(' / ');

// A block built by the same code the search uses, for a report's finalists.
function blockFor(report, { fixtures = 40, observed = false } = {}) {
 const finalists = report.table.rows.filter(r => r.finalist && Number.isFinite(r.test)), teams = finalists.map(r => ({ team: r.team, primary: !!r.primary, finalScore: r.test }));
 const species = ['melmetal', 'tinkaton', 'cramorant', 'altaria'].map((id, i) => ({ speciesId: id, speciesName: id, dex: i + 1, weight: 4 - i, moveset: ['A', 'B', 'C'], features: [0], scoutByType: Array(18).fill(.5), types: [] }));
 const prepared = { species, variants: species.flatMap(s => [s, { ...s, moveset: ['A', 'B', 'D'], scoutScore: .4 }, { ...s, moveset: ['A', 'C', 'D'], scoutScore: .3 }]) };
 const info = A.plan(prepared, createMeta(species, { mode: 'independent' }), { fixtures, seed: 9, observed });
 const rows = teams.map((t, ti) => ({ team: t.team, scores: Array.from({ length: fixtures * 3 }, (_, p) => Math.max(0, Math.min(1, .6 + .15 * Math.sin(Math.floor(p / 3) + ti) + [0, -.06, -.1][p % 3]))) }));
 return A.assemble(info, teams, rows, { seed: 4 }).block;
}

test('the caption is the module\'s own wording; nothing without the field', () => {
 const d = v3(), block = blockFor(d);d.alternatePanel = block;
 const text = P.alternatePanelCaption(d, names);
 assert.equal(text, A.caption(block, names));
 assert.match(text, /^Alternate opponent movesets \(40 common fixtures, after the final test\)/);
 assert.match(text, / pp\) with the best alternate and /);assert.match(text, /with the second alternate/);assert.match(text, /Exploratory: fewer than 256 fixtures/);
 assert.equal(P.alternatePanelCaption(v3(), names), '');assert.equal(P.alternatePanelCaption({ alternatePanel: { teams: [] } }, names), '');
 // One finalist: no cross-finalist clause.
 const single = { alternatePanel: { ...block, teams: block.teams.slice(0, 1) } };
 assert.doesNotMatch(P.alternatePanelCaption(single, names), /across finalists/);assert.equal(P.alternatePanelCaption(single, names), A.caption(single.alternatePanel, names));
 // A run of 256 fixtures or more is not called exploratory.
 const long = blockFor(v3(), { fixtures: 256 });assert.doesNotMatch(A.caption(long, names), /Exploratory/);
 assert.equal(P.alternatePanelCaption({ alternatePanel: long }, names), A.caption(long, names));
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

test('the finalists card shows the caption line, and older reports show nothing new', () => {
 const d = v3(), before = renderText(JSON.parse(JSON.stringify(d))).text;
 assert.doesNotMatch(before, /Alternate opponent movesets/);
 d.alternatePanel = blockFor(d);core.validate(d);
 const { text, host } = renderText(d), card = find(host, n => n.tag === 'section' && n.className === 'nn-card' && n.children[0]?.text === 'Finalists on the same final opponents')[0];
 assert.ok(card);
 assert.match(text, /Alternate opponent movesets \(40 common fixtures, after the final test\)/);
 const lines = find(card, n => /^Alternate opponent movesets/.test(n.text));
 assert.equal(lines.length, 1);assert.equal(lines[0].className, 'nn-caption');
 assert.equal(text.replace(lines[0].text, '').replace(/\s+/g, ' ').trim(), before.replace(/\s+/g, ' ').trim(), 'nothing else on the page changed');
});

test('report validation accepts the block and refuses a malformed one', () => {
 const trim = x => { x.table.rows = x.table.rows.slice(0, 3);x.table.matches = Object.fromEntries(x.table.rows.map(r => [r.id, x.table.matches[r.id]]));return x; };
 const d = v3(), block = blockFor(d);trim(d);core.validate(d);
 d.alternatePanel = block;assert.equal(core.validate(d), d);
 for (const empty of [null, undefined]) { const x = JSON.parse(JSON.stringify(d));x.alternatePanel = empty;assert.equal(core.validate(x), x); }
 const mutations = [
  x => { x.alternatePanel.fixtures = 0; }, x => { x.alternatePanel.fixtures = 41; }, x => { x.alternatePanel.requestedFixtures = 'many'; }, x => { x.alternatePanel.requestedFixtures = 200000; }, x => { x.alternatePanel = 'yes'; },
  x => { x.alternatePanel.reference = null; }, x => { x.alternatePanel.reference.id = ''; }, x => { x.alternatePanel.reference.label = 7; },
  x => { x.alternatePanel.levels = []; }, x => { x.alternatePanel.levels = 'two'; }, x => { x.alternatePanel.levels[1].id = x.alternatePanel.levels[0].id; }, x => { x.alternatePanel.levels[0].id = x.alternatePanel.reference.id; },
  x => { x.alternatePanel.levels[0].rank = 0; }, x => { x.alternatePanel.levels[0].changedMemberShare = 2; }, x => { x.alternatePanel.levels[0].label = 'x'.repeat(101); },
  x => { x.alternatePanel.teams = {}; }, x => { x.alternatePanel.teams[0].team = [0, 1]; }, x => { x.alternatePanel.teams[0].team = [0, 1, 99999999]; },
  x => { x.alternatePanel.teams[0].scores.run = 1.5; }, x => { x.alternatePanel.teams[0].scores['alternate-1'] = NaN; }, x => { delete x.alternatePanel.teams[0].scores['alternate-2']; },
  x => { x.alternatePanel.teams[0].deltas = x.alternatePanel.teams[0].deltas.slice(1); }, x => { x.alternatePanel.teams[0].deltas[0].level = 'other'; }, x => { x.alternatePanel.teams[0].deltas[0].interval95 = [0]; },
  x => { x.alternatePanel.teams[0].deltas[0].verdict = 'better'; }, x => { x.alternatePanel.teams[0].deltas[0].delta = null; }, x => { x.alternatePanel.teams[0].worstDelta = 'low'; }, x => { x.alternatePanel.teams[0].worstLevel = ''; },
 ];
 mutations.forEach((mutate, i) => { const bad = JSON.parse(JSON.stringify(d));mutate(bad);assert.throws(() => core.validate(bad), /invalid alternate panel/, 'mutation ' + i); });
 const huge = JSON.parse(JSON.stringify(d));huge.alternatePanel.teams = Array.from({ length: 65 }, () => huge.alternatePanel.teams[0]);assert.throws(() => core.validate(huge), /invalid alternate panel/);
});

test('a report with observed-moveset opponent rows still validates, and a missing species row does not', () => {
 const d = v3();
 const trim = x => { x.table.rows = x.table.rows.slice(0, 3);x.table.matches = Object.fromEntries(x.table.rows.map(r => [r.id, x.table.matches[r.id]]));return x; };trim(d);
 const base = d.table.opponents[0], extra = { ...base, moveset: ['THUNDER_SHOCK', 'ROCK_SLIDE', 'SUPER_POWER'], recommended: base.moveset };
 d.table.opponents.push(extra);const last = d.table.opponents.length - 1, row = d.table.rows[0];
 d.table.matches[row.id].test = [[[last, 1, 2], 123, 1], ...d.table.matches[row.id].test.slice(0, 2)];
 assert.equal(core.validate(d), d);
 d.table.matches[row.id].test[0][0][0] = last + 1;assert.throws(() => core.validate(d), /invalid|missing|match/i);
});

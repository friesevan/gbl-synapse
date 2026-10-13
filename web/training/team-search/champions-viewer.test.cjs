'use strict';
// The viewer's baseline chart (includes/pro/neural-portable.js) and the report validator for the previous-champions group.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const core = require('../../includes/pro/neural-report-core.js');
const ctx = vm.createContext({});vm.runInContext(fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8'), ctx);
const P = ctx.NeuralPortable, v3 = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz'))));
const names = team => Array.from(team).map(i => 'M' + i).join(' / '), plain = x => x == null ? x : JSON.parse(JSON.stringify(x));

const withChampions = () => ({
 baselines: {
  'uniform-random': { delta: .45, baselineTeams: 4 }, 'weight-sampled-best-moves': { delta: .3, baselineTeams: 4 }, 'greedy-scout-coverage': { delta: .35, baselineTeams: 4 },
  'previous-champions': { delta: .02, interval95: [-.03, .07], baselineTeams: 3 },
 },
 finalPanel: { completedFixtures: 512 },
 champions: {
  teams: [], skipped: [{ label: 'v1-published', source: 'v1-published', reason: 'moveset-not-in-pool', detail: 'Quagsire with MUD_SHOT is not among the pool\'s 5 retained movesets for that species' }],
  comparisons: {
   fixtures: 512, outcome: 'unresolved', summary: 'The new primary is not clearly separated from at least one previous champion on this panel; a difference inside the interval is a tie.', method: 'simultaneous paired opponent-fixture bootstrap',
   entries: [
    { team: [1, 2, 3], label: 'v3-refined', sources: [{ source: 'v3-refined', role: 'primary', rank: 1 }], score: .70, delta: .01, interval95: [-.04, .06], verdict: 'unresolved', sameTeam: false },
    { team: [4, 5, 6], label: 'v4-observed', sources: [{ source: 'v4-observed', role: 'finalist', rank: 3 }], score: .60, delta: .11, interval95: [.06, .16], verdict: 'primary-better', sameTeam: false },
    { team: [7, 8, 9], label: 'v1-published', sources: [{ source: 'v1-published', role: 'primary', rank: 1 }], score: .71, delta: 0, interval95: [0, 0], verdict: 'same-team', sameTeam: true },
   ],
  },
 },
});

test('the baseline chart shows the previous-champions group beside the simple groups, and each champion as its own bar', () => {
 const d = withChampions(), primary = { test: .71 }, chart = plain(P.baselineChart(d, primary, names));
 assert.deepEqual(chart.bars.map(b => b.label), ['Selected search team', 'Random teams', 'Popularity + recommended moves', 'Simple coverage strategy', 'Previous champions (average)', 'Champion · v3-refined', 'Champion · v4-observed', 'Champion · v1-published']);
 // Group bars are the primary's score minus the paired difference; each champion bar is its own score on the final panel.
 assert.deepEqual(chart.bars.map(b => Math.round(b.score * 1000) / 1000), [.71, .26, .41, .36, .69, .70, .60, .71]);
 assert.equal(chart.bars[4].color, 'var(--viz-4)');assert.equal(chart.bars[1].color, 'var(--viz-neutral)');assert.equal(chart.bars[0].color, undefined);
 assert.match(chart.note, /same 512 final opponent fixtures/);assert.match(chart.note, /only 4 \/ 4 \/ 4 teams were tested in the simple groups/);assert.match(chart.note, /chose that champion again, which is a tie, not a failure/);
 // Without a champion table the group is still drawn, labelled, with no per-champion bars and no champion wording.
 const bare = withChampions();delete bare.champions;const unlisted = plain(P.baselineChart(bare, primary, names));
 assert.equal(unlisted.bars.length, 5);assert.equal(unlisted.bars[4].label, 'Previous champions (average)');assert.doesNotMatch(unlisted.note, /chose that champion/);
 // Nothing to draw without a final score or any baselines.
 assert.equal(P.baselineChart(d, { test: null }, names), null);assert.equal(P.baselineChart({ baselines: {} }, primary, names), null);
});

test('the intro sentence keeps the simple-baseline claim separate from the champions claim', () => {
 const d = withChampions();
 assert.equal(P.baselineSentence(d), 'It beat the tested simple baseline groups. ' + d.champions.comparisons.summary + ' ');
 // A primary that does not beat the champions on average must not poison the claim about the simple groups.
 d.baselines['previous-champions'].delta = -.05;assert.match(P.baselineSentence(d), /^It beat the tested simple baseline groups\./);
 // A loss to a simple group removes that claim but not the champions sentence.
 d.baselines['uniform-random'].delta = -.01;assert.doesNotMatch(P.baselineSentence(d), /simple baseline/);assert.match(P.baselineSentence(d), /previous champion/);
 assert.equal(P.baselineSentence({ baselines: { 'uniform-random': { delta: .1 } } }), 'It beat the tested simple baseline groups. ');assert.equal(P.baselineSentence({}), '');
});

test('the champion table has one row per champion with its verdict wording, and lists teams not in the pool', () => {
 const t = plain(P.championTable(withChampions(), names));
 assert.equal(t.rows.length, 3);assert.equal(t.fixtures, 512);
 assert.deepEqual(t.rows[0], ['v3-refined', 'M1 / M2 / M3', '70.0%', '+1.0 pp', '-4.0 pp to +6.0 pp', 'unresolved: a tie at this panel size']);
 assert.deepEqual(t.rows[1], ['v4-observed', 'M4 / M5 / M6', '60.0%', '+11.0 pp', '+6.0 pp to +16.0 pp', 'primary better']);
 assert.deepEqual(t.rows[2], ['v1-published', 'M7 / M8 / M9', '71.0%', '0.0 pp', '—', 'same team (rediscovered)']);
 assert.equal(t.skipped.length, 1);assert.match(t.skipped[0], /v1-published: Quagsire with MUD_SHOT/);
 const merged = withChampions();merged.champions.comparisons.entries[0].sources.push({ source: 'v4-observed', role: 'finalist', rank: 2 });assert.equal(plain(P.championTable(merged, names)).rows[0][0], 'v3-refined (also v4-observed #2)');
 assert.equal(P.championTable({ baselines: {} }, names), null);assert.equal(P.championTable({ champions: { comparisons: { entries: [] } } }, names), null);
});

test('published reports without champions chart exactly as before', () => {
 const d = v3(), primary = d.table.rows.find(r => r.primary), chart = plain(P.baselineChart(d, primary, names));
 assert.equal(chart.bars.length, 4);assert.deepEqual(chart.bars.slice(1).map(b => b.label), ['Random teams', 'Popularity + recommended moves', 'Simple coverage strategy']);
 assert.equal(P.baselineSentence(d), 'It beat the tested simple baseline groups. ');assert.equal(P.championTable(d, names), null);
 assert.match(chart.note, /Baseline bars are group averages; only 4 \/ 4 \/ 4 teams were tested in the simple groups\./);
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
 vm.runInContext(fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8'), c);
 c.NeuralPortable.render(report);
 return host.textContent;
}

test('the viewer renders the champion chart, sentence and table from a report, and nothing new for a report without champions', () => {
 const d = v3(), primary = d.table.rows.find(r => r.primary), rows = d.table.rows.filter(r => r.finalist && !r.primary).slice(0, 2), score = primary.test;
 const before = renderText(JSON.parse(JSON.stringify(d)));
 assert.doesNotMatch(before, /Previous champions/);assert.match(before, /Did the search find stronger teams\?/);assert.match(before, /It beat the tested simple baseline groups\./);
 d.baselines['previous-champions'] = { delta: .01, interval95: [-.03, .05], fixtures: 512, baselineTeams: 2, method: 'x' };
 const entry = (r, label, verdict, delta) => ({ team: r.team, label, sources: [{ source: label, role: 'primary', rank: 1 }], score: r.test, delta, interval95: [delta - .05, delta + .05], verdict, sameTeam: false });
 d.champions = { teams: rows.map((r, i) => ({ team: r.team, label: 'old-' + i, sources: [] })), skipped: [{ label: 'old-x', source: 'old-x', reason: 'moveset-not-in-pool', detail: 'Quagsire with MUD_SHOT is not among the pool\'s 5 retained movesets' }], comparisons: { fixtures: 512, outcome: 'unresolved', summary: 'The new primary is not clearly separated from at least one previous champion on this panel; a difference inside the interval is a tie.', method: 'simultaneous paired opponent-fixture bootstrap', entries: [entry(rows[0], 'old-0', 'unresolved', score - rows[0].test), entry(rows[1], 'old-1', 'primary-better', score - rows[1].test)] } };
 core.validate(d);
 const text = renderText(d);
 assert.match(text, /Previous champions \(average\)/);assert.match(text, /Champion · old-0/);assert.match(text, /Champion · old-1/);assert.match(text, /Previous champions, one by one/);
 assert.match(text, /not clearly separated from at least one previous champion/);assert.match(text, /unresolved: a tie at this panel size/);assert.match(text, /primary better/);
 assert.match(text, /Not tested \(not in this pool\): old-x: Quagsire with MUD_SHOT/);assert.match(text, /previous-champions: \+1\.0 pp/);
});

test('report validation accepts the champions block and refuses a malformed one', () => {
 const d = v3();core.validate(d);
 d.champions = { scope: 'primary', teams: [{ team: [0, 1, 2], label: 'v3', sources: [] }], skipped: [{ label: 'x', source: 'x', reason: 'species-not-in-pool', detail: 'x is not in the current pool' }], comparisons: { entries: [{ team: [0, 1, 2], score: .5, delta: 0, interval95: [0, 0], verdict: 'same-team' }] } };
 assert.equal(core.validate(d), d);
 for (const mutate of [x => { x.champions.teams[0].team = [0, 1]; }, x => { x.champions.teams[0].team = [0, 1, 99999999]; }, x => { x.champions.teams[0].label = 7; }, x => { x.champions.teams = 'nope'; }, x => { x.champions.skipped = [{ label: 'a' }]; }, x => { x.champions.skipped = 'none'; }]) { const bad = JSON.parse(JSON.stringify(d));mutate(bad);assert.throws(() => core.validate(bad), /invalid previous champions/); }
 for (const mutate of [x => { x.champions.comparisons.entries[0].score = NaN; }, x => { x.champions.comparisons.entries[0].interval95 = [0]; }, x => { x.champions.comparisons.entries[0].verdict = 5; }, x => { x.champions.comparisons.entries = {}; }]) { const bad = JSON.parse(JSON.stringify(d));mutate(bad);assert.throws(() => core.validate(bad), /invalid champion comparisons/); }
 d.champions = null;assert.equal(core.validate(d), d);
});

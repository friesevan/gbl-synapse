'use strict';
// The viewer (includes/pro/neural-portable.js) and the report validator (neural-report-core.js) for the sealed
// confirmation test: pure helpers, the finalist cards, the Search Performance table and the validation of the block.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const core = require('../../includes/pro/neural-report-core.js');
const source = fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8');
const ctx = vm.createContext({});vm.runInContext(source, ctx);
const P = ctx.NeuralPortable, v3 = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz'))));
const names = team => Array.from(team).map(i => 'M' + i).join(' / '), plain = x => x == null ? x : JSON.parse(JSON.stringify(x));

const confirmed = () => ({
 seed: 1688725709, bootstrapSeed: 830124, requestedFixtures: 256, completedFixtures: 256, complete: true, primary: [1, 2, 3], finalPanelFixtures: 512,
 triggers: [{ stage: 'final-panel', fixtures: 512, challengers: [{ team: [4, 5, 6], evidence: [{ kind: 'finalist', delta: -.08, interval95: [-.12, -.04] }] }] }],
 teams: [{ team: [1, 2, 3], role: 'primary', finalScore: .80, score: .74 }, { team: [4, 5, 6], role: 'challenger', kind: 'finalist', sources: ['finalist'], finalScore: .88, score: .79 }, { team: [7, 8, 9], role: 'challenger', kind: 'previous-champion', sources: ['previous-champion'], finalScore: .70, score: .60, resolvedByExtension: true }],
 comparisons: [
  { team: [4, 5, 6], kind: 'finalist', delta: -.05, interval95: [-.09, -.01], simultaneous95: [-.10, 0], verdict: 'unresolved', confirmed: false },
  { team: [7, 8, 9], kind: 'previous-champion', delta: .14, interval95: [.10, .18], simultaneous95: [.09, .19], verdict: 'primary-better', confirmed: false, resolvedByExtension: true },
 ],
 pairs: [], outcome: 'not-confirmed', summary: 'The challenger advantage seen on the final panel was not confirmed on 256 sealed fixtures: 1 with the primary clearly ahead, 1 unresolved.', method: 'paired opponent-fixture bootstrap',
});

test('the confirmation view has one row per team with the final-panel and sealed-panel scores side by side', () => {
 const view = plain(P.confirmationView({ confirmation: confirmed() }, names));
 assert.equal(view.outcome, 'not-confirmed');assert.equal(view.fixtures, 256);assert.equal(view.requested, 256);assert.equal(view.seed, 1688725709);assert.match(view.summary, /was not confirmed/);
 assert.deepEqual(view.rows[0], ['M1 / M2 / M3', 'primary', '80.0%', '74.0%', '—', '—', 'reference']);
 assert.deepEqual(view.rows[1], ['M4 / M5 / M6', 'challenger', '88.0%', '79.0%', '-5.0 pp', '-10.0 pp to +0.0 pp', 'unresolved: a tie at this panel size']);
 assert.deepEqual(view.rows[2], ['M7 / M8 / M9', 'challenger (resolved by the longer final panel)', '70.0%', '60.0%', '+14.0 pp', '+9.0 pp to +19.0 pp', 'primary better']);
 const hit = confirmed();hit.outcome = 'challenger-confirmed';hit.comparisons[0] = { ...hit.comparisons[0], verdict: 'challenger-better', confirmed: true, delta: -.10, simultaneous95: [-.14, -.06] };
 assert.equal(plain(P.confirmationView({ confirmation: hit }, names)).rows[1][6], 'challenger better: confirmed');
 assert.equal(P.confirmationView({}, names), null);assert.equal(P.confirmationView({ confirmation: null }, names), null);assert.equal(P.confirmationView({ confirmation: { teams: [] } }, names), null);
});

test('the intro sentence and the finalist cards say whether the challenger advantage was confirmed', () => {
 const d = { confirmation: confirmed() };
 assert.match(P.confirmationSentence(d), /was not confirmed on a new sealed panel/);
 d.confirmation.outcome = 'challenger-confirmed';assert.match(P.confirmationSentence(d), /was confirmed on a new sealed panel; the selected team stays/);
 d.confirmation.outcome = 'incomplete';assert.match(P.confirmationSentence(d), /could not be completed/);
 assert.equal(P.confirmationSentence({}), '');assert.equal(P.confirmationSentence({ confirmation: null }), '');
 const hit = { confirmation: confirmed() };hit.confirmation.comparisons[0] = { ...hit.confirmation.comparisons[0], verdict: 'challenger-better', confirmed: true };
 assert.equal(P.confirmationBadge(hit, [4, 5, 6]), 'confirmed better than the selected team on a sealed panel');
 assert.equal(P.confirmationBadge(hit, [7, 8, 9]), 'not confirmed: the selected team led on the sealed panel');
 assert.equal(P.confirmationBadge({ confirmation: confirmed() }, [4, 5, 6]), 'not confirmed: unresolved on the sealed panel');
 assert.equal(P.confirmationBadge(hit, [1, 2, 3]), 'reference in the sealed confirmation test');
 assert.equal(P.confirmationBadge(hit, [9, 9, 9]), '');assert.equal(P.confirmationBadge({}, [4, 5, 6]), '');assert.equal(P.confirmationBadge(hit, null), '');
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
 return host.textContent;
}

test('the viewer renders the confirmation in the finalist chart, the intro and Search Performance, and nothing new without one', () => {
 const d = v3(), primary = d.table.rows.find(r => r.primary), others = d.table.rows.filter(r => r.finalist && !r.primary).slice(0, 2);
 const before = renderText(JSON.parse(JSON.stringify(d)));
 assert.doesNotMatch(before, /Sealed confirmation test/);assert.doesNotMatch(before, /confirmed better than the selected team/);assert.match(before, /Finalists on the same final opponents/);
 const entry = (r, verdict, delta) => ({ team: r.team, kind: 'finalist', delta, interval95: [delta - .05, delta + .05], simultaneous95: [delta - .08, delta + .08], verdict, confirmed: verdict === 'challenger-better' });
 d.confirmation = {
  seed: 12345, bootstrapSeed: 1, requestedFixtures: 256, completedFixtures: 256, complete: true, primary: primary.team, finalPanelFixtures: 512, triggers: [],
  teams: [{ team: primary.team, role: 'primary', finalScore: primary.test, score: .7 }, { team: others[0].team, role: 'challenger', kind: 'finalist', finalScore: others[0].test, score: .75 }, { team: others[1].team, role: 'challenger', kind: 'finalist', finalScore: others[1].test, score: .6 }],
  comparisons: [entry(others[0], 'challenger-better', -.05), entry(others[1], 'primary-better', .1)], pairs: [],
  outcome: 'challenger-confirmed', summary: '1 of 2 challengers scored clearly above the screening-selected primary on the new 256 sealed fixtures.', method: 'paired opponent-fixture bootstrap',
 };
 core.validate(d);
 const text = renderText(d);
 assert.match(text, /Sealed confirmation test/);assert.match(text, /1 of 2 challengers scored clearly above the screening-selected primary/);
 assert.match(text, /confirmed better than the selected team on a sealed panel/, 'on the finalist card');assert.match(text, /not confirmed: the selected team led on the sealed panel/);
 assert.match(text, /was confirmed on a new sealed panel; the selected team stays/, 'in the intro');assert.match(text, /256 of 256 sealed fixtures · seed 12345/);
 assert.match(text, /challenger better: confirmed/);assert.match(text, /Final-panel score/);assert.match(text, /Confirmation score/);
 // A longer final panel names its target in the fixture counter.
 d.finalPanel = { ...d.finalPanel, requestedFixtures: 512, completedFixtures: 768, extension: { baseFixtures: 512, requestedMax: 1024, step: 64, completedFixtures: 768, steps: [], stoppedBecause: 'time' } };
 core.validate(d);assert.match(renderText(d), /768 \/ 1024/);
});

test('report validation accepts the confirmation block and refuses a malformed one', () => {
 const d = v3();core.validate(d);
 const valid = () => { const base = JSON.parse(JSON.stringify(d)), rows = base.table.rows.filter(r => r.finalist).slice(0, 2), c = confirmed();
  const [a, b] = rows.map(r => r.team);c.primary = a;c.teams = [{ team: a, role: 'primary', finalScore: .8, score: .7 }, { team: b, role: 'challenger', finalScore: .85, score: .74 }];
  c.comparisons = [{ team: b, delta: -.04, interval95: [-.08, 0], simultaneous95: [-.1, .02], verdict: 'unresolved', confirmed: false }];c.pairs = [{ a, b, delta: -.04, simultaneous95: [-.1, .02], verdict: 'unresolved' }];
  base.confirmation = c;return base; };
 const ok = valid();assert.equal(core.validate(ok), ok);
 ok.confirmation = null;assert.equal(core.validate(ok), ok);
 for (const mutate of [
  x => { x.confirmation.seed = -1; }, x => { x.confirmation.seed = 2 ** 33; }, x => { x.confirmation.requestedFixtures = 0; }, x => { x.confirmation.completedFixtures = 300; }, x => { x.confirmation.primary = [1, 2]; },
  x => { x.confirmation.primary = [0, 1, 99999999]; }, x => { x.confirmation.outcome = 'perhaps'; }, x => { x.confirmation.summary = 5; }, x => { x.confirmation.teams = 'none'; }, x => { x.confirmation.teams[0].role = 'boss'; },
  x => { x.confirmation.teams[1].score = 7; }, x => { x.confirmation.comparisons[0].verdict = 'maybe'; }, x => { x.confirmation.comparisons[0].simultaneous95 = [0]; }, x => { x.confirmation.comparisons[0].confirmed = 'yes'; },
  x => { x.confirmation.comparisons[0].delta = NaN; }, x => { x.confirmation.pairs = {}; }, x => { x.confirmation.pairs[0].a = [1]; }, x => { x.confirmation.method = {}; },
 ]) { const bad = valid();mutate(bad);assert.throws(() => core.validate(bad), /invalid confirmation/, mutate.toString()); }
 // Older reports have no such block at all.
 const old = v3();delete old.confirmation;assert.equal(core.validate(old), old);
});

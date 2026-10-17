'use strict';
// The viewer's caption under the held-out error chart (includes/pro/neural-portable.js) and the report validator for `uncertaintyCalibration`.
const test = require('node:test'), assert = require('node:assert/strict'), vm = require('node:vm'), fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const core = require('../../includes/pro/neural-report-core.js'), { uncertaintyCalibration, calibrationSummary } = require('./calibration.cjs');
const source = fs.readFileSync(path.join(__dirname, '../../includes/pro/neural-portable.js'), 'utf8');
const ctx = vm.createContext({});vm.runInContext(source, ctx);
const P = ctx.NeuralPortable, v3 = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '../../includes/pro/data/team-v3-refined.pvpteams.json.gz'))));
const sample = (extra = {}) => ({ teams: 1752, k80: 5.25, k90: 8.2, coverage80: .8, coverage90: .9, coverage1: .256, spearman: .13, medianSpread: .035, medianAbsResidual: .08, wellMeasured: null, ...extra });
const round = (n, c) => ({ round: n, diagnostics: { neuralMSE: .02, constantMSE: .06, ...(c === undefined ? {} : { uncertaintyCalibration: c }) }, elapsedSeconds: n });

test('the caption names k90 and the share covered in the last round, and says what the spread is', () => {
  const text = P.calibrationCaption([round(1, null), round(2, sample())]);
  assert.match(text, /^±8\.2 × spread covered 90% of the 1,752 held-out teams in the last round \(±5\.3 × covered 80%\); ±1 × spread covered 26%\./);
  assert.match(text, /Rank correlation of spread with error: 0\.13 \(negligible\)\./);
  assert.match(text, /not a confidence interval/);assert.match(text, /sampling noise/);
  // The most recent round that has a value is used and named when it is not the last.
  assert.match(P.calibrationCaption([round(1, sample({ k90: 3.1, teams: 40 })), round(2, null)]), /^±3\.1 × spread covered 90% of the 40 held-out teams in round 1 /);
  assert.match(P.calibrationCaption([round(1, sample({ k90: 3.1 })), round(2, sample({ k90: 12.4 }))]), /^±12\.4 ×/);
  // Large multipliers are whole numbers; missing pieces are left out rather than printed as NaN.
  assert.match(P.calibrationCaption([round(1, sample({ k90: 143.7 }))]), /^±144 ×/);
  const sparse = P.calibrationCaption([round(1, sample({ k80: null, coverage1: null, spearman: null }))]);
  assert.doesNotMatch(sparse, /80%|NaN|null|undefined|±1 ×/);assert.match(sparse, /could not be rank-compared/);
  for (const [rho, word] of [[.7, 'strong'], [.45, 'moderate'], [.25, 'weak'], [0, 'negligible'], [-.5, 'negative']]) assert.match(P.calibrationCaption([round(1, sample({ spearman: rho }))]), new RegExp('\\(' + word + '\\)'));
});

test('there is no caption without a read-out, so older reports and early rounds are unchanged', () => {
  assert.equal(P.calibrationCaption([]), null);
  assert.equal(P.calibrationCaption(undefined), null);
  assert.equal(P.calibrationCaption([round(1), round(2, null), round(3, sample({ k90: null }))]), null, 'a null multiplier (infinite) is not captioned');
});

// A just-enough DOM to run the viewer's real render() and read back where the caption appears.
function renderTree(report) {
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
  return host;
}
const find = (node, test, out = []) => { if (test(node)) out.push(node); node.children.forEach(c => find(c, test, out)); return out; };

test('the caption sits directly under the held-out error chart and nowhere else', () => {
  const d = v3();
  d.history.forEach((h, i) => { h.diagnostics = { ...h.diagnostics, uncertaintyCalibration: i === d.history.length - 1 ? sample({ k90: 9.9, teams: 321 }) : null }; });
  const host = renderTree(d), cards = find(host, n => n.tag === 'section' && n.className === 'nn-card' && n.children[0]?.text === 'Held-out team prediction error · lower is better');
  assert.equal(cards.length, 1);
  const captions = cards[0].children.filter(n => n.className === 'nn-caption').map(n => n.text);
  assert.equal(captions.length, 2, 'the existing caption and the calibration caption');
  assert.match(captions[0], /Mean squared error measures/);
  assert.match(captions[1], /^±9\.9 × spread covered 90% of the 321 held-out teams in the last round/);
  assert.equal(find(host, n => /spread covered 90%/.test(n.text)).length, 1);
  // Older reports (no read-out anywhere) render the chart with its single caption.
  const old = renderTree(v3()), oldCard = find(old, n => n.tag === 'section' && n.className === 'nn-card' && n.children[0]?.text === 'Held-out team prediction error · lower is better')[0];
  assert.equal(oldCard.children.filter(n => n.className === 'nn-caption').length, 1);
  assert.doesNotMatch(old.textContent, /spread covered/);
});

test('report validation accepts the read-out on diagnostics and on every round, and refuses a malformed one', () => {
  const trim = x => { x.table.rows = x.table.rows.slice(0, 3);x.table.matches = Object.fromEntries(x.table.rows.map(r => [r.id, x.table.matches[r.id]]));return x; };
  const d = trim(v3());core.validate(d);
  d.diagnostics = { ...d.diagnostics, uncertaintyCalibration: sample({ wellMeasured: { minFixtures: 64, ...sample({ teams: 800 }) } }) };
  d.history[0].diagnostics = { ...d.history[0].diagnostics, uncertaintyCalibration: sample() };
  assert.equal(core.validate(d), d);
  // Real output of the module passes, including null fields.
  const rows = Array.from({ length: 40 }, (_, i) => ({ key: 'k' + i, predicted: .5, spread: i < 6 ? 0 : .02, observed: .5 + (i + 1) / 100, fixtures: 64 }));
  d.diagnostics.uncertaintyCalibration = JSON.parse(JSON.stringify(calibrationSummary(rows)));assert.equal(core.validate(d), d);
  assert.equal(d.diagnostics.uncertaintyCalibration.k90, null);
  d.diagnostics.uncertaintyCalibration = null;assert.equal(core.validate(d), d);
  const bad = [
    c => { c.teams = -1; }, c => { c.teams = 1.5; }, c => { c.teams = '12'; }, c => { c.k90 = -1; }, c => { c.k80 = Infinity; }, c => { c.k90 = 'x'; }, c => { c.coverage90 = 1.2; }, c => { c.coverage1 = -.1; },
    c => { c.spearman = 1.5; }, c => { c.medianSpread = -.01; }, c => { c.wellMeasured = { ...sample(), minFixtures: 0 }; }, c => { c.wellMeasured = { ...sample(), minFixtures: 64, k90: -2 }; },
    c => { c.wellMeasured = { minFixtures: 64, ...sample({ wellMeasured: { minFixtures: 8, ...sample() } }) }; }
  ];
  bad.forEach((mutate, i) => {
    const onDiagnostics = JSON.parse(JSON.stringify(d)), onRound = JSON.parse(JSON.stringify(d));
    onDiagnostics.diagnostics.uncertaintyCalibration = sample();mutate(onDiagnostics.diagnostics.uncertaintyCalibration);
    onRound.history[1].diagnostics = { ...onRound.history[1].diagnostics, uncertaintyCalibration: sample() };mutate(onRound.history[1].diagnostics.uncertaintyCalibration);
    assert.throws(() => core.validate(onDiagnostics), /invalid uncertainty calibration/, 'diagnostics mutation ' + i);
    assert.throws(() => core.validate(onRound), /invalid uncertainty calibration/, 'history mutation ' + i);
  });
  assert.throws(() => core.validateCalibration({ teams: 3, k90: -1 }), /uncertainty calibration/);
  assert.equal(core.validateCalibration(uncertaintyCalibration(rows, { minTeams: 5 })).teams, 40);
});

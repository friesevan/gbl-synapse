'use strict';
// Report text for the selection protocol (confirmation.cjs, selection.cjs): the sealed confirmation test, the
// minimum-evidence rule and the longer final panel, as HTML for report.html and Markdown for findings.md.
const { challengers } = require('./confirmation.cjs');
const VERDICT = { 'challenger-better': 'challenger better: confirmed', 'primary-better': 'primary better', unresolved: 'unresolved (a tie at this panel size)' };
const ROLE = { primary: 'primary', challenger: 'challenger' };
const KIND = { finalist: 'finalist', 'previous-champion': 'previous champion' };

const names = (team, pool) => team.map(i => pool.variants[i].speciesName);
const pp = x => (100 * x).toFixed(1);

function confirmationTable(c, pool) {
 const byKey = new Map(c.comparisons.map(x => [x.team.join(','), x]));
 return c.teams.map(t => {
  const comparison = byKey.get(t.team.join(',')), isPrimary = t.role === 'primary';
  return {
   names: names(t.team, pool), role: isPrimary ? 'primary' : (t.sources || [t.kind]).map(k => KIND[k] || k).join(' and ') + ' challenger' + (t.resolvedByExtension ? ' (resolved only by the longer final panel)' : ''),
   finalScore: t.finalScore, confirmationScore: t.score, delta: comparison?.delta, interval: comparison?.simultaneous95, verdict: comparison ? VERDICT[comparison.verdict] : (isPrimary ? 'reference' : 'not played'),
  };
 });
}

function selectionLines(state) {
 const lines = [], config = state.config || {};
 if (config.minLeadFixtures) {
  const s = state.selection;
  lines.push('Minimum evidence before leading: a team needed at least ' + config.minLeadFixtures + ' fixtures to lead the training ranking, to be the retest incumbent or to be screened; teams below it ranked after every team above it.'
   + (s ? ' When screening began, ' + s.teamsAtOrAboveThreshold + ' of ' + s.teams + ' teams had reached it' + (s.fallback ? ' (none had, so the ranking was left unchanged)' : '; ' + s.screeningCandidatesBelowThreshold + ' of the ' + s.screeningCandidates + ' screened teams were below it') + '.' : ''));
 }
 const extension = state.finalPanel?.extension;
 if (extension) {
  lines.push('Final panel: ' + extension.completedFixtures + ' of ' + extension.requestedMax + ' common fixtures (base ' + extension.baseFixtures + ', extended in steps of ' + extension.step + ' while time remained; ' + ({ 'target-reached': 'target reached', time: 'stopped when the time ran out', stopped: 'stopped by request', 'base-incomplete': 'not started: the base panel itself was not completed', 'in-progress': 'interrupted' }[extension.stoppedBecause] || extension.stoppedBecause) + ').');
 }
 if (config.confirmationOpponents && state.validations?.length && !state.confirmation) {
  const waiting = challengers(state).length;
  lines.push('Sealed confirmation test (' + config.confirmationOpponents + ' fixtures) was enabled and ' + (waiting ? 'needed for ' + waiting + ' challenger' + (waiting > 1 ? 's' : '') + ' clearly above the primary on the final panel, but it was not recorded (the run ended first).' : 'not needed: no challenger was clearly above the primary on the final panel.'));
 }
 return lines;
}

function html(state, pool, { escape, pct }) {
 const c = state.confirmation;
 let out = '';
 if (c) {
  const rows = confirmationTable(c, pool);
  out += '<h2>Sealed confirmation test</h2><p>' + escape(c.summary) + '</p><div class="scroll"><table><thead><tr><th>Team</th><th>Role</th><th>Final-panel score at the trigger</th><th>Confirmation score</th><th>Primary − team</th><th>Simultaneous 95% interval</th><th>Verdict</th></tr></thead><tbody>'
   + rows.map(r => '<tr><td>' + r.names.map(escape).join(' · ') + '</td><td>' + escape(r.role) + '</td><td>' + pct(r.finalScore) + '</td><td>' + pct(r.confirmationScore) + '</td><td>' + (Number.isFinite(r.delta) ? pp(r.delta) + ' pp' : '—') + '</td><td>' + (r.interval ? r.interval.map(pp).join(' to ') + ' pp' : '—') + '</td><td>' + escape(r.verdict) + '</td></tr>').join('')
   + '</tbody></table></div><p>' + c.completedFixtures + ' of ' + c.requestedFixtures + ' sealed fixtures, seed ' + c.seed + '. ' + escape(c.method) + '. Final-panel scores are as of the trigger (' + [...new Set(c.triggers.map(t => t.fixtures))].join(' / ') + ' final fixtures); a challenger\'s is the best-looking of several teams on that panel and is optimistic, while its confirmation-panel score was not used to choose it.</p>';
 }
 const lines = selectionLines(state);
 if (lines.length) out += '<h2>Selection safeguards</h2><ul>' + lines.map(l => '<li>' + escape(l) + '</li>').join('') + '</ul>';
 return out;
}

function markdown(state, pool, { pct }) {
 const c = state.confirmation;
 let out = '';
 if (c) {
  out += '\nSealed confirmation test: ' + c.summary + '\n' + confirmationTable(c, pool).map(r => '- ' + r.names.join(' / ') + ' (' + r.role + '): final panel at the trigger ' + pct(r.finalScore) + ', confirmation ' + pct(r.confirmationScore) + (r.interval ? '; primary minus team ' + pp(r.delta) + ' points, simultaneous 95% interval ' + r.interval.map(pp).join(' to ') + ' points (' + r.verdict + ')' : '')).join('\n') + '\n' + c.completedFixtures + ' of ' + c.requestedFixtures + ' sealed fixtures, seed ' + c.seed + '.\n';
 }
 const lines = selectionLines(state);
 if (lines.length) out += '\nSelection safeguards:\n' + lines.map(l => '- ' + l).join('\n') + '\n';
 return out;
}

module.exports = { confirmationTable, selectionLines, html, markdown };

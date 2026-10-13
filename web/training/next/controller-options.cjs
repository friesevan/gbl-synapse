'use strict';
// Node access to the controller options of the v4 controller. They are defined once, in lookahead-v4.js between
// the <controller-options> markers (the battle VM and the browser replay use that same source), and evaluated here
// in this realm, so plain objects and errors behave normally. See OBSERVATION_CONTROLLER.md, "Controller options".
const fs = require('node:fs'), path = require('node:path');
const BEGIN = '// <controller-options>', END = '// </controller-options>';
const NAMES = ['teamControllerDefaults', 'teamControllerNeverSwitch', 'teamControllerPick', 'teamControllerSettings', 'teamControllerIdentity', 'teamControllerSuffix', 'teamControllerSideKeys', 'teamWeightedReply'];

function section(source = fs.readFileSync(path.join(__dirname, 'lookahead-v4.js'), 'utf8')) {
 const begin = source.indexOf(BEGIN), end = source.indexOf(END);
 if (begin < 0 || end < begin) throw Error('lookahead-v4.js lost its <controller-options> section');
 return source.slice(begin, end + END.length);
}
// eslint-disable-next-line no-new-func
const api = new Function(section() + '\nreturn {' + NAMES.join(',') + '};')();

// Search and tools take the run-wide controller from command-line options (--reply-model, --reply-temperature,
// --rollout-continuation). Returns the canonical non-default settings as play() options, or null for the default.
function searchController(opts = {}) {
 const picked = {};
 for (const k of ['replyModel', 'replyTemperature', 'rolloutContinuation']) if (opts[k] !== undefined && opts[k] !== '') picked[k] = opts[k];
 return api.teamControllerIdentity(picked);
}
// A short human label: 'default' or 'replyModel=weighted, replyTemperature=0.25'.
function describe(controller) { const id = api.teamControllerIdentity(controller || {}); return id ? Object.keys(id).map(k => k + '=' + id[k]).join(', ') : 'default'; }

module.exports = { ...api, section, NAMES, searchController, describe };

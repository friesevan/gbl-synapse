#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const directory = path.resolve(process.argv[2] || 'training/runs/team-search');
const file = path.join(directory, 'process.json');
if (!fs.existsSync(file)) throw Error('No process metadata yet: ' + directory);
const runtime = JSON.parse(fs.readFileSync(file));
if (runtime.endedAt) {
  console.log('This run already ended at ' + runtime.endedAt);
} else {
  let command;
  try {
    command = execFileSync('/bin/ps', ['-p', String(runtime.pid), '-o', 'command='], { encoding: 'utf8' });
  } catch {
    console.log('The training process is no longer running.');
    process.exit(0);
  }
  // Refuse to signal a PID reused by another process after a crash or reboot.
  if (!command.includes(path.join(__dirname, 'search.cjs')) || !runtime.runId || !command.includes(runtime.runId)) {
    throw Error('Process identity cannot be verified; refusing to signal PID ' + runtime.pid);
  }
  process.kill(runtime.pid, 'SIGINT');
  console.log('Stopping PID ' + runtime.pid + '; active battles finish and results checkpoint.');
}

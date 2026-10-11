'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { acquire } = require('./lock.cjs');

test('run lock excludes a second owner and recovers a confirmed dead process', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'team-search-lock-'));
  try {
    const release = acquire(directory);
    assert.throws(() => acquire(directory), /already in use/);
    release();
    const file = path.join(directory, '.search.lock.json');
    fs.writeFileSync(file, JSON.stringify({ pid: 2147483647, token: 'dead' }));
    const recovered = acquire(directory);
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    recovered();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

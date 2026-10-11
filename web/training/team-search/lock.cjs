'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function acquire(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, '.search.lock.json');
  const owner = { pid: process.pid, token: crypto.randomUUID() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(owner), { flag: 'wx' });
      return () => {
        if (!fs.existsSync(file)) return;
        const current = JSON.parse(fs.readFileSync(file));
        if (current.token === owner.token) fs.unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let old;
      try { old = JSON.parse(fs.readFileSync(file)); }
      catch { throw Error('Run directory is locked; another process may be starting.'); }
      if (!Number.isInteger(old.pid) || old.pid < 1) throw Error('Invalid run lock: ' + file);
      try {
        process.kill(old.pid, 0);
      } catch (signalError) {
        if (signalError.code === 'ESRCH') {
          // Recover only a confirmed dead owner, never an ambiguous/live lock.
          const recovery = file + '.recovering';
          let recoveryFd;
          try { recoveryFd = fs.openSync(recovery, 'wx'); }
          catch { throw Error('Another process is recovering this run directory.'); }
          try {
            // Serialize stale-lock removal so two restarts cannot delete a new owner.
            if (fs.existsSync(file)) {
              const current = JSON.parse(fs.readFileSync(file));
              if (current.token === old.token && current.pid === old.pid) fs.unlinkSync(file);
            }
          } finally { fs.closeSync(recoveryFd); fs.unlinkSync(recovery); }
          continue;
        }
        throw signalError;
      }
      throw Error('Run directory already in use by PID ' + old.pid);
    }
  }
  throw Error('Could not acquire run directory: ' + directory);
}
module.exports = { acquire };

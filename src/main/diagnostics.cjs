'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Native lifecycle only: never write roster data, API credentials or argv. */
function createNativeLog(directory) {
  const file = path.join(directory, 'desktop-native.log');
  return function log(event, details = {}) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        fs.rmSync(file + '.1', { force: true }); fs.renameSync(file, file + '.1');
      }
      fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), pid: process.pid, event, ...details }) + '\n', 'utf8');
    } catch { /* Diagnostics cannot prevent a window from opening. */ }
  };
}
module.exports = { createNativeLog };

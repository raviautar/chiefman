const fs = require('fs');
const path = require('path');

// A small local log of what the app did. It never holds message text.
function makeLog(dir) {
  const file = path.join(dir, 'chiefman.log');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch {}
  const log = (...parts) => {
    const line = `${new Date().toISOString()} ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`;
    try {
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch {}
    if (process.env.CHIEFMAN_DEV_URL) process.stdout.write(line);
  };
  log.file = file;
  return log;
}

module.exports = { makeLog };

const fs = require('fs');
const path = require('path');

// chiefman's own record of the boxes, so they can come back after a reboot.
class State {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
  }

  load() {
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (d && Array.isArray(d.boxes)) return d;
    } catch {}
    return { version: 1, boxes: [] };
  }

  save(d) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { State };

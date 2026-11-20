const fs = require('fs');
const path = require('path');

const short = (v) => (v === null || v === undefined || String(v).length <= 40 ? v : '(long value)');

// Claude Code saves `/model` as the default for every new session. A switch
// made in this app is for one box, so the app puts the user's own value back.
// It edits only that one key in the text, so the rest of the file keeps
// every byte Claude wrote.

function skipString(t, i) {
  for (let j = i + 1; j < t.length; j++) {
    if (t[j] === '\\') j++;
    else if (t[j] === '"') return j + 1;
  }
  return t.length;
}

function skipSpace(t, i) {
  while (i < t.length && /\s/.test(t[i])) i++;
  return i;
}

function valueEnd(t, i) {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] === '{' || t[i] === '[') {
    let depth = 0;
    for (let j = i; j < t.length; j++) {
      if (t[j] === '"') {
        j = skipString(t, j) - 1;
        continue;
      }
      if (t[j] === '{' || t[j] === '[') depth++;
      else if (t[j] === '}' || t[j] === ']') {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return t.length;
  }
  let j = i;
  while (j < t.length && !/[\s,}\]]/.test(t[j])) j++;
  return j;
}

// Where a top-level key sits in the text: its name and its value.
function locate(t, key) {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '"') {
      const end = skipString(t, i);
      if (depth === 1) {
        const colon = skipSpace(t, end);
        if (t[colon] === ':') {
          const start = skipSpace(t, colon + 1);
          const stop = valueEnd(t, start);
          let name = null;
          try {
            name = JSON.parse(t.slice(i, end));
          } catch {}
          if (name === key) return { keyAt: i, start, stop };
          i = stop - 1;
          continue;
        }
      }
      i = end - 1;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}

// Where a key path sits, e.g. ['modelSettings', 'claude-opus-5-5', 'effortLevel'].
function locatePath(t, keys) {
  let off = 0;
  let sub = t;
  for (let i = 0; i < keys.length; i++) {
    const at = locate(sub, keys[i]);
    if (!at) return null;
    if (i === keys.length - 1) return { keyAt: off + at.keyAt, start: off + at.start, stop: off + at.stop };
    off += at.start;
    sub = t.slice(off, off + (at.stop - at.start));
  }
  return null;
}

// The raw text of a key's value, or null when the key is not there.
function rawValue(t, keys) {
  const at = locatePath(t, [].concat(keys));
  return at ? t.slice(at.start, at.stop) : null;
}

// What to keep for a path: the value where it ends, or, when part of the path
// is missing, that first missing key, so a restore removes what Claude added.
function snapshot(t, keys) {
  for (let i = 1; i <= keys.length; i++) {
    if (!locatePath(t, keys.slice(0, i))) return { keys: keys.slice(0, i), raw: null };
  }
  return { keys, raw: rawValue(t, keys) };
}

// The text with only that key set back to `raw` (null removes the key).
function withValue(t, keysIn, raw) {
  const keys = [].concat(keysIn);
  const at = locatePath(t, keys);
  if (at && raw !== null) return t.slice(0, at.start) + raw + t.slice(at.stop);
  if (at && raw === null) {
    let before = at.keyAt - 1;
    while (before >= 0 && /\s/.test(t[before])) before--;
    if (t[before] === ',') return t.slice(0, before) + t.slice(at.stop);
    const after = skipSpace(t, at.stop);
    if (t[after] === ',') return t.slice(0, at.keyAt) + t.slice(skipSpace(t, after + 1));
    return t.slice(0, at.keyAt) + t.slice(after);
  }
  if (!at && raw !== null) {
    const parent = keys.length > 1 ? locatePath(t, keys.slice(0, -1)) : { start: t.indexOf('{') };
    if (!parent || parent.start < 0 || t[parent.start] !== '{') return null;
    const open = parent.start;
    const next = skipSpace(t, open + 1);
    const entry = `${JSON.stringify(keys[keys.length - 1])}: ${raw}`;
    if (t[next] === '}') return t.slice(0, open + 1) + entry + t.slice(next);
    return t.slice(0, open + 1) + t.slice(open + 1, next) + entry + ', ' + t.slice(next);
  }
  return t;
}

function getPath(o, keys) {
  return keys.reduce((x, k) => (x && typeof x === 'object' && k in x ? x[k] : undefined), o);
}

// Both objects equal once the value at `keys` is taken out of each.
function sameExcept(a, b, keys) {
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o));
    let x = c;
    for (const k of keys.slice(0, -1)) {
      if (!x || typeof x !== 'object' || !(k in x)) return JSON.stringify(c);
      x = x[k];
    }
    if (x && typeof x === 'object') delete x[keys[keys.length - 1]];
    return JSON.stringify(c);
  };
  return strip(a) === strip(b);
}


// Watches one key of the settings file while a switch runs and puts the
// user's value back whenever Claude saves another one. `saw(value)` tells
// the caller Claude wrote the switch, which is how a switch is confirmed.
class DefaultKeeper {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.watches = new Map(); // path -> { snap, until, timer, onWrite }
  }

  read() {
    try {
      return fs.readFileSync(fs.realpathSync(this.file), 'utf8');
    } catch {
      return null;
    }
  }

  // Call before sending the command. Watches until `ms` from now, or release().
  guard(keysIn, ms, onWrite) {
    const keys = [].concat(keysIn);
    const id = keys.join('.');
    const w = this.watches.get(id);
    if (w) {
      w.until = Math.max(w.until, Date.now() + ms);
      if (onWrite) w.onWrite = onWrite;
      return;
    }
    const text = this.read();
    if (text === null) return;
    const entry = { keys, snap: snapshot(text, keys), until: Date.now() + ms, timer: null, onWrite };
    this.watches.set(id, entry);
    this.log('default guard', { key: id, value: short(entry.snap.raw) });
    const tick = () => {
      if (this.watches.get(id) !== entry) return;
      this.check(entry);
      if (Date.now() > entry.until) {
        this.watches.delete(id);
        this.log('default guard end', { key: id, value: short(rawValue(this.read() || '', entry.snap.keys)) });
        return;
      }
      entry.timer = setTimeout(tick, 200);
    };
    entry.timer = setTimeout(tick, 200);
  }

  // Stops watching a little later, so a late write is still caught.
  release(keysIn, ms = 3000) {
    const w = this.watches.get([].concat(keysIn).join('.'));
    if (w) w.until = Math.min(w.until, Date.now() + ms);
  }

  check(w) {
    const text = this.read();
    if (text === null) return;
    const { keys, raw } = w.snap;
    const now = rawValue(text, keys);
    if (now === raw) return;
    const id = keys.join('.');
    const full = rawValue(text, w.keys);
    if (w.onWrite) w.onWrite(full === null ? null : JSON.parse(full));
    const fixed = withValue(text, keys, raw);
    let ok = false;
    try {
      const a = JSON.parse(fixed);
      const b = JSON.parse(text);
      const want = raw === null ? undefined : JSON.parse(raw);
      ok = JSON.stringify(getPath(a, keys)) === JSON.stringify(want) && sameExcept(a, b, keys);
    } catch {}
    if (!ok) {
      this.log('default not restored', { key: id, saw: short(now) });
      return;
    }
    const real = fs.realpathSync(this.file);
    const mode = fs.statSync(real).mode & 0o777;
    const tmp = path.join(path.dirname(real), `.${path.basename(real)}.chiefman-${process.pid}`);
    fs.writeFileSync(tmp, fixed, { mode });
    fs.renameSync(tmp, real);
    this.log('default restored', { key: id, saw: short(now), back: short(raw) });
    setTimeout(() => {
      const again = rawValue(this.read() || '', keys);
      this.log('default check', { key: id, value: short(again), ok: again === raw });
    }, 2000);
  }
}

module.exports = { DefaultKeeper, rawValue, withValue, snapshot };

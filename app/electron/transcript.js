const fs = require('fs');
const { EventEmitter } = require('events');
const { mask } = require('./mask');

const CHUNK = 16 * 1024 * 1024;
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const KEEP_TYPES = ['{"type":"user"', '{"type":"assistant"', '{"type":"system"', '{"type":"attachment"'];
// Commands the app sends for its own buttons; they never show as bubbles.
const HIDDEN = /^\/(model|effort|rename|remote-control|context|compact|clear)\b/;
const NOT_A_MESSAGE = /^\s*(<(command-|local-command|bash-|system-reminder|task-notification|user-prompt-submit|teammate-message|tick>)|\[Request interrupted|Caveat: )/;

function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  if (content.some((b) => b && b.type === 'tool_result')) return null;
  const parts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return parts.length ? parts.join('\n') : null;
}

function cleanUser(t) {
  if (typeof t !== 'string') return null;
  const s = t.replace(/<\/?pasted_content[^>]*>\n?/g, '').trim();
  if (!s || NOT_A_MESSAGE.test(s)) return null;
  return s;
}

// "/rename notes" from the log line Claude writes for a slash command.
function slashCommand(s) {
  const m = /<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/.exec(s);
  if (!m) return null;
  const a = /<command-args>([\s\S]*?)<\/command-args>/.exec(s);
  const name = m[1].startsWith('/') ? m[1] : '/' + m[1];
  return a && a[1].trim() ? `${name} ${a[1].trim()}` : name;
}

function localOutput(s) {
  const m = /<local-command-std(?:out|err)>([\s\S]*?)<\/local-command-std(?:out|err)>/.exec(s);
  if (!m) return null;
  const t = m[1].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
  return t || null;
}

function duration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// Skips the big log lines (API requests, file snapshots) without parsing them.
function worthParsing(line) {
  if (!line) return false;
  if (line.startsWith('{"type":"')) return KEEP_TYPES.some((p) => line.startsWith(p));
  return line.includes('"user"') || line.includes('"assistant"') || line.includes('turn_duration') || line.includes('queued_command') || line.includes('local_command') || line.includes('compact_boundary');
}

// Follows one session log, start to end, and keeps what is worth showing:
// his messages, each text block the box writes, and one line per turn of work.
// Emits 'reset' once loaded, then 'add' with each new item and where it goes.
class Transcript extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.items = [];
    this.seen = new Set();
    this.turn = null;
    this.offset = 0;
    this.rest = '';
    this.added = [];
    this.loaded = false;
    this.watcher = null;
    this.timer = null;
  }

  async start() {
    await this.load();
    if (this.stopped) return;
    this.loaded = true;
    this.added = [];
    this.emit('reset', { items: this.items, steps: this.steps });
    if (!this.watcher) {
      try {
        this.watcher = fs.watch(this.file, () => this.follow());
      } catch {}
      this.timer = setInterval(() => this.follow(), 1500);
    }
  }

  stop() {
    this.stopped = true;
    if (this.watcher) this.watcher.close();
    clearInterval(this.timer);
    this.removeAllListeners();
  }

  get steps() {
    return this.turn ? this.turn.steps : 0;
  }

  async load() {
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    const fd = fs.openSync(this.file, 'r');
    try {
      while (this.offset < size && !this.stopped) {
        const len = Math.min(CHUNK, size - this.offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, this.offset);
        this.offset += len;
        this.takeText(buf.toString('utf8'));
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  follow() {
    if (!this.loaded || this.stopped) return;
    let size;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.items = [];
      this.seen.clear();
      this.turn = null;
      this.offset = 0;
      this.rest = '';
      this.loaded = false;
      this.start();
      return;
    }
    if (size === this.offset) return;
    const len = size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = size;
    const before = this.steps;
    this.takeText(buf.toString('utf8'));
    if (this.added.length || before !== this.steps) {
      const added = this.added;
      this.added = [];
      this.emit('add', { added, steps: this.steps });
    }
  }

  takeText(text) {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop();
    for (const line of lines) {
      if (!worthParsing(line)) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      this.take(d);
    }
  }

  insert(item, at) {
    const after = at > 0 ? this.items[at - 1].id : null;
    this.items.splice(at, 0, item);
    if (this.loaded) this.added.push({ item, after });
  }

  push(item) {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    this.insert(item, this.items.length);
  }

  endTurn(lastTs) {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.steps) return;
    const ms = t.durationMs != null ? t.durationMs : Date.parse(lastTs || t.lastTs) - Date.parse(t.startTs);
    // Short jobs get no line; the answer says enough.
    if (!(ms >= 30000)) return;
    let text = `Worked for ${duration(ms || 0)} · ${t.steps} ${t.steps === 1 ? 'step' : 'steps'}`;
    if (t.files.size) text += ` · ${t.files.size} ${t.files.size === 1 ? 'file' : 'files'} changed`;
    const item = { id: 'work:' + (t.anchor || t.startTs), k: 'work', t: text, ts: lastTs || t.lastTs };
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    const a = t.anchor ? this.items.findIndex((i) => i.id === t.anchor) : -1;
    this.insert(item, a < 0 ? this.items.length : a + 1);
  }

  take(d) {
    if (!d || d.isSidechain) return;
    const ts = d.timestamp;
    if (this.turn && ts) this.turn.lastTs = ts;
    if (d.type === 'user') {
      if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
      const raw = userText(d.message && d.message.content);
      if (typeof raw === 'string' && /^\s*\[Request interrupted/.test(raw)) {
        this.endTurn(ts);
        this.push({ id: 'i:' + d.uuid, k: 'work', t: 'Interrupted', ts });
        return;
      }
      const cmd = typeof raw === 'string' && raw.includes('<command-name>') ? slashCommand(raw) : null;
      if (cmd && HIDDEN.test(cmd)) {
        this.hideOut = cmd.startsWith('/context') ? 'context' : 'drop';
        return;
      }
      if (cmd) {
        this.endTurn(ts);
        this.push({ id: 'u:' + d.uuid, k: 'you', t: mask(cmd), ts });
        this.turn = { anchor: 'u:' + d.uuid, steps: 0, files: new Set(), startTs: ts, lastTs: ts, durationMs: null };
        return;
      }
      // Newer Claude versions log a command's output as a user line.
      if (typeof raw === 'string' && raw.includes('<local-command-std')) {
        const out = localOutput(raw);
        if (this.hideOut) {
          if (out && this.hideOut === 'context' && this.loaded) this.emit('context', mask(out));
          this.hideOut = false;
          return;
        }
        if (out) this.push({ id: 'o:' + d.uuid, k: 'box', t: mask(out), ts });
        return;
      }
      const t = cleanUser(raw);
      if (!t) return;
      this.endTurn(ts);
      const id = 'u:' + d.uuid;
      this.push({ id, k: 'you', t: mask(t), ts });
      this.turn = { anchor: id, steps: 0, files: new Set(), startTs: ts, lastTs: ts, durationMs: null };
      return;
    }
    if (d.type === 'attachment') {
      const a = d.attachment;
      if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return;
      const t = cleanUser(typeof a.prompt === 'string' ? a.prompt : userText(a.prompt));
      if (t) this.push({ id: 'q:' + (a.source_uuid || d.uuid), k: 'you', t: mask(t), ts });
      return;
    }
    if (d.type === 'assistant') {
      const content = d.message && d.message.content;
      if (!Array.isArray(content)) return;
      content.forEach((b, i) => {
        if (!b) return;
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = b.text.trim();
          if (t && t !== '(no content)') this.push({ id: `a:${d.uuid}:${i}`, k: 'box', t: mask(t), ts });
        } else if (b.type === 'tool_use') {
          if (!this.turn) this.turn = { anchor: null, steps: 0, files: new Set(), startTs: ts, lastTs: ts, durationMs: null };
          this.turn.steps++;
          const fp = b.input && (b.input.file_path || b.input.notebook_path);
          if (EDIT_TOOLS.has(b.name) && fp) this.turn.files.add(fp);
        }
      });
      return;
    }
    if (d.type === 'system' && d.subtype === 'local_command' && typeof d.content === 'string') {
      const cmd = slashCommand(d.content);
      // Commands the app sends for its own buttons stay out of the chat;
      // /context answers in the app's popover.
      if (cmd && HIDDEN.test(cmd)) {
        this.hideOut = cmd.startsWith('/context') ? 'context' : 'drop';
        return;
      }
      if (cmd) {
        this.endTurn(ts);
        this.push({ id: 'c:' + d.uuid, k: 'you', t: mask(cmd), ts });
        return;
      }
      const out = localOutput(d.content);
      if (out && this.hideOut) {
        if (this.hideOut === 'context' && this.loaded) this.emit('context', mask(out));
        this.hideOut = false;
        return;
      }
      if (out) this.push({ id: 'o:' + d.uuid, k: 'box', t: mask(out), ts });
      return;
    }
    if (d.type === 'system' && d.subtype === 'compact_boundary') {
      this.endTurn(ts);
      this.push({ id: 'k:' + d.uuid, k: 'work', t: 'Compacted', ts });
      return;
    }
    if (d.type === 'system' && d.subtype === 'turn_duration' && this.turn) {
      this.turn.durationMs = d.durationMs;
      this.endTurn(ts);
    }
  }
}

module.exports = { Transcript };

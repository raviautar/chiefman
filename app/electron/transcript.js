const fs = require('fs');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { mask } = require('./mask');
const { unmark } = require('./mark');
const { splitAsks } = require('./asks');
const { describe, doing, takeResult, summarize, detailOf } = require('./steps');

const CHUNK = 16 * 1024 * 1024;
const KEEP_TYPES = ['{"type":"user"', '{"type":"assistant"', '{"type":"system"', '{"type":"attachment"', '{"type":"pr-link"'];
// Commands the app sends for its own buttons; they never show as bubbles.
const HIDDEN = /^\/(model|effort|rename|remote-control|context|compact|clear)\b/;
const NOT_A_MESSAGE = /^\s*(<(command-|local-command|bash-|system-reminder|task-notification|user-prompt-submit|teammate-message|tick>)|\[Request interrupted|Caveat: )/;
// The skills the buttons under the message box run. A run shows as one quiet
// tag, the same words as the button, whichever plugin's copy ran
// ("/p:plain-english").
const SKILL_LINES = { 'plain-english': 'Plain English', explain: 'Explain', 'drill-down': 'Drill down' };

function skillLine(cmd) {
  const m = /^\/(?:[\w.-]+:)?([\w-]+)$/.exec(cmd);
  return m && Object.prototype.hasOwnProperty.call(SKILL_LINES, m[1]) ? SKILL_LINES[m[1]] : null;
}

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

// What a "!" command printed, from the log line Claude writes for it.
function shellOutput(s) {
  const out = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/.exec(s);
  const err = /<bash-stderr>([\s\S]*?)<\/bash-stderr>/.exec(s);
  const t = [out && out[1], err && err[1]].filter((x) => x && x.trim()).join('\n');
  return t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '');
}

// His own words in an answer to Claude Code's question menu: what is not one
// of the options. Several picks come joined with ", ".
function typedAnswers(r) {
  if (!r || typeof r !== 'object' || !r.answers || typeof r.answers !== 'object' || !Array.isArray(r.questions)) return null;
  const out = [];
  for (const q of r.questions) {
    const a = q && r.answers[q.question];
    if (typeof a !== 'string' || !a.trim()) continue;
    const labels = Array.isArray(q.options) ? q.options.map((o) => o && o.label) : [];
    const rest = q.multiSelect ? a.split(', ').filter((p) => !labels.includes(p)).join(', ') : labels.includes(a) ? '' : a;
    if (rest.trim()) out.push(rest.trim());
  }
  return out.length ? out.join('\n') : null;
}

const near = (a, b, ms) => Math.abs(Date.parse(a) - Date.parse(b)) < ms;

const newTurn = (anchor, ts) => ({ anchor, steps: [], open: new Map(), fresh: [], startTs: ts, lastTs: ts, durationMs: null });

// Skips the big log lines (API requests, file snapshots) without parsing them.
function worthParsing(line) {
  if (!line) return false;
  if (line.startsWith('{"type":"')) return KEEP_TYPES.some((p) => line.startsWith(p));
  return line.includes('"user"') || line.includes('"assistant"') || line.includes('turn_duration') || line.includes('queued_command') || line.includes('local_command') || line.includes('compact_boundary') || line.includes('"pr-link"');
}

// Follows one session log, start to end, and keeps what is worth showing:
// his messages, each text block the box writes, and one line of facts per
// turn of work, which carries what each step was (steps.js).
// Emits 'reset' once loaded, then 'add' with each new item and where it goes,
// and `now`: the turn that runs, its newest step and its failures.
// A message the app sent carries its mark: the mark is taken out, the item
// says app, and the box's replies to it bring their questions as `asks`.
class Transcript extends EventEmitter {
  // marks: times the app's own Esc stopped this box. cuts: [from, to] times
  // a rewind took back; what was logged between them is hidden.
  constructor(file, opts = {}) {
    super();
    this.file = file;
    this.marks = opts.marks || [];
    this.cuts = (opts.cuts || []).filter((c) => Array.isArray(c) && c.length === 2).map(([a, b]) => [Date.parse(a), Date.parse(b)]);
    this.items = [];
    this.seen = new Set();
    this.turn = null;
    this.offset = 0;
    this.rest = '';
    // Where in the log each step's call and result lines are (byte offset,
    // length), so a change or an output loads only when he opens it.
    this.pos = 0;
    this.dec = new StringDecoder('utf8');
    this.where = new Map();
    // PR links Claude Code noted for this session: link -> number, repo.
    this.prs = new Map();
    this.added = [];
    this.loaded = false;
    this.watcher = null;
    this.timer = null;
  }

  async start() {
    await this.load();
    if (this.stopped) return;
    this.placeMarks();
    this.loaded = true;
    this.added = [];
    this.emit('reset', { items: this.items, now: this.now });
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

  // The turn that runs: how many steps, the newest one's words as they read
  // while it runs, when it started, and the steps that failed so far.
  get now() {
    const t = this.turn;
    if (!t) return null;
    const last = t.steps[t.steps.length - 1];
    return {
      n: t.steps.length,
      say: last ? doing(last.say) : null,
      since: t.startTs || null,
      failed: t.steps
        .filter((s) => s.failed)
        .slice(-3)
        .map((s) => ({ id: s.id, say: s.say })),
    };
  }

  nowKey() {
    const t = this.turn;
    return t ? `${t.startTs}|${t.steps.length}|${t.steps.filter((s) => s.failed).length}` : '';
  }

  // A file's change or a step's output, read again from the log.
  detail(ids) {
    const out = [];
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      return out;
    }
    const line = (spot, id) => {
      if (!spot || spot[1] > 64 * 1024 * 1024) return null;
      const buf = Buffer.alloc(spot[1]);
      fs.readSync(fd, buf, 0, spot[1], spot[0]);
      const s = buf.toString('utf8');
      if (!s.includes(id)) return null;
      try {
        return JSON.parse(s);
      } catch {
        return null;
      }
    };
    try {
      for (const id of ids.slice(0, 50)) {
        const w = this.where.get(id);
        if (!w) continue;
        const d = detailOf(id, line(w.use, id), line(w.res, id));
        if (d) out.push(d);
      }
    } catch {
    } finally {
      fs.closeSync(fd);
    }
    return out;
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
        this.takeText(this.dec.write(buf));
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
      this.lastApp = false;
      this.offset = 0;
      this.rest = '';
      this.pos = 0;
      this.dec = new StringDecoder('utf8');
      this.where.clear();
      this.prs.clear();
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
    const before = this.nowKey();
    this.takeText(this.dec.write(buf));
    if (this.added.length || before !== this.nowKey()) {
      const added = this.added;
      this.added = [];
      this.emit('add', { added, now: this.now });
    }
  }

  takeText(text) {
    const lines = (this.rest + text).split('\n');
    this.rest = lines.pop();
    for (const line of lines) {
      const at = this.pos;
      const len = Buffer.byteLength(line, 'utf8');
      this.pos += len + 1;
      if (!worthParsing(line)) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      this.take(d, [at, len]);
    }
  }

  // An "Interrupted" line where the app stopped the box, unless Claude wrote
  // its own there.
  placeMarks() {
    for (const ts of this.marks) {
      const id = 'm:' + ts;
      if (this.seen.has(id) || this.hidden({ ts })) continue;
      if (this.items.some((i) => i.t === 'Interrupted' && i.ts && near(i.ts, ts, 20000))) continue;
      this.seen.add(id);
      let at = this.items.length;
      while (at > 0 && this.items[at - 1].ts && Date.parse(this.items[at - 1].ts) > Date.parse(ts)) at--;
      // The cut-off answer is logged just after the Esc; the line goes below it.
      while (at < this.items.length && this.items[at].k === 'box' && this.items[at].ts && Date.parse(this.items[at].ts) - Date.parse(ts) < 5000) at++;
      this.items.splice(at, 0, { id, k: 'work', t: 'Interrupted', ts });
    }
  }

  markNow(ts) {
    const item = { id: 'm:' + ts, k: 'work', t: 'Interrupted', ts };
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    this.insert(item, this.items.length);
    if (this.loaded) {
      const added = this.added;
      this.added = [];
      this.emit('add', { added, now: this.now });
    }
  }

  hidden(item) {
    const t = item.ts ? Date.parse(item.ts) : NaN;
    return !Number.isNaN(t) && this.cuts.some(([a, b]) => t >= a && t < b);
  }

  cut([from, to]) {
    this.cuts.push([Date.parse(from), Date.parse(to)]);
    this.items = this.items.filter((i) => !this.hidden(i));
  }

  insert(item, at) {
    const after = at > 0 ? this.items[at - 1].id : null;
    this.items.splice(at, 0, item);
    if (this.loaded) this.added.push({ item, after });
  }

  push(item) {
    if (this.seen.has(item.id)) return;
    this.seen.add(item.id);
    if (this.hidden(item)) return;
    if (item.t === 'Interrupted' && item.ts && this.items.slice(-6).some((i) => i.id.startsWith('m:') && near(i.ts, item.ts, 20000))) return;
    const last = this.items[this.items.length - 1];
    if (item.k === 'box' && last && last.id.startsWith('m:') && item.ts && Date.parse(item.ts) - Date.parse(last.ts) < 5000) {
      this.insert(item, this.items.length - 1);
      return;
    }
    this.insert(item, this.items.length);
  }

  // The turn's line of facts goes under its last reply. A turn that only
  // read gets none.
  endTurn(lastTs) {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.steps.length) return;
    const ms = t.durationMs != null ? t.durationMs : Date.parse(lastTs || t.lastTs) - Date.parse(t.startTs);
    const { line, turn } = summarize(t.steps, Number.isFinite(ms) ? ms : null, this.prs, t.fresh);
    if (!line) return;
    const item = { id: 'work:' + (t.anchor || t.startTs), k: 'work', t: line, ts: lastTs || t.lastTs, turn };
    if (this.seen.has(item.id) || this.hidden(item)) return;
    this.seen.add(item.id);
    // Above the app's own "Interrupted" for this turn.
    let at = this.items.length;
    const start = Date.parse(t.startTs);
    while (at > 0 && this.items[at - 1].id.startsWith('m:') && !(Date.parse(this.items[at - 1].ts) < start)) at--;
    this.insert(item, at);
  }

  // A tool call becomes a step of the turn; its result fills it in.
  step(b, ts, spot) {
    if (!this.turn) this.turn = newTurn(null, ts);
    const s = { id: typeof b.id === 'string' ? b.id : `s${this.turn.steps.length}`, tool: b.name, ...describe(String(b.name || ''), b.input) };
    this.turn.steps.push(s);
    this.turn.open.set(s.id, s);
    this.where.set(s.id, { use: spot });
  }

  results(d, spot) {
    const c = d.message && d.message.content;
    if (!Array.isArray(c) || !this.turn) return;
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const s = this.turn.open.get(b.tool_use_id);
      if (!s) continue;
      this.turn.open.delete(b.tool_use_id);
      takeResult(s, b, d.toolUseResult);
      const w = this.where.get(s.id);
      if (w) w.res = spot;
    }
  }

  take(d, spot) {
    if (!d || d.isSidechain) return;
    const ts = d.timestamp;
    if (this.turn && ts) this.turn.lastTs = ts;
    if (d.type === 'pr-link') {
      const u = typeof d.prUrl === 'string' ? d.prUrl : null;
      if (!u || this.prs.has(u)) return;
      this.prs.set(u, { n: Number(d.prNumber) || null, repo: typeof d.prRepository === 'string' ? d.prRepository : null });
      if (this.turn) this.turn.fresh.push(u);
      return;
    }
    if (d.type === 'user') {
      this.results(d, spot);
      if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
      // Words he typed into Claude Code's question show as his message.
      const typed = typedAnswers(d.toolUseResult);
      if (typed) {
        this.push({ id: 'w:' + d.uuid, k: 'you', t: mask(typed), ts });
        return;
      }
      const raw = userText(d.message && d.message.content);
      if (typeof raw === 'string' && /^\s*\[Request interrupted/.test(raw)) {
        this.endTurn(ts);
        this.push({ id: 'i:' + d.uuid, k: 'work', t: 'Interrupted', ts });
        return;
      }
      if (typeof raw === 'string' && /^\s*<bash-input>/.test(raw)) {
        const c = /<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw);
        this.endTurn(ts);
        this.lastApp = false;
        if (c) this.push({ id: 'u:' + d.uuid, k: 'you', t: mask('!' + c[1]), ts });
        return;
      }
      if (typeof raw === 'string' && /^\s*<bash-std(out|err)>/.test(raw)) {
        const out = shellOutput(raw);
        this.push({ id: 'o:' + d.uuid, k: 'box', t: mask(out || '(no output)'), ts, mono: true });
        return;
      }
      const sc = typeof raw === 'string' && raw.includes('<command-name>') ? slashCommand(raw) : null;
      const cu = sc ? unmark(sc) : null;
      const cmd = cu ? cu.text : null;
      if (cmd && HIDDEN.test(cmd)) {
        this.hideOut = cmd.startsWith('/context') ? 'context' : 'drop';
        return;
      }
      if (cmd) {
        this.endTurn(ts);
        this.lastApp = cu.app;
        const quiet = skillLine(cmd);
        const app = cu.app ? { app: true } : {};
        this.push(quiet ? { id: 'u:' + d.uuid, k: 'work', t: quiet, ts, ...app } : { id: 'u:' + d.uuid, k: 'you', t: mask(cmd), ts, ...app });
        this.turn = newTurn('u:' + d.uuid, ts);
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
      const c = cleanUser(raw);
      const u = c ? unmark(c) : null;
      if (!u || !u.text.trim()) return;
      this.endTurn(ts);
      this.lastApp = u.app;
      const id = 'u:' + d.uuid;
      this.push({ id, k: 'you', t: mask(u.text), ts, ...(u.app ? { app: true } : {}) });
      this.turn = newTurn(id, ts);
      return;
    }
    if (d.type === 'attachment') {
      const a = d.attachment;
      if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return;
      const c = cleanUser(typeof a.prompt === 'string' ? a.prompt : userText(a.prompt));
      const u = c ? unmark(c) : null;
      if (!u || !u.text.trim()) return;
      this.lastApp = u.app;
      this.push({ id: 'q:' + (a.source_uuid || d.uuid), k: 'you', t: mask(u.text), ts, ...(u.app ? { app: true } : {}) });
      return;
    }
    if (d.type === 'assistant') {
      const content = d.message && d.message.content;
      if (!Array.isArray(content)) return;
      content.forEach((b, i) => {
        if (!b) return;
        if (b.type === 'text' && typeof b.text === 'string') {
          const t = b.text.trim();
          if (!t || t === '(no content)') return;
          const id = `a:${d.uuid}:${i}`;
          // Only a reply to a message from the app is read for questions.
          const q = this.lastApp ? splitAsks(mask(t)) : null;
          this.push(q ? { id, k: 'box', t: q.text, ts, asks: q.asks } : { id, k: 'box', t: mask(t), ts });
        } else if (b.type === 'tool_use') {
          this.step(b, ts, spot);
        }
      });
      return;
    }
    if (d.type === 'system' && d.subtype === 'local_command' && typeof d.content === 'string') {
      const sc = slashCommand(d.content);
      const cmd = sc ? unmark(sc).text : null;
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

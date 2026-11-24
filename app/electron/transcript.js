const fs = require('fs');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { mask } = require('./mask');
const { unmark } = require('./mark');
const { readBlocks } = require('./blocks');
const { describe, doing, takeResult, summarize, detailOf, gitAfter } = require('./steps');
const { tailOf } = require('./live');

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

// Claude Code's own question menu once he answered it: each question with
// the answer it went with, his own words included ("skipped" when it got
// none). Its plan approval: the plan's title, approved or not.
function askedRows(step, block, r) {
  const res = r && typeof r === 'object' ? r : {};
  if (step.tool === 'ExitPlanMode') return [{ q: step.plan || 'Its plan', a: block && block.is_error ? 'not approved' : 'approved' }];
  const qs = Array.isArray(res.questions) && res.questions.length ? res.questions : step.ask || [];
  const answers = res.answers && typeof res.answers === 'object' ? res.answers : {};
  return qs
    .filter((q) => q && typeof q.question === 'string')
    .map((q) => {
      const a = answers[q.question];
      return { q: mask(q.question), a: typeof a === 'string' && a.trim() ? mask(a.trim()) : 'skipped' };
    });
}

// Claude Code's notes that something it ran on its own ended, by the id of
// the call that started it.
function notesIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const tag = (t) => (new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(m[1]) || [])[1];
    const use = tag('tool-use-id');
    if (use) out.push({ use: use.trim(), task: (tag('task-id') || '').trim(), status: (tag('status') || '').trim(), summary: (tag('summary') || '').trim(), result: tag('result') || '', file: (tag('output-file') || '').trim() });
  }
  return out;
}

// The words of a parsed log line he (or Claude Code) sent.
const textOfLine = (d) => {
  const c = d && d.message && d.message.content;
  return typeof c === 'string' ? c : userText(c) || '';
};
const clipEnd = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const near = (a, b, ms) => Math.abs(Date.parse(a) - Date.parse(b)) < ms;

const newTurn = (anchor, ts, fresh = []) => ({ anchor, steps: [], open: new Map(), fresh, startTs: ts, lastTs: ts, durationMs: null });

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
// says app, and the box's replies to it bring the blocks they hold (blocks.js).
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
    // PR links Claude Code noted for this session: link -> number, repo;
    // loose: those noted outside a turn, for the next one.
    this.prs = new Map();
    this.loose = [];
    // Agents and background commands it started, by call id, for the note
    // that says they ended.
    this.bgs = new Map();
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
      for (const raw of ids.slice(0, 50)) {
        // "bg:<id>": a background command that failed after its turn.
        const id = raw.startsWith('bg:') ? raw.slice(3) : raw;
        const w = this.where.get(id);
        if (!w) continue;
        // An agent's report, or what a background command printed, from
        // the note that it ended.
        const n = w.note ? notesIn(textOfLine(line(w.note, id))).find((x) => x.use === id) : null;
        const d = detailOf(id, line(w.use, id), line(w.res, id));
        const cmd = d && d.cmd ? { cmd: d.cmd } : {};
        if (n && w.agent && n.result.trim()) out.push({ id: raw, out: mask(clipEnd(n.result.trim(), 8000)), md: true });
        else if (n && !w.agent) {
          const tail = tailOf(n.file, 80, 64 * 1024);
          out.push({ id: raw, out: tail.length ? tail.join('\n') : mask(n.summary), ...cmd });
        } else if (!d) continue;
        // Started on its own and not ended yet: nothing to show but that.
        else if ((w.bg || w.async) && !n) out.push({ id: raw, out: '', running: true, ...cmd });
        else out.push({ ...d, id: raw, ...(w.agent ? { md: true } : {}) });
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
      this.loose = [];
      this.bgs.clear();
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

  // A turn starts; PR links noted between turns are its own.
  begin(anchor, ts) {
    const t = newTurn(anchor, ts, this.loose);
    this.loose = [];
    return t;
  }

  // A tool call becomes a step of the turn; its result fills it in.
  step(b, ts, spot) {
    if (!this.turn) this.turn = this.begin(null, ts);
    const name = String(b.name || '');
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    const s = { id: typeof b.id === 'string' ? b.id : `s${this.turn.steps.length}`, tool: b.name, ...describe(name, input) };
    if (name === 'AskUserQuestion' && Array.isArray(input.questions)) s.ask = input.questions;
    if (name === 'ExitPlanMode' && typeof input.plan === 'string') {
      const head = input.plan.split('\n').find((l) => l.trim()) || '';
      s.plan = mask(head.replace(/^#+\s*/, '').replace(/^plan:\s*/i, '').trim().slice(0, 120)) || null;
    }
    this.turn.steps.push(s);
    this.turn.open.set(s.id, s);
    this.where.set(s.id, { use: spot, ...(s.agent ? { agent: true } : {}), ...(s.bg ? { bg: true } : {}) });
    if (s.agent || s.bg) {
      this.bgs.set(s.id, { say: s.say.replace(/^(Agent|Watch): /, ''), cmd: s.cmd || '' });
      if (this.bgs.size > 5000) this.bgs.delete(this.bgs.keys().next().value);
    }
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
      const r = d.toolUseResult;
      if (w && s.agent && r && typeof r === 'object' && r.status === 'async_launched') w.async = true;
      // His answer to Claude Code's question or plan: a card with each
      // question and what it went with.
      if (s.tool === 'AskUserQuestion' || s.tool === 'ExitPlanMode') {
        const rows = askedRows(s, b, r);
        if (rows.length) this.push({ id: 'ask:' + s.id, k: 'work', t: s.tool === 'ExitPlanMode' ? 'Its plan' : 'Asked you', ts: d.timestamp, asked: rows });
      }
    }
  }

  // A background command or watch that ended badly counts as a failure of
  // the turn it ends in, and the git work of one that ran fine as that
  // turn's; an agent's or command's end is kept for its report.
  notes(text, ts, spot) {
    for (const n of notesIn(text)) {
      const w = this.where.get(n.use);
      if (w && n.status) w.note = spot;
      const bg = this.bgs.get(n.use);
      if (!w || !w.bg || !bg || this.seen.has('bg:' + n.use)) continue;
      if (n.status === 'failed') {
        this.seen.add('bg:' + n.use);
        if (!this.turn) this.turn = this.begin(null, ts);
        const why = n.summary.replace(/^.*?(?=(exit code|failed|timed out))/i, '');
        this.turn.steps.push({ id: 'bg:' + n.use, tool: 'Background', say: bg.say, kind: 'step', done: true, failed: true, bgNote: true, tail: why ? [mask(why.slice(0, 200))] : [] });
      } else if (n.status === 'completed' && /\b(git|gh)\b/.test(bg.cmd)) {
        this.seen.add('bg:' + n.use);
        const git = gitAfter(bg.cmd, tailOf(n.file, 40, 16384).join('\n'));
        if (!git.length) continue;
        if (!this.turn) this.turn = this.begin(null, ts);
        this.turn.steps.push({ id: n.use, tool: 'Bash', say: bg.say, kind: 'step', done: true, git });
      }
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
      else this.loose.push(u);
      return;
    }
    if (d.type === 'user') {
      this.results(d, spot);
      const raw = userText(d.message && d.message.content);
      if (typeof raw === 'string' && raw.includes('<task-notification>')) {
        this.notes(raw, ts, spot);
        return;
      }
      if (d.isMeta || d.isCompactSummary || d.isVisibleInTranscriptOnly) return;
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
        this.turn = this.begin('u:' + d.uuid, ts);
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
      this.turn = this.begin(id, ts);
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
          // Only a reply to a message from the app is read for its blocks.
          const read = this.lastApp ? readBlocks(mask(t)) : null;
          if (read && !read.t && !read.asks && !read.cards && !read.tail) return;
          this.push(read ? { id, k: 'box', ts, ...read } : { id, k: 'box', t: mask(t), ts });
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

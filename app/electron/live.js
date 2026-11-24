const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { mask } = require('./mask');
const { describe, takeResult, summarize } = require('./steps');

// Follows one session log for what the box started that runs on its own:
// agents, background commands and watches, each until it is done. Also its
// todo list, its newest plan, the tool calls that have no result yet (one
// of them is what a permission question is about), and the line of facts
// of its last turn that did something.

const CHUNK = 16 * 1024 * 1024;
const DONE = new Set(['completed', 'failed', 'killed', 'stopped']);
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SKIP = ['{"type":"api-request', '{"type":"file-history', '{"type":"data-flow', '{"type":"atis', '{"type":"session-owner', '{"type":"bridge-session'];
const tagOf = (s, t) => {
  const m = new RegExp(`<${t}>([\\s\\S]*?)</${t}>`).exec(s);
  return m ? m[1].trim() : null;
};
const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const msOf = (ts) => {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? t : Date.now();
};

// The text of a tool result or a reply block list.
function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

class Live {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.rest = '';
    this.dec = new StringDecoder('utf8');
    this.busy = false;
    // Tool calls with no result yet, oldest first: id -> { name, input, at }.
    this.open = new Map();
    // What runs on its own, by the id of the call that started it; alias
    // holds the ids Claude Code gives it later (agent id, task id).
    this.tasks = new Map();
    this.alias = new Map();
    this.todos = [];
    this.todoAt = 0;
    this.plan = null;
    this.prs = new Map();
    this.turn = null;
    this.last = null;
    this.seq = 0;
  }

  async poll() {
    if (this.busy) return false;
    this.busy = true;
    const before = this.seq;
    try {
      let size;
      try {
        size = fs.statSync(this.file).size;
      } catch {
        return false;
      }
      if (size < this.offset) {
        this.offset = 0;
        this.rest = '';
        this.dec = new StringDecoder('utf8');
      }
      if (size === this.offset) return false;
      const fd = fs.openSync(this.file, 'r');
      try {
        while (this.offset < size) {
          const len = Math.min(CHUNK, size - this.offset);
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, this.offset);
          this.offset += len;
          const lines = (this.rest + this.dec.write(buf)).split('\n');
          this.rest = lines.pop();
          for (const line of lines) this.line(line);
          if (this.offset < size) await new Promise((r) => setImmediate(r));
        }
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this.busy = false;
    }
    return this.seq !== before;
  }

  line(line) {
    if (!line || SKIP.some((p) => line.startsWith(p))) return;
    // Only lines that start, end or finish something are parsed.
    if (
      !line.includes('"tool_use"') &&
      !line.includes('"tool_result"') &&
      !line.includes('task-notification') &&
      !line.includes('"handback"') &&
      !line.includes('turn_duration') &&
      !line.includes('"pr-link"') &&
      !(line.includes('"type":"user"') && !line.includes('"isMeta":true'))
    )
      return;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    if (!d || d.isSidechain) return;
    this.take(d);
  }

  take(d) {
    const ts = d.timestamp;
    const at = msOf(ts);
    if (d.type === 'pr-link') {
      const u = typeof d.prUrl === 'string' ? d.prUrl : null;
      if (u && !this.prs.has(u)) {
        this.prs.set(u, { n: Number(d.prNumber) || null, repo: typeof d.prRepository === 'string' ? d.prRepository : null });
        if (this.turn) this.turn.fresh.push(u);
      }
      return;
    }
    if (d.type === 'queue-operation' && typeof d.content === 'string') return this.notes(d.content, at);
    if (d.type === 'attachment' && d.attachment && typeof d.attachment.prompt === 'string') return this.notes(d.attachment.prompt, at);
    if (d.type === 'system' && d.subtype === 'turn_duration') return this.endTurn(at, d.durationMs);
    const c = d.message && d.message.content;
    if (d.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) if (b && b.type === 'tool_use' && typeof b.id === 'string') this.call(b, at);
      return;
    }
    if (d.type !== 'user') return;
    const o = d.origin;
    if (o && o.kind === 'peer' && o.handback && typeof o.from === 'string') {
      const t = this.find(o.from);
      if (t && typeof o.handbackReportText === 'string') {
        t.report = mask(clip(o.handbackReportText, 8000));
        this.seq++;
      }
      return;
    }
    if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) {
      for (const b of c) if (b && b.type === 'tool_result') this.result(b, d.toolUseResult, at);
      return;
    }
    const text = textOf(c);
    if (text.includes('<task-notification>')) return this.notes(text, at);
    // His message (or any new prompt) starts a new turn.
    if (!d.isMeta && !d.isCompactSummary && text.trim()) {
      this.endTurn(at, null);
      this.turn = { steps: [], byId: new Map(), fresh: [], at };
    }
  }

  call(b, at) {
    const name = String(b.name || '');
    const input = b.input && typeof b.input === 'object' ? b.input : {};
    this.open.set(b.id, { id: b.id, name, input, at });
    if (this.open.size > 200) this.open.delete(this.open.keys().next().value);
    if (!this.turn) this.turn = { steps: [], byId: new Map(), fresh: [], at };
    const s = { id: b.id, tool: name, ...describe(name, input) };
    this.turn.steps.push(s);
    this.turn.byId.set(b.id, s);
    const say = (x) => mask(clip(String(x || '').replace(/\s+/g, ' '), 120));
    if (name === 'Agent' || name === 'Task') {
      this.tasks.set(b.id, { id: b.id, kind: 'agent', say: say(input.description) || 'An agent', since: at, done: null, status: null, report: null, out: null, last: null });
      this.seq++;
    } else if (name === 'Bash' && input.run_in_background) {
      this.tasks.set(b.id, { id: b.id, kind: 'command', say: s.say || 'A command', since: at, done: null, status: null, report: null, out: null, last: null, wait: true });
    } else if (name === 'Monitor') {
      this.tasks.set(b.id, { id: b.id, kind: 'watch', say: say(input.description) || 'A watch', since: at, done: null, status: null, report: null, out: null, last: null, wait: true });
    } else if (name === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : '';
      this.plan = { id: b.id, text: mask(clip(plan, 40000)), at };
      this.seq++;
    } else if (name === 'TodoWrite' && Array.isArray(input.todos)) {
      this.todos = input.todos
        .filter((t) => t && typeof t.content === 'string')
        .map((t, i) => ({ id: 't' + i, t: mask(clip(t.content, 200)), s: String(t.status || 'pending'), now: typeof t.activeForm === 'string' ? mask(clip(t.activeForm, 200)) : null }));
      this.todoAt = at;
      this.seq++;
    } else if (name === 'TaskUpdate' && input.taskId != null) {
      const t = this.todos.find((x) => x.id === String(input.taskId));
      if (t) {
        if (input.status === 'deleted') this.todos = this.todos.filter((x) => x !== t);
        else if (typeof input.status === 'string') t.s = input.status;
        if (typeof input.subject === 'string') t.t = mask(clip(input.subject, 200));
        if (typeof input.activeForm === 'string') t.now = mask(clip(input.activeForm, 200));
        this.todoAt = at;
        this.seq++;
      }
    }
  }

  result(b, r, at) {
    const id = b.tool_use_id;
    const call = this.open.get(id);
    this.open.delete(id);
    const step = this.turn && this.turn.byId.get(id);
    if (step) takeResult(step, b, r);
    if (!call) return;
    const failed = !!b.is_error;
    const t = this.tasks.get(id);
    const res = r && typeof r === 'object' ? r : {};
    if (call.name === 'ExitPlanMode' && this.plan && this.plan.id === id) {
      this.plan = null;
      this.seq++;
    }
    if (call.name === 'TaskCreate' && !failed && res.task && res.task.id != null) {
      const i = call.input;
      this.todos.push({ id: String(res.task.id), t: mask(clip(i.subject || res.task.subject || '', 200)), s: 'pending', now: typeof i.activeForm === 'string' ? mask(clip(i.activeForm, 200)) : null });
      this.todoAt = at;
      this.seq++;
    }
    if (call.name === 'TaskStop' || call.name === 'KillShell') {
      const k = res.task_id || res.shell_id || call.input.task_id || call.input.shell_id;
      const s = k && this.find(String(k));
      if (s && !s.done && !failed) this.finish(s, at, 'stopped');
    }
    if (!t) return;
    if (t.kind === 'agent') {
      if (res.status === 'async_launched' && typeof res.agentId === 'string') {
        this.alias.set(res.agentId, id);
        t.out = typeof res.outputFile === 'string' ? res.outputFile : null;
        this.seq++;
        return;
      }
      // An agent that ran in the turn itself: its result is its report.
      const text = textOf(b.content) || textOf(res.content);
      t.report = text ? mask(clip(text, 8000)) : null;
      this.finish(t, at, failed ? 'failed' : 'completed');
      return;
    }
    const key = t.kind === 'command' ? res.backgroundTaskId : res.taskId;
    if (failed || typeof key !== 'string') {
      this.tasks.delete(id);
      return;
    }
    this.alias.set(key, id);
    const m = /Output is being written to: (\S+)/.exec(textOf(b.content));
    t.out = m ? m[1].replace(/[.,]$/, '') : null;
    t.wait = false;
    this.seq++;
  }

  // Claude Code's notes that something it ran on its own ended (or, for a
  // watch, saw an event).
  notes(text, at) {
    if (!text.includes('<task-notification>')) return;
    const re = /<task-notification>([\s\S]*?)<\/task-notification>/g;
    let m;
    while ((m = re.exec(text))) {
      const s = m[1];
      const t = this.find(tagOf(s, 'task-id')) || this.find(tagOf(s, 'tool-use-id'));
      if (!t) continue;
      const status = tagOf(s, 'status');
      const event = tagOf(s, 'event');
      if (event && !status) {
        const line = mask(clip(event.replace(ANSI, '').split('\n').filter((l) => l.trim()).pop() || '', 200));
        if (line && line !== t.last) {
          t.last = line;
          this.seq++;
        }
        continue;
      }
      if (status && DONE.has(status) && !t.done) {
        const result = tagOf(s, 'result');
        if (t.kind === 'agent' && result && !t.report) t.report = mask(clip(result, 8000));
        this.finish(t, at, status);
      }
    }
  }

  finish(t, at, status) {
    t.done = at;
    t.status = status;
    this.seq++;
  }

  find(key) {
    if (!key) return null;
    return this.tasks.get(key) || this.tasks.get(this.alias.get(key)) || null;
  }

  endTurn(at, ms) {
    const t = this.turn;
    this.turn = null;
    if (!t || !t.steps.length) return;
    const took = ms != null ? ms : at - t.at;
    const { line } = summarize(t.steps, Number.isFinite(took) ? took : null, this.prs, t.fresh);
    if (line) {
      this.last = { line, at };
      this.seq++;
    }
  }

  // What still runs, and what ended while it ran. Anything started before
  // this Claude started (from) ran in an earlier run of the session and is
  // gone. shells: the background shells the box's own screen counts, or
  // null when its foot is not on screen; with none there, a command or a
  // watch the log still thinks runs has ended.
  batch(from, shells) {
    const all = [...this.tasks.values()].filter((t) => !t.wait && t.since >= from - 2000);
    const now = Date.now();
    const runs = (t) => !t.done && !(shells === 0 && t.kind !== 'agent' && now - t.since > 15000);
    const running = all.filter(runs);
    if (!running.length) return { running, items: [] };
    const start = Math.min(...running.map((t) => t.since));
    const items = all.filter((t) => runs(t) || (t.done && t.done >= start)).sort((a, b) => a.since - b.since);
    return { running, items, start, runs };
  }

  // The short form, for the sidebar and the line above the message box.
  summary(from, shells) {
    const { running, start } = this.batch(from, shells);
    if (!running.length) return null;
    const n = (k) => running.filter((t) => t.kind === k).length;
    const first = running.reduce((a, b) => (b.since < a.since ? b : a));
    return { agents: n('agent'), commands: n('command'), watches: n('watch'), since: start, on: first.say, kind: first.kind, more: running.length - 1 };
  }

  // The long form, when he opens it: each one's words, times, report and
  // the last line its output has.
  detail(from, shells) {
    const { items, runs } = this.batch(from, shells);
    return items.map((t) => ({
      id: t.id,
      kind: t.kind,
      say: t.say,
      since: t.since,
      done: runs(t) ? null : t.done || Date.now(),
      status: runs(t) ? null : t.status || 'stopped',
      report: t.report,
      last: t.kind === 'agent' ? null : t.last || lastLine(t.out),
    }));
  }

  // The todo list while some of it is left.
  todo(from) {
    const list = this.todos;
    if (!list.length || this.todoAt < from - 2000) return null;
    const done = list.filter((t) => t.s === 'completed').length;
    if (done === list.length) return null;
    const cur = list.find((t) => t.s === 'in_progress');
    return { done, total: list.length, now: cur ? cur.now || cur.t : null, list: list.map((t) => ({ t: t.t, s: t.s })) };
  }

  // The calls that have no result yet, newest last.
  pending() {
    return [...this.open.values()];
  }
}

const home = require('os').homedir();
const tilde = (p) => (typeof p === 'string' && p.startsWith(home) ? '~' + p.slice(home.length) : String(p || ''));
const diffOf = (edits) => {
  const out = [];
  for (const e of edits) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.old_string === 'string') for (const l of e.old_string.split('\n')) out.push('-' + l);
    if (typeof e.new_string === 'string') for (const l of e.new_string.split('\n')) out.push('+' + l);
  }
  return out;
};
const MCP = /^mcp__(.+?)__(.+)$/;
const words = (s) => String(s || '').replace(/[_-]+/g, ' ').trim();

// A tool call he is asked to allow, in plain words: what it does (say), the
// command, file or page (what), the change or the content (body, a diff
// when diff), and the box's own words for it (note).
function callWords(name, i, title) {
  const out = (say, what, body, note, diff) => ({
    say,
    what: mask(clip(what || '', 4000)),
    body: body ? mask(clip(body, 20000)) : null,
    note: note ? mask(clip(String(note).replace(/\s+/g, ' '), 300)) : null,
    ...(diff ? { diff: true } : {}),
  });
  const file = tilde(i.file_path || i.notebook_path || i.path || '');
  switch (name) {
    case 'Bash':
      return out('Run a command', String(i.command || ''), null, i.description);
    case 'Edit':
    case 'MultiEdit':
      return out('Edit a file', file, diffOf(Array.isArray(i.edits) ? i.edits : [i]).slice(0, 400).join('\n'), null, true);
    case 'Write': {
      const lines = String(i.content || '').split('\n');
      return out(/overwrite/i.test(title || '') ? 'Replace a file' : 'Create a file', file, lines.slice(0, 400).map((l) => '+' + l).join('\n'), null, true);
    }
    case 'NotebookEdit':
      return out('Edit a notebook', file, typeof i.new_source === 'string' ? i.new_source : null);
    case 'Read':
      return out('Read a file', file);
    case 'Glob':
    case 'Grep':
      return out('Search files', String(i.pattern || ''), null, i.path ? tilde(i.path) : null);
    case 'WebFetch':
      return out('Fetch a page', String(i.url || ''), null, i.prompt);
    case 'WebSearch':
      return out('Search the web', String(i.query || ''));
    case 'Agent':
    case 'Task':
      return out('Start an agent', String(i.description || ''), i.prompt ? String(i.prompt) : null);
    case 'Skill':
      return out('Run a skill', String(i.skill || '').replace(/^[\w.-]+:/, ''));
  }
  const m = MCP.exec(name);
  const body = Object.keys(i).length ? JSON.stringify(i, null, 2) : null;
  if (m) {
    const server = m[1].replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '');
    const service = words(server).replace(/^\w/, (c) => c.toUpperCase());
    return out(`Use ${service}`, words(m[2]), body);
  }
  return out(`Use ${words(name.replace(/([a-z])([A-Z])/g, '$1 $2')).toLowerCase()}`, '', body);
}

// The screen's title for a permission question, in plain words, when the
// log has no call for it.
function titleWords(title) {
  const t = String(title || '');
  if (/bash|command/i.test(t)) return 'Run a command';
  if (/create/i.test(t)) return 'Create a file';
  if (/overwrite|write/i.test(t)) return 'Replace a file';
  if (/edit/i.test(t)) return 'Edit a file';
  if (/fetch/i.test(t)) return 'Fetch a page';
  if (/web search/i.test(t)) return 'Search the web';
  if (/read/i.test(t)) return 'Read a file';
  return t ? t.replace(/^\w/, (c) => c.toUpperCase()) : 'Use a tool';
}

// What a permission question is about. calls: the box's calls with no
// result yet, oldest first; seen: the title and lines the screen shows over
// the question. The call the screen names wins; else the newest one.
function askWords(calls, seen, screen) {
  const keyOf = (c) => {
    const i = c.input || {};
    const k = i.command || i.file_path || i.notebook_path || i.url || i.query || i.pattern || i.description || '';
    return String(k).split('\n')[0].trim().slice(0, 60);
  };
  const on = (k) => {
    if (!k) return false;
    if (screen.includes(k)) return true;
    const base = k.slice(k.lastIndexOf('/') + 1);
    return base.length > 2 && screen.includes(base);
  };
  const pick = [...calls].reverse().find((c) => on(keyOf(c))) || calls[calls.length - 1];
  if (pick) return callWords(pick.name, pick.input || {}, seen && seen.title);
  return {
    say: titleWords(seen && seen.title),
    what: mask(clip((seen && seen.body) || '', 4000)),
    body: null,
    note: null,
  };
}

// The last lines a background command printed, read from the end of its
// output file. Only a file under the system's temp folders or Claude's own
// folder is read.
function tailOf(out, n, bytes = 4096) {
  if (typeof out !== 'string' || !path.isAbsolute(out)) return [];
  const file = path.normalize(out);
  if (!/\/(tmp|T|\.claude)\//.test(file)) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(bytes, size);
    if (!len) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf
      .toString('utf8')
      .replace(ANSI, '')
      .split(/\r?\n|\r/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim())
      .slice(-n)
      .map((l) => mask(clip(l, 400)));
  } catch {
    return [];
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

const lastLine = (out) => {
  const l = tailOf(out, 1)[0];
  return l ? clip(l.trim(), 200) : null;
};

module.exports = { Live, askWords, tailOf };

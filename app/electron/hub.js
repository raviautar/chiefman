const fs = require('fs');
const path = require('path');
const { run, hasSession, Control } = require('./tmux');
const { readSessions, liveSessionIds, transcriptPath } = require('./sessions');
const { Transcript } = require('./transcript');
const { newestDrill } = require('./drilldown');
const { State } = require('./state');
const { mask } = require('./mask');
const { promptState, parseActivity, parseMenu } = require('./screen');
const { Usage, modelName } = require('./usage');
const { execFile } = require('child_process');

const PALETTE = ['#6C358C', '#0052B4', '#C2410C', '#034F46', '#A3398F', '#496E2D', '#5B5B59'];
const ICONS = ['crown', 'columns', 'check', 'wrench', 'eye', 'bubble', 'window', 'doc'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FLAG_RE = /^[a-z0-9.-]{1,40}$/;
const MODELS = ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const ALIASES = { opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const argsOf = (pid) =>
  new Promise((res) => execFile('ps', ['-o', 'args=', '-p', String(pid)], (e, out) => res(e ? '' : String(out))));

// A box looks as New Box saved it; any other window gets a look from its name.
function look(name, saved) {
  if (saved && ICONS.includes(saved.icon) && PALETTE.includes(saved.color)) return { icon: saved.icon, color: saved.color };
  if (name === 'chief') return { icon: 'crown', color: PALETTE[0] };
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { icon: ICONS.filter((i) => i !== 'crown')[h % (ICONS.length - 1)], color: PALETTE[(h >>> 4) % PALETTE.length] };
}

class Hub {
  constructor(cfg, emit, log) {
    this.cfg = cfg;
    this.out = emit;
    this.log = log || (() => {});
    this.store = new State(cfg.stateDir);
    this.state = this.store.load();
    this.phase = 'starting';
    this.error = null;
    this.restore = null;
    this.guard = 0;
    this.boxes = [];
    this.panes = new Set();
    this.ctl = null;
    this.watch = null;
    this.chief = null;
    this.drill = null;
    this.term = null;
    this.working = new Map();
    this.screens = new Map();
    this.resumedAt = new Map();
    this.starting = new Set();
    this.usage = new Map();
    this.launch = new Map();
    this.switched = new Map();
    this.timers = [];
    this.soonTimers = {};
    this.busy = false;
    this.quitting = false;
  }

  // ---- lifecycle ---------------------------------------------------------

  async boot() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.state = this.store.load();
      if (!(await hasSession(this.cfg.session))) {
        const live = liveSessionIds(this.cfg.claudeHome);
        const resumable = this.state.boxes.filter((b) => UUID_RE.test(b.sessionId || '') && !live.has(b.sessionId));
        this.log('session missing', { saved: this.state.boxes.length, resumable: resumable.length });
        if (resumable.length) await this.restoreAll(resumable);
        else await this.freshChief();
        this.guard = 0;
      } else {
        // A session that came back with fewer windows than saved must not
        // shrink the saved list.
        this.guard = this.state.boxes.length;
      }
      await this.attach();
    } catch (e) {
      this.error = String((e && e.message) || e);
      this.log('boot failed', this.error);
      this.setPhase('error');
    } finally {
      this.busy = false;
    }
  }

  async attach() {
    const ctl = new Control(this.cfg.session);
    this.ctl = ctl;
    ctl.on('output', (pane, buf) => this.onOutput(pane, buf));
    ctl.on('windows', (kind, id) => {
      this.soon('scan', 150, () => this.scan());
      if (kind === '%layout-change' && this.term && this.term.windowId === id) this.soon('term', 250, () => this.snapshotTerm());
    });
    ctl.on('exit', () => this.onDetached(ctl));
    ctl.on('log', (s) => this.log('tmux:', s.trim()));
    ctl.start();
    this.log('attached', { session: this.cfg.session, flags: 'ignore-size' });
    await this.scan();
    this.setPhase('ready');
    this.timers.push(setInterval(() => this.scan(), 5000));
    this.timers.push(setInterval(() => this.pollScreens(), 1500));
    this.timers.push(setInterval(() => this.pollUsage(), 3000));
    try {
      const w = fs.watch(path.join(this.cfg.claudeHome, 'sessions'), () => this.soon('scan', 400, () => this.scan()));
      this.timers.push({ close: () => w.close() });
    } catch {}
    if (this.term) this.snapshotTerm();
    this.pollScreens();
    this.pollUsage();
  }

  onDetached(ctl) {
    if (this.ctl !== ctl) return;
    this.ctl = null;
    this.log('detached');
    for (const t of this.timers) (t.close ? t.close() : clearInterval(t));
    this.timers = [];
    if (this.quitting) return;
    this.setPhase('starting');
    setTimeout(() => this.boot(), 600);
  }

  shutdown() {
    this.quitting = true;
    for (const t of this.timers) (t.close ? t.close() : clearInterval(t));
    if (this.watch && this.watch.tr) this.watch.tr.stop();
    if (this.chief && this.chief.tr) this.chief.tr.stop();
    if (this.ctl) this.ctl.stop();
  }

  soon(key, ms, fn) {
    clearTimeout(this.soonTimers[key]);
    this.soonTimers[key] = setTimeout(fn, ms);
  }

  setPhase(p) {
    this.phase = p;
    this.out({ type: 'phase', ...this.phaseInfo() });
  }

  phaseInfo() {
    return {
      phase: this.phase,
      error: this.error,
      restore: this.restore && { total: this.restore.total, done: this.restore.done },
    };
  }

  snapshot() {
    const home = this.cfg.home;
    const tilde = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
    return {
      ...this.phaseInfo(),
      boxes: this.publicBoxes(),
      drill: this.drill,
      config: {
        session: this.cfg.session,
        workdir: tilde(this.cfg.workdir),
        stateFile: tilde(this.store.file),
        model: this.cfg.model,
        effort: this.cfg.effort,
      },
    };
  }

  // ---- boxes -------------------------------------------------------------

  status(b) {
    if (this.restore && this.restore.names[b.name]) return this.restore.names[b.name];
    if (this.starting.has(b.name)) return 'starting';
    if (!b.claude) return 'off';
    if (this.working.has(b.paneId)) return 'working';
    const r = this.resumedAt.get(b.name);
    if (r && Date.now() - r < 6000) return 'resumed';
    return 'idle';
  }

  publicBoxes() {
    return this.boxes.map((b) => {
      const sc = this.screens.get(b.paneId) || {};
      return {
        id: b.windowId,
        name: b.name,
        paneId: b.paneId,
        icon: b.icon,
        color: b.color,
        status: this.status(b),
        since: this.working.get(b.paneId) || null,
        activity: this.working.has(b.paneId) ? sc.activity || null : null,
        menu: sc.menu || null,
        ...this.meter(b),
        remote: !!(b.claude && b.claude.bridge),
      };
    });
  }

  // ---- cost, context, model, effort ----------------------------------------

  // Per window: the cost of sessions before the current one (kept across
  // /clear), and a reader for the current session.
  syncUsage() {
    for (const b of this.boxes) {
      if (!b.paneId) continue;
      const sid = b.claude ? b.claude.sessionId : null;
      let u = this.usage.get(b.windowId);
      const saved = this.state.boxes.find((x) => x.name === b.name) || {};
      if (!u) {
        u = { sid: null, cur: null, base: Number(saved.costCarry) || 0, olds: [], name: b.name };
        this.usage.set(b.windowId, u);
        // A /clear while the app was closed: count the session it left.
        if (sid && saved.sessionId && saved.sessionId !== sid && UUID_RE.test(saved.sessionId)) {
          const f = transcriptPath(this.cfg.claudeHome, saved.cwd || this.cfg.workdir, saved.sessionId);
          if (f) u.olds.push(new Usage(f));
        }
      }
      if (sid && sid !== u.sid) {
        if (u.cur) u.olds.push(u.cur);
        u.sid = sid;
        const f = transcriptPath(this.cfg.claudeHome, b.claude.cwd, sid);
        u.cur = f ? new Usage(f) : null;
        this.soon('usage', 50, () => this.pollUsage());
      }
      if (b.claude && b.claude.pid && !this.launch.has(b.claude.pid)) {
        this.launch.set(b.claude.pid, null);
        argsOf(b.claude.pid).then((a) => {
          const m = /--model[ =](\S+)/.exec(a);
          const e = /--effort[ =](\S+)/.exec(a);
          this.launch.set(b.claude.pid, { model: m ? ALIASES[m[1]] || m[1] : null, effort: e && EFFORTS.includes(e[1]) ? e[1] : null });
          this.emitBoxes();
        });
      }
    }
    const live = new Set(this.boxes.map((b) => b.windowId));
    for (const k of [...this.usage.keys()]) if (!live.has(k)) this.usage.delete(k);
  }

  async pollUsage() {
    if (this.usagePolling) return;
    this.usagePolling = true;
    let changed = false;
    try {
      for (const u of [...this.usage.values()]) {
        for (const o of u.olds) if (await o.poll()) changed = true;
        if (u.cur && (await u.cur.poll())) changed = true;
      }
    } finally {
      this.usagePolling = false;
    }
    if (changed) {
      this.recordState();
      this.emitBoxes();
    }
  }

  carry(b) {
    const u = this.usage.get(b.windowId);
    if (!u) return null;
    return u.base + u.olds.reduce((t, o) => t + o.total, 0);
  }

  meter(b) {
    const u = this.usage.get(b.windowId);
    const cur = u && u.cur;
    const launch = b.claude ? this.launch.get(b.claude.pid) : null;
    const started = b.claude && b.claude.startedAt ? Number(new Date(b.claude.startedAt)) || 0 : 0;
    const sw = b.claude ? this.switched.get(b.claude.pid) || {} : {};
    // The newest word wins: launch flags, a switch from the app, the log.
    const latest = (list) => list.filter((x) => x.v).sort((a, b) => b.at - a.at)[0];
    const m = latest([
      { v: launch && launch.model, at: started },
      { v: sw.model && sw.model.v, at: sw.model ? sw.model.at : 0 },
      { v: cur && cur.last && cur.last.model, at: cur && cur.last ? cur.last.at : 0 },
      { v: cur && cur.modelSet && cur.modelSet.id, at: cur && cur.modelSet ? cur.modelSet.at : 0 },
    ]);
    const e = latest([
      { v: launch && launch.effort, at: started },
      { v: sw.effort && sw.effort.v, at: sw.effort ? sw.effort.at : 0 },
      { v: cur && cur.effortSet && cur.effortSet.effort, at: cur && cur.effortSet ? cur.effortSet.at : 0 },
    ]);
    let model = m ? m.v : null;
    let effort = e ? e.v : null;
    if (!b.claude) model = effort = null;
    return {
      cost: u ? this.carry(b) + (cur ? cur.total : 0) : null,
      context: cur ? cur.context : null,
      model,
      modelName: modelName(model),
      effort,
    };
  }

  // A switch is for this box only. Claude saves /model and /effort as the
  // default for new sessions too, so the two settings are put back after.
  async switchBox(paneId, kind, value) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    if (kind === 'model' && !MODELS.includes(value)) return { ok: false, reason: 'Unknown model.' };
    if (kind === 'effort' && !EFFORTS.includes(value)) return { ok: false, reason: 'Unknown effort.' };
    const file = path.join(this.cfg.claudeHome, 'settings.json');
    const keys = ['model', 'effortLevel'];
    const read = () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
    };
    const before = read();
    const r = await this.sendText(paneId, `/${kind} ${value}`);
    if (!r.ok) return r;
    if (before) {
      for (let i = 0; i < 8; i++) {
        await sleep(500);
        const now = read();
        if (!now) continue;
        if (keys.every((k) => JSON.stringify(now[k]) === JSON.stringify(before[k]))) continue;
        for (const k of keys) {
          if (k in before) now[k] = before[k];
          else delete now[k];
        }
        const tmp = file + '.chiefman-tmp';
        fs.writeFileSync(tmp, JSON.stringify(now, null, 2) + '\n');
        fs.renameSync(tmp, file);
        this.log('default kept', { box: box.name, kind });
        break;
      }
    }
    const sw = this.switched.get(box.claude.pid) || {};
    sw[kind] = { v: value, at: Date.now() };
    this.switched.set(box.claude.pid, sw);
    this.recordState();
    this.emitBoxes();
    this.log('switch', { box: box.name, kind, value });
    return { ok: true };
  }

  // Remote Control: on means Claude gave the session a claude.ai link.
  async remote(paneId) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    if (box.claude.bridge) return { ok: true, url: 'https://claude.ai/code/' + box.claude.bridge };
    const r = await this.sendText(paneId, '/remote-control');
    return r.ok ? { ok: true, started: true } : r;
  }

  // ---- box actions --------------------------------------------------------

  async action(paneId, kind) {
    const cmd = { compact: '/compact', clear: '/clear', context: '/context' }[kind];
    if (!cmd) return { ok: false, reason: 'Unknown action.' };
    return this.sendText(paneId, cmd);
  }

  // Renames the tmux window and the Claude session; the saved box keeps its look.
  async rename(paneId, raw) {
    const name = String(raw || '').trim();
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box) return { ok: false, reason: 'That box is gone.' };
    if (!NAME_RE.test(name)) return { ok: false, reason: 'Use lowercase letters, digits and dashes.' };
    if (name === box.name) return { ok: true };
    if (this.boxes.some((b) => b.name === name) || this.starting.has(name)) return { ok: false, reason: `A box named ${name} already exists.` };
    const saved = this.state.boxes.find((b) => b.name === box.name);
    if (saved) {
      saved.name = name;
      this.store.save(this.state);
    }
    const u = this.usage.get(box.windowId);
    if (u) u.name = name;
    await run(['rename-window', '-t', box.windowId, name]);
    if (box.claude) await this.sendText(paneId, `/rename ${name}`);
    this.log('rename', { from: box.name, to: name });
    await this.scan();
    return { ok: true, name };
  }

  // Earlier sessions in the working folder, newest first, for New Box.
  recentSessions() {
    const dir = path.join(this.cfg.claudeHome, 'projects', this.cfg.workdir.replace(/[^A-Za-z0-9]/g, '-'));
    const live = liveSessionIds(this.cfg.claudeHome);
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((f) => UUID_RE.test(f.slice(0, -6)) && f.endsWith('.jsonl') && !live.has(f.slice(0, -6)))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(0, 10);
    } catch {
      return [];
    }
    return files
      .map(({ f, t }) => {
        let text = '';
        try {
          const fd = fs.openSync(path.join(dir, f), 'r');
          const buf = Buffer.alloc(512 * 1024);
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          text = buf.subarray(0, n).toString('utf8');
        } catch {}
        let title = '';
        let first = '';
        for (const line of text.split('\n')) {
          if (!title && line.startsWith('{"type":"custom-title"')) {
            try {
              title = JSON.parse(line).customTitle || '';
            } catch {}
          }
          if (!first && line.includes('"type":"user"') && !line.includes('"isMeta":true')) {
            try {
              const d = JSON.parse(line);
              const c = d.message && d.message.content;
              const s = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((x) => x && x.type === 'text') || {}).text || '' : '';
              if (s && !/^\s*</.test(s)) first = s.trim().split('\n')[0];
            } catch {}
          }
          if (title && first) break;
        }
        if (!first && !title) return null;
        return { id: f.slice(0, -6), at: t, title: mask(title).slice(0, 40), first: mask(first).slice(0, 100) };
      })
      .filter(Boolean);
  }

  emitBoxes() {
    this.out({ type: 'boxes', boxes: this.publicBoxes() });
  }

  async scan() {
    let out;
    try {
      out = await run([
        'list-panes', '-s', '-t', `=${this.cfg.session}`,
        '-F', '#{window_id}\t#{window_index}\t#{window_name}\t#{pane_id}',
      ]);
    } catch {
      return;
    }
    const sessions = readSessions(this.cfg.claudeHome, this.cfg.session);
    const seen = new Set();
    const boxes = [];
    for (const line of out.split('\n')) {
      if (!line) continue;
      const [windowId, index, name, paneId] = line.split('\t');
      if (seen.has(windowId)) continue;
      seen.add(windowId);
      const saved = this.state.boxes.find((b) => b.name === name);
      boxes.push({ windowId, index: Number(index), name, paneId, claude: sessions.get(paneId) || null, ...look(name, saved) });
    }
    boxes.sort((a, b) => a.index - b.index);
    this.boxes = boxes;
    this.panes = new Set(boxes.map((b) => b.paneId));
    for (const p of [...this.working.keys()]) if (!this.panes.has(p)) this.working.delete(p);
    for (const p of [...this.screens.keys()]) if (!this.panes.has(p)) this.screens.delete(p);
    this.syncUsage();
    this.recordState();
    this.syncChief();
    this.syncWatch();
    this.emitBoxes();
  }

  // state.json mirrors every window: its name, session id and folder.
  recordState() {
    if (this.guard) {
      if (this.boxes.length < this.guard) return;
      this.guard = 0;
    }
    const prev = this.state.boxes;
    const boxes = this.boxes.map((b) => {
      const old = prev.find((p) => p.name === b.name) || {};
      const live = this.meter(b);
      const carry = this.carry(b);
      const entry = {
        name: b.name,
        icon: b.icon,
        color: b.color,
        sessionId: (b.claude && b.claude.sessionId) || old.sessionId || null,
        cwd: (b.claude && b.claude.cwd) || old.cwd || this.cfg.workdir,
        model: (live.model && FLAG_RE.test(live.model) ? live.model : null) || old.model || this.cfg.model,
        effort: live.effort || old.effort || this.cfg.effort,
        createdAt: old.createdAt || null,
        costCarry: Math.round((carry != null ? carry : Number(old.costCarry) || 0) * 10000) / 10000,
      };
      if (!entry.sessionId && old.pending) entry.pending = true;
      return entry;
    });
    const next = { version: 1, session: this.cfg.session, workdir: this.cfg.workdir, boxes };
    if (JSON.stringify(next) !== JSON.stringify(this.state)) {
      this.state = next;
      try {
        this.store.save(next);
      } catch (e) {
        this.log('state save failed', String(e.message || e));
      }
    }
  }

  // Reads every Claude pane: working or not, the spinner's words, any menu.
  async pollScreens() {
    if (this.polling || !this.ctl) return;
    this.polling = true;
    let changed = false;
    try {
      for (const b of this.boxes) {
        if (!b.claude) {
          if (this.working.delete(b.paneId)) changed = true;
          if (this.screens.delete(b.paneId)) changed = true;
          continue;
        }
        let text;
        try {
          text = await this.ctl.command(`capture-pane -p -t ${b.paneId}`);
        } catch {
          continue;
        }
        const tail = text.split('\n').filter((l) => l.trim()).slice(-25);
        const w = tail.some((l) => /[(·].*esc to interrupt/.test(l));
        if (w && !this.working.has(b.paneId)) {
          this.working.set(b.paneId, Date.now());
          changed = true;
        } else if (!w && this.working.has(b.paneId)) {
          this.working.delete(b.paneId);
          changed = true;
        }
        const menu = parseMenu(text);
        const sc = {
          activity: w ? mask(parseActivity(text) || '') || null : null,
          menu: menu && {
            question: mask(menu.question),
            selected: menu.selected,
            options: menu.options.map((o) => ({ n: o.n, label: mask(o.label) })),
          },
        };
        if (JSON.stringify(sc) !== JSON.stringify(this.screens.get(b.paneId) || {})) {
          this.screens.set(b.paneId, sc);
          changed = true;
        }
      }
    } finally {
      this.polling = false;
    }
    if (changed) this.emitBoxes();
  }

  // ---- chat --------------------------------------------------------------

  follow(slot, handlers) {
    const box = this.boxes.find((b) => b.paneId === slot.paneId);
    const sid = box && box.claude ? box.claude.sessionId : null;
    if (slot.tr && sid === slot.sessionId) return;
    if (slot.tr) slot.tr.stop();
    slot.tr = null;
    slot.sessionId = null;
    const file = sid && transcriptPath(this.cfg.claudeHome, box.claude.cwd, sid);
    if (!file) {
      if (!slot.empty) handlers.reset({ items: [], steps: 0 });
      slot.empty = true;
      return;
    }
    slot.empty = false;
    slot.sessionId = sid;
    const tr = new Transcript(file);
    slot.tr = tr;
    tr.on('reset', handlers.reset);
    tr.on('add', handlers.add);
    if (handlers.context) tr.on('context', handlers.context);
    tr.start();
  }

  watchPane(paneId) {
    const w = this.watch;
    if (w && w.paneId === paneId && w.tr && w.tr.loaded) {
      this.out({ type: 'chat-reset', paneId, items: w.tr.items, steps: w.tr.steps });
      return;
    }
    if (w && w.paneId === paneId) return;
    if (w && w.tr) w.tr.stop();
    this.watch = { paneId, sessionId: null, tr: null };
    this.syncWatch();
  }

  syncWatch() {
    const w = this.watch;
    if (!w) return;
    this.follow(w, {
      reset: (e) => this.watch === w && this.out({ type: 'chat-reset', paneId: w.paneId, items: e.items, steps: e.steps }),
      add: (e) => this.watch === w && this.out({ type: 'chat-add', paneId: w.paneId, added: e.added, steps: e.steps }),
      context: (text) => this.watch === w && this.out({ type: 'context', paneId: w.paneId, text }),
    });
  }

  syncChief() {
    const box = this.boxes.find((b) => b.name === 'chief');
    if (!box) {
      if (this.chief && this.chief.tr) this.chief.tr.stop();
      this.chief = null;
      this.setDrill(null);
      return;
    }
    if (!this.chief || this.chief.paneId !== box.paneId) {
      if (this.chief && this.chief.tr) this.chief.tr.stop();
      this.chief = { paneId: box.paneId, sessionId: null, tr: null };
    }
    const c = this.chief;
    const update = () => this.chief === c && this.setDrill(c.tr ? newestDrill(c.tr.items) : null);
    this.follow(c, { reset: update, add: update });
  }

  setDrill(d) {
    if (JSON.stringify(d) === JSON.stringify(this.drill)) return;
    this.drill = d;
    this.out({ type: 'drill', drill: d });
  }

  // ---- terminal ----------------------------------------------------------

  openTerm(paneId) {
    if (!paneId || !this.panes.has(paneId)) {
      this.term = null;
      return;
    }
    const box = this.boxes.find((b) => b.paneId === paneId);
    this.term = { paneId, windowId: box.windowId, ready: false, dec: null, buf: '', flush: null };
    this.snapshotTerm();
  }

  // Size, cursor and screen in one line, so no output lands between them.
  snapshotTerm() {
    const t = this.term;
    if (!t || !this.ctl) return;
    t.ready = false;
    const fmt = "'#{pane_width} #{pane_height} #{cursor_x} #{cursor_y} #{cursor_flag}'";
    this.ctl.send(`display -p -t ${t.paneId} ${fmt} ; capture-pane -p -e -t ${t.paneId} -S -400`, 2, (err, r) => {
      if (err || this.term !== t) return;
      const [cols, rows, cx, cy, cur] = r[0].trim().split(' ').map(Number);
      const lines = r[1].split('\n');
      while (lines.length > rows && lines[lines.length - 1] === '') lines.pop();
      const data =
        '\x1b[0m' + mask(lines.join('\r\n'), true) + `\x1b[0m\x1b[${cy + 1};${cx + 1}H` + (cur ? '\x1b[?25h' : '\x1b[?25l');
      t.dec = new TextDecoder();
      t.buf = '';
      t.ready = true;
      this.out({ type: 'term-reset', paneId: t.paneId, cols, rows, data });
    });
  }

  onOutput(pane, buf) {
    const t = this.term;
    if (!t || t.paneId !== pane || !t.ready) return;
    t.buf += t.dec.decode(buf, { stream: true });
    if (!t.flush) {
      t.flush = setTimeout(() => {
        t.flush = null;
        if (this.term !== t || !t.buf) return;
        const data = mask(t.buf, true);
        t.buf = '';
        this.out({ type: 'term', paneId: t.paneId, data });
      }, 12);
    }
  }

  termInput(paneId, data) {
    if (!this.term || this.term.paneId !== paneId || !this.panes.has(paneId) || !this.ctl) return;
    const bytes = Buffer.from(String(data), 'utf8');
    for (let i = 0; i < bytes.length; i += 256) {
      const hex = [...bytes.subarray(i, i + 256)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
      this.ctl.command(`send-keys -t ${paneId} -H ${hex}`).catch(() => {});
    }
  }

  // ---- typing into a box -------------------------------------------------

  // Claude reads fast typing as a paste, and an Enter inside a paste becomes
  // part of the text. So the Enters wait until the text has settled.
  async enter(paneId, text, enters) {
    await sleep(Math.min(900, 250 + Math.round(text.length / 4)));
    for (let i = 0; i < enters; i++) {
      if (i) await sleep(120);
      await run(['send-keys', '-t', paneId, 'Enter']);
    }
  }

  // Text goes in as typed keys, with Option+Enter between lines. A bracketed
  // paste would reach Claude marked as pasted text, which it treats as words
  // he may not have written.
  async deliver(paneId, text) {
    const enters = text.startsWith('/') ? 1 : 2;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let t = lines[i];
      if (t.endsWith(';')) t = t.slice(0, -1) + '\\;';
      if (t) await run(['send-keys', '-t', paneId, '-l', '--', t]);
      if (i < lines.length - 1) await run(['send-keys', '-t', paneId, 'M-Enter']);
    }
    await this.enter(paneId, text, enters);
  }

  // Sends, then checks the text left the prompt; one more Enter if it stuck.
  async deliverChecked(paneId, text) {
    await this.deliver(paneId, text);
    for (let i = 0; i < 4; i++) {
      await sleep(700);
      let st;
      try {
        st = promptState(await run(['capture-pane', '-p', '-e', '-t', paneId]));
      } catch {
        return false;
      }
      if (st !== 'typed') return true;
      await run(['send-keys', '-t', paneId, 'Enter']);
    }
    return false;
  }

  async promptEmpty(paneId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (promptState(await run(['capture-pane', '-p', '-e', '-t', paneId])) === 'empty') return true;
      } catch {
        return false;
      }
      await sleep(400);
    }
    return false;
  }

  async sendText(paneId, raw) {
    const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '');
    if (!text) return { ok: false, reason: 'Nothing to send.' };
    if (text.length > 50000) return { ok: false, reason: 'That message is too long.' };
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    if (!box.claude) return { ok: false, reason: `${box.name} has no Claude running.` };
    let screen;
    try {
      screen = await run(['capture-pane', '-p', '-e', '-t', paneId]);
    } catch {
      return { ok: false, reason: `Could not read ${box.name}.` };
    }
    const st = promptState(screen);
    if (st === 'typed') return { ok: false, reason: `Something is already typed in ${box.name}. Clear it in Terminal first.` };
    if (st === 'no-prompt') return { ok: false, reason: `${box.name} is waiting on a choice. Pick one above, or use Terminal.` };
    const queued = this.working.has(paneId);
    await this.deliver(paneId, text);
    this.log('sent', { box: box.name, chars: text.length, slash: text.startsWith('/'), queued });
    return { ok: true, queued };
  }

  async sendChief(text) {
    const box = this.boxes.find((b) => b.name === 'chief');
    if (!box) return { ok: false, reason: 'There is no chief window.' };
    return this.sendText(box.paneId, text);
  }

  // Esc stops a box that is working. An idle box gets nothing, since a
  // second Esc there opens Claude's rewind menu.
  async interrupt(paneId) {
    if (!this.panes.has(paneId) || !this.working.has(paneId)) return { ok: false };
    await run(['send-keys', '-t', paneId, 'Escape']);
    this.log('interrupt', { pane: paneId });
    return { ok: true };
  }

  // Picks option n in the menu the pane shows, by moving to it and pressing Enter.
  async choose(paneId, n) {
    if (!this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    const menu = parseMenu(await run(['capture-pane', '-p', '-t', paneId]));
    if (!menu || !menu.options.some((o) => o.n === n)) return { ok: false, reason: 'That choice is no longer on screen.' };
    const d = n - menu.selected;
    const keys = Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up');
    await run(['send-keys', '-t', paneId, ...keys, 'Enter']);
    this.log('choose', { pane: paneId, n });
    this.soon('poll', 400, () => this.pollScreens());
    return { ok: true };
  }

  // ---- starting boxes ----------------------------------------------------

  claudeCmd(resume, model, effort) {
    const m = FLAG_RE.test(model || '') ? model : this.cfg.model;
    const e = FLAG_RE.test(effort || '') ? effort : this.cfg.effort;
    const dirs = this.cfg.pluginDirs.map((d) => ` --plugin-dir '${d.replace(/'/g, "'\\''")}'`).join('');
    let cmd = `claude${dirs} --dangerously-skip-permissions --model ${m} --effort ${e}`;
    if (resume && UUID_RE.test(resume)) cmd += ` --resume ${resume}`;
    return cmd;
  }

  // Ready when Claude's prompt shows. A folder trust question is his to
  // answer, so it ends the wait instead of being answered here.
  async waitReady(paneId, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      await sleep(700);
      let s;
      try {
        s = await run(['capture-pane', '-p', '-t', paneId]);
      } catch {
        return false;
      }
      if (/trust (the files in )?this folder/i.test(s)) return 'trust';
      if (/bypass permissions on/.test(s) && /❯/.test(s)) return true;
    }
    return false;
  }

  async newWindow(name, first, cwd) {
    const S = this.cfg.session;
    const dir = cwd && fs.existsSync(cwd) ? cwd : this.cfg.workdir;
    const fmt = '#{window_id} #{pane_id}';
    const args = first
      ? ['new-session', '-d', '-P', '-F', fmt, '-s', S, '-n', name, '-c', dir, '-x', '200', '-y', '50']
      : ['new-window', '-d', '-P', '-F', fmt, '-t', `=${S}:`, '-n', name, '-c', dir];
    const [windowId, paneId] = (await run(args)).trim().split(' ');
    return { windowId, paneId };
  }

  async newBox(spec) {
    const name = String((spec && spec.name) || '').trim();
    const icon = ICONS.includes(spec && spec.icon) ? spec.icon : 'doc';
    const color = PALETTE.includes(spec && spec.color) ? spec.color : PALETTE[0];
    const message = String((spec && spec.message) || '').replace(/\r\n?/g, '\n').trim();
    const model = MODELS.includes(spec && spec.model) ? spec.model : this.cfg.model;
    const effort = EFFORTS.includes(spec && spec.effort) ? spec.effort : this.cfg.effort;
    const resume = spec && UUID_RE.test(spec.resume || '') ? spec.resume : null;
    if (resume && liveSessionIds(this.cfg.claudeHome).has(resume)) return { ok: false, reason: 'That session already runs in another window.' };
    if (!NAME_RE.test(name)) return { ok: false, reason: 'Use lowercase letters, digits and dashes for the name.' };
    if (this.starting.has(name) || this.boxes.some((b) => b.name === name)) return { ok: false, reason: `A box named ${name} already exists.` };
    if (!this.ctl) return { ok: false, reason: 'chiefman is not connected to tmux yet.' };
    this.starting.add(name);
    try {
      return await this.startBox(name, icon, color, message, model, effort, resume);
    } finally {
      this.starting.delete(name);
      this.emitBoxes();
    }
  }

  async startBox(name, icon, color, message, model, effort, resume) {
    const record = {
      name, icon, color, sessionId: resume || null, cwd: this.cfg.workdir, model, effort,
      createdAt: new Date().toISOString(), pending: true,
    };
    this.state.boxes = this.state.boxes.filter((b) => b.name !== name).concat(record);
    this.store.save(this.state);
    this.log('new box', { name, model, effort });
    const { paneId } = await this.newWindow(name, false);
    await this.scan();
    await sleep(900);
    await run(['send-keys', '-t', paneId, '-l', '--', this.claudeCmd(resume, model, effort)]);
    await run(['send-keys', '-t', paneId, 'Enter']);
    const ready = await this.waitReady(paneId, 90000);
    if (ready === 'trust') return { ok: false, reason: `${name} asks whether to trust its folder. Answer it in Terminal.`, paneId };
    if (!ready) return { ok: false, reason: `${name} did not start in time. Open Terminal to see why.`, paneId };
    await this.promptEmpty(paneId, 5000);
    await this.deliverChecked(paneId, `/rename ${name}`);
    if (message) {
      await sleep(600);
      await this.promptEmpty(paneId, 8000);
      if (!(await this.deliverChecked(paneId, message))) {
        this.log('first message stuck', { name });
        return { ok: false, reason: `${name} started, but its first message is still typed there. Press Enter in Terminal.`, paneId };
      }
    }
    this.log('box started', { name });
    await this.scan();
    return { ok: true, paneId };
  }

  async restoreAll(list) {
    this.restore = { total: list.length, done: 0, names: {} };
    for (const b of list) this.restore.names[b.name] = 'resuming';
    this.boxes = list.map((b) => ({ windowId: 'saved:' + b.name, name: b.name, paneId: null, claude: null, ...look(b.name, b) }));
    this.panes = new Set();
    this.setPhase('restoring');
    this.emitBoxes();
    const started = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const w = await this.newWindow(b.name, i === 0, b.cwd);
      started.push({ b, ...w });
    }
    await sleep(900);
    for (const s of started) {
      await run(['send-keys', '-t', s.paneId, '-l', '--', this.claudeCmd(s.b.sessionId, s.b.model, s.b.effort)]);
      await run(['send-keys', '-t', s.paneId, 'Enter']);
    }
    await Promise.all(
      started.map(async (s) => {
        const ok = (await this.waitReady(s.paneId, 120000)) === true;
        this.restore.names[s.b.name] = ok ? 'resumed' : 'off';
        this.restore.done++;
        if (ok) this.resumedAt.set(s.b.name, Date.now());
        this.log('restored', { name: s.b.name, ok });
        this.setPhase('restoring');
        this.emitBoxes();
      }),
    );
    await sleep(1200);
    this.restore = null;
  }

  async freshChief() {
    this.restore = { total: 1, done: 0, names: { chief: 'resuming' } };
    this.boxes = [{ windowId: 'saved:chief', name: 'chief', paneId: null, claude: null, ...look('chief') }];
    this.setPhase('fresh');
    this.emitBoxes();
    const { paneId } = await this.newWindow('chief', true);
    await sleep(900);
    await run(['send-keys', '-t', paneId, '-l', '--', this.claudeCmd(null)]);
    await run(['send-keys', '-t', paneId, 'Enter']);
    if ((await this.waitReady(paneId, 90000)) === true) await this.deliver(paneId, '/rename chief');
    this.restore = null;
  }
}

module.exports = { Hub };

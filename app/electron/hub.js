const fs = require('fs');
const path = require('path');
const { run, hasSession, Control } = require('./tmux');
const { readSessions, liveSessionIds, transcriptPath, alive } = require('./sessions');
const { Transcript } = require('./transcript');
const { newestDrill } = require('./drilldown');
const { State } = require('./state');
const { mask } = require('./mask');
const { promptState, parseActivity, parseMenu, parseMode, promptText, SEND_ALL } = require('./screen');
const { DefaultKeeper } = require('./defaults');
const { Usage, modelName } = require('./usage');
const { readPlan, readWorkspace } = require('./plan');
const { buttonSkills, pluginDirsIn } = require('./skills');
const { markText, unmark } = require('./mark');
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
const READY = (s) => /(?:⏵⏵|⏸) .+ on\b/.test(s) && /❯/.test(s) && !parseMenu(s);
// CHIEFMAN_START_LIMIT_MS shortens the limit for a test run.
const START_LIMIT = Number(process.env.CHIEFMAN_START_LIMIT_MS) || 90000;
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
const SHELLS = /^-?(zsh|bash|sh|fish|dash|ksh|tcsh|csh)$/;
const TRUST = /trust (the files in )?this folder/i;
const NOT_TRUSTED = 'Its folder was not trusted.';
// tmux names a running Claude by its version number, or claude or node.
const CLAUDE_CMD = /^(claude|node|\d+\.\d+\.\d+)$/i;

// A key the app refused to send: the result the button gets instead.
class Refused extends Error {
  constructor(result) {
    super(result.reason);
    this.result = result;
  }
}
// Text compared without its spacing or quote style.
const same = (s) => String(s || '').replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'").replace(/\s+/g, '');
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
    // Boxes whose window closed: kept, with their draft, until he starts them
    // again or closes them, or their window comes back.
    this.ended = new Map((Array.isArray(this.state.ended) ? this.state.ended : []).filter((e) => e && NAME_RE.test(e.name || '')).map((e) => [e.name, e]));
    // Sessions of boxes he removed from the list: New Box offers them first.
    this.removed = (Array.isArray(this.state.removed) ? this.state.removed : []).filter((e) => e && UUID_RE.test(e.id || '') && NAME_RE.test(e.name || '')).slice(0, 6);
    // Why a box ended as it started, by name, for the line above its actions.
    this.endWhy = new Map();
    // Panes last seen running Claude, and when: keys go only there.
    this.claudeAt = new Map();
    this.closing = new Set();
    this.phase = 'starting';
    this.error = null;
    this.restoreRun = null;
    this.resuming = new Map();
    this.touched = new Map();
    this.stoppedAt = new Map();
    this.rewinding = new Map();
    this.fileCache = new Map();
    this.editsFile = path.join(cfg.stateDir, 'chat-edits.json');
    const edits = readJson(this.editsFile) || {};
    this.cuts = edits.cuts || {};
    this.marks = edits.marks || {};
    // Until this time a session someone else is still building keeps the
    // saved list from shrinking.
    this.hold = 0;
    // When the tmux session was made: tells a saved list from this session
    // apart from one of an earlier session.
    this.created = null;
    this.windowsFile = path.join(cfg.stateDir, 'windows');
    this.windowsText = null;
    this.boxes = [];
    this.panes = new Set();
    this.ctl = null;
    this.watch = null;
    this.chief = null;
    this.drill = null;
    this.term = null;
    this.working = new Map();
    // Each pane's @claude_state tmux option, and whether the tab bar draws
    // tabs from it.
    this.tabs = new Map();
    this.tabFormat = false;
    this.screens = new Map();
    this.resumedAt = new Map();
    this.starting = new Set();
    this.usage = new Map();
    this.launch = new Map();
    this.switched = new Map();
    this.switching = new Map();
    this.queues = new Map();
    // One answer to a box's question menu at a time; panes whose "Review
    // your answers" step the app is submitting (not shown meanwhile).
    this.menuOps = new Map();
    this.confirming = new Set();
    this.lastSend = new Map();
    this.typedByApp = new Map();
    // Remote Control, by Claude pid: the ones he turned off (kept across app
    // restarts while that Claude runs), his clicks not yet done, when the app
    // may next turn one on by itself, and the ones with a command in flight.
    this.remoteOff = new Set((Array.isArray(this.state.remoteOff) ? this.state.remoteOff : []).filter(Number.isInteger));
    this.remoteAsk = new Map();
    this.remoteNext = new Map();
    this.remoteBusy = new Set();
    this.keeper = new DefaultKeeper(path.join(cfg.claudeHome, 'settings.json'), this.log);
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
        this.forgetClosed();
        const live = liveSessionIds(this.cfg.claudeHome);
        const resumable = this.state.boxes.filter((b) => UUID_RE.test(b.sessionId || '') && !live.has(b.sessionId));
        this.log('session missing', { saved: this.state.boxes.length, resumable: resumable.length });
        if (resumable.length) await this.openRestore(resumable);
        else await this.openFresh();
        this.hold = 0;
      } else {
        // The session follows its windows: a saved box with no window was
        // closed while chiefman was closed. Only a session made in the last
        // two minutes by something else may still be getting its windows
        // back, so the saved list waits for them until then.
        const created = await this.sessionCreated();
        const young = created && created !== this.state.created && Date.now() - created * 1000 < 120000;
        this.hold = young ? created * 1000 + 120000 : 0;
      }
      await this.attach();
      for (const name of [...this.resuming.keys()]) this.followStart(name);
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
    this.created = await this.sessionCreated();
    await this.keepWindowList();
    const fmt = await run(['show-options', '-gv', 'window-status-format']).catch(() => '');
    this.tabFormat = /@claude_state/.test(fmt);
    await this.scan();
    this.setPhase('ready');
    this.timers.push(setInterval(() => this.scan(), 5000));
    this.timers.push(setInterval(() => this.pollScreens(), 1500));
    this.timers.push(setInterval(() => this.pollUsage(), 3000));
    this.timers.push(setInterval(() => this.pollPlan(), 15000));
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

  // ---- windows closed while chiefman is closed ----------------------------

  async sessionCreated() {
    const out = await run(['display', '-p', '-t', `=${this.cfg.session}:`, '#{session_created}']).catch(() => '');
    return Number(out.trim()) || null;
  }

  // tmux itself keeps the list of the session's windows in a file, rewritten
  // each time a window closes, also while chiefman is closed. The hook sits
  // in one fixed slot of the session's own hooks and writes nothing once the
  // session itself is gone (a restart, or tmux quitting), so the list then
  // still holds every box that was running. A session hook would hide a
  // global one of the same kind, so with one of those set, none is added.
  async keepWindowList() {
    const f = this.windowsFile;
    if (/['"$`\\#\n]/.test(f)) return this.log('window list off', { why: 'path' });
    const global = await run(['show-hooks', '-g', 'window-unlinked']).catch(() => '');
    if (global.includes('[')) return this.log('window list off', { why: 'global hook' });
    const sh =
      `{ [ -n "#{W:x}" ] && printf "%s\\n" #{session_created} #{W:#{window_id} } > "${f}.tmp" && mv -f "${f}.tmp" "${f}"; }` +
      ' >/dev/null 2>&1; true';
    try {
      await run(['set-hook', '-t', `=${this.cfg.session}:`, 'window-unlinked[42]', `run-shell -b '${sh}'`]);
    } catch (e) {
      this.log('window list off', { why: String((e && e.message) || e).slice(0, 120) });
    }
  }

  // The same list, written by the app while it runs.
  writeWindows() {
    if (!this.created || !this.boxes.length) return;
    const text = [this.created, ...this.boxes.map((b) => b.windowId)].join('\n') + '\n';
    if (text === this.windowsText) return;
    try {
      fs.writeFileSync(this.windowsFile + '.tmp', text, { mode: 0o600 });
      fs.renameSync(this.windowsFile + '.tmp', this.windowsFile);
      this.windowsText = text;
    } catch {}
  }

  // Before a restore: a saved box whose window is missing from the list tmux
  // kept for that same session was closed on purpose, so it stays closed.
  forgetClosed() {
    let lines;
    try {
      lines = fs.readFileSync(this.windowsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return;
    }
    const [created, ...open] = lines;
    if (!open.length || !this.state.created || Number(created) !== this.state.created) return;
    const closed = this.state.boxes.filter((b) => b.windowId && !open.includes(b.windowId));
    if (!closed.length) return;
    this.state.boxes = this.state.boxes.filter((b) => !closed.includes(b));
    this.store.save(this.state);
    this.log('closed while away', { names: closed.map((b) => b.name) });
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
      restore: this.restoreInfo(),
    };
  }

  // The plan's usage bars and the machine's workspace name, read from disk
  // every 15 seconds; sent only when they change.
  readPlanInfo() {
    return { plan: readPlan(this.cfg.claudeHome), workspace: readWorkspace(this.cfg.claudeHome) };
  }

  pollPlan() {
    const info = this.readPlanInfo();
    const text = JSON.stringify(info);
    if (text === this.planText) return;
    this.planText = text;
    this.out({ type: 'plan', ...info });
  }

  snapshot() {
    const home = this.cfg.home;
    const tilde = (p) => (p.startsWith(home) ? '~' + p.slice(home.length) : p);
    const info = this.readPlanInfo();
    this.planText = JSON.stringify(info);
    return {
      ...this.phaseInfo(),
      ...info,
      boxes: this.publicBoxes(),
      drill: this.drill,
      config: {
        session: this.cfg.session,
        workdir: tilde(this.cfg.workdir),
        stateFile: tilde(this.store.file),
        attachDir: path.join(this.cfg.stateDir, 'attachments'),
        model: this.cfg.model,
        effort: this.cfg.effort,
      },
    };
  }

  // ---- boxes -------------------------------------------------------------

  // The quiet sidebar line while boxes come back; gone once each is back or failed.
  restoreInfo() {
    const run = this.restoreRun;
    if (!run) return null;
    const waiting = run.names.filter((n) => {
      const r = this.resuming.get(n);
      return r && r.state === 'resuming';
    }).length;
    if (!waiting) {
      this.restoreRun = null;
      return null;
    }
    return { total: run.names.length, done: run.names.length - waiting, label: run.label };
  }

  status(b) {
    const r = this.resuming.get(b.name);
    if (r && r.paneId === b.paneId && !(r.state === 'failed' && b.claude)) return r.state === 'failed' ? 'failed' : 'resuming';
    if (this.starting.has(b.name)) return 'starting';
    if (!b.claude) return 'off';
    if (this.working.has(b.paneId)) return 'working';
    const back = this.resumedAt.get(b.name);
    if (back && Date.now() - back < 6000) return 'resumed';
    return 'idle';
  }

  // A box ended when its window closed (status "ended", no pane), or when its
  // Claude exited and left the window on a shell. Either can start again
  // from its session.
  // A box New Box made that never got a session (its folder was not trusted)
  // ends the same way, with nothing to start again.
  endedInfo(b) {
    if (b.claude || this.status(b) !== 'off') return null;
    const saved = this.state.boxes.find((s) => s.name === b.name);
    if (!saved || (!UUID_RE.test(saved.sessionId || '') && !saved.pending)) return null;
    return { start: this.hasConversation(saved.sessionId, saved.cwd), window: true, later: this.resumable(saved.sessionId), why: this.endWhy.get(b.name) || null };
  }

  // New Box resumes sessions from the working folder only.
  sessionDir() {
    return path.join(this.cfg.claudeHome, 'projects', this.cfg.workdir.replace(/[^A-Za-z0-9]/g, '-'));
  }

  sessionFile(id) {
    return path.join(this.sessionDir(), `${id}.jsonl`);
  }

  resumable(id) {
    return UUID_RE.test(id || '') && fs.existsSync(this.sessionFile(id));
  }

  // Resume runs in the box's own folder, or the working folder.
  hasConversation(id, cwd) {
    if (this.resumable(id)) return true;
    const dir = path.join(this.cfg.claudeHome, 'projects', String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'));
    return UUID_RE.test(id || '') && !!cwd && fs.existsSync(path.join(dir, `${id}.jsonl`));
  }

  publicBoxes() {
    const gone = [...this.ended.values()]
      .filter((e) => !this.boxes.some((b) => b.name === e.name))
      .map((e) => ({
        id: `ended:${e.name}`,
        name: e.name,
        paneId: null,
        lastPane: e.paneId || null,
        icon: e.icon,
        color: e.color,
        status: 'ended',
        tab: null,
        since: null,
        activity: null,
        menu: null,
        mode: null,
        switching: null,
        cost: e.costCarry || null,
        context: null,
        tokens: null,
        model: null,
        modelName: null,
        effort: null,
        remote: false,
        skills: [],
        ended: { start: this.hasConversation(e.sessionId, e.cwd), window: false, later: this.resumable(e.sessionId), why: this.endWhy.get(e.name) || null },
        session: UUID_RE.test(e.sessionId || '') ? e.sessionId : null,
      }));
    return this.livePublicBoxes().concat(gone);
  }

  // The box's state as its tmux tab shows it: working, asks (it asked him
  // something and waits) or done. Where the tab bar draws tabs from the
  // @claude_state option that Claude's hooks set, that option decides, so
  // the app and the tab bar never disagree. Without it, the app reads the
  // screen: working, or a question.
  tabOf(b, sc, tabBar) {
    if (tabBar) {
      const s = this.tabs.get(b.paneId) || '';
      if (s === 'working' || s === 'stopping') return 'working';
      if (s === 'input') return 'asks';
      return s === 'done' ? 'done' : null;
    }
    if (sc.menu) return 'asks';
    return this.working.has(b.paneId) ? 'working' : null;
  }

  livePublicBoxes() {
    const tabBar = this.tabFormat || [...this.tabs.values()].some(Boolean);
    return this.boxes.map((b) => {
      const sc = this.screens.get(b.paneId) || {};
      return {
        id: b.windowId,
        name: b.name,
        paneId: b.paneId,
        icon: b.icon,
        color: b.color,
        status: this.status(b),
        tab: this.tabOf(b, sc, tabBar),
        since: this.working.get(b.paneId) || null,
        activity: this.working.has(b.paneId) ? sc.activity || null : null,
        menu: sc.menu || null,
        mode: (b.claude && sc.mode) || null,
        switching: this.switching.has(b.paneId) ? { ...this.switching.get(b.paneId), asking: !!sc.menu } : null,
        ...this.meter(b),
        remote: !!(b.claude && b.claude.bridge),
        remoteAsk: (b.claude && (this.remoteAsk.get(b.claude.pid) || {}).want) || null,
        skills: (b.claude && (this.launch.get(b.claude.pid) || {}).skills) || [],
        ended: this.endedInfo(b),
        session: (b.claude && b.claude.sessionId) || (this.state.boxes.find((s) => s.name === b.name) || {}).sessionId || null,
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
        u.cwd = b.claude.cwd;
        const f = transcriptPath(this.cfg.claudeHome, b.claude.cwd, sid);
        u.cur = f ? new Usage(f) : null;
        this.soon('usage', 50, () => this.pollUsage());
      }
      if (b.claude && b.claude.pid && !this.launch.has(b.claude.pid)) {
        this.launch.set(b.claude.pid, null);
        const cwd = b.claude.cwd;
        argsOf(b.claude.pid).then((a) => {
          const m = /--model[ =](\S+)/.exec(a);
          const e = /--effort[ =](\S+)/.exec(a);
          // A Claude finds its skills as it starts, so they are read once.
          let skills = [];
          try {
            skills = buttonSkills(this.cfg.claudeHome, cwd, pluginDirsIn(a, this.cfg.pluginDirs));
          } catch {}
          this.launch.set(b.claude.pid, { model: m ? ALIASES[m[1]] || m[1] : null, effort: e && EFFORTS.includes(e[1]) ? e[1] : null, skills });
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
        // A new session writes its transcript only with its first message.
        if (u.sid && !u.cur) {
          const f = transcriptPath(this.cfg.claudeHome, u.cwd, u.sid);
          if (f) u.cur = new Usage(f);
        }
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
      tokens: cur ? cur.tokens : null,
      model,
      modelName: modelName(model),
      effort,
    };
  }

  // A switch is for this box only. Claude saves /model and /effort as the
  // default for every new session, so the keeper puts the user's own value
  // back. The box says "Set model to …" when the switch took; until then the
  // header says "Switching…".
  async switchBox(paneId, kind, value) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    if (kind === 'model' && !MODELS.includes(value)) return { ok: false, reason: 'Unknown model.' };
    if (kind === 'effort' && !EFFORTS.includes(value)) return { ok: false, reason: 'Unknown effort.' };
    if (this.switching.has(paneId)) return { ok: false, reason: `${box.name} is still switching.` };
    const keys = this.defaultKeys(box, kind);
    const sw = { kind, value, at: Date.now() };
    this.switching.set(paneId, sw);
    this.touch(paneId);
    this.emitBoxes();
    this.keeper.guard(keys, 180000);
    const r = await this.sendText(paneId, `/${kind} ${value}`, { app: true });
    if (!r.ok) {
      this.switching.delete(paneId);
      this.keeper.release(keys, 0);
      this.emitBoxes();
      return r;
    }
    this.followSwitch(box, sw, keys);
    return { ok: true, pending: true };
  }

  // Where Claude saves the default this switch would change.
  defaultKeys(box, kind) {
    if (kind === 'model') return ['model'];
    const m = this.meter(box).model;
    return m && FLAG_RE.test(m) ? ['modelSettings', m, 'effortLevel'] : ['modelSettings'];
  }

  async followSwitch(box, sw, keys) {
    const paneId = box.paneId;
    const done = (ok, why) => {
      this.switching.delete(paneId);
      this.keeper.release(keys, 4000);
      if (ok && box.claude) {
        const prev = this.switched.get(box.claude.pid) || {};
        prev[sw.kind] = { v: sw.value, at: Date.now() };
        this.switched.set(box.claude.pid, prev);
        this.recordState();
      }
      this.log(ok ? 'switch' : 'switch not taken', { box: box.name, kind: sw.kind, value: sw.value, why });
      if (!ok && why !== 'kept') this.out({ type: 'notice', text: `${box.name} did not switch ${sw.kind}.`, bad: true });
      this.emitBoxes();
    };
    const said = sw.kind === 'model' ? /Set model to/ : /Set effort level to/;
    const kept = sw.kind === 'model' ? /Kept model as|cancell?ed/i : /Kept effort|cancell?ed/i;
    const end = sw.at + 180000;
    let quietSince = 0;
    while (Date.now() < end && this.panes.has(paneId)) {
      await sleep(400);
      let text;
      try {
        text = await run(['capture-pane', '-p', '-t', paneId, '-S', '-60']);
      } catch {
        return done(false, 'gone');
      }
      const lines = text.split('\n');
      let at = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].includes(`/${sw.kind} ${sw.value}`)) {
          at = i;
          break;
        }
      }
      const after = at >= 0 ? lines.slice(at + 1).join('\n') : '';
      if (said.test(after)) return done(true, 'said');
      if (kept.test(after)) return done(false, 'kept');
      if (parseMenu(text)) {
        quietSince = 0;
        continue;
      }
      if (promptState(text) === 'empty') {
        quietSince = quietSince || Date.now();
        if (Date.now() - quietSince > 6000) return done(false, 'no answer');
      } else quietSince = 0;
    }
    return done(false, 'timeout');
  }

  // Shift+Tab in the box: the mode under its prompt moves to the next one.
  async cycleMode(paneId) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    this.touch(paneId);
    await this.keys(paneId, ['BTab']);
    this.log('mode', { box: box.name });
    this.soon('poll', 300, () => this.pollScreens());
    return { ok: true };
  }

  // ---- Remote Control -----------------------------------------------------

  // On means Claude gave the session a claude.ai link. "link" returns it;
  // "on" and "off" are his clicks on the header's icon, done once the box
  // is idle.
  async remote(paneId, what) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    const c = box.claude;
    if (what === 'link') return c.bridge ? { ok: true, url: 'https://claude.ai/code/' + c.bridge } : { ok: false, reason: 'Remote Control is off.' };
    if (what !== 'on' && what !== 'off') return { ok: false, reason: 'Bad request.' };
    if (what === 'off') this.remoteOff.add(c.pid);
    else this.remoteOff.delete(c.pid);
    this.recordState();
    if (!!c.bridge === (what === 'on')) {
      this.remoteAsk.delete(c.pid);
      this.emitBoxes();
      return { ok: true };
    }
    this.remoteAsk.set(c.pid, { want: what, at: Date.now(), tries: 0, last: 0 });
    this.log('remote asked', { box: box.name, want: what });
    this.emitBoxes();
    this.soon('remote', 50, () => this.syncRemote());
    return { ok: true, pending: true };
  }

  // Every box has Remote Control on. Boxes the app starts get the flag; a
  // box found without it (started by hand, or by the chief) is turned on
  // once, quietly, when it is idle. One he turned off stays off while that
  // Claude runs, and so does one that had it and lost it (he disconnected
  // it in the terminal).
  syncRemote() {
    if (!this.ctl) return;
    let changed = false;
    for (const b of this.boxes) {
      const c = b.claude;
      if (!c || !c.pid || this.remoteBusy.has(c.pid)) continue;
      const on = !!c.bridge;
      if (on) this.remoteNext.set(c.pid, Infinity);
      const want = this.remoteOff.has(c.pid) ? 'off' : 'on';
      const ask = this.remoteAsk.get(c.pid);
      if (ask && (ask.want !== want || (ask.want === 'on') === on)) {
        this.remoteAsk.delete(c.pid);
        changed = true;
        continue;
      }
      if (ask && (ask.tries >= 2 || Date.now() - ask.at > 600000)) {
        this.remoteAsk.delete(c.pid);
        this.log('remote not taken', { box: b.name, want });
        this.out({ type: 'notice', text: `${b.name} did not turn Remote Control ${want}.`, bad: true });
        changed = true;
        continue;
      }
      if ((want === 'on') === on) continue;
      if (ask) {
        if (Date.now() - ask.last < 4000) continue;
      } else {
        if (want !== 'on') continue;
        // A Claude started with the flag or the setting connects by itself
        // within seconds, so it gets 30 seconds first.
        const started = Number(new Date(c.startedAt)) || 0;
        if (!this.remoteNext.has(c.pid)) this.remoteNext.set(c.pid, Math.max(Date.now(), started + 30000));
        if (Date.now() < this.remoteNext.get(c.pid)) continue;
        // The Terminal view open on this box: he may be typing there.
        if (this.term && this.term.paneId === b.paneId) continue;
      }
      if (!this.remoteIdle(b)) continue;
      this.remoteRun(b, want, ask);
    }
    for (const p of [...this.remoteOff]) if (!alive(p)) this.remoteOff.delete(p);
    for (const p of [...this.remoteAsk.keys()]) if (!alive(p)) this.remoteAsk.delete(p);
    for (const p of [...this.remoteNext.keys()]) if (!alive(p)) this.remoteNext.delete(p);
    if (changed) this.emitBoxes();
  }

  remoteIdle(b) {
    const sc = this.screens.get(b.paneId) || {};
    return (
      !this.working.has(b.paneId) && !sc.menu && !this.starting.has(b.name) && !this.resuming.has(b.name) &&
      !this.switching.has(b.paneId) && !this.touchedWithin(b.paneId, 3000)
    );
  }

  // Sends /remote-control as the app's other buttons send their commands.
  // On a session that has it, Claude asks what to do: "Disconnect this
  // session" turns it off, "Continue" leaves it on.
  async remoteRun(b, want, ask) {
    const pid = b.claude.pid;
    const paneId = b.paneId;
    this.remoteBusy.add(pid);
    let sent = false;
    try {
      const r = await this.sendText(paneId, '/remote-control', { app: true });
      sent = r.ok && !r.duplicate;
      if (!sent) return;
      // One pick only: keys that land after the dialog closed would reach
      // the prompt, where Up brings back the last command.
      const pick = want === 'off' ? /^Disconnect this session\b/ : /^Continue$/;
      let picked = false;
      for (let i = 0; i < 40; i++) {
        await sleep(400);
        const now = readSessions(this.cfg.claudeHome, this.cfg.session).get(paneId);
        const menu = parseMenu(await run(['capture-pane', '-p', '-t', paneId]).catch(() => ''));
        const opt = !picked && menu && menu.options.some((o) => /^Disconnect this session\b/.test(o.label)) && menu.options.find((o) => pick.test(o.label));
        if (opt) {
          picked = true;
          await this.choose(paneId, opt.n);
          continue;
        }
        if (now && (now.pid !== pid || (!!now.bridge === (want === 'on') && !menu))) break;
      }
    } catch (e) {
      this.log('remote failed', String((e && e.message) || e).slice(0, 120));
    } finally {
      // The next look at the box must see what the command did.
      await this.scan().catch(() => {});
      this.remoteBusy.delete(pid);
      if (ask) {
        ask.last = Date.now();
        if (sent) ask.tries++;
      }
      // By itself the app tries once per Claude; a box that had text typed
      // or a question open is tried again later.
      if (!ask) this.remoteNext.set(pid, sent ? Infinity : Date.now() + 20000);
      this.log('remote', { box: b.name, want, asked: !!ask, sent });
    }
  }

  // ---- box actions --------------------------------------------------------

  async action(paneId, kind) {
    const cmd = { compact: '/compact', clear: '/clear' }[kind];
    if (!cmd) return { ok: false, reason: 'Unknown action.' };
    return this.sendText(paneId, cmd, { app: true });
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
    if (box.claude) await this.sendText(paneId, `/rename ${name}`, { app: true });
    this.log('rename', { from: box.name, to: name });
    await this.scan();
    return { ok: true, name };
  }

  // Earlier sessions in the working folder, newest first, for New Box.
  recentSessions() {
    const dir = this.sessionDir();
    const live = liveSessionIds(this.cfg.claudeHome);
    let files = [];
    try {
      const kept = this.removed
        .filter((e) => !live.has(e.id) && this.resumable(e.id))
        .map((e) => ({ f: `${e.id}.jsonl`, t: fs.statSync(this.sessionFile(e.id)).mtimeMs, name: e.name }));
      const top = fs
        .readdirSync(dir)
        .filter((f) => UUID_RE.test(f.slice(0, -6)) && f.endsWith('.jsonl') && !live.has(f.slice(0, -6)) && !kept.some((k) => k.f === f))
        .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
        .slice(0, 10);
      files = kept.concat(top);
    } catch {
      return [];
    }
    return files
      .map(({ f, t, name }) => {
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
        title = title || name || '';
        if (!first && !title) return null;
        return { id: f.slice(0, -6), at: t, title: mask(title).slice(0, 40), first: mask(first).slice(0, 100) };
      })
      .filter(Boolean);
  }

  emitBoxes() {
    this.out({ type: 'boxes', boxes: this.publicBoxes(), restore: this.restoreInfo() });
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
      const saved = this.state.boxes.find((b) => b.name === name) || this.ended.get(name);
      boxes.push({ windowId, index: Number(index), name, paneId, claude: sessions.get(paneId) || null, ...look(name, saved) });
    }
    boxes.sort((a, b) => a.index - b.index);
    // A window that closed on its own leaves its box as ended. A rename keeps
    // the window id, and a Close from the app is expected, so neither counts.
    for (const old of this.boxes) {
      if (boxes.some((b) => b.windowId === old.windowId || b.name === old.name)) continue;
      if (this.closing.delete(old.name) || this.starting.has(old.name)) continue;
      const saved = this.state.boxes.find((s) => s.name === old.name) || {};
      this.ended.set(old.name, {
        name: old.name,
        icon: old.icon,
        color: old.color,
        paneId: old.paneId,
        sessionId: (old.claude && old.claude.sessionId) || saved.sessionId || null,
        cwd: (old.claude && old.claude.cwd) || saved.cwd || this.cfg.workdir,
        model: saved.model || this.cfg.model,
        effort: saved.effort || this.cfg.effort,
        costCarry: Number(saved.costCarry) || 0,
        at: Date.now(),
      });
      this.log('box ended', { name: old.name });
    }
    // Its window came back: the box is live again and keeps its record.
    for (const b of boxes) {
      const e = this.ended.get(b.name);
      if (!e) continue;
      this.ended.delete(b.name);
      if (!this.state.boxes.some((s) => s.name === b.name)) {
        this.state.boxes.push({ name: e.name, icon: e.icon, color: e.color, sessionId: e.sessionId, cwd: e.cwd, model: e.model, effort: e.effort, createdAt: null, costCarry: e.costCarry || 0 });
      }
    }
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
    if (this.hold) {
      if (this.boxes.length < this.state.boxes.length && Date.now() < this.hold) return;
      this.hold = 0;
    }
    this.writeWindows();
    const prev = this.state.boxes;
    const boxes = this.boxes.map((b) => {
      const old = prev.find((p) => p.name === b.name) || {};
      const live = this.meter(b);
      const carry = this.carry(b);
      const entry = {
        name: b.name,
        windowId: b.windowId,
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
    const remoteOff = this.boxes.filter((b) => b.claude && this.remoteOff.has(b.claude.pid)).map((b) => b.claude.pid);
    const next = { version: 1, session: this.cfg.session, workdir: this.cfg.workdir, created: this.created, boxes, ended: [...this.ended.values()], removed: this.removed, remoteOff };
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
    // A Claude that died shows at once, not at the next scan.
    if (this.boxes.some((b) => b.claude && !alive(b.claude.pid))) this.soon('scan', 50, () => this.scan());
    this.polling = true;
    let changed = false;
    try {
      // A question shows only while Claude runs: after it quits, its last
      // screen stays in the window, buttons and all.
      const cmds = new Map();
      const tabs = new Map();
      try {
        const out = await run(['list-panes', '-s', '-t', `=${this.cfg.session}`, '-F', '#{pane_id}\t#{pane_current_command}\t#{@claude_state}']);
        for (const line of out.split('\n')) {
          const [p, c, st] = line.split('\t');
          if (!p) continue;
          cmds.set(p, c || '');
          tabs.set(p, st || '');
        }
      } catch {
        return;
      }
      if (JSON.stringify([...tabs]) !== JSON.stringify([...this.tabs])) changed = true;
      this.tabs = tabs;
      for (const b of this.boxes) {
        if (!b.paneId) continue;
        const cmd = cmds.get(b.paneId) || '';
        const runsClaude = CLAUDE_CMD.test(cmd);
        if (!b.claude || SHELLS.test(cmd) || !cmds.has(b.paneId)) {
          if (this.working.delete(b.paneId)) changed = true;
          // Before Claude registers, it may ask whether to trust the folder.
          let menu = null;
          if (runsClaude && (this.starting.has(b.name) || this.resuming.has(b.name))) {
            try {
              menu = parseMenu(await this.ctl.command(`capture-pane -p -t ${b.paneId}`));
            } catch {}
          }
          const sc = menu ? { menu: this.maskMenu(menu) } : null;
          if (JSON.stringify(sc) !== JSON.stringify(this.screens.get(b.paneId) || null)) {
            if (sc) this.screens.set(b.paneId, sc);
            else this.screens.delete(b.paneId);
            changed = true;
          }
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
        let menu = parseMenu(text);
        // The Remote Control dialog the icon's click opens is answered by the app.
        if (menu && this.remoteBusy.has(b.claude.pid) && menu.options.some((o) => /^Disconnect this session\b/.test(o.label))) menu = null;
        // So is the review step after his last answer to a question menu.
        if (menu && menu.review && this.confirming.has(b.paneId)) menu = null;
        const sc = {
          activity: w ? mask(parseActivity(text) || '') || null : null,
          menu: menu && this.maskMenu(menu),
          mode: parseMode(text),
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
    this.syncRemote();
  }

  maskMenu(menu) {
    return {
      question: mask(menu.question),
      selected: menu.selected,
      options: menu.options.map((o) => {
        const opt = { n: o.n, label: mask(o.label) };
        if (o.current) opt.current = true;
        if (o.box) Object.assign(opt, { box: true, checked: !!o.checked });
        return opt;
      }),
      esc: !!menu.esc,
      free: menu.free || null,
      ...(menu.multi ? { multi: true, button: menu.button || null } : {}),
    };
  }

  // ---- chat --------------------------------------------------------------

  follow(slot, handlers) {
    const box = this.boxes.find((b) => b.paneId === slot.paneId);
    const back = box && !box.claude ? this.resuming.get(box.name) : null;
    let sid = box && box.claude ? box.claude.sessionId : back && back.paneId === box.paneId ? back.sessionId : null;
    let cwd = box && box.claude ? box.claude.cwd : back ? back.cwd : null;
    // A box that ended keeps showing its conversation, read from its log.
    if (!sid) {
      const saved = box ? this.state.boxes.find((s) => s.name === box.name) : [...this.ended.values()].find((e) => e.paneId === slot.paneId);
      if (saved && UUID_RE.test(saved.sessionId || '')) {
        sid = saved.sessionId;
        cwd = saved.cwd;
      }
    }
    if (slot.tr && sid === slot.sessionId) return;
    if (slot.tr) slot.tr.stop();
    slot.tr = null;
    slot.sessionId = null;
    const file = sid && transcriptPath(this.cfg.claudeHome, cwd, sid);
    if (!file) {
      if (!slot.empty) handlers.reset({ items: [], steps: 0 });
      slot.empty = true;
      return;
    }
    slot.empty = false;
    slot.sessionId = sid;
    const tr = new Transcript(file, { marks: this.marks[sid] || [], cuts: this.cuts[sid] || [] });
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

  // Every key the app sends to a box goes through here, and only to a pane
  // that runs Claude: a stale button must never type into a bare shell. A
  // burst of keys asks tmux once.
  async keys(paneId, args) {
    await this.needClaude(paneId);
    return run(['send-keys', '-t', paneId, ...args]);
  }

  // A button for a question checks first: the question may be the last
  // screen of a Claude that quit.
  async needClaude(paneId) {
    const t = this.claudeAt.get(paneId);
    if (!t || Date.now() - t > 400) {
      const cmd = (await run(['display', '-p', '-t', paneId, '#{pane_current_command}']).catch(() => '')).trim();
      if (!CLAUDE_CMD.test(cmd)) {
        this.claudeAt.delete(paneId);
        const box = this.boxes.find((b) => b.paneId === paneId);
        const name = box ? box.name : 'That box';
        this.log('keys refused', { box: box ? box.name : paneId, runs: SHELLS.test(cmd) ? 'shell' : cmd ? 'other' : 'nothing' });
        this.soon('scan', 50, () => this.scan());
        this.soon('poll', 50, () => this.pollScreens());
        throw new Refused({ ok: false, reason: SHELLS.test(cmd) || !cmd ? `${name} ended.` : `No Claude runs in ${name}.` });
      }
      this.claudeAt.set(paneId, Date.now());
    }
  }

  // Claude reads fast typing as a paste, and an Enter inside a paste becomes
  // part of the text. So the Enters wait until the text has settled.
  async enter(paneId, text, enters) {
    await sleep(Math.min(900, 250 + Math.round(text.length / 4)));
    for (let i = 0; i < enters; i++) {
      if (i) await sleep(120);
      await this.keys(paneId, ['Enter']);
    }
  }

  // Text goes in as typed keys, with Option+Enter between lines. A bracketed
  // paste would reach Claude marked as pasted text, which it treats as words
  // he may not have written.
  async deliver(paneId, text) {
    const enters = /^[/!]/.test(text) ? 1 : 2;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      let t = lines[i];
      if (t.endsWith(';')) t = t.slice(0, -1) + '\\;';
      if (t) await this.keys(paneId, ['-l', '--', t]);
      if (i < lines.length - 1) await this.keys(paneId, ['M-Enter']);
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
      await this.keys(paneId, ['Enter']);
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

  // Sends to one box one at a time, in order. The same text to the same box
  // within 3 seconds is a double click and is dropped.
  sendText(paneId, raw, opts = {}) {
    const text = String(raw || '').replace(/\r\n?/g, '\n').replace(/^\s+|\s+$/g, '');
    if (!text) return Promise.resolve({ ok: false, reason: 'Nothing to send.' });
    if (text.length > 50000) return Promise.resolve({ ok: false, reason: 'That message is too long.' });
    const last = this.lastSend.get(paneId);
    if (!opts.replace && last && last.text === text && Date.now() - last.at < 3000) {
      this.log('duplicate dropped', { pane: paneId, chars: text.length });
      return Promise.resolve({ ok: true, duplicate: true });
    }
    this.lastSend.set(paneId, { text, at: Date.now() });
    const prev = this.queues.get(paneId) || Promise.resolve();
    const next = prev.then(() => this.sendNow(paneId, text, opts)).catch((e) => {
      if (e && e.result) return e.result;
      throw e;
    });
    this.queues.set(paneId, next.catch(() => {}));
    return next.then((r) => {
      if (!r.ok) this.lastSend.delete(paneId);
      return r;
    });
  }

  async sendNow(paneId, text, opts) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    // Before Claude registers it can already be asking (the trust question).
    const asking = !!(this.screens.get(paneId) || {}).menu;
    if (!box.claude) return { ok: false, reason: asking ? 'Answer the question above first.' : `${box.name} has no Claude running.` };
    // Claude may have died since the last scan; text must never reach a shell.
    if (await this.onShell(box)) return { ok: false, reason: `${box.name} ended.` };
    let screen;
    try {
      screen = await run(['capture-pane', '-p', '-e', '-t', paneId]);
    } catch {
      return { ok: false, reason: `Could not read ${box.name}.` };
    }
    let st = promptState(screen);
    if (st === 'no-prompt') return { ok: false, reason: asking ? 'Answer the question above first.' : `${box.name} is waiting on a choice. Pick one above.` };
    if (st === 'typed') {
      // Text the app typed, or Claude put back after Esc, is cleared at once.
      // Anything else is his, so he is asked first.
      const typed = promptText(screen);
      const ours = (this.typedByApp.get(paneId) || []).some((t) => same(t) === same(typed));
      if (!ours && !opts.replace) {
        return { ok: false, ask: 'replace', typed: mask(unmark(typed).text).slice(0, 300), reason: `Something else is typed in ${box.name}'s terminal. Replace it?` };
      }
      if (!(await this.clearPrompt(paneId, typed))) return { ok: false, reason: `Could not clear what's typed in ${box.name}.` };
      this.log('cleared prompt', { box: box.name, ours });
    }
    // A /model or /effort he types is for this box only, like the header's.
    const m = /^\/(model|effort)\b/.exec(text);
    if (m && !opts.app) {
      this.keeper.guard(['model'], 120000);
      this.keeper.guard(['modelSettings'], 120000);
    }
    const queued = this.working.has(paneId);
    this.touch(paneId);
    // The app's own commands (/model, /rename ...) go bare; all else is marked.
    const out = opts.app ? text : markText(text);
    if (text.startsWith('!')) await this.deliverChecked(paneId, out);
    else await this.deliver(paneId, out);
    const mine = (this.typedByApp.get(paneId) || []).concat(out).slice(-20);
    this.typedByApp.set(paneId, mine);
    this.log('sent', { box: box.name, chars: text.length, slash: text.startsWith('/'), queued, app: !!opts.app });
    return { ok: true, queued };
  }

  // Ctrl+U takes one line at a time and never stops the box. Ctrl+C clears
  // all at once but arms "press again to exit", so it is the last resort, and
  // only on an idle box.
  async clearPrompt(paneId, typed) {
    const lines = Math.min(200, String(typed).split('\n').length + 2);
    for (let round = 0; round < 3; round++) {
      await this.keys(paneId, ['C-e']);
      for (let k = 0; k < lines; k++) await this.keys(paneId, ['C-u']);
      await sleep(300);
      try {
        if (promptState(await run(['capture-pane', '-p', '-e', '-t', paneId])) !== 'typed') return true;
      } catch {
        return false;
      }
    }
    if (this.working.has(paneId)) return false;
    await this.keys(paneId, ['C-c']);
    await sleep(400);
    try {
      return promptState(await run(['capture-pane', '-p', '-e', '-t', paneId])) !== 'typed';
    } catch {
      return false;
    }
  }

  async sendChief(text, replace) {
    const box = this.boxes.find((b) => b.name === 'chief');
    if (!box) return { ok: false, reason: 'There is no chief window.' };
    return this.sendText(box.paneId, text, { replace: !!replace });
  }

  // Esc stops a box that is working. An idle box gets nothing, since a
  // second Esc there opens Claude's rewind menu.
  async interrupt(paneId) {
    if (!this.panes.has(paneId) || !this.working.has(paneId)) return { ok: false };
    // A second Esc right after the first would reach Claude as Esc twice,
    // which opens its rewind menu; one stop is enough.
    const stopped = this.stoppedAt.get(paneId);
    if (stopped && Date.now() - stopped < 2000) return { ok: false, again: true };
    this.stoppedAt.set(paneId, Date.now());
    await this.keys(paneId, ['Escape']);
    this.touch(paneId);
    this.log('interrupt', { pane: paneId });
    const box = this.boxes.find((b) => b.paneId === paneId);
    const sid = box && box.claude && box.claude.sessionId;
    if (sid) {
      const ts = new Date().toISOString();
      this.marks[sid] = (this.marks[sid] || []).concat(ts).slice(-50);
      this.saveEdits();
      const w = this.watch;
      if (w && w.paneId === paneId && w.tr && w.sessionId === sid) w.tr.markNow(ts);
    }
    return { ok: true };
  }

  // One answer to a box's menu at a time: a second click waits for the first,
  // then finds the screen the first one left.
  onMenu(paneId, fn) {
    const next = (this.menuOps.get(paneId) || Promise.resolve()).then(fn);
    this.menuOps.set(paneId, next.catch(() => {}));
    return next;
  }

  // The question a click was made on. A click that lands after Claude moved
  // on to the next question (a fast second click) must not answer that one.
  askOf(menu) {
    return `${mask(menu.question || '')}|${menu.options.length}`;
  }

  moved(menu, ask) {
    return typeof ask === 'string' && ask !== '' && this.askOf(menu) !== ask;
  }

  // He chose in the app, so Claude's "Review your answers" step after the
  // last question is submitted for him. The next question or the prompt
  // showing instead ends the wait.
  async confirmReview(paneId, before) {
    this.confirming.add(paneId);
    try {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        await sleep(200);
        let s;
        try {
          s = await run(['capture-pane', '-p', '-t', paneId]);
        } catch {
          return false;
        }
        const menu = parseMenu(s);
        if (!menu) {
          if (/(?:⏵⏵|⏸) .+ on\b/.test(s) && /❯/.test(s)) return false;
          continue;
        }
        if (!menu.review) {
          if (this.askOf(menu) === before) continue;
          return false;
        }
        const send = menu.options.find((o) => SEND_ALL.test(o.label));
        if (!send) return false;
        await this.keys(paneId, [...moves(menu, send.n), 'Enter']);
        this.log('review submitted', { pane: paneId });
        return true;
      }
      this.log('review not seen', { pane: paneId });
      return false;
    } finally {
      this.confirming.delete(paneId);
    }
  }

  // Picks option n in the menu the pane shows, by moving to it and pressing Enter.
  choose(paneId, n, ask) {
    return this.onMenu(paneId, () => this.chooseNow(paneId, n, ask));
  }

  async chooseNow(paneId, n, ask) {
    if (!this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    await this.needClaude(paneId);
    const menu = parseMenu(await run(['capture-pane', '-p', '-t', paneId]));
    if (!menu || !menu.options.some((o) => o.n === n)) return { ok: false, reason: 'That choice is no longer on screen.' };
    if (this.moved(menu, ask)) return { ok: false, stale: true, reason: 'The question had moved on.' };
    if (/model|effort/i.test(menu.question + ' ' + menu.options.map((o) => o.label).join(' '))) {
      this.keeper.guard(['model'], 30000);
      this.keeper.guard(['modelSettings'], 30000);
    }
    const keys = moves(menu, n);
    this.touch(paneId);
    // In the model menu, "s" applies the pick to this session only, so his
    // default stays as it was (the guard above still watches it).
    await this.keys(paneId, [...keys, menu.sessionKey ? 's' : 'Enter']);
    this.log('choose', { pane: paneId, n, session: !!menu.sessionKey });
    const rw = this.rewinding.get(paneId);
    if (rw && Date.now() - rw.at < 120000) this.afterRewind(paneId, rw, (menu.options.find((o) => o.n === n) || {}).label || '');
    if (menu.reviewNext) await this.confirmReview(paneId, this.askOf(menu));
    this.soon('poll', 400, () => this.pollScreens());
    return { ok: true };
  }

  // Leaves the menu the pane shows, as Esc does in the terminal.
  dismiss(paneId) {
    return this.onMenu(paneId, () => this.dismissNow(paneId));
  }

  async dismissNow(paneId) {
    if (!this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    await this.needClaude(paneId);
    const menu = parseMenu(await run(['capture-pane', '-p', '-t', paneId]));
    if (!menu) return { ok: true, gone: true };
    if (!menu.esc) return { ok: false, reason: 'Pick an option above.' };
    this.touch(paneId);
    await this.keys(paneId, ['Escape']);
    this.log('dismiss', { pane: paneId });
    this.soon('poll', 300, () => this.pollScreens());
    return { ok: true };
  }

  // His own words as the answer, where the menu offers "Type something.":
  // move to that option, type, and press Enter.
  answer(paneId, text, ask) {
    return this.onMenu(paneId, () => this.answerNow(paneId, text, ask));
  }

  async answerNow(paneId, text, ask) {
    if (!this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    await this.needClaude(paneId);
    const menu = parseMenu(await run(['capture-pane', '-p', '-t', paneId]));
    if (!menu || !menu.free) return { ok: false, reason: 'Pick an option above.' };
    if (this.moved(menu, ask)) return { ok: false, reason: 'The question changed. Send again to answer this one.' };
    const one = String(text).replace(/\s+/g, ' ').trim();
    if (!one) return { ok: false };
    // With check boxes, Enter would only tick it: his words go with the picks.
    if (menu.multi) return this.submitNow(paneId, menu.options.filter((o) => o.box && o.checked && o.n !== menu.free).map((o) => o.n), one);
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || (await this.onShell(box))) return { ok: false, reason: 'That box ended.' };
    const d = moves(menu, menu.free);
    this.touch(paneId);
    if (d.length) await this.keys(paneId, d);
    await sleep(150);
    await this.keys(paneId, ['-l', '--', one]);
    await sleep(150);
    await this.keys(paneId, ['Enter']);
    this.log('answer', { pane: paneId, chars: one.length });
    if (menu.reviewNext) await this.confirmReview(paneId, this.askOf(menu));
    this.soon('poll', 400, () => this.pollScreens());
    return { ok: true };
  }

  // A question that allows several picks, driven as the terminal does: each
  // check box that should change gets Enter, his own words go in the last
  // one, and once the screen shows exactly his picks, Enter on Submit (or
  // Next) sends them. The review step after it is submitted too.
  submitMenu(paneId, picks, text, ask) {
    return this.onMenu(paneId, () => this.submitNow(paneId, picks, text, ask));
  }

  async submitNow(paneId, picks, text, ask) {
    if (!this.panes.has(paneId)) return { ok: false, reason: 'That box is gone.' };
    await this.needClaude(paneId);
    const read = async () => parseMenu(await run(['capture-pane', '-p', '-t', paneId]));
    let menu = await read();
    if (!menu || !menu.multi || !menu.order.includes(0)) return { ok: false, reason: 'That question is no longer on screen.' };
    if (this.moved(menu, ask)) return { ok: false, stale: true, reason: 'The question had moved on.' };
    const want = new Set(picks);
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || (await this.onShell(box))) return { ok: false, reason: 'That box ended.' };
    this.touch(paneId);
    let at = menu.at;
    const go = async (key, extra) => {
      const to = menu.order.indexOf(key);
      const d = to - at;
      at = to;
      await this.keys(paneId, [...Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'), ...extra]);
      await sleep(120);
    };
    for (const o of menu.options) {
      if (!o.box || o.n === menu.free) continue;
      if (!!o.checked !== want.has(o.n)) await go(o.n, ['Enter']);
    }
    if (one && menu.free) {
      await go(menu.free, []);
      await this.keys(paneId, ['-l', '--', one]);
      await sleep(200);
    }
    await sleep(250);
    const now = await read();
    const right =
      now &&
      now.multi &&
      now.options.every((o) => !o.box || o.n === now.free || !!o.checked === want.has(o.n)) &&
      (!one || (now.options.find((o) => o.n === now.free) || {}).checked);
    if (!right) {
      this.log('submit menu', { pane: paneId, ok: false });
      return { ok: false, reason: 'Your picks did not all take. Check them in Terminal.' };
    }
    menu = now;
    at = now.at;
    await go(0, ['Enter']);
    this.log('submit menu', { pane: paneId, picks: want.size, words: !!one });
    if (now.reviewNext) await this.confirmReview(paneId, this.askOf(now));
    this.soon('poll', 400, () => this.pollScreens());
    return { ok: true };
  }

  // ---- starting boxes ----------------------------------------------------

  claudeCmd(resume, model, effort) {
    const m = FLAG_RE.test(model || '') ? model : this.cfg.model;
    const e = FLAG_RE.test(effort || '') ? effort : this.cfg.effort;
    const dirs = this.cfg.pluginDirs.map((d) => ` --plugin-dir '${d.replace(/'/g, "'\\''")}'`).join('');
    // Remote Control is on for every box the app starts or brings back.
    let cmd = `claude${dirs} --dangerously-skip-permissions --remote-control --model ${m} --effort ${e}`;
    if (resume && UUID_RE.test(resume)) cmd += ` --resume ${resume}`;
    return cmd;
  }

  // Ready when Claude's prompt shows. A folder trust question is his to
  // answer, so it ends the wait instead of being answered here.
  // Waits for the prompt. The trust question shows as buttons in the chat
  // and is never answered for him; it gets up to ten more minutes.
  // seen.asked: a question showed before the prompt was ready.
  async waitReady(paneId, ms, seen = {}) {
    let end = Date.now() + ms;
    let asked = false;
    while (Date.now() < end) {
      await sleep(700);
      let s;
      try {
        s = await run(['capture-pane', '-p', '-t', paneId]);
      } catch {
        return false;
      }
      // A question counts only while Claude runs. Once one showed, a shell
      // means Claude quit ("No, exit"), though its question still shows.
      const cmd = (await run(['display', '-p', '-t', paneId, '#{pane_current_command}']).catch(() => '')).trim();
      if ((asked || seen.asked) && SHELLS.test(cmd)) return 'exited';
      const menu = CLAUDE_CMD.test(cmd) ? parseMenu(s) : null;
      // Each question, the trust one or any after it, waits for his answer
      // (up to ten minutes); it shows as buttons in the chat.
      if (menu) {
        seen.asked = true;
        end = Math.max(end, Date.now() + 600000);
        if (!asked) {
          asked = true;
          this.log('asks', { pane: paneId, trust: TRUST.test(s) });
          this.soon('poll', 100, () => this.pollScreens());
        }
        continue;
      }
      if (/(?:⏵⏵|⏸) .+ on\b/.test(s) && /❯/.test(s) && !menu) return true;
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
    // A session has one row. Resuming one that has a row uses that row: a
    // live one is only shown, an ended one starts again in it.
    if (resume) {
      const row = this.rowForSession(resume);
      if (row && row.live) {
        this.log('resume uses its row', { name: row.name, live: true });
        return { ok: true, name: row.name, existing: true, ...(message ? { unsent: message } : {}) };
      }
      if (row) {
        this.log('resume uses its row', { name: row.name, live: false });
        return { ...(await this.resumeWith(row.name, message)), name: row.name, existing: true };
      }
      if (liveSessionIds(this.cfg.claudeHome).has(resume)) return { ok: false, reason: 'Already running in a window outside chiefman.' };
    }
    if (!NAME_RE.test(name)) return { ok: false, reason: 'Use lowercase letters, digits and dashes for the name.' };
    // Another conversation with this name gets "<name>-2".
    let final = name;
    if (resume) for (let i = 2; this.nameTaken(final); i++) final = `${name.slice(0, 28)}-${i}`;
    else if (this.nameTaken(name)) return { ok: false, reason: `A box named ${name} already exists.` };
    if (!this.ctl) return { ok: false, reason: 'chiefman is not connected to tmux yet.' };
    this.starting.add(final);
    this.endWhy.delete(final);
    try {
      const r = await this.startBox(final, icon, color, message, model, effort, resume);
      return { ...r, name: final, ...(final !== name ? { renamed: name } : {}) };
    } finally {
      this.starting.delete(final);
      this.emitBoxes();
    }
  }

  nameTaken(name) {
    return this.starting.has(name) || this.boxes.some((b) => b.name === name) || this.ended.has(name);
  }

  // The row that holds a session, if any: live (running, or starting) or ended.
  rowForSession(id) {
    const sidOf = (b) => (b.claude && b.claude.sessionId) || (this.state.boxes.find((s) => s.name === b.name) || {}).sessionId;
    const rows = this.boxes.filter((b) => sidOf(b) === id);
    const live = rows.find((b) => !this.endedInfo(b));
    if (live) return { name: live.name, live: true };
    if (rows.length) return { name: rows[0].name, live: false };
    const gone = [...this.ended.values()].find((e) => e.sessionId === id && !this.boxes.some((b) => b.name === e.name));
    return gone ? { name: gone.name, live: false } : null;
  }

  async startBox(name, icon, color, message, model, effort, resume) {
    if (resume) this.removed = this.removed.filter((e) => e.id !== resume);
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
    const seen = {};
    const ready = await this.waitReady(paneId, 90000, seen);
    const keep = message ? { unsent: message } : {};
    if (ready === 'exited') {
      this.endWhy.set(name, NOT_TRUSTED);
      return { ok: false, ended: true, reason: NOT_TRUSTED, paneId, ...keep };
    }
    if (!ready) return { ok: false, reason: `${name} did not start in time. Open Terminal to see why.`, paneId, ...keep };
    await this.promptEmpty(paneId, 5000);
    await this.deliverChecked(paneId, `/rename ${name}`).catch(() => false);
    const first = await this.sendFirst(paneId, name, message, seen.asked);
    this.log('box started', { name });
    await this.scan();
    return { ok: true, paneId, ...first };
  }

  // His first message goes in once the prompt is ready, and must be seen
  // sent. A question before it was answered so Claude goes on ("Yes"), so
  // it goes then too. When it does not go through, it goes back to the app
  // as the box's draft: never lost.
  async sendFirst(paneId, name, message, asked) {
    if (!message) return {};
    await sleep(600);
    if (!(await this.promptEmpty(paneId, 8000))) {
      this.log('first message kept', { name, why: 'prompt not empty' });
      return { unsent: message };
    }
    const out = markText(message);
    this.typedByApp.set(paneId, [out]);
    const went = await this.deliverChecked(paneId, out).catch((e) => {
      if (e && e.result) return 'refused';
      throw e;
    });
    if (went === 'refused') {
      this.log('first message kept', { name, why: 'ended' });
      return { unsent: message };
    }
    if (!went) {
      // Taken back out of the terminal, so it is in one place only.
      await this.clearPrompt(paneId, out).catch(() => false);
      this.log('first message kept', { name, why: 'stuck' });
      return { unsent: message, reason: `${name} did not take its first message. It is in the field.` };
    }
    this.log(asked ? 'sent after yes' : 'first message sent', { name });
    return { sent: true };
  }

  // ---- bringing boxes back ------------------------------------------------

  // Opens a window per saved box and starts its Claude. Nothing waits on
  // them: each box is followed on its own and usable as soon as it is back.
  async openRestore(list) {
    const started = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      started.push({ b, ...(await this.newWindow(b.name, i === 0, b.cwd)) });
    }
    await sleep(900);
    for (const s of started) {
      const cmd = this.claudeCmd(s.b.sessionId, s.b.model, s.b.effort);
      await run(['send-keys', '-t', s.paneId, '-l', '--', cmd]);
      await run(['send-keys', '-t', s.paneId, 'Enter']);
      this.resuming.set(s.b.name, { paneId: s.paneId, cmd, cwd: s.b.cwd || this.cfg.workdir, sessionId: s.b.sessionId, state: 'resuming' });
    }
    this.restoreRun = { names: started.map((s) => s.b.name), label: 'Bringing your boxes back' };
  }

  async openFresh() {
    const { paneId } = await this.newWindow('chief', true);
    await sleep(900);
    const cmd = this.claudeCmd(null);
    await run(['send-keys', '-t', paneId, '-l', '--', cmd]);
    await run(['send-keys', '-t', paneId, 'Enter']);
    this.resuming.set('chief', {
      paneId,
      cmd,
      cwd: this.cfg.workdir,
      sessionId: null,
      state: 'resuming',
      after: (p) => this.deliver(p, '/rename chief'),
    });
    this.restoreRun = { names: ['chief'], label: 'Starting your chief' };
  }

  // Follows one box as it starts. A question it asks shows as buttons in its
  // chat and stops the clock; without one, 90 seconds is the limit.
  async followStart(name) {
    const r = this.resuming.get(name);
    if (!r || r.following) return;
    r.following = true;
    const t0 = Date.now();
    let end = t0 + START_LIMIT;
    while (this.resuming.get(name) === r && !this.quitting) {
      await sleep(800);
      let s;
      try {
        s = await run(['capture-pane', '-p', '-t', r.paneId]);
      } catch {
        r.state = 'failed';
        r.why = 'gone';
        break;
      }
      // A question counts only while Claude runs: after "No, exit" it still
      // shows in the window over a bare shell.
      const cmd = (await run(['display', '-p', '-t', r.paneId, '#{pane_current_command}']).catch(() => '')).trim();
      if (SHELLS.test(cmd) && (r.asking || Date.now() - t0 > 5000)) {
        r.state = 'failed';
        r.why = 'exited';
        break;
      }
      if (CLAUDE_CMD.test(cmd) && parseMenu(s)) {
        if (!r.asking) {
          this.log('start asks', { name });
          this.soon('poll', 100, () => this.pollScreens());
        }
        r.asking = true;
        r.trust = TRUST.test(s);
        end = Date.now() + START_LIMIT;
        continue;
      }
      r.asking = false;
      if (READY(s)) {
        r.state = 'resumed';
        break;
      }
      if (Date.now() > end) {
        r.state = 'failed';
        r.why = 'timeout';
        break;
      }
    }
    if (this.resuming.get(name) !== r) return;
    r.following = false;
    this.log('restored', { name, ok: r.state === 'resumed', why: r.why || null });
    if (r.state === 'resumed') {
      this.resumedAt.set(name, Date.now());
      this.resuming.delete(name);
      if (r.after) await r.after(r.paneId).catch(() => {});
      setTimeout(() => this.emitBoxes(), 6500);
    }
    // Claude quit (he said "No, exit", or it stopped): the box has ended, with
    // Resume, like any box whose Claude quit.
    if (r.why === 'exited') {
      this.resuming.delete(name);
      if (r.trust) this.endWhy.set(name, NOT_TRUSTED);
    }
    await this.scan().catch(() => {});
    this.emitBoxes();
  }

  // A box that did not start gets a fresh shell in its window and its
  // Claude command again.
  async retryStart(paneId) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    const r = box && this.resuming.get(box.name);
    if (!r || r.state !== 'failed') return { ok: false, reason: 'Nothing to retry.' };
    const dir = r.cwd && fs.existsSync(r.cwd) ? r.cwd : this.cfg.workdir;
    await run(['respawn-pane', '-k', '-t', paneId, '-c', dir]);
    await sleep(900);
    await run(['send-keys', '-t', paneId, '-l', '--', r.cmd]);
    await run(['send-keys', '-t', paneId, 'Enter']);
    this.resuming.set(box.name, { paneId, cmd: r.cmd, cwd: r.cwd, sessionId: r.sessionId, state: 'resuming', after: r.after });
    this.log('retry start', { name: box.name });
    this.emitBoxes();
    this.followStart(box.name);
    return { ok: true };
  }

  // ---- boxes that ended ------------------------------------------------------

  // Starts an ended box again on its own session: in a new window with the
  // same name when its window closed, or in its window when only Claude exited.
  // Resume, or Resume and send: his message goes in once the prompt is
  // ready, as New Box's first message does, or waits in the field.
  async resumeWith(name, message) {
    const r = await this.startAgain(name);
    const keep = message ? { unsent: message } : {};
    if (!r.ok || !message) return { ...r, ...keep };
    const seen = {};
    const ready = await this.waitReady(r.paneId, START_LIMIT, seen);
    if (ready !== true) return { ...r, ...keep };
    return { ...r, ...(await this.sendFirst(r.paneId, name, message, seen.asked)) };
  }

  async startAgain(name) {
    const e = this.ended.get(name);
    const box = this.boxes.find((b) => b.name === name);
    const saved = e || this.state.boxes.find((s) => s.name === name);
    if (!saved || !UUID_RE.test(saved.sessionId || '')) return { ok: false, reason: `Couldn't resume:${name} has no conversation to resume.` };
    if ((this.resuming.get(name) || {}).state === 'resuming') return { ok: false, reason: `Already resuming ${name}.` };
    if (liveSessionIds(this.cfg.claudeHome).has(saved.sessionId)) {
      const row = this.rowForSession(saved.sessionId);
      return { ok: false, reason: row && row.live ? `Already running as ${row.name}.` : 'Already running in a window outside chiefman.' };
    }
    if (!this.hasConversation(saved.sessionId, saved.cwd)) return { ok: false, reason: `Couldn't resume:${name} never got a message, so there is nothing to resume.` };
    if (!this.ctl) return { ok: false, reason: "Couldn't resume:chiefman is not connected to tmux yet." };
    const cmd = this.claudeCmd(saved.sessionId, saved.model, saved.effort);
    const cwd = saved.cwd && fs.existsSync(saved.cwd) ? saved.cwd : this.cfg.workdir;
    let paneId;
    if (box) {
      if (!this.endedInfo(box)) return { ok: false, reason: `Already running as ${name}.` };
      const now = (await run(['display', '-p', '-t', box.paneId, '#{pane_current_command}']).catch(() => '')).trim();
      if (!SHELLS.test(now)) return { ok: false, reason: `Couldn't resume:something else runs in ${name}'s window.` };
    } else if (!e) return { ok: false, reason: `Couldn't resume:${name} is gone.` };
    try {
      if (box) {
        await run(['respawn-pane', '-k', '-t', box.paneId, '-c', cwd]);
        paneId = box.paneId;
      } else {
        // The saved record keeps its name, icon and colour for the new window.
        this.state.boxes = this.state.boxes.filter((b) => b.name !== name).concat({
          name, icon: e.icon, color: e.color, sessionId: e.sessionId, cwd, model: e.model, effort: e.effort,
          createdAt: null, costCarry: e.costCarry || 0,
        });
        this.store.save(this.state);
        ({ paneId } = await this.newWindow(name, false, cwd));
      }
      this.resuming.set(name, { paneId, cmd, cwd, sessionId: saved.sessionId, state: 'resuming' });
      await this.scan();
      await sleep(900);
      await run(['send-keys', '-t', paneId, '-l', '--', cmd]);
      await run(['send-keys', '-t', paneId, 'Enter']);
    } catch (err) {
      this.resuming.delete(name);
      return { ok: false, reason: `Couldn't resume:${String((err && err.message) || err).slice(0, 120)}` };
    }
    this.log('start again', { name });
    this.endWhy.delete(name);
    this.followStart(name);
    return { ok: true, paneId };
  }

  // True when the box's pane runs a bare shell: its Claude is gone.
  async onShell(box) {
    const now = (await run(['display', '-p', '-t', box.paneId, '#{pane_current_command}']).catch(() => '')).trim();
    if (!SHELLS.test(now)) return false;
    this.soon('scan', 50, () => this.scan());
    return true;
  }

  // Drops an ended box. A window left on a bare shell is closed with it.
  async closeEnded(name) {
    const box = this.boxes.find((b) => b.name === name);
    if (box) {
      if (!this.endedInfo(box)) return { ok: false, reason: `${name} is not ended.` };
      const now = (await run(['display', '-p', '-t', box.paneId, '#{pane_current_command}']).catch(() => '')).trim();
      if (!SHELLS.test(now)) return { ok: false, reason: `Something else runs in ${name}'s window.` };
      this.closing.add(name);
      await run(['kill-window', '-t', box.windowId]);
    }
    const sid = (this.ended.get(name) || this.state.boxes.find((b) => b.name === name) || {}).sessionId;
    const kept = this.resumable(sid);
    if (kept) this.removed = [{ id: sid, name, at: Date.now() }, ...this.removed.filter((e) => e.id !== sid)].slice(0, 6);
    this.ended.delete(name);
    this.state.boxes = this.state.boxes.filter((b) => b.name !== name);
    this.log('closed ended', { name });
    this.endWhy.delete(name);
    await this.scan();
    this.recordState();
    this.emitBoxes();
    // The app keeps his typed text with the session, for a resume from New Box.
    return kept ? { ok: true, session: sid } : { ok: true };
  }

  // ---- what the app did lately, per box -------------------------------------

  touch(paneId) {
    this.touched.set(paneId, Date.now());
  }

  // True when the app acted on this box within `ms`: a question that follows
  // is one he just caused.
  touchedWithin(paneId, ms) {
    const t = this.touched.get(paneId);
    return !!t && Date.now() - t < ms;
  }

  saveEdits() {
    try {
      fs.writeFileSync(this.editsFile, JSON.stringify({ cuts: this.cuts, marks: this.marks }), { mode: 0o600 });
    } catch {}
  }

  // ---- editing an earlier message --------------------------------------------

  // Opens Claude's own rewind menu and moves to the message he picked,
  // reading each highlighted line, so nothing is picked blind. Claude's next
  // question then shows as buttons in the chat.
  async rewind(paneId, spec) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box || !box.claude) return { ok: false, reason: 'No Claude runs there.' };
    if (this.working.has(paneId)) return { ok: false, reason: `${box.name} is working. Stop it first.` };
    const text = String((spec && spec.text) || '');
    const dupAfter = Math.max(0, Number(spec && spec.dupAfter) || 0);
    if (!text) return { ok: false, reason: 'Pick a message.' };
    let screen = await run(['capture-pane', '-p', '-e', '-t', paneId]);
    const st = promptState(screen);
    if (st === 'no-prompt') return { ok: false, reason: `${box.name} is waiting on a choice. Answer it first.` };
    if (st === 'typed') return { ok: false, reason: `Something is typed in ${box.name}. Send or clear it first.` };
    this.touch(paneId);
    await this.keys(paneId, ['Escape']);
    await sleep(150);
    await this.keys(paneId, ['Escape']);
    let open = false;
    for (let i = 0; i < 10 && !open; i++) {
      await sleep(200);
      screen = await run(['capture-pane', '-p', '-t', paneId]);
      open = /^\s*Rewind\s*$/m.test(screen) && /\(current\)/.test(screen);
    }
    if (!open) return { ok: false, reason: `${box.name} did not open its rewind menu.` };
    // The menu shows the message as it was typed: with the app's mark, when
    // the app sent it.
    const wants = [same(text), same(markText(text))];
    let seen = 0;
    let prev = null;
    for (let step = 0; step < 150; step++) {
      await this.keys(paneId, ['Up']);
      await sleep(120);
      screen = await run(['capture-pane', '-p', '-t', paneId]);
      const sel = screen.split('\n').filter((l) => /❯/.test(l)).pop() || '';
      const line = sel.replace(/^\s*❯\s*/, '').trim();
      const head = same(line.replace(/…$/, ''));
      if (head && wants.some((want) => want.startsWith(head) && head.length >= Math.min(want.length, 12))) {
        if (seen === dupAfter) {
          await this.keys(paneId, ['Enter']);
          this.rewinding.set(paneId, { text, from: this.tsOf(paneId, spec && spec.id), sid: box.claude.sessionId, at: Date.now() });
          this.log('rewind', { box: box.name, steps: step + 1 });
          this.soon('poll', 300, () => this.pollScreens());
          return { ok: true };
        }
        seen++;
      }
      // At the top the list stops moving, or wraps round to "(current)".
      if (step > 0 && (screen === prev || /\(current\)/.test(line))) break;
      prev = screen;
    }
    await this.keys(paneId, ['Escape']);
    return { ok: false, reason: `Could not find that message in ${box.name}'s rewind menu.` };
  }

  // When his picked message was logged.
  tsOf(paneId, id) {
    const w = this.watch;
    if (!w || w.paneId !== paneId || !w.tr) return null;
    const it = w.tr.items.find((i) => i.id === id);
    return (it && it.ts) || null;
  }

  // After his answer to Claude's rewind question: a restored conversation
  // hides his message and all logged after it until now, and his message goes
  // back in the field.
  async afterRewind(paneId, rw, label) {
    this.rewinding.delete(paneId);
    const restore = /restore/i.test(label) && /conversation/i.test(label);
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      let screen;
      try {
        screen = await run(['capture-pane', '-p', '-e', '-t', paneId]);
      } catch {
        return;
      }
      if (parseMenu(screen)) continue;
      const back = promptText(screen);
      if (promptState(screen) === 'typed' && same(unmark(back).text) === same(rw.text)) {
        this.typedByApp.set(paneId, (this.typedByApp.get(paneId) || []).concat(back).slice(-20));
        if (restore && rw.sid && rw.from) {
          const range = [rw.from, new Date().toISOString()];
          this.cuts[rw.sid] = (this.cuts[rw.sid] || []).concat([range]).slice(-200);
          this.saveEdits();
          const w = this.watch;
          const c = this.chief;
          if (c && c.tr && c.sessionId === rw.sid) {
            c.tr.cut(range);
            this.setDrill(newestDrill(c.tr.items));
          }
          if (w && w.paneId === paneId && w.tr) {
            w.tr.cut(range);
            this.out({ type: 'chat-reset', paneId, items: w.tr.items, steps: w.tr.steps });
          }
        }
        this.out({ type: 'draft', paneId, text: rw.text });
        this.log('rewound', { pane: paneId, restore });
        return;
      }
      if (i > 4) return;
    }
  }

  // ---- files for @ -----------------------------------------------------------

  // Files in the box's folder: what git tracks or would, else a short walk.
  // At most 30 matches come back.
  async files(paneId, query) {
    const box = this.boxes.find((b) => b.paneId === paneId);
    if (!box) return [];
    const saved = this.state.boxes.find((x) => x.name === box.name) || {};
    const cwd = (box.claude && box.claude.cwd) || saved.cwd || this.cfg.workdir;
    let entry = this.fileCache.get(cwd);
    if (!entry || Date.now() - entry.at > 30000) {
      entry = { at: Date.now(), list: await listFiles(cwd) };
      this.fileCache.set(cwd, entry);
    }
    const q = String(query || '').toLowerCase();
    if (!q) return entry.list.slice(0, 30);
    const scored = [];
    for (const f of entry.list) {
      const l = f.toLowerCase();
      const base = l.slice(l.lastIndexOf('/') + 1);
      let score = -1;
      if (base.startsWith(q)) score = 0;
      else if (base.includes(q)) score = 1;
      else if (l.includes(q)) score = 2;
      else if (subsequence(q, l)) score = 3;
      if (score >= 0) scored.push([score, f.length, f]);
      if (scored.length > 4000) break;
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return scored.slice(0, 30).map((x) => x[2]);
  }
}

// The arrow keys that move a menu's ❯ to option n.
function moves(menu, n) {
  const d = menu.order.indexOf(n) - menu.at;
  return Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up');
}

function subsequence(q, s) {
  let i = 0;
  for (const c of s) if (c === q[i] && ++i === q.length) return true;
  return false;
}

function listFiles(cwd) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'ls-files', '-co', '--exclude-standard'], { timeout: 4000, maxBuffer: 32 * 1024 * 1024 }, (e, out) => {
      if (!e && out) return resolve(String(out).split('\n').filter(Boolean).slice(0, 20000));
      const list = [];
      const walk = (dir, rel, depth) => {
        if (depth > 6 || list.length >= 5000) return;
        let ents = [];
        try {
          ents = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const d of ents) {
          if (list.length >= 5000) return;
          if (d.name.startsWith('.') || d.name === 'node_modules') continue;
          const r = rel ? `${rel}/${d.name}` : d.name;
          if (d.isDirectory()) walk(path.join(dir, d.name), r, depth + 1);
          else if (d.isFile()) list.push(r);
        }
      };
      walk(cwd, '', 0);
      resolve(list);
    });
  });
}

module.exports = { Hub };

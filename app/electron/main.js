const { app, BrowserWindow, ipcMain, shell, session, clipboard, Notification, protocol, screen } = require('electron');
const fs = require('fs');
const path = require('path');

process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');

const cfg = require('./config');
const { Hub } = require('./hub');
const { mask } = require('./mask');
const { makeLog } = require('./log');
const { ensureReplyHook, removeReplyHook } = require('./replyhook');

const log = makeLog(cfg.stateDir);

let win = null;
let hub = null;

// A test run with its own state folder gets its own profile, so it neither
// collides with the running app nor shares its storage.
if (process.env.CHIEFMAN_STATE_DIR) app.setPath('userData', path.join(cfg.stateDir, 'profile'));
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});

const PANE = /^%\d+$/;
const appUrl = () => cfg.devUrl || 'file://';
const ATTACH_DIR = path.join(cfg.stateDir, 'attachments');
const DRAFTS_FILE = path.join(cfg.stateDir, 'drafts.json');
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

// Pictures he attached are shown from cm-att://f/<name>, and only from the
// attachments folder: a name that resolves anywhere else is refused.
protocol.registerSchemesAsPrivileged([{ scheme: 'cm-att', privileges: { standard: true, secure: true } }]);

function serveAttachment(req) {
  let name;
  try {
    name = decodeURIComponent(new URL(req.url).pathname.replace(/^\/+/, ''));
  } catch {
    return new Response(null, { status: 400 });
  }
  const type = IMAGE_TYPES[path.extname(name).toLowerCase()];
  if (!name || name.includes('/') || name.startsWith('.') || !type) return new Response(null, { status: 404 });
  let dir, real;
  try {
    dir = fs.realpathSync(ATTACH_DIR);
    real = fs.realpathSync(path.join(ATTACH_DIR, name));
  } catch {
    return new Response(null, { status: 404 });
  }
  if (path.dirname(real) !== dir || !fs.statSync(real).isFile()) return new Response(null, { status: 403 });
  return new Response(fs.readFileSync(real), { headers: { 'content-type': type, 'cache-control': 'no-store' } });
}

// Unsent text per box, kept on disk so a restart or a forced quit keeps it.
let drafts = null;
function readDrafts() {
  if (drafts) return drafts;
  try {
    const d = JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8'));
    drafts = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    drafts = {};
  }
  return drafts;
}
// Widget answers and quote replies waiting for Send, in the order he made them.
function cleanBundle(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, e] of Object.entries(input).slice(0, 60)) {
    if (key.length > 200 || !e || typeof e.text !== 'string' || e.text.length > 20000) continue;
    const x = { text: e.text };
    if (Number.isInteger(e.n)) x.n = e.n;
    if (Array.isArray(e.picks)) x.picks = e.picks.filter((p) => typeof p === 'string').slice(0, 20).map((p) => p.slice(0, 500));
    if (typeof e.words === 'string') x.words = e.words.slice(0, 20000);
    if (typeof e.quote === 'string') x.quote = e.quote.slice(0, 20000);
    out[key] = x;
  }
  return out;
}
function cleanDrafts(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [name, d] of Object.entries(input).slice(0, 200)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name) || !d || typeof d.text !== 'string' || d.text.length > 200000) continue;
    const atts = Array.isArray(d.atts)
      ? d.atts
          .filter((a) => a && typeof a.path === 'string' && path.dirname(a.path) === ATTACH_DIR && typeof a.name === 'string')
          .slice(0, 20)
          .map((a) => ({ path: a.path, name: a.name.slice(0, 120), image: !!a.image }))
      : [];
    const bundle = cleanBundle(d.bundle);
    const held = Object.keys(bundle).length > 0;
    if (!d.text && !atts.length && !held) continue;
    out[name] = { text: d.text, caret: Number.isInteger(d.caret) ? d.caret : d.text.length, atts, ...(held ? { bundle } : {}) };
  }
  return out;
}
function writeDrafts() {
  try {
    fs.mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
    const tmp = DRAFTS_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(drafts || {}), { mode: 0o600 });
    fs.renameSync(tmp, DRAFTS_FILE);
  } catch (e) {
    log('drafts not saved', String((e && e.message) || e));
  }
}

function send(ev) {
  if (ev && ev.type === 'boxes') notice(ev.boxes);
  if (win && !win.isDestroyed()) win.webContents.send('cm:event', ev);
}

// A box that finishes a job or waits on a choice, while its chat is not in
// front, gets a notification and counts on the Dock badge.
const lastSeen = new Map();
const unseen = new Set();
function notice(boxes) {
  for (const b of boxes) {
    if (!b.paneId) continue;
    const prev = lastSeen.get(b.paneId);
    const now = { status: b.status, menu: !!b.menu };
    lastSeen.set(b.paneId, now);
    if (!prev) continue;
    const done = prev.status === 'working' && b.status === 'idle';
    const asks = !prev.menu && now.menu;
    if (!done && !asks) continue;
    const front = win && win.isFocused() && hub && hub.watch && hub.watch.paneId === b.paneId;
    // A question right after a click of his in the app is one he caused.
    const caused = asks && hub && hub.touchedWithin(b.paneId, 15000) && win && win.isVisible() && !win.isMinimized();
    if (front || caused) continue;
    unseen.add(b.paneId);
    if (app.dock) app.dock.setBadge(String(unseen.size));
    log('notify', { box: b.name, why: asks ? 'asks' : 'done', badge: unseen.size });
    if (Notification.isSupported()) {
      const n = new Notification({ title: b.name, body: asks ? 'Waiting on your choice' : 'Done', silent: false });
      n.on('click', () => {
        if (!win) return;
        win.show();
        win.focus();
        send({ type: 'select', paneId: b.paneId });
      });
      n.on('show', () => log('notify shown', { box: b.name }));
      n.on('failed', (_e, error) => log('notify failed', { box: b.name, error: String(error) }));
      n.show();
    }
  }
}
function seen(paneId) {
  if (!unseen.delete(paneId) && unseen.size) return;
  if (app.dock) app.dock.setBadge(unseen.size ? String(unseen.size) : '');
}

// Only the app's own page may call in.
function fromApp(e) {
  const url = (e.senderFrame && e.senderFrame.url) || '';
  return !!win && e.sender === win.webContents && url.startsWith(appUrl());
}

function handle(ch, fn) {
  ipcMain.handle(ch, async (e, ...a) => {
    if (!fromApp(e)) throw new Error('blocked');
    return fn(...a);
  });
}

function on(ch, fn) {
  ipcMain.on(ch, (e, ...a) => {
    if (fromApp(e)) fn(...a);
  });
}

// A button's request: it does its job or says why not in one line, and every
// click is logged with its result.
function act(ch, fn) {
  handle(ch, async (...a) => {
    let r;
    try {
      r = await fn(...a);
    } catch (e) {
      // A refused key brings its own result ("<box> ended.").
      r = e && e.result ? e.result : { ok: false, reason: `Couldn't do that: ${String((e && e.message) || e).slice(0, 120)}` };
    }
    if (!r || typeof r !== 'object') r = { ok: false };
    if (r.ok === false && !r.reason) r = { ...r, reason: "Couldn't do that." };
    log('click', { what: ch.slice(3), ok: r.ok !== false, ...(r.reason ? { why: r.reason } : {}) });
    return r;
  });
}

function wireIpc() {
  handle('cm:init', () => hub.snapshot());
  on('cm:watch', (p) => {
    if (!PANE.test(p)) return;
    hub.watchPane(p);
    seen(p);
    // Its question is checked again the moment he switches to it.
    hub.soon('poll', 30, () => hub.pollScreens());
  });
  on('cm:term', (p) => hub.openTerm(PANE.test(p) ? p : null));
  on('cm:term-input', (p, d) => PANE.test(p) && typeof d === 'string' && hub.termInput(p, d));
  handle('cm:send', (p, t, replace) =>
    PANE.test(p) && typeof t === 'string' ? hub.sendText(p, t, { replace: replace === true }) : { ok: false, reason: 'Bad request.' },
  );
  handle('cm:chief-send', (t, replace) => (typeof t === 'string' ? hub.sendChief(t, replace === true) : { ok: false, reason: 'Bad request.' }));
  act('cm:mode', (p) => (PANE.test(p) ? hub.cycleMode(p) : { ok: false, reason: 'Bad request.' }));
  handle('cm:mask', (t) => (typeof t === 'string' ? mask(t) : ''));
  act('cm:new-box', (spec) => hub.newBox(spec && typeof spec === 'object' ? spec : {}));
  act('cm:interrupt', (p) => (PANE.test(p) ? hub.interrupt(p) : { ok: false }));
  // ask: the question the click was made on (see Hub.askOf).
  const isAsk = (a) => a == null || (typeof a === 'string' && a.length <= 5000);
  act('cm:choose', (p, n, a) => (PANE.test(p) && Number.isInteger(n) && isAsk(a) ? hub.choose(p, n, a) : { ok: false, reason: 'Bad request.' }));
  act('cm:dismiss', (p) => (PANE.test(p) ? hub.dismiss(p) : { ok: false, reason: 'Bad request.' }));
  act('cm:answer', (p, t, a) => (PANE.test(p) && typeof t === 'string' && t.length <= 5000 && isAsk(a) ? hub.answer(p, t, a) : { ok: false, reason: 'Bad request.' }));
  act('cm:submit-menu', (p, picks, t, a) =>
    PANE.test(p) && Array.isArray(picks) && picks.length <= 20 && picks.every((n) => Number.isInteger(n)) && (t == null || (typeof t === 'string' && t.length <= 5000)) && isAsk(a)
      ? hub.submitMenu(p, picks, t || '', a)
      : { ok: false, reason: 'Bad request.' },
  );
  act('cm:action', (p, kind) => (PANE.test(p) && typeof kind === 'string' ? hub.action(p, kind) : { ok: false, reason: 'Bad request.' }));
  act('cm:rename', (p, name) => (PANE.test(p) && typeof name === 'string' ? hub.rename(p, name) : { ok: false, reason: 'Bad request.' }));
  handle('cm:recent', () => hub.recentSessions());
  act('cm:switch', (p, kind, v) =>
    PANE.test(p) && (kind === 'model' || kind === 'effort') && typeof v === 'string' ? hub.switchBox(p, kind, v) : { ok: false, reason: 'Bad request.' },
  );
  act('cm:retry', (p) => (PANE.test(p) ? hub.retryStart(p) : { ok: false, reason: 'Bad request.' }));
  const BOX_NAME = /^[A-Za-z0-9._-]{1,64}$/;
  act('cm:start-again', (n, m) =>
    typeof n === 'string' && BOX_NAME.test(n) && (m == null || (typeof m === 'string' && m.length <= 20000))
      ? hub.resumeWith(n, m ? m.trim() : '')
      : { ok: false, reason: 'Bad request.' },
  );
  act('cm:close-ended', (n) => (typeof n === 'string' && BOX_NAME.test(n) ? hub.closeEnded(n) : { ok: false, reason: 'Bad request.' }));
  act('cm:close-box', (p) => (PANE.test(p) ? hub.closeBox(p) : { ok: false, reason: 'Bad request.' }));
  act('cm:rewind', (p, spec) =>
    PANE.test(p) && spec && typeof spec.text === 'string' && spec.text.length < 100000
      ? hub.rewind(p, { text: spec.text, id: typeof spec.id === 'string' ? spec.id : '', dupAfter: Number(spec.dupAfter) || 0 })
      : { ok: false, reason: 'Bad request.' },
  );
  handle('cm:files', (p, q) => (PANE.test(p) && typeof q === 'string' && q.length < 200 ? hub.files(p, q) : []));
  handle('cm:steps', (p, ids) =>
    PANE.test(p) && Array.isArray(ids) && ids.length <= 50 && ids.every((i) => typeof i === 'string' && i.length < 200) ? hub.stepDetail(p, ids) : [],
  );
  act('cm:remote', (p, what) => (PANE.test(p) && ['on', 'off', 'link'].includes(what) ? hub.remote(p, what) : { ok: false, reason: 'Bad request.' }));
  on('cm:copy', (t) => {
    if (typeof t === 'string' && /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/.test(t)) clipboard.writeText(t);
  });
  // A dropped or pasted file is kept in the state folder; Claude reads it by path.
  handle('cm:attach', (name, data) => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array || data instanceof ArrayBuffer)) return { ok: false, reason: 'Bad file.' };
    const bytes = Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    if (bytes.length > 25 * 1024 * 1024) return { ok: false, reason: 'Files up to 25 MB.' };
    const dir = path.join(cfg.stateDir, 'attachments');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const safe = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+/, '').slice(-80) || 'file';
    const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}`);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    log('attached', { bytes: bytes.length });
    return { ok: true, path: file };
  });
  handle('cm:drafts', () => readDrafts());
  on('cm:drafts-save', (d) => {
    drafts = cleanDrafts(d);
    writeDrafts();
  });
  on('cm:open-url', (u) => {
    if (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)) shell.openExternal(u);
  });
}

// The window opens where he left it, at its size, while that place is still
// on a screen.
const PLACE_FILE = path.join(cfg.stateDir, 'window.json');
function lastPlace() {
  try {
    const p = JSON.parse(fs.readFileSync(PLACE_FILE, 'utf8'));
    const ok = ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(p[k]));
    if (!ok || p.width < 960 || p.height < 600) return null;
    const seen = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return p.x < a.x + a.width - 80 && p.x + p.width > a.x + 80 && p.y >= a.y - 40 && p.y < a.y + a.height - 80;
    });
    return seen ? { x: p.x, y: p.y, width: p.width, height: p.height, maximized: !!p.maximized } : null;
  } catch {
    return null;
  }
}
let placeTimer = null;
function keepPlace() {
  if (!win || win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
  try {
    fs.writeFileSync(PLACE_FILE, JSON.stringify({ ...win.getNormalBounds(), maximized: win.isMaximized() }), { mode: 0o600 });
  } catch {}
}

function createWindow() {
  const place = lastPlace();
  win = new BrowserWindow({
    width: place ? place.width : 1280,
    height: place ? place.height : 800,
    ...(place ? { x: place.x, y: place.y } : {}),
    minWidth: 960,
    minHeight: 600,
    title: 'chiefman',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 22, y: 22 },
    backgroundColor: '#FFFFFF',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(appUrl())) e.preventDefault();
  });
  const soonKeep = () => {
    clearTimeout(placeTimer);
    placeTimer = setTimeout(keepPlace, 500);
  };
  win.on('resize', soonKeep);
  win.on('move', soonKeep);
  win.on('close', keepPlace);
  win.once('ready-to-show', () => {
    if (place && place.maximized) win.maximize();
    if (cfg.devHook) win.showInactive();
    else win.show();
    // The window number lets `screencapture -l` take a picture of it.
    try {
      const id = win.getMediaSourceId().split(':')[1];
      fs.writeFileSync(path.join(cfg.stateDir, 'window-id'), id + '\n');
    } catch {}
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') log('page', e.level, String(e.message).slice(0, 300));
  });
  win.on('focus', () => hub && hub.watch && seen(hub.watch.paneId));
  win.webContents.on('render-process-gone', (_e, d) => log('renderer gone', d && d.reason));
  win.on('closed', () => (win = null));
  if (cfg.devUrl) {
    win.loadURL(cfg.devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

// A folder of command files lets a script take a screenshot of the window
// without opening any port. Running page scripts needs CHIEFMAN_DEV_HOOK.
function hook() {
  const dir = cfg.devHook || path.join(cfg.stateDir, 'hook');
  const allowJs = !!cfg.devHook;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let busy = false;
  setInterval(async () => {
    if (busy || !win) return;
    busy = true;
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('cmd-') && x.endsWith('.json'))) {
        const p = path.join(dir, f);
        let cmd;
        try {
          cmd = JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {
          continue;
        }
        fs.unlinkSync(p);
        let res;
        try {
          if (cmd.shot) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(path.resolve(dir, cmd.shot), img.toPNG());
            res = { ok: true, size: img.getSize() };
          } else if (cmd.size && allowJs) {
            win.setSize(Number(cmd.size[0]) || 1280, Number(cmd.size[1]) || 800);
            res = { ok: true, size: win.getSize() };
          } else if (cmd.js && allowJs) res = { value: await win.webContents.executeJavaScript(cmd.js, true) };
          else res = { error: 'only shot is allowed without CHIEFMAN_DEV_HOOK' };
        } catch (e) {
          res = { error: String((e && e.message) || e) };
        }
        fs.writeFileSync(path.join(dir, 'res-' + f.slice(4)), JSON.stringify(res));
      }
    } catch {
    } finally {
      busy = false;
    }
  }, 250);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  protocol.handle('cm-att', serveAttachment);
  log('start', { session: cfg.session, stateDir: cfg.stateDir, dev: !!cfg.devUrl, version: app.getVersion() });
  if (cfg.replyHook) ensureReplyHook(cfg.claudeHome, log);
  else removeReplyHook(cfg.claudeHome, log);
  hub = new Hub(cfg, send, log);
  wireIpc();
  createWindow();
  hub.boot();
  hook();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  log('quit');
  if (drafts) writeDrafts();
  if (hub) hub.shutdown();
});
process.on('SIGTERM', () => app.quit());
process.on('uncaughtException', (e) => log('uncaught', String((e && e.stack) || e).slice(0, 800)));

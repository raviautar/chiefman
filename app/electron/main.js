const { app, BrowserWindow, ipcMain, shell, session, clipboard, Notification } = require('electron');
const fs = require('fs');
const path = require('path');

process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':');

const cfg = require('./config');
const { Hub } = require('./hub');
const { makeLog } = require('./log');

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
    if (front) continue;
    unseen.add(b.paneId);
    if (app.dock) app.dock.setBadge(String(unseen.size));
    if (Notification.isSupported()) {
      const n = new Notification({ title: b.name, body: asks ? 'Waiting on your choice' : 'Done', silent: false });
      n.on('click', () => {
        if (!win) return;
        win.show();
        win.focus();
        send({ type: 'select', paneId: b.paneId });
      });
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

function wireIpc() {
  handle('cm:init', () => hub.snapshot());
  on('cm:watch', (p) => {
    if (!PANE.test(p)) return;
    hub.watchPane(p);
    seen(p);
  });
  on('cm:term', (p) => hub.openTerm(PANE.test(p) ? p : null));
  on('cm:term-input', (p, d) => PANE.test(p) && typeof d === 'string' && hub.termInput(p, d));
  handle('cm:send', (p, t) => (PANE.test(p) && typeof t === 'string' ? hub.sendText(p, t) : { ok: false, reason: 'Bad request.' }));
  handle('cm:chief-send', (t) => (typeof t === 'string' ? hub.sendChief(t) : { ok: false, reason: 'Bad request.' }));
  handle('cm:new-box', async (spec) => {
    try {
      return await hub.newBox(spec && typeof spec === 'object' ? spec : {});
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) };
    }
  });
  handle('cm:interrupt', (p) => (PANE.test(p) ? hub.interrupt(p) : { ok: false }));
  handle('cm:choose', (p, n) => (PANE.test(p) && Number.isInteger(n) ? hub.choose(p, n) : { ok: false, reason: 'Bad request.' }));
  handle('cm:action', (p, kind) => (PANE.test(p) && typeof kind === 'string' ? hub.action(p, kind) : { ok: false, reason: 'Bad request.' }));
  handle('cm:rename', (p, name) => (PANE.test(p) && typeof name === 'string' ? hub.rename(p, name) : { ok: false, reason: 'Bad request.' }));
  handle('cm:recent', () => hub.recentSessions());
  handle('cm:switch', (p, kind, v) =>
    PANE.test(p) && (kind === 'model' || kind === 'effort') && typeof v === 'string' ? hub.switchBox(p, kind, v) : { ok: false, reason: 'Bad request.' },
  );
  handle('cm:remote', (p) => (PANE.test(p) ? hub.remote(p) : { ok: false, reason: 'Bad request.' }));
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
  on('cm:open-url', (u) => {
    if (typeof u === 'string' && /^https:\/\/[^\s]+$/.test(u)) shell.openExternal(u);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    title: 'chiefman',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 22 },
    backgroundColor: '#F5F4F0',
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
  win.once('ready-to-show', () => {
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
  log('start', { session: cfg.session, stateDir: cfg.stateDir, dev: !!cfg.devUrl, version: app.getVersion() });
  hub = new Hub(cfg, send, log);
  wireIpc();
  createWindow();
  hub.boot();
  hook();
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  log('quit');
  if (hub) hub.shutdown();
});
process.on('uncaughtException', (e) => log('uncaught', String((e && e.stack) || e).slice(0, 800)));

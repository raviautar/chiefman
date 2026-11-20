const fs = require('fs');
const path = require('path');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Maps a tmux pane id ("%12") to the Claude session running in it.
function readSessions(claudeHome, tmuxSession) {
  const dir = path.join(claudeHome, 'sessions');
  const byPane = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return byPane;
  }
  for (const f of files) {
    let d;
    try {
      d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      continue;
    }
    if (!d || typeof d.tmux !== 'string' || !d.sessionId) continue;
    const m = /^(.*):@(\d+)\.(%\d+)$/.exec(d.tmux);
    if (!m || m[1] !== tmuxSession) continue;
    if (!alive(d.pid)) continue;
    const prev = byPane.get(m[3]);
    if (prev && (prev.updatedAt || 0) > (d.updatedAt || 0)) continue;
    byPane.set(m[3], {
      pid: d.pid,
      sessionId: d.sessionId,
      cwd: d.cwd,
      name: d.name,
      status: d.status,
      updatedAt: d.updatedAt,
      startedAt: d.startedAt || null,
      bridge: typeof d.bridgeSessionId === 'string' && /^session_[A-Za-z0-9]{8,64}$/.test(d.bridgeSessionId) ? d.bridgeSessionId : null,
      windowId: '@' + m[2],
    });
  }
  return byPane;
}

// Session ids that a live Claude process runs right now, in any tmux session.
function liveSessionIds(claudeHome) {
  const dir = path.join(claudeHome, 'sessions');
  const ids = new Set();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f));
  } catch {
    return ids;
  }
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d && d.sessionId && alive(d.pid)) ids.add(d.sessionId);
    } catch {}
  }
  return ids;
}

function transcriptPath(claudeHome, cwd, sessionId) {
  const projects = path.join(claudeHome, 'projects');
  if (cwd) {
    const p = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(projects)) {
      const p = path.join(projects, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

module.exports = { readSessions, liveSessionIds, transcriptPath };

const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// The plan's usage limits, read only from files a tmux status bar or Claude
// Code's status line already keep on disk; nothing is fetched here.
// usage/api.json: a copy of the usage endpoint, used while under 15 minutes
// old. usage/limits.json: the session and week limits Claude Code hands its
// status line. Each limit: its label, percent used, and when it resets (ms).
function readPlan(claudeHome) {
  const dir = path.join(claudeHome, 'usage');
  return fromApi(readJson(path.join(dir, 'api.json'))) || fromStatusLine(readJson(path.join(dir, 'limits.json')));
}

function fromApi(d) {
  if (!d || !Array.isArray(d.limits) || !(Date.now() / 1000 - Number(d.fetched) <= 900)) return null;
  const at = (s) => (typeof s === 'string' ? Date.parse(s.replace(/(\.\d{3})\d+/, '$1')) || null : null);
  const week = d.limits.find((l) => l && l.kind === 'weekly_all');
  const out = [];
  for (const l of d.limits) {
    if (!l || l.percent == null || !isFinite(Number(l.percent))) continue;
    let label;
    let resets = at(l.resets_at);
    if (l.kind === 'session') label = 'session';
    else if (l.kind === 'weekly_all') label = 'week';
    else {
      const model = l.scope && l.scope.model && l.scope.model.display_name;
      if (typeof model !== 'string' || !model) continue;
      label = model.toLowerCase().slice(0, 20);
      // A model limit that resets with the week would only repeat its countdown.
      if (week && typeof l.resets_at === 'string' && typeof week.resets_at === 'string' && l.resets_at.slice(0, 16) === week.resets_at.slice(0, 16)) resets = null;
    }
    out.push({ label, pct: Number(l.percent), resets });
  }
  return out.length ? out : null;
}

function fromStatusLine(d) {
  if (!d) return null;
  const out = [];
  for (const [key, label] of [['five_hour', 'session'], ['seven_day', 'week']]) {
    const w = d[key];
    if (!w || !isFinite(Number(w.used_percentage)) || !isFinite(Number(w.resets_at))) continue;
    const resets = Number(w.resets_at) * 1000;
    out.push({ label, pct: resets <= Date.now() ? 0 : Number(w.used_percentage), resets });
  }
  return out.length ? out : null;
}

// The machine's workspace name and colour, where a tmux config file in
// Claude's folder sets them (set -g @workspace "<name>" and
// set -g @workspace_colour "#rrggbb").
function readWorkspace(claudeHome) {
  let text;
  try {
    text = fs.readFileSync(path.join(claudeHome, 'workspace.conf'), 'utf8');
  } catch {
    return null;
  }
  const opt = (name) => {
    const m = new RegExp(`^\\s*set(?:-option)?(?:\\s+-[A-Za-z]+)*\\s+${name}\\s+(?:"([^"]*)"|'([^']*)'|(\\S+))`, 'm').exec(text);
    return m ? (m[1] ?? m[2] ?? m[3] ?? '').trim() : '';
  };
  const name = opt('@workspace').slice(0, 24);
  if (!name) return null;
  const colour = opt('@workspace_colour');
  return { name, colour: /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : '#a9b1d6' };
}

module.exports = { readPlan, readWorkspace };

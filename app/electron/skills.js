const fs = require('fs');
const path = require('path');

// The skills that have buttons under the message box. A button sends the bare
// name, as he would type it; Claude Code runs whichever installed copy it finds.
const BUTTONS = ['plain-english', 'explain', 'drill-down'];

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// A skill folder's name: the "name:" in its SKILL.md, or the folder's own.
function skillName(dir) {
  let head;
  try {
    head = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8').slice(0, 2000);
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
  const m = fm && /^name:\s*["']?([\w:.-]+)/m.exec(fm[1]);
  return m ? m[1] : path.basename(dir);
}

// One skill folder, or a folder of them.
function addSkills(dir, names) {
  const one = skillName(dir);
  if (one) return void names.add(one);
  for (const d of list(dir)) {
    const n = skillName(path.join(dir, d));
    if (n) names.add(n);
  }
}

function addCommands(dir, names) {
  for (const f of list(dir)) if (f.endsWith('.md')) names.add(f.slice(0, -3));
}

// A plugin's skills/ and commands/ folders, and any others its plugin.json names.
function addPlugin(root, names) {
  const meta = readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {};
  const paths = (v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((p) => typeof p === 'string') : []);
  for (const p of ['skills', ...paths(meta.skills)]) addSkills(path.resolve(root, p), names);
  for (const p of ['commands', ...paths(meta.commands)]) {
    const f = path.resolve(root, p);
    if (f.endsWith('.md')) names.add(path.basename(f, '.md'));
    else addCommands(f, names);
  }
}

// The folders of the plugins these settings files turn on, where Claude Code
// installed them.
function enabledPlugins(claudeHome, settingsFiles) {
  const installed = (readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')) || {}).plugins || {};
  const dirs = [];
  for (const f of settingsFiles) {
    const on = (readJson(f) || {}).enabledPlugins || {};
    for (const [key, yes] of Object.entries(on)) {
      if (yes !== true) continue;
      for (const e of Array.isArray(installed[key]) ? installed[key] : []) if (e && typeof e.installPath === 'string') dirs.push(e.installPath);
    }
  }
  return dirs;
}

// The plugin folders on a Claude command line (--plugin-dir). The app's own
// folders are found by their full path, spaces and all.
function pluginDirsIn(args, known = []) {
  const a = String(args || '');
  const dirs = [...a.matchAll(/--plugin-dir[ =](\S+)/g)].map((m) => m[1]);
  for (const d of known) if (a.includes(d) && !dirs.includes(d)) dirs.push(d);
  return dirs;
}

// The button skills a box can run: the user's own skills and commands, its
// project's, the plugins turned on, and the plugin folders it started with.
function buttonSkills(claudeHome, cwd, pluginDirs) {
  const names = new Set();
  addSkills(path.join(claudeHome, 'skills'), names);
  addCommands(path.join(claudeHome, 'commands'), names);
  const settings = [path.join(claudeHome, 'settings.json')];
  if (cwd) {
    addSkills(path.join(cwd, '.claude', 'skills'), names);
    addCommands(path.join(cwd, '.claude', 'commands'), names);
    settings.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  }
  for (const d of [...enabledPlugins(claudeHome, settings), ...pluginDirs]) addPlugin(d, names);
  return BUTTONS.filter((n) => names.has(n));
}

module.exports = { buttonSkills, pluginDirsIn };

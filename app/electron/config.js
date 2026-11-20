const fs = require('fs');
const os = require('os');
const path = require('path');

const home = os.homedir();
const expand = (p) => (typeof p === 'string' ? p.replace(/^~(?=$|\/)/, home) : p);
const stateDir = expand(process.env.CHIEFMAN_STATE_DIR || '~/.chiefman');

// Settings live in <stateDir>/config.json, outside the code:
// { "workdir", "pluginDirs": [...], "tmuxSession", "model", "effort" }.
// Environment variables override it, for test runs.
function readConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    return d && typeof d === 'object' ? d : {};
  } catch {
    return {};
  }
}

// The plugin shipped with the app: the folder that holds this app folder,
// when it is a Claude Code plugin. A packaged app has none.
function shippedPlugin() {
  const root = path.resolve(__dirname, '..', '..');
  return fs.existsSync(path.join(root, '.claude-plugin')) ? [root] : [];
}

const file = readConfig();
const envDirs = process.env.CHIEFMAN_PLUGIN_DIRS ? process.env.CHIEFMAN_PLUGIN_DIRS.split(':') : null;
const dirs = (envDirs || (Array.isArray(file.pluginDirs) ? file.pluginDirs : shippedPlugin()))
  .map(expand)
  .filter((d) => typeof d === 'string' && d && fs.existsSync(d));

module.exports = {
  session: process.env.CHIEFMAN_TMUX_SESSION || file.tmuxSession || 'chief',
  workdir: expand(process.env.CHIEFMAN_WORKDIR || file.workdir || '~'),
  stateDir,
  model: process.env.CHIEFMAN_MODEL || file.model || 'claude-opus-5-5',
  effort: process.env.CHIEFMAN_EFFORT || file.effort || 'xhigh',
  pluginDirs: dirs,
  claudeHome: path.join(home, '.claude'),
  devUrl: process.env.CHIEFMAN_DEV_URL || '',
  devHook: process.env.CHIEFMAN_DEV_HOOK || '',
  home,
};

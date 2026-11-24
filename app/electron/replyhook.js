const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MARK, RULES, SHORT, RULES_VERSION } = require('./mark');
const { rawValue, withValue } = require('./defaults');

// One UserPromptSubmit hook in the user's Claude settings, for every box,
// also those the app did not start. It prints chiefman's rules only for a
// message that carries the mark, so the terminal is untouched. It is
// chiefman's alone: its own script file, and one entry that names it.
// "replyHook": false in config.json takes both away again.
//
// Every copy of the app shares that one file, test copies and older builds
// too: it keeps its "rules sent" folder in the user's own ~/.chiefman, and a
// copy rewrites it only when its rules are newer than the file's version line.
const SCRIPT = 'chiefman-reply.sh';
const VERSION_LINE = /^# chiefman rules version (\d+)$/m;

// The rules version a hook file holds; 0 for one written before versions.
function versionOf(text) {
  const m = VERSION_LINE.exec(text || '');
  return m ? Number(m[1]) : 0;
}

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// The full rules go to a session once, and again after each compact or a
// change of the rules: a file per session in seenDir holds the rules'
// version and how many compacts its log had then. Every other marked
// message gets the one short line.
function scriptText(seenDir) {
  const version = crypto.createHash('sha1').update(RULES + SHORT).digest('hex').slice(0, 10);
  return [
    '#!/bin/sh',
    `# chiefman rules version ${RULES_VERSION}`,
    '# Added by the chiefman app. For a message sent from chiefman (it carries the',
    '# mark below), it prints how chiefman shows replies: in full the first time in',
    '# a session and after a compact, else one line. Any other message: nothing.',
    '# To take it away, set "replyHook": false in ~/.chiefman/config.json.',
    'input=$(cat)',
    'case "$input" in',
    `  *"${MARK}"*) ;;`,
    '  *) exit 0 ;;',
    'esac',
    String.raw`field() { printf '%s\n' "$input" | sed -n "s/.*\"$1\" *: *\"\([^\"]*\)\".*/\1/p" | head -n 1; }`,
    "sid=$(field session_id | tr -cd 'A-Za-z0-9-')",
    'log=$(field transcript_path)',
    `seen=${quote(seenDir)}`,
    `now=${quote(version)}`,
    `if [ -f "$log" ]; then now="$now $(grep -c '"subtype":"compact_boundary"' "$log")"; fi`,
    'if [ -n "$sid" ] && [ "$(cat "$seen/$sid" 2>/dev/null)" = "$now" ]; then',
    "  cat <<'CHIEFMAN_SHORT'",
    SHORT,
    'CHIEFMAN_SHORT',
    '  exit 0',
    'fi',
    `if [ -n "$sid" ]; then mkdir -p "$seen" && printf '%s' "$now" > "$seen/$sid"; fi`,
    "cat <<'CHIEFMAN_RULES'",
    RULES,
    'CHIEFMAN_RULES',
    '',
  ].join('\n');
}

function entryFor(file) {
  return { hooks: [{ type: 'command', command: `sh ${quote(file)} 2>/dev/null; true`, timeout: 5 }] };
}

const ours = (e) => !!e && Array.isArray(e.hooks) && e.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(SCRIPT));

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? '' : null;
  }
}

// Writes the settings file with only UserPromptSubmit changed, checked
// before it is written, so the rest keeps every byte Claude wrote.
function writeList(settings, list, log) {
  let real = settings;
  try {
    real = fs.realpathSync(settings);
  } catch {}
  const text = readText(real);
  if (text === null) return log('reply hook', { done: false, why: 'settings unreadable' });
  let before = {};
  if (text.trim()) {
    try {
      before = JSON.parse(text);
    } catch {
      return log('reply hook', { done: false, why: 'settings not JSON' });
    }
  }
  // An empty list takes the key away.
  const raw = list.length ? JSON.stringify(list, null, 2).replace(/\n/g, '\n    ') : null;
  let next;
  if (!text.trim()) next = JSON.stringify({ hooks: { UserPromptSubmit: list } }, null, 2) + '\n';
  else if (rawValue(text, ['hooks']) === null) next = raw === null ? text : withValue(text, ['hooks'], JSON.stringify({ UserPromptSubmit: list }, null, 2).replace(/\n/g, '\n  '));
  else next = withValue(text, ['hooks', 'UserPromptSubmit'], raw);
  let after;
  try {
    after = JSON.parse(next);
  } catch {
    return log('reply hook', { done: false, why: 'edit not JSON' });
  }
  const strip = (o) => {
    const c = JSON.parse(JSON.stringify(o || {}));
    if (c.hooks && typeof c.hooks === 'object') {
      delete c.hooks.UserPromptSubmit;
      if (!Object.keys(c.hooks).length) delete c.hooks;
    }
    return JSON.stringify(c);
  };
  if (strip(after) !== strip(before) || JSON.stringify((after.hooks || {}).UserPromptSubmit || []) !== JSON.stringify(list)) {
    return log('reply hook', { done: false, why: 'edit check failed' });
  }
  let mode = 0o600;
  try {
    mode = fs.statSync(real).mode & 0o777;
  } catch {}
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.chiefman-${process.pid}`);
  fs.writeFileSync(tmp, next, { mode });
  fs.renameSync(tmp, real);
  return true;
}

function currentList(settings) {
  const text = readText(settings);
  if (text === null) return null;
  if (!text.trim()) return [];
  try {
    const list = ((JSON.parse(text) || {}).hooks || {}).UserPromptSubmit;
    return Array.isArray(list) ? list : [];
  } catch {
    return null;
  }
}

function ensureReplyHook(claudeHome, seenDir, log) {
  const file = path.join(claudeHome, 'hooks', SCRIPT);
  const settings = path.join(claudeHome, 'settings.json');
  try {
    const body = scriptText(seenDir);
    const was = readText(file);
    const theirs = versionOf(was);
    if (was !== body && (!was || theirs < RULES_VERSION)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = path.join(path.dirname(file), `.${SCRIPT}.chiefman-${process.pid}`);
      fs.writeFileSync(tmp, body, { mode: 0o755 });
      fs.renameSync(tmp, file);
      log('reply hook script written', { version: RULES_VERSION, was: theirs });
    } else if (was !== body) log('reply hook script kept', { version: theirs, ours: RULES_VERSION });
    const list = currentList(settings);
    if (list === null) return log('reply hook', { done: false, why: 'settings unreadable' });
    const entry = entryFor(file);
    const mine = list.filter(ours);
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) return;
    const next = list.filter((e) => !ours(e)).concat(entry);
    if (writeList(settings, next, log) === true) log('reply hook added', { settings });
  } catch (e) {
    log('reply hook', { done: false, why: String((e && e.message) || e).slice(0, 160) });
  }
}

function removeReplyHook(claudeHome, log) {
  const file = path.join(claudeHome, 'hooks', SCRIPT);
  const settings = path.join(claudeHome, 'settings.json');
  try {
    const list = currentList(settings);
    if (list && list.some(ours) && writeList(settings, list.filter((e) => !ours(e)), log) === true) log('reply hook removed');
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    log('reply hook', { removed: false, why: String((e && e.message) || e).slice(0, 160) });
  }
}

module.exports = { ensureReplyHook, removeReplyHook };

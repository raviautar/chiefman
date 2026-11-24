const path = require('path');
const { mask } = require('./mask');

// What each tool call in a turn was, in plain words, and what a turn did that
// matters: files changed, writes to other systems, git, failures. The rest
// are steps that only read.

const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Tools whose failure is the box's own business: a missed read, a retried
// edit. They are listed with the other steps, not counted as failed.
const QUIET_FAILS = new Set(['Read', 'Glob', 'Grep', 'LS', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'ToolSearch', 'TaskStop', 'TaskOutput', 'AskUserQuestion', 'ExitPlanMode']);
// A tool of another system writes when the first verb in its name does:
// "jira_link_to_epic" writes, "slack_read_list" reads.
const WRITE_VERBS = new Set('create add update edit set send post reply forward publish draft delete remove trash untrash archive move transition assign merge close comment upload link label unlabel mark schedule notify submit approve restore duplicate apply insert patch put write rename spawn ask react'.split(' '));
const READ_VERBS = new Set('get list search read fetch query find view download check investigate compare describe lookup wait guide export resolve authenticate complete'.split(' '));
const SENDS = new Set(['send', 'post', 'reply', 'forward', 'notify', 'ask']);
// Browser tools click and type in a page; they are steps, not writes.
const BROWSER = /chrome|playwright|browser|computer/i;
const PRODUCTS = { jira: 'Jira', confluence: 'Confluence', slack: 'Slack', notion: 'Notion', gmail: 'Gmail', github: 'GitHub', linear: 'Linear', calendar: 'Calendar', drive: 'Drive' };
const NOT_VERBS = new Set([...Object.keys(PRODUCTS), 'mcp', 'claude', 'ai', 'plugin']);

// How a tool of another system writes: draft, sent or change; null when it
// only reads.
function writeOf(tool) {
  const words = tool.toLowerCase().split(/[_-]+/).filter((w) => w && !NOT_VERBS.has(w));
  let verb = words.length === 1 && words[0] === 'batch' ? 'batch' : null;
  for (const w of words) {
    if (verb || READ_VERBS.has(w)) break;
    if (WRITE_VERBS.has(w)) verb = w;
  }
  if (!verb) return null;
  return /draft/i.test(tool) ? 'draft' : SENDS.has(verb) ? 'sent' : 'change';
}
const HINT_KEYS = ['issue_key', 'title', 'summary', 'subject', 'name'];
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const LINK = /https?:\/\/[^\s"'<>`)\]]+/;
const GH = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const base = (p) => path.basename(String(p || ''));

function mcpParts(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m) return null;
  const [, server, tool] = m;
  const words = tool.split(/[_-]+/).filter(Boolean);
  const first = (words[0] || '').toLowerCase();
  let service = PRODUCTS[first];
  if (service) words.shift();
  else {
    const s = server.replace(/^claude_ai_/, '').replace(/^plugin_[^_]+_/, '').replace(/^mcp[-_]/, '');
    service = cap(s.split(/[_-]+/).filter(Boolean).join(' ')) || server;
    // "notion-update-page" under the Notion server reads "update page".
    if (first && service.toLowerCase().startsWith(first)) words.shift();
  }
  return { server, tool, service, words: words.join(' ').toLowerCase() };
}

// The plain words of one tool call, as an instruction ("Run the tests"),
// and its kind: file (a change to a file), outside (a write to another
// system) or step. Git is found once the result is in.
function describe(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = i.file_path || i.notebook_path || null;
  const step = (say, extra) => ({ say: mask(clip(say, 140)), kind: 'step', ...extra });
  switch (name) {
    case 'Bash': {
      const cmd = String(i.command || '');
      return step(i.description || cmd.split('\n')[0] || 'Run a command', { cmd, ...(i.run_in_background ? { bg: 'command' } : {}) });
    }
    case 'Read':
      return step(`Read ${base(file)}`, { file });
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { say: mask(`Change ${base(file)}`), kind: 'file', file };
    case 'Write':
      return { say: mask(`Write ${base(file)}`), kind: 'file', file, wlines: typeof i.content === 'string' ? i.content.split('\n').length : 0 };
    case 'Grep':
      return step(`Search for "${clip(i.pattern, 50)}"`);
    case 'Glob':
      return step(`Find files ${clip(i.pattern, 60)}`);
    case 'WebFetch': {
      let host = '';
      try {
        host = new globalThis.URL(i.url).host;
      } catch {}
      return step(`Read ${host || 'a web page'}`, { link: typeof i.url === 'string' ? i.url : undefined });
    }
    case 'WebSearch':
      return step(`Search the web for "${clip(i.query, 60)}"`);
    case 'Agent':
    case 'Task':
      return step(`Agent: ${i.description || 'a task'}`, { agent: true });
    case 'Skill':
      return step(`Run the ${String(i.skill || '').replace(/^[\w.-]+:/, '') || 'a'} skill`);
    case 'ToolSearch':
      return step('Load tools');
    case 'TodoWrite':
      return step('Update the todo list');
    case 'AskUserQuestion':
      return step('Ask you a question');
    case 'ExitPlanMode':
      return step('Show the plan');
    case 'SendMessage':
      return step(`Message ${i.to || i.recipient || 'an agent'}`);
    case 'TaskStop':
      return step('Stop a background task');
    case 'TaskOutput':
      return step('Read a background task');
    case 'Monitor':
      return step(i.description ? `Watch: ${i.description}` : 'Watch for an event', { bg: 'watch' });
    case 'Artifact':
      if (i.action && i.action !== 'publish') return step('Read a page');
      return { say: mask(clip(`Publish ${i.title || 'a page'}`, 140)), kind: 'outside', service: 'Pages', write: 'published' };
    case 'ArtifactData':
      if (!/^(set|update|delete|batch)$/.test(String(i.action || ''))) return step('Read a page’s data');
      return { say: 'Change a page’s data', kind: 'outside', service: 'Pages', write: 'change' };
    case 'ArtifactComments':
      if (!/create|reply|resolve|delete/.test(String(i.action || ''))) return step('Read a page’s comments');
      return { say: 'Comment on a page', kind: 'outside', service: 'Pages', write: 'sent' };
  }
  const m = mcpParts(name);
  if (m) {
    const hintKey = HINT_KEYS.find((k) => typeof i[k] === 'string' && i[k].trim() && i[k].length <= 80);
    const say = `${m.service}: ${m.words}${hintKey ? ' ' + clip(i[hintKey], 60) : ''}`;
    const write = BROWSER.test(m.server) ? null : writeOf(m.tool);
    if (write) return { say: mask(clip(say, 140)), kind: 'outside', service: m.service, write };
    return step(say, { browser: BROWSER.test(m.server) || undefined });
  }
  return step(cap(name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()));
}

// Common first words of a step's words, as they read while it runs.
const VERBS = new Set(
  'run list show check read find search get fetch create make build install start stop kill open close write update add remove delete copy move rename count print view look test push pull commit merge rebase clone compare verify wait send post set save load download upload capture take inspect extract parse convert render launch restart watch query diff fix apply revert reset clean tail sort filter scan connect switch export import generate format package pack deploy publish call ping measure confirm describe ask review map draft edit change replace insert append compile mark tag stage unstage retry poll prepare collect gather summarize scroll click type press navigate resize quit focus record monitor grep sync log message start pick use try note walk'.split(' '),
);
const DOUBLE = new Set(['run', 'stop', 'get', 'set', 'put', 'cut', 'hit', 'plan', 'ship', 'drop', 'skip', 'grab', 'tag', 'log', 'scan', 'chat', 'map', 'wrap', 'step', 'trim', 'swap', 'commit', 'submit', 'begin', 'omit', 'admit', 'nap', 'tap', 'zip', 'pin', 'dig', 'pop']);

function ing(word) {
  const w = word.toLowerCase();
  if (DOUBLE.has(w)) return w + w[w.length - 1] + 'ing';
  if (w.endsWith('ie')) return w.slice(0, -2) + 'ying';
  if (w.endsWith('e') && !w.endsWith('ee') && !w.endsWith('ye') && !w.endsWith('oe')) return w.slice(0, -1) + 'ing';
  return w + 'ing';
}

// "Run the tests" reads "Running the tests" while it runs.
function doing(say) {
  const m = /^([A-Za-z]+)(\b.*)$/s.exec(say || '');
  if (!m || !VERBS.has(m[1].toLowerCase())) return say;
  const w = ing(m[1]);
  return (m[1][0] === m[1][0].toUpperCase() ? cap(w) : w) + m[2];
}

function resultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

function lastLines(text, n) {
  return mask(String(text || '').replace(ANSI, ''))
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => (l.length > 200 ? l.slice(0, 199) + '…' : l));
}

// Lines added and removed in a file change, from the result Claude Code logs.
function lineCounts(step, r) {
  let add = 0;
  let del = 0;
  const patch = r && Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  for (const h of patch)
    for (const l of (h && h.lines) || []) {
      if (typeof l !== 'string') continue;
      if (l[0] === '+') add++;
      else if (l[0] === '-') del++;
    }
  if (!patch.length && r && r.type === 'create' && typeof r.content === 'string') add = r.content.split('\n').length;
  // A Write whose result has no patch: all its lines count as added.
  if (!add && !del && !patch.length && step.wlines) add = step.wlines;
  return { add, del, created: !!(r && r.type === 'create') };
}

// Git work in a finished command: what Claude Code noted itself
// (gitOperation), else read from the command and what it printed. A command
// that failed counts only what it printed it did; one that ran fine in the
// background (fine) did what it says, whatever it printed.
function gitOf(cmd, out, op, failed, fine) {
  const ev = [];
  const has = (k) => ev.some((e) => e.kind === k);
  const repoTo = /^To (?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?\s*$/m.exec(out);
  const repo = repoTo ? repoTo[1] : null;
  if (op && typeof op === 'object') {
    if (op.commit && op.commit.sha) ev.push({ kind: 'commit', sha: String(op.commit.sha), branch: op.commit.branch || null });
    if (op.push) ev.push({ kind: 'push', branch: (op.push && op.push.branch) || null, repo });
    const pr = op.pr;
    if (pr && pr.number) {
      const k = { created: 'opened', merged: 'merged', closed: 'closed', ready: 'ready' }[pr.action];
      const g = typeof pr.url === 'string' ? GH.exec(pr.url) : null;
      if (k) ev.push({ kind: k, n: Number(pr.number), url: pr.url || null, repo: g ? g[1] : null });
      if (pr.action === 'commented') ev.push({ kind: 'commented', n: Number(pr.number), url: pr.url || null });
    }
    if (op.branch && op.branch.ref && (op.branch.action === 'rebased' || op.branch.action === 'merged')) ev.push({ kind: op.branch.action, ref: String(op.branch.ref) });
  }
  if (!has('commit') && /\bgit\b[^|;&\n]*\bcommit\b(?!-)/.test(cmd) && !/nothing to commit|no changes added to commit/.test(out)) {
    const re = /^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/gm;
    let m;
    while ((m = re.exec(out))) ev.push({ kind: 'commit', sha: m[2], branch: m[1], msg: m[3] });
    // A quiet commit (-q) prints no summary; a "git log --oneline" after it
    // still names it.
    if (!has('commit') && !failed) {
      const l = /\bgit\b[^|;&\n]*\blog\b/.test(cmd) ? /^([0-9a-f]{7,40}) (.+)$/m.exec(out) : null;
      ev.push({ kind: 'commit', sha: l ? l[1] : '', msg: l ? l[2] : null });
    }
  } else if (has('commit')) {
    const m = /^\[([^\]\s]+)(?: \([^)]*\))? ([0-9a-f]{7,40})\] (.+)$/m.exec(out);
    const c = ev.find((e) => e.kind === 'commit');
    if (m && c && !c.msg) c.msg = m[3];
  }
  const push = /\bgit\b[^|;&\n]*\bpush\b([^|;&\n]*)/.exec(cmd);
  if (!has('push') && push && !/(^|\s)(-n|--dry-run)\b/.test(push[1])) {
    const m = /(?:\.\.\.?\S*|\[new branch\]|\[new tag\]|\+\s*\S+)\s+(\S+)\s+->\s+(\S+)/.exec(out);
    // A quiet push (-q) prints nothing: a command that ran fine did it.
    const quiet = (fine || /(^|\s)(-q|--quiet)\b/.test(push[1])) && !failed && !/\b(fatal|error):|\[(remote )?rejected\]/.test(out);
    if (m) ev.push({ kind: 'push', branch: m[2], repo });
    else if (quiet) {
      const b = /\bpush\b(?:\s+-\S+)*\s+(?:-u\s+)?\S+\s+(?:HEAD:)?([\w./-]+)/.exec(push[0]);
      ev.push({ kind: 'push', branch: b ? b[1] : null, repo });
    }
  }
  if (failed) return ev.filter((e) => e.kind === 'commit' || e.kind === 'push');
  if (!has('opened') && /\bgh\s+pr\s+create\b/.test(cmd)) {
    const g = GH.exec(out);
    ev.push({ kind: 'opened', n: g ? Number(g[2]) : null, url: g ? g[0] : null, repo: g ? g[1] : null });
  }
  // --auto only asks GitHub to merge it later.
  if (!has('merged') && /\bgh\s+pr\s+merge\b/.test(cmd) && !/--auto\b/.test(cmd) && !/will be automatically merged/i.test(out)) {
    const g = GH.exec(cmd) || GH.exec(out);
    const n = g ? Number(g[2]) : Number((/\bgh\s+pr\s+merge\s+#?(\d+)/.exec(cmd) || /Merged pull request (?:[\w.-]+\/[\w.-]+)?#(\d+)/.exec(out) || [])[1]) || null;
    ev.push({ kind: 'merged', n, url: g ? g[0] : null, repo: g ? g[1] : null });
  }
  return ev;
}

// A step takes its result: whether it failed, its last lines, a link, the
// lines it changed, the git work it did.
function takeResult(step, block, r) {
  const text = resultText(block);
  const failed = !!(block && block.is_error);
  const denied = /^\s*(\[Request interrupted|The user (doesn't|does not|didn't)|User rejected|Permission (for|to) .* (denied|was denied)|<tool_use_error>)/i.test(text);
  step.done = true;
  if (failed && !denied && !QUIET_FAILS.has(step.tool) && !step.browser) {
    step.failed = true;
    step.tail = lastLines(text.replace(/^Exit code \d+\s*\n?/, ''), 5);
    if (!step.tail.length) step.tail = lastLines(text, 5);
  } else if (failed) step.missed = true;
  // What failed changed nothing: it is no file change and no write. A
  // command that failed late may still have committed or pushed.
  if (failed) {
    if (step.kind !== 'step') step.kind = 'step';
    if (step.tool === 'Bash' && !denied) {
      const out = r && typeof r === 'object' ? [r.stdout, r.stderr].filter((x) => typeof x === 'string').join('\n') : text;
      const ev = gitOf(step.cmd || '', (out || text).replace(ANSI, ''), r && typeof r === 'object' ? r.gitOperation : null, true);
      if (ev.length) step.git = ev;
    }
    return;
  }
  if (step.kind === 'file') {
    Object.assign(step, lineCounts(step, r));
    if (step.created) step.say = mask(`Create ${base(step.file)}`);
  }
  if (step.kind === 'outside') {
    const u = LINK.exec(text);
    if (u) step.link = mask(u[0]);
  }
  if (step.tool === 'Bash') {
    const out = r && typeof r === 'object' ? [r.stdout, r.stderr].filter((x) => typeof x === 'string').join('\n') : text;
    const ev = gitOf(step.cmd || '', out.replace(ANSI, ''), r && r.gitOperation);
    if (ev.length) step.git = ev;
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// What a turn did that matters, for the card, and its one line of facts
// ("Opened PR 184 · 2 commits · 3 files · 1 failed"). No line when it only
// read. prs: PR links Claude Code noted, by link; fresh: those first noted
// in this turn.
function summarize(steps, ms, prs, fresh) {
  const files = new Map();
  const outside = [];
  const git = [];
  const failed = [];
  const agents = [];
  const background = [];
  const other = [];
  let repo = null;
  for (const s of steps) for (const e of s.git || []) if (e.repo && !repo) repo = e.repo;
  if (!repo) for (const u of fresh) if (prs.get(u) && prs.get(u).repo) repo = prs.get(u).repo;
  const prUrl = (n) => {
    for (const [u, p] of prs) if (p.n === n && (!repo || !p.repo || p.repo === repo)) return u;
    return null;
  };
  const seenPr = new Set();
  for (const s of steps) {
    if (s.failed) {
      failed.push({ id: s.id, say: s.say, tail: s.tail || [], ...(s.bgNote ? { note: true } : {}) });
      if (!(s.git || []).length) continue;
    }
    // Its question and his answer show in the chat on their own.
    if (s.tool === 'AskUserQuestion' || s.tool === 'ExitPlanMode') continue;
    if (s.agent && !s.failed) {
      agents.push({ id: s.id, say: s.say.replace(/^Agent: /, ''), ...(s.done ? {} : { running: true }) });
      continue;
    }
    if (s.bg && !s.failed) {
      background.push({ id: s.id, say: s.say.replace(/^Watch: /, ''), kind: s.bg });
      continue;
    }
    // A call with no result yet runs still: no change or write is counted.
    if (!s.done && !s.failed) {
      other.push({ id: s.id, say: s.say, running: true });
      continue;
    }
    if (s.kind === 'file' && s.file) {
      const f = files.get(s.file) || { path: mask(s.file), name: mask(base(s.file)), add: 0, del: 0, ids: [] };
      f.add += s.add || 0;
      f.del += s.del || 0;
      if (s.created) f.created = true;
      f.ids.push(s.id);
      files.set(s.file, f);
      continue;
    }
    if (s.kind === 'outside') {
      outside.push({ id: s.id, say: s.say, service: s.service, write: s.write, ...(s.link ? { link: s.link } : {}) });
      continue;
    }
    const ev = (s.git || []).filter((e) => e.kind !== 'commented');
    for (const e of (s.git || []).filter((x) => x.kind === 'commented'))
      outside.push({ id: s.id, say: `GitHub: comment on PR ${e.n}`, service: 'GitHub', write: 'change', ...(e.url ? { link: e.url } : {}) });
    if (!ev.length) {
      if (!(s.git || []).length && !s.failed) other.push({ id: s.id, say: s.say, ...(s.missed ? { missed: true } : {}) });
      continue;
    }
    for (const e of ev) {
      const r = e.repo || repo;
      let say;
      let link = null;
      if (e.kind === 'commit') {
        say = ['Commit', e.sha ? e.sha.slice(0, 7) : '', e.msg ? clip(e.msg, 80) : ''].filter(Boolean).join(' ');
        if (r && e.sha) link = `https://github.com/${r}/commit/${e.sha}`;
      } else if (e.kind === 'push') {
        say = e.branch ? `Push ${e.branch}` : 'Push';
        if (r && e.branch) link = `https://github.com/${r}/tree/${e.branch}`;
      } else if (e.kind === 'rebased' || (e.kind === 'merged' && e.ref)) {
        say = e.kind === 'rebased' ? `Rebase on ${e.ref}` : `Merge ${e.ref}`;
      } else {
        const n = e.n || (e.kind === 'opened' && fresh.length ? prs.get(fresh[0]).n : null);
        if (n) seenPr.add(n);
        const verb = { opened: 'Opened', merged: 'Merged', closed: 'Closed', ready: 'Marked ready' }[e.kind];
        say = n ? `${verb} PR ${n}` : `${verb} a PR`;
        link = e.url || (n ? prUrl(n) : null) || (e.kind === 'opened' && fresh.length ? fresh[0] : null);
        e.n = n;
      }
      git.push({ id: s.id, kind: e.kind === 'merged' && e.ref ? 'branch' : e.kind, say: mask(say), ...(link ? { link: mask(link) } : {}), ...(e.n ? { n: e.n } : {}) });
    }
  }
  // PRs Claude Code noted in this turn that no step above opened or merged.
  for (const u of fresh) {
    const p = prs.get(u);
    if (p && !seenPr.has(p.n)) git.push({ id: 'pr:' + u, kind: 'pr', say: `PR ${p.n}${p.repo ? ' · ' + p.repo : ''}`, link: u, n: p.n });
  }

  const parts = [];
  const opened = git.filter((g) => g.kind === 'opened');
  const merged = git.filter((g) => g.kind === 'merged');
  const commits = git.filter((g) => g.kind === 'commit').length;
  const pushes = git.filter((g) => g.kind === 'push').length;
  if (opened.length) parts.push(opened.length === 1 ? opened[0].say : `Opened ${opened.length} PRs`);
  if (merged.length) parts.push(merged.length === 1 ? merged[0].say : `Merged ${merged.length} PRs`);
  if (commits) parts.push(plural(commits, 'commit'));
  if (pushes && !opened.length && !merged.length) parts.push('Pushed');
  if (files.size) parts.push(plural(files.size, 'file'));
  const drafts = outside.filter((o) => o.write === 'draft').length;
  const sent = outside.filter((o) => o.write === 'sent').length;
  const published = outside.filter((o) => o.write === 'published').length;
  const changes = outside.filter((o) => o.write === 'change');
  if (drafts) parts.push(plural(drafts, 'draft'));
  if (sent) parts.push(`${sent} sent`);
  if (published) parts.push(`${published} published`);
  if (changes.length) {
    const svc = new Set(changes.map((c) => c.service));
    parts.push(svc.size === 1 ? `${plural(changes.length, [...svc][0] + ' change')}` : `${changes.length} changes elsewhere`);
  }
  if (agents.length) parts.push(plural(agents.length, 'agent'));
  const cmds = background.filter((b) => b.kind === 'command').length;
  const watches = background.length - cmds;
  if (cmds) parts.push(plural(cmds, 'background command'));
  if (watches) parts.push(plural(watches, 'watch', 'watches'));
  if (failed.length) parts.push(`${failed.length} failed`);
  const turn = { ms: ms != null && ms >= 0 ? ms : null, n: steps.length, files: [...files.values()], outside, git, failed, agents, background, other };
  return { line: parts.join(' · '), turn };
}

// A file change as a patch, or a step's output, read again from the log when
// he opens it. use: the log line with the call; res: the one with its result.
function detailOf(id, use, res) {
  const blockIn = (d, type, key) => {
    const c = d && d.message && d.message.content;
    return Array.isArray(c) ? c.find((b) => b && b.type === type && b[key] === id) : null;
  };
  const call = blockIn(use, 'tool_use', 'id');
  const result = blockIn(res, 'tool_result', 'tool_use_id');
  if (!call && !result) return null;
  const r = res && res.toolUseResult && typeof res.toolUseResult === 'object' ? res.toolUseResult : null;
  const name = call ? call.name : '';
  const input = (call && call.input) || {};
  const LIMIT = 600;
  if (EDITS.has(name) && !(result && result.is_error)) {
    const out = [];
    const patch = r && Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
    for (const h of patch) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
      for (const l of h.lines || []) out.push(l);
    }
    if (!out.length && r && r.type === 'create' && typeof r.content === 'string') for (const l of r.content.split('\n')) out.push('+' + l);
    if (!out.length) {
      const edits = Array.isArray(input.edits) ? input.edits : [input];
      for (const e of edits) {
        if (typeof e.old_string === 'string') for (const l of e.old_string.split('\n')) out.push('-' + l);
        if (typeof e.new_string === 'string') for (const l of e.new_string.split('\n')) out.push('+' + l);
        if (typeof e.content === 'string') for (const l of e.content.split('\n')) out.push('+' + l);
      }
    }
    const more = out.length - LIMIT;
    return { id, diff: mask(out.slice(0, LIMIT).join('\n')) + (more > 0 ? `\n… ${more} more lines` : '') };
  }
  let text = r && (typeof r.stdout === 'string' || typeof r.stderr === 'string') ? [r.stdout, r.stderr].filter((x) => x && x.trim()).join('\n') : resultText(result);
  text = String(text || '').replace(ANSI, '').replace(/\s+$/, '');
  const lines = text.split('\n');
  const tail = lines.slice(-80).join('\n');
  return { id, out: mask(tail.length > 8000 ? '…' + tail.slice(-8000) : tail), ...(lines.length > 80 ? { cut: lines.length - 80 } : {}), ...(input && input.command ? { cmd: mask(clip(input.command, 2000)) } : {}) };
}

// The git work of a background command that ran fine, from its command and
// what its output file still holds.
const gitAfter = (cmd, out) => gitOf(cmd, String(out || '').replace(ANSI, ''), null, false, true);

module.exports = { describe, doing, takeResult, summarize, detailOf, gitAfter, EDITS };

// Proof that the app's readers miss nothing that matters in a session log.
//
//   node scripts/coverage.js <session.jsonl> [more.jsonl ...]
//   node scripts/coverage.js --lines <session.jsonl>
//
// First it lists, on its own, every item of the log that matters: PRs
// opened, merged or linked, commits, pushes, writes to other systems (by
// tool name), failed commands (background ones too), questions asked of the
// person (question blocks and Claude Code's own question and plan menus),
// agents and background commands. Then it runs the app's readers
// (electron/transcript.js with blocks.js, and the live reader) over the same
// log and counts what the chat shows, on screen or one click away: an item
// in a turn's card counts; one folded under "other steps" does not.
//
// It prints counts per kind only. --lines adds each miss's kind, log line
// and tool name. It never prints what the log says: logs hold secrets.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Transcript } = require('../electron/transcript');
const { Live } = require('../electron/live');
const { summarize } = require('../electron/steps');

const KINDS = ['pr opened', 'pr merged', 'pr linked', 'commit', 'push', 'outside write', 'failed command', 'question', 'agent', 'background command'];
const MARK = '[sent from chiefman]';
const SKIP = ['{"type":"api-request', '{"type":"file-history', '{"type":"data-flow', '{"type":"atis', '{"type":"session-owner', '{"type":"bridge-session', '{"type":"frame-link'];
const PULL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const BROWSER = /chrome|playwright|browser|computer/i;
// The first verb in a tool's name says whether it writes.
const WRITE = new Set('create add update edit set send post reply forward publish draft delete remove trash untrash archive move transition assign merge close comment upload link label unlabel mark schedule notify submit approve restore duplicate apply insert patch put write rename spawn ask react'.split(' '));
const READ = new Set('get list search read fetch query find view download check investigate compare describe lookup wait guide export resolve authenticate complete'.split(' '));
const PRODUCT = new Set('jira confluence slack notion gmail github linear calendar drive mcp claude ai plugin'.split(' '));

function textOf(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  return '';
}

function writes(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  if (name === 'Artifact') return !i.action || i.action === 'publish';
  if (name === 'ArtifactData') return /^(set|update|delete|batch)$/.test(String(i.action || ''));
  if (name === 'ArtifactComments') return /create|reply|resolve|delete/.test(String(i.action || ''));
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (!m || BROWSER.test(m[1])) return false;
  const words = m[2].toLowerCase().split(/[_-]+/).filter((w) => w && !PRODUCT.has(w));
  if (words.length === 1 && words[0] === 'batch') return true;
  for (const w of words) {
    if (WRITE.has(w)) return true;
    if (READ.has(w)) return false;
  }
  return false;
}

// ---- what the log holds, read plainly ----

async function truth(file) {
  const found = new Map(KINDS.map((k) => [k, new Map()]));
  const put = (kind, key, line, tool, extra) => {
    const m = found.get(kind);
    const e = m.get(key);
    if (e) e.count++;
    else m.set(key, { count: 1, line, tool, ...extra });
  };
  const calls = new Map();
  const notes = new Set();
  let lastApp = false;
  let n = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    n++;
    if (!line || SKIP.some((p) => line.startsWith(p))) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (!d || d.isSidechain) continue;
    if (d.type === 'pr-link' && typeof d.prUrl === 'string') {
      put('pr linked', d.prUrl, n, 'pr-link', { n: Number(d.prNumber) || null });
      continue;
    }
    // A background command or watch that ended badly.
    const noteText = d.type === 'queue-operation' ? d.content : d.type === 'attachment' && d.attachment ? d.attachment.prompt : d.type === 'user' && d.message ? textOf(d.message.content) : '';
    if (typeof noteText === 'string' && noteText.includes('<task-notification>')) {
      for (const m of noteText.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const id = (/<task-id>([^<]*)<\/task-id>/.exec(m[1]) || [])[1];
        const use = (/<tool-use-id>([^<]*)<\/tool-use-id>/.exec(m[1]) || [])[1];
        const status = (/<status>([^<]*)<\/status>/.exec(m[1]) || [])[1];
        const call = use && calls.get(use);
        if (!id || notes.has(id) || !call || !((call.name === 'Bash' && call.input.run_in_background) || call.name === 'Monitor')) continue;
        if (status === 'failed') {
          notes.add(id);
          put('failed command', 'bg:' + use, n, call.name + ' (background)');
        }
        // A background command that ran fine did what it says.
        const cmd = String(call.input.command || '');
        if (status === 'completed' && call.name === 'Bash') {
          notes.add(id);
          if (/\bgh\s+pr\s+merge\b/.test(cmd) && !/--auto\b/.test(cmd)) put('pr merged', use, n, 'Bash (background)');
          if (/\bgit\b[^|;&\n]*\bpush\b/.test(cmd) && !/(^|\s)(-n|--dry-run)\b/.test(cmd)) put('push', use, n, 'Bash (background)');
          if (/\bgit\b[^|;&\n]*\bcommit\b(?!-)/.test(cmd)) put('commit', use, n, 'Bash (background)');
        }
      }
      continue;
    }
    if (d.type === 'attachment' && d.attachment && d.attachment.type === 'queued_command') {
      const p = d.attachment.prompt;
      lastApp = (typeof p === 'string' ? p : textOf(p)).includes(MARK);
      continue;
    }
    const c = d.message && d.message.content;
    if (d.type === 'assistant' && Array.isArray(c)) {
      c.forEach((b, i) => {
        if (!b) return;
        if (b.type === 'text' && typeof b.text === 'string' && lastApp && /^[ \t]*`{3,}questions[ \t]*$/m.test(b.text)) put('question', `a:${d.uuid}:${i}`, n, 'questions block');
        if (b.type !== 'tool_use' || typeof b.id !== 'string') return;
        const name = String(b.name || '');
        const input = b.input && typeof b.input === 'object' ? b.input : {};
        calls.set(b.id, { name, input, line: n });
        if (name === 'Agent' || name === 'Task') put('agent', b.id, n, name);
        if ((name === 'Bash' && input.run_in_background) || name === 'Monitor') put('background command', b.id, n, name);
        if (name === 'AskUserQuestion' || name === 'ExitPlanMode') put('question', b.id, n, name);
      });
      continue;
    }
    if (d.type !== 'user' || !Array.isArray(c)) {
      if (d.type === 'user' && !d.isMeta && typeof c === 'string') lastApp = c.includes(MARK);
      continue;
    }
    if (!c.some((b) => b && b.type === 'tool_result')) {
      if (!d.isMeta) lastApp = textOf(c).includes(MARK);
      continue;
    }
    for (const b of c) {
      if (!b || b.type !== 'tool_result') continue;
      const call = calls.get(b.tool_use_id);
      if (!call) continue;
      const text = textOf(b.content);
      const r = d.toolUseResult && typeof d.toolUseResult === 'object' ? d.toolUseResult : null;
      const stopped = /^\s*(\[Request interrupted|The user (doesn't|does not|didn't)|User rejected|Permission (for|to) .* (denied|was denied)|<tool_use_error>)/i.test(text);
      if (stopped) continue;
      const bad = !!b.is_error;
      const id = b.tool_use_id;
      // An agent that could not start is a failure, not an agent.
      if ((call.name === 'Agent' || call.name === 'Task') && bad) found.get('agent').delete(id);
      // A background command's result says only that it started.
      if (call.name === 'Bash' && call.input.run_in_background && !bad) continue;
      if (call.name !== 'Bash') {
        if (!bad && writes(call.name, call.input)) put('outside write', id, call.line, call.name);
        continue;
      }
      const cmd = String(call.input.command || '');
      const out = r && (typeof r.stdout === 'string' || typeof r.stderr === 'string') ? [r.stdout, r.stderr].filter((x) => typeof x === 'string').join('\n') : text;
      const op = r && r.gitOperation && typeof r.gitOperation === 'object' ? r.gitOperation : {};
      if (bad) put('failed command', id, call.line, 'Bash');
      // Git work shows in what the command printed, even when a later part
      // of it failed.
      const sums = [...out.matchAll(/^\[[^\]\s]+(?: \([^)]*\))? ([0-9a-f]{7,40})\] /gm)];
      if (op.commit) put('commit', id, call.line, 'Bash');
      else if (/\bgit\b[^|;&\n]*\bcommit(?!-)\b/.test(cmd)) {
        for (let k = 0; k < sums.length; k++) put('commit', id, call.line, 'Bash');
        if (!sums.length && !bad && !/nothing to commit|no changes added/.test(out)) put('commit', id, call.line, 'Bash');
      }
      // A quiet push (-q) prints nothing; a command that ran fine did it.
      const push = /\bgit\b[^|;&\n]*\bpush\b([^|;&\n]*)/.exec(cmd);
      const quiet = push && /(^|\s)(-q|--quiet)\b/.test(push[1]) && !bad && !/\b(fatal|error):|\[(remote )?rejected\]/.test(out);
      const pushed = op.push || (push && !/(^|\s)(-n|--dry-run)\b/.test(push[1]) && (quiet || (/^To \S/m.test(out) && /\s->\s/.test(out) && !/\[(remote )?rejected\]/.test(out))));
      if (pushed) put('push', id, call.line, 'Bash');
      const pr = op.pr && typeof op.pr === 'object' ? op.pr : null;
      const made = (pr && pr.action === 'created') || (/\bgh\s+pr\s+create\b/.test(cmd) && PULL.test(out));
      if (made) {
        const g = PULL.exec((pr && pr.url) || out) || [];
        put('pr opened', id, call.line, 'Bash', { n: Number((pr && pr.number) || g[2]) || null });
      }
      const merged = (pr && pr.action === 'merged') || (!bad && /\bgh\s+pr\s+merge\b/.test(cmd) && !/--auto\b/.test(cmd) && !/will be automatically merged/i.test(out));
      if (merged) {
        const num = (pr && pr.number) || (/\bgh\s+pr\s+merge\s+#?(\d+)/.exec(cmd) || PULL.exec(cmd) || /Merged pull request [\w.-]*\/?[\w.-]*#(\d+)/.exec(out) || [])[1];
        put('pr merged', id, call.line, 'Bash', { n: Number(num) || null });
      }
    }
  }
  return { found, lines: n };
}

// ---- what the app's readers make of it ----

async function shown(file) {
  const got = new Map(KINDS.map((k) => [k, new Map()]));
  const add = (kind, key) => got.get(kind).set(key, (got.get(kind).get(key) || 0) + 1);
  const nums = { opened: new Set(), merged: new Set(), any: new Set() };
  const tr = new Transcript(file);
  await tr.load();
  const turns = tr.items.filter((i) => i.turn).map((i) => i.turn);
  // The turn still running at the log's end shows once it ends.
  let open = 0;
  if (tr.turn && tr.turn.steps.length) {
    turns.push(summarize(tr.turn.steps, null, tr.prs, tr.turn.fresh).turn);
    open = tr.turn.steps.length;
  }
  for (const t of turns) {
    for (const g of t.git) {
      const k = { commit: 'commit', push: 'push', opened: 'pr opened', merged: 'pr merged' }[g.kind];
      if (k) add(k, g.id);
      const num = g.n || (g.link && Number((PULL.exec(g.link) || [])[2])) || null;
      if (num && ['opened', 'merged', 'pr', 'closed', 'ready'].includes(g.kind)) {
        nums.any.add(num);
        if (g.kind === 'opened' || g.kind === 'pr') nums.opened.add(num);
        if (g.kind === 'merged') nums.merged.add(num);
      }
    }
    for (const o of t.outside) add('outside write', o.id);
    for (const f of t.failed) add('failed command', f.id);
    for (const a of t.agents || []) add('agent', a.id);
    for (const b of t.background || []) add('background command', b.id);
  }
  for (const i of tr.items) {
    if (i.asks && i.asks.length) add('question', i.id);
    if (i.asked) add('question', i.id.replace(/^ask:/, ''));
  }
  const live = new Live(file);
  await live.poll();
  const tasks = [...live.tasks.values()];
  tr.stop();
  return { got, nums, open, live: { agents: tasks.filter((t) => t.kind === 'agent').length, commands: tasks.filter((t) => t.kind === 'command').length, watches: tasks.filter((t) => t.kind === 'watch').length, running: tasks.filter((t) => !t.done).length } };
}

function misses(kind, want, have, nums) {
  const out = [];
  for (const [key, e] of want) {
    let left = e.count - (have.get(key) || 0);
    if (left > 0 && e.n && kind === 'pr opened' && nums.opened.has(e.n)) left = 0;
    if (left > 0 && e.n && kind === 'pr merged' && nums.merged.has(e.n)) left = 0;
    if (kind === 'pr linked') left = e.n && nums.any.has(e.n) ? 0 : 1;
    for (let i = 0; i < left; i++) out.push({ key, ...e });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const lines = args.includes('--lines');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('node scripts/coverage.js [--lines] <session.jsonl> [...]');
    process.exit(2);
  }
  const total = new Map(KINDS.map((k) => [k, [0, 0]]));
  for (const file of files) {
    const t = await truth(file);
    const s = await shown(file);
    console.log(`\n${path.basename(file)}: ${t.lines} log lines`);
    console.log('kind'.padEnd(20) + 'in log'.padStart(8) + 'missed'.padStart(8));
    for (const k of KINDS) {
      const want = t.found.get(k);
      const all = [...want.values()].reduce((a, e) => a + (k === 'pr linked' ? 1 : e.count), 0);
      const miss = misses(k, want, s.got.get(k), s.nums);
      total.get(k)[0] += all;
      total.get(k)[1] += miss.length;
      console.log(k.padEnd(20) + String(all).padStart(8) + String(miss.length).padStart(8));
      if (lines) for (const m of miss) console.log(`    ${k} · line ${m.line} · ${m.tool}`);
    }
    console.log(`live reader: ${s.live.agents} agents, ${s.live.commands} background commands, ${s.live.watches} watches; ${s.live.running} still running`);
    if (s.open) console.log(`the turn still running at the end has ${s.open} steps; its items show when it ends`);
  }
  if (files.length > 1) {
    console.log('\nall logs');
    for (const k of KINDS) console.log(k.padEnd(20) + String(total.get(k)[0]).padStart(8) + String(total.get(k)[1]).padStart(8));
  }
}

main().catch((e) => {
  console.error(String((e && e.message) || e));
  process.exit(1);
});

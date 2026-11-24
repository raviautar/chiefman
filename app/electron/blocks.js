// The blocks a box writes for chiefman, read by one strict reader. Each is a
// fenced block whose first line names its kind. It leaves the reply's text
// and becomes a card under the reply:
//
//   ```questions      numbered questions, each with its widget
//   ```actions        up to four buttons; a click sends the words
//   ```draft slack    text he posts himself; where it goes after "draft"
//   ```your turn      steps only he can do, each with an optional link
//   ```result         passed N, failed N, one line per failure, a link
//   ```waiting        what the box waits on, what it does after, a link
//   ```title          two or three words that name a new box; never shown
//
// Strict: a block with a line it cannot read stays in the text as written,
// a code block, never half a widget. A block not closed yet is held back as
// the tail, so it never shows half written.

const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
const KIND = /^(questions|actions|draft|your[ -]turn|result|waiting|title)(?:[ \t]+(.*))?$/i;
const URL = /^https?:\/\/[^\s<>"]+$/;
// "words | https://…": a line with its link.
const LINKED = /^(.*?)\s+\|\s+(https?:\/\/[^\s<>"]+)$/;

// ---- questions ----

// 1. Merge the fix now? [yes/no]
// 2. Which environment first? [one: dev* | stage]
// 3. Which checks should run? [any: api | ui | load]
// 4. What should the box be called? [text]
// 5. Which plan? [one]
//    - small *
//      done today
//    - full
//
// A * at either end of a choice marks the one the box recommends; a line
// indented under a choice is its note. A numbered line without a tag gets
// only his own words. A number twice, or a line that is none of these, and
// the block is not read.
const QLINE = /^(\d{1,2})[.)]\s+(.+)$/;
const TAG = /^(.*?)\s*\[([^\]]*)\]$/;

function choice(s) {
  const t = String(s).trim();
  const label = t.replace(/^\*\s*|\s*\*$/g, '').trim();
  return label !== t ? { label, recommended: true } : { label };
}

// Choices that make no widget (fewer than 2, more than 8, or long) leave
// the question to his own words.
function settle(a) {
  const seen = new Set();
  const options = a.options.filter((o) => o.label && !seen.has(o.label) && seen.add(o.label));
  if (options.length < 2 || options.length > 8 || options.some((o) => o.label.length > 80)) return { n: a.n, q: a.q, kind: 'words', options: [] };
  // One pick: one recommendation at most.
  if (a.kind === 'one') {
    let lit = false;
    for (const o of options) {
      if (o.recommended && lit) delete o.recommended;
      if (o.recommended) lit = true;
    }
  }
  return { n: a.n, q: a.q, kind: a.kind, options };
}

function askOf(line) {
  const m = QLINE.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  const words = { n, q: m[2], kind: 'words', options: [] };
  const t = TAG.exec(m[2]);
  if (!t) return words;
  const q = t[1].trim();
  const tag = t[2].trim();
  if (!q) return null;
  const yn = tag.split('/').map(choice);
  if (yn.length === 2 && /^yes$/i.test(yn[0].label) && /^no$/i.test(yn[1].label)) {
    return { n, q, kind: 'yesno', options: [{ ...yn[0], label: 'yes' }, { ...yn[1], label: 'no' }] };
  }
  if (/^text$/i.test(tag)) return { n, q, kind: 'text', options: [] };
  const o = /^(one|any)\s*(?::([\s\S]*))?$/i.exec(tag);
  if (!o) return words;
  const kind = o[1].toLowerCase();
  // [one] or [any] alone: the choices are on the lines under it.
  if (o[2] == null) return { n, q, kind, options: [], list: true };
  return settle({ n, q, kind, options: o[2].split('|').map(choice) });
}

function readQuestions(lines) {
  const asks = [];
  let list = null;
  let last = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    const l = raw.trim();
    const dash = /^-\s+(.+)$/.exec(l);
    if (last && indent > last.indent && !dash) {
      last.c.note = last.c.note ? `${last.c.note} ${l}` : l;
      if (last.c.note.length > 200) return null;
      continue;
    }
    if (QLINE.test(l)) {
      const a = askOf(l);
      if (!a || asks.some((x) => x.n === a.n)) return null;
      asks.push(a);
      list = a.list ? a : null;
      last = null;
      continue;
    }
    if (dash && list) {
      const c = choice(dash[1]);
      if (!c.label) return null;
      list.options.push(c);
      last = { c, indent };
      continue;
    }
    return null;
  }
  if (!asks.length) return null;
  return asks.map((a) => (a.list ? settle(a) : a));
}

// ---- the other cards ----

const BULLET = /^(?:[-•]|\d{1,2}[.)])\s+/;

function readActions(lines) {
  const buttons = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const l = raw.trim().replace(BULLET, '').replace(/^["“](.*)["”]$/, '$1').trim();
    if (!l || l.length > 60 || buttons.includes(l)) return null;
    buttons.push(l);
  }
  return buttons.length && buttons.length <= 4 ? { kind: 'actions', buttons } : null;
}

function readDraft(lines, where) {
  const text = lines.join('\n').replace(/^\s*\n|\s+$/g, '');
  if (!text.trim() || text.length > 20000 || where.length > 60) return null;
  return { kind: 'draft', where, text };
}

// "words | link": the link must be one.
function withLink(l) {
  const bar = l.lastIndexOf(' | ');
  if (bar < 0) return { text: l };
  const m = LINKED.exec(l);
  return m ? { text: m[1].trim(), url: m[2] } : null;
}

function readTurn(lines) {
  const steps = [];
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const s = withLink(raw.trim().replace(/^(?:[-•]|\d{1,2}[.)]|\[[ xX]?\])\s+/, ''));
    if (!s || !s.text || s.text.length > 300) return null;
    steps.push(s);
  }
  return steps.length && steps.length <= 9 ? { kind: 'turn', steps } : null;
}

function readResult(lines, label) {
  let passed = null;
  let failed = null;
  let url = null;
  const fails = [];
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    let m;
    if ((m = /^passed\s*:?\s*(\d{1,7})$/i.exec(l))) {
      if (passed != null) return null;
      passed = Number(m[1]);
    } else if ((m = /^failed\s*:?\s*(\d{1,7})$/i.exec(l))) {
      if (failed != null) return null;
      failed = Number(m[1]);
    } else if (URL.test(l)) {
      if (url) return null;
      url = l;
    } else {
      const f = l.replace(/^(?:[-•✗✘]|\d{1,3}[.)])\s+/, '');
      const bar = f.indexOf(' | ');
      const name = (bar < 0 ? f : f.slice(0, bar)).trim();
      const why = bar < 0 ? '' : f.slice(bar + 3).trim();
      if (!name || name.length > 200 || why.length > 600) return null;
      fails.push(why ? { name, why } : { name });
    }
  }
  if (passed == null && failed == null) return null;
  if (fails.length > 50 || label.length > 60) return null;
  if (failed == null && fails.length) failed = fails.length;
  return { kind: 'result', label, passed, failed, fails, ...(url ? { url } : {}) };
}

function readWaiting(lines) {
  let on = null;
  let then = null;
  let url = null;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (URL.test(l)) {
      if (url) return null;
      url = l;
    } else if (on == null) {
      const s = withLink(l);
      if (!s || (s.url && url)) return null;
      on = s.text.replace(/^(?:waiting\s+)?(?:on|for)\s+/i, '');
      if (s.url) url = s.url;
    } else if (then == null) then = l.replace(/^then\b[:,]?\s*/i, '');
    else return null;
  }
  if (!on || on.length > 200 || (then != null && (!then || then.length > 300))) return null;
  return { kind: 'waiting', on, ...(then ? { then } : {}), ...(url ? { url } : {}) };
}

// Two or three lower-case words, as a box name: weather-radar-notes.
function readTitle(lines) {
  const ls = lines.map((l) => l.trim()).filter(Boolean);
  if (ls.length !== 1) return null;
  const words = ls[0].toLowerCase().replace(/[`"'*_.]/g, '').split(/[\s-]+/).filter(Boolean);
  if (!words.length || words.length > 4 || words.some((w) => !/^[a-z0-9]+$/.test(w))) return null;
  const name = words.join('-');
  return name.length <= 32 ? name : null;
}

function read(kind, rest, body) {
  if (kind === 'draft') return readDraft(body, rest);
  if (kind === 'result') return readResult(body, rest);
  if (rest) return null;
  if (kind === 'questions') return readQuestions(body);
  if (kind === 'actions') return readActions(body);
  if (kind === 'your turn') return readTurn(body);
  if (kind === 'waiting') return readWaiting(body);
  if (kind === 'title') return readTitle(body);
  return null;
}

// How many of each card one reply may have; one more stays text.
const MOST = { actions: 1, turn: 1, waiting: 1, draft: 4, result: 4 };

// The reply without the blocks it read, and what they hold: asks (the
// questions), cards (the others, in the order written), title, and tail (a
// block not closed yet). Null when it read nothing.
function readBlocks(text) {
  const ls = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const keep = [];
  const cards = [];
  let asks = null;
  let title = null;
  let tail = null;
  for (let i = 0; i < ls.length; i++) {
    const f = FENCE.exec(ls[i]);
    if (!f) {
      keep.push(ls[i]);
      continue;
    }
    const close = new RegExp(`^[ \\t]*\\${f[2][0]}{${f[2].length},}[ \\t]*$`);
    let j = i + 1;
    while (j < ls.length && !close.test(ls[j])) j++;
    const k = f[2][0] === '`' ? KIND.exec(f[3].trim()) : null;
    const raw = ls.slice(i, j + 1);
    i = j;
    // Any other code block goes through untouched, to its end.
    if (!k) {
      keep.push(...raw);
      continue;
    }
    if (j >= ls.length) {
      tail = raw.join('\n');
      break;
    }
    const cut = new RegExp(`^[ \\t]{0,${f[1].length}}`);
    const body = raw.slice(1, -1).map((l) => l.replace(cut, ''));
    const kind = k[1].toLowerCase().replace('-', ' ');
    const got = read(kind, (k[2] || '').trim(), body);
    // A title is for the app alone: it never shows, read or not.
    if (kind === 'title') {
      if (got && !title) title = got;
      continue;
    }
    if (kind === 'questions' && got && !asks) {
      asks = got;
      continue;
    }
    if (got && kind !== 'questions' && cards.filter((c) => c.kind === got.kind).length < MOST[got.kind]) {
      cards.push(got);
      continue;
    }
    keep.push(...raw);
  }
  const t = keep.join('\n');
  if (!asks && !cards.length && !title && tail == null && t === String(text || '').replace(/\r\n?/g, '\n')) return null;
  return {
    t: t.replace(/\n{3,}/g, '\n\n').trim(),
    ...(asks ? { asks } : {}),
    ...(cards.length ? { cards } : {}),
    ...(title ? { title } : {}),
    ...(tail != null ? { tail } : {}),
  };
}

module.exports = { readBlocks };

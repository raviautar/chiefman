// Reads the chief's newest list. Only what needs the person now becomes cards.
// A quote becomes a one-click answer only when the line offers it as words
// to say; quotes that are evidence stay text. When in doubt, no button.

const CUE = /\b(say|reply|answer|type|send|pick|choose)\b/i;
const QUOTE = /“([^”]{1,60})”|"([^"]{1,60})"/g;

function stripMarks(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1');
}

// Splits on . ? ! outside quotes and brackets.
function sentences(s) {
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    cur += c;
    if (quote) {
      if ((quote === '“' && c === '”') || (quote === '"' && c === '"')) quote = null;
      continue;
    }
    if (c === '“' || c === '"') quote = c;
    else if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (!depth && (c === '.' || c === '?' || c === '!') && (s[i + 1] === ' ' || s[i + 1] === '*' || i === s.length - 1)) {
      out.push(cur);
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function quotes(s) {
  const out = [];
  let m;
  QUOTE.lastIndex = 0;
  while ((m = QUOTE.exec(s))) out.push({ text: (m[1] || m[2]).trim(), at: m.index, end: m.index + m[0].length });
  return out;
}

// Answer words from a raw (markdown) line.
function answerWords(raw) {
  const words = [];
  const short = (w) => w && w.split(/\s+/).length <= 6 && !/https?:/.test(w);
  for (const sent of sentences(raw)) {
    const qs = quotes(sent);
    if (!qs.length) continue;
    const plain = sent.replace(/\*\*/g, '');
    const before = plain.slice(0, plain.search(/[“"]/));
    const joined = qs.length > 1 && qs.slice(1).every((q, i) => /^\s*\**\s*(,|or|,\s*or)\s*\**\s*$/.test(sent.slice(qs[i].end, q.at)));
    const boldAlone = qs.length === 1 && /^\*\*\s*[“"][^”"]+[”"]\s*\*\*/.test(sent);
    if (CUE.test(before) || joined || boldAlone) for (const q of qs) if (short(q.text)) words.push(q.text);
  }
  return [...new Set(words)].slice(0, 4);
}

// One short line: the first sentence that is not only "Say ...", links gone,
// brackets that hold the answer words gone, at most about 110 characters.
function shortLine(raw) {
  let s = stripMarks(raw)
    .replace(/\s*\((?=[^)]*[“"])[^)]*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const parts = sentences(s);
  let pick = parts[0] || s;
  if (parts.length > 1 && /^say\b/i.test(pick)) pick = parts[1];
  pick = pick.replace(/[:\s]+$/, '').trim();
  if (pick.length > 110) pick = pick.slice(0, 107).replace(/\s+\S*$/, '') + '…';
  return pick;
}

// Two shapes. The chiefman shape opens with "Needs you: <n>" and numbers only
// what needs him, links on their own line, an "Also:" line last. The two-part
// shape has a "Needs you now" part and an "Everything else" part.
function parseList(text) {
  const lines = text.split('\n');
  const head = lines.findIndex((l) => /^\s*\**\s*needs you:\s*\d+/i.test(l));
  if (head >= 0) {
    const count = Number(/needs you:\s*(\d+)/i.exec(lines[head])[1]);
    const items = [];
    let also = null;
    let done = false;
    for (const line of lines.slice(head + 1)) {
      const a = /^\s*\**\s*also:\**\s*(.*)$/i.exec(line);
      if (a) {
        also = stripMarks(a[1]).trim() || null;
        break;
      }
      if (/^\s*\**\s*(everything else|in flight|the rest)\b/i.test(line)) done = true;
      const m = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/.exec(line);
      if (!m) continue;
      const raw = m[2];
      const now = !done && items.filter((x) => x.now).length < count;
      const words = quotes(raw)
        .map((q) => q.text)
        .filter((w) => w.split(/\s+/).length <= 6 && !/https?:/.test(w));
      items.push({ n: Number(m[1]), text: shortLine(raw), full: stripMarks(raw).trim(), words: [...new Set(words)].slice(0, 4), now });
    }
    items.also = also || items.filter((x) => !x.now).map((x) => x.text).join(' · ') || null;
    return items;
  }
  const items = [];
  let rest = false;
  let parts = false;
  for (const line of lines) {
    const m = /^\s{0,3}(\d{1,2})[.)]\s+(.+)$/.exec(line);
    if (!m) {
      if (/needs you now/i.test(line)) parts = true;
      if (items.length && /everything else|in flight|nothing (is )?needed|no action/i.test(line)) rest = true;
      continue;
    }
    const n = Number(m[1]);
    if (items.length && n !== items[items.length - 1].n + 1) {
      if (n === 1) {
        items.length = 0;
        rest = false;
      } else continue;
    }
    if (!items.length && n !== 1) continue;
    const raw = m[2];
    items.push({ n, text: shortLine(raw), full: stripMarks(raw).trim(), words: answerWords(raw), now: !rest });
  }
  return items.length >= (parts ? 1 : 2) ? items : null;
}

// Numbers he answered after the list: a line of his that starts "3." or "3 ".
function answeredNumbers(text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:^|\n)\s*(\d{1,2})(?:[.):]|\s)\s*\S/g)) out.add(Number(m[1]));
  return out;
}

// The chief's newest list, without the lines he already answered. Output of
// a slash command is never a list.
function newestDrill(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.k !== 'box' || it.id.startsWith('o:')) continue;
    const list = parseList(it.t);
    if (!list) continue;
    const answered = new Set();
    for (const later of items.slice(i + 1)) if (later.k === 'you') for (const n of answeredNumbers(later.t)) answered.add(n);
    const open = list.filter((x) => !answered.has(x.n));
    // total: what needed him when the list came, answered or not.
    return { id: it.id, at: it.ts, items: open.filter((x) => x.now), total: list.filter((x) => x.now).length, rest: open.filter((x) => !x.now).length, also: list.also || null };
  }
  return null;
}

module.exports = { parseList, newestDrill, answerWords, shortLine };

// Reads what a box's pane shows: whether text is typed at the prompt, the
// spinner's own words while it works, and any choice menu it waits on.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;
const strip = (s) => s.replace(ANSI, '');
const RULE = /^\s*[─━═]{3,}/;

// 'typed' when the prompt holds text he typed, 'empty' when it holds nothing
// or only the dim suggestion the box offers, 'no-prompt' when a dialog shows.
function promptState(screen) {
  const lines = screen.split('\n');
  let i = lines.length - 1;
  for (; i >= 0; i--) if (/^\s*❯/.test(strip(lines[i]))) break;
  if (i < 0 || parseMenu(screen)) return 'no-prompt';
  let dim = false;
  let grey = false;
  let seenPrompt = false;
  for (let j = i; j < lines.length; j++) {
    const line = lines[j];
    if (j > i && RULE.test(strip(line))) break;
    for (let k = 0; k < line.length; k++) {
      const c = line[k];
      if (c === '\x1b') {
        if (line[k + 1] === '[') {
          let e = k + 2;
          while (e < line.length && !/[A-Za-z]/.test(line[e])) e++;
          if (line[e] === 'm') {
            const ps = line.slice(k + 2, e).split(';').map((x) => (x === '' ? 0 : Number(x)));
            for (let p = 0; p < ps.length; p++) {
              const v = ps[p];
              if (v === 0) dim = grey = false;
              else if (v === 2) dim = true;
              else if (v === 22) dim = false;
              else if (v === 39) grey = false;
              else if (v === 90) grey = true;
              else if (v >= 30 && v <= 37) grey = false;
              else if (v === 38 && ps[p + 1] === 5) {
                const n = ps[p + 2];
                grey = n === 8 || (n >= 236 && n <= 252) || n === 102 || n === 145;
                p += 2;
              } else if (v === 38 && ps[p + 1] === 2) {
                const [r, g, b] = ps.slice(p + 2, p + 5);
                grey = Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 60 && r < 200;
                p += 4;
              } else if (v === 48 && (ps[p + 1] === 5 || ps[p + 1] === 2)) {
                p += ps[p + 1] === 5 ? 2 : 4;
              }
            }
          }
          k = e;
        } else if (line[k + 1] === ']') {
          let e = k + 2;
          while (e < line.length && line[e] !== '\x07' && !(line[e] === '\x1b' && line[e + 1] === '\\')) e++;
          k = line[e] === '\x07' ? e : e + 1;
        }
        continue;
      }
      if (j === i && !seenPrompt) {
        if (c === '❯') seenPrompt = true;
        continue;
      }
      if (/\s| /.test(c)) continue;
      if (!dim && !grey) return 'typed';
    }
  }
  return 'empty';
}

function plainLines(screen) {
  return strip(screen)
    .split('\n')
    .map((l) => l.replace(/^\s*[│┃|]\s?/, '').replace(/\s*[│┃|]\s*$/, ''));
}

// "✻ Waiting on checks… (4m 10s · ↓ 2k tokens)" becomes "Waiting on checks… 4m 10s".
function parseActivity(screen) {
  const lines = plainLines(screen).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const m = /^\s*[✻✽✶✳✢·*∗]\s+(.+?…)\s*(?:\((.*)\))?\s*$/.exec(lines[i]);
    if (!m) continue;
    const time = (m[2] || '')
      .split('·')
      .map((x) => x.trim())
      .find((x) => /^(\d+h\s*)?(\d+m\s*)?(\d+s)?$/.test(x) && x);
    return time ? `${m[1]} ${time}` : m[1];
  }
  return null;
}

const ART = /[─-▟■-◿]/g;
const HINT = /enter to (select|confirm)|esc to (cancel|exit|close)|to navigate|\(esc\)/i;

// Text above a menu, without the box-drawing art Claude draws around it.
// When the block holds a question line, that line alone is the question.
function questionAbove(lines, first) {
  const block = [];
  let blanks = 0;
  for (let i = first - 1; i >= Math.max(0, first - 10); i--) {
    const raw = lines[i];
    if (RULE.test(raw) || /^\s*[╭╰┌└]/.test(raw)) break;
    const t = raw.replace(ART, '').replace(/\s+/g, ' ').trim();
    if (!t) {
      if (raw.trim()) break; // a bar of art closes the menu's block
      if (block.length && ++blanks >= 2) break;
      continue;
    }
    blanks = 0;
    block.unshift(t);
  }
  const plain = block.map(plainLine).filter(Boolean);
  const asks = plain.filter((t) => /\?$/.test(t));
  if (asks.length) return asks[asks.length - 1];
  return plain.join(' ');
}

// Sentences that only make sense in the terminal: flags, keys, and "your
// pick is the default", which the app does not do (it keeps his default).
const TERMINAL = /\s--[a-z]|\b(ctrl|shift|alt|cmd|option)\+|[←→↑↓]|\b(enter|esc|tab|space) to\b|\bdefault for new sessions\b/i;
function plainLine(t) {
  return t
    .split(/(?<=[.!?])\s+/)
    .filter((s) => !TERMINAL.test(' ' + s))
    .join(' ')
    .trim();
}

// The trust question, in plain words.
function trustQuestion(lines) {
  const at = lines.findIndex((l) => /accessing workspace:/i.test(l));
  let folder = '';
  for (let i = at + 1; at >= 0 && i < Math.min(lines.length, at + 4); i++) {
    if (lines[i].trim()) {
      folder = lines[i].trim();
      break;
    }
  }
  const f = folder.replace(/^\/Users\/[^/]+/, '~').replace(/\/+$/, '');
  const name = !f ? 'this folder' : f === '~' ? 'your home folder' : `the ${f.slice(f.lastIndexOf('/') + 1)} folder`;
  return `Trust ${name}? Claude can read, change and run files there.`;
}

// The answers of a question menu with several questions, before he submits
// them, in plain words.
function reviewQuestion(lines, first) {
  let r = first - 1;
  while (r >= Math.max(0, first - 30) && !REVIEW.test(lines[r])) r--;
  const out = ['Review your answers'];
  for (const raw of lines.slice(r + 1, first)) {
    const t = raw.replace(ART, '').trim();
    if (!t) continue;
    if (/^→\s*/.test(t) && out.length > 1) out[out.length - 1] += ' ' + t.replace(/^→\s*/, '');
    else out.push(t);
  }
  return out.join('\n');
}

// A choice menu with a ❯ on the current option, as Claude Code draws for
// permission prompts, AskUserQuestion, the trust question and its own menus.
// Options are numbered, or plain lines in one column. A question that allows
// several picks (multi) has a check box on each option, and a Submit or Next
// line under them that sends the picks.
// order: the rows the arrow keys move through, top to bottom (0 is the
// Submit or Next line); at: the row the ❯ is on.
function parseMenu(screen) {
  const lines = plainLines(screen);
  const start = Math.max(0, lines.length - 40);
  const numbered = parseNumbered(lines, start);
  const menu = numbered || parsePlain(lines, start);
  if (!menu) return null;
  const trust = menu.options.some((o) => /trust this folder/i.test(o.label));
  if (trust) menu.question = trustQuestion(lines);
  if (/^Rewind\b/.test(menu.question || '')) menu.question = menu.question.replace(/^Rewind\s+/, '').replace(/\s*\(\d+\s*\w+ ago\)/, '');
  if (menu.review) menu.question = reviewQuestion(lines, menu.first);
  const hint = lines.slice(menu.end, menu.end + 9).join(' ');
  // Esc leaves the menu, unless an option is already marked as the Esc one,
  // or Esc means "exit Claude" (the trust question).
  const escOption = menu.options.some((o) => /\(esc\)\s*$/i.test(o.label));
  const esc = !trust && !escOption && (menu.bare || /esc to (cancel|exit|close|go back)/i.test(hint));
  const options = menu.options.map((o) => {
    const raw = o.label.replace(ART, '').replace(/\s*\(esc\)\s*$/i, '');
    const box = menu.multi ? BOX.exec(raw) : null;
    if (box) return { n: o.n, label: raw.slice(box[0].length).trim(), box: true, checked: box[1] !== ' ' };
    const label = raw.replace(/\s*✔\s*/g, '  ').trim().replace(/\s{2,}/g, ' · ');
    return /✔/.test(raw) ? { n: o.n, label, current: true } : { n: o.n, label };
  });
  // With several picks, his own words go in the last check box, which says
  // "Type something" until he types there.
  const boxes = options.filter((o) => o.box);
  const free = menu.multi && menu.button ? boxes[boxes.length - 1] : options.find((o) => /^type something\.?$/i.test(o.label));
  const order = menu.order || options.map((o) => o.n);
  return {
    question: menu.question,
    selected: menu.selected,
    options,
    esc,
    // The model menu can apply a pick to this session only, which keeps his default.
    sessionKey: /\bs to use this session only\b/i.test(hint),
    free: free ? free.n : null,
    multi: !!menu.multi,
    button: menu.button || null,
    order,
    at: menu.at != null ? menu.at : Math.max(0, order.indexOf(menu.selected)),
  };
}

const BOX = /^\[( |✔|✓|x|X|×)\]\s+/;
const BUTTON = /^\s*(❯\s*)?(Submit|Next)\s*$/;
const REVIEW = /^\s*Review your answers\s*$/;

function parseNumbered(lines, start) {
  const opts = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/.exec(lines[i]);
    if (m) opts.push({ i, n: Number(m[2]), label: m[3], on: !!m[1] });
  }
  // The ❯ can sit on the Submit or Next line of a question with check boxes.
  const onButton = (g) => lines.slice(g[0].i, g[g.length - 1].i).some((l) => /^\s*❯/.test(l) && BUTTON.test(l));
  let best = null;
  for (let a = 0; a < opts.length; a++) {
    if (opts[a].n !== 1) continue;
    const group = [opts[a]];
    for (let b = a + 1; b < opts.length; b++) {
      const prev = group[group.length - 1];
      if (opts[b].n !== prev.n + 1 || opts[b].i - prev.i > 4) break;
      group.push(opts[b]);
    }
    if (group.length >= 2 && (group.some((o) => o.on) || onButton(group))) best = group;
  }
  if (!best) return null;
  const first = best[0].i;
  const last = best[best.length - 1].i;
  const near = lines.slice(Math.max(0, first - 1), Math.min(lines.length, last + 8)).join('\n');
  // Some of Claude's own menus (the rewind question) have no key hint: they
  // sit under a ▔ bar with nothing below them.
  const bare = lines.slice(last + 1).every((l) => !l.trim()) && lines.slice(Math.max(0, first - 14), first).some((l) => /^\s*▔{10,}/.test(l));
  // Nor does the last step of a question menu, "Review your answers".
  const review = lines.slice(last + 1).every((l) => !l.trim()) && best.some((o) => o.on) && lines.slice(Math.max(0, first - 30), first).some((l) => REVIEW.test(l));
  if (!HINT.test(near) && !bare && !review) return null;
  const multi = best.filter((o) => BOX.test(o.label)).length >= 2;
  let button = null;
  let order = null;
  let at = null;
  if (multi) {
    const rows = best.map((o) => ({ i: o.i, n: o.n, on: o.on }));
    for (let i = first; i <= last; i++) {
      const m = BUTTON.exec(lines[i]);
      if (m) {
        button = m[2];
        rows.push({ i, n: 0, on: !!m[1] });
        break;
      }
    }
    rows.sort((x, y) => x.i - y.i);
    order = rows.map((r) => r.n);
    at = Math.max(0, rows.findIndex((r) => r.on));
  }
  return {
    question: questionAbove(lines, first),
    selected: (best.find((o) => o.on) || best[0]).n,
    options: best.map((o) => ({ n: o.n, label: o.label })),
    end: last + 1,
    first,
    bare,
    review,
    multi,
    button,
    order,
    at,
  };
}

function parsePlain(lines, start) {
  let hint = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (HINT.test(lines[i])) {
      hint = i;
      break;
    }
  }
  if (hint < 0) return null;
  let on = -1;
  for (let i = hint - 1; i >= Math.max(start, hint - 14); i--) {
    if (RULE.test(lines[i])) return null;
    if (/^\s*❯\s+\S/.test(lines[i])) {
      on = i;
      break;
    }
  }
  if (on < 0) return null;
  const col = lines[on].indexOf('❯') + (/^(\s*❯\s+)/.exec(lines[on])[1].length - lines[on].indexOf('❯'));
  const isOption = (l) => l.trim() && !RULE.test(l) && (/^\s*❯\s+\S/.test(l) || (l.length > col && l.slice(0, col).trim() === '' && l[col] !== ' '));
  let a = on;
  while (a - 1 >= start && isOption(lines[a - 1]) && lines[a - 1].search(/\S/) <= col) a--;
  let b = on;
  while (b + 1 < hint && isOption(lines[b + 1])) b++;
  const rows = [];
  for (let i = a; i <= b; i++) rows.push({ i, label: lines[i].replace(/^\s*❯?\s*/, '').trim() });
  if (rows.length < 2 || rows.length > 9) return null;
  return {
    question: questionAbove(lines, a),
    selected: on - a + 1,
    options: rows.map((r, k) => ({ n: k + 1, label: r.label })),
    end: b + 1,
    bare: false,
  };
}

// The mode the footer shows under the prompt: "bypass permissions",
// "auto mode", "manual mode", "accept edits", "plan mode".
function parseMode(screen) {
  const lines = plainLines(screen);
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
    const m = /(?:⏵⏵|⏸|▶▶)\s+(.+?)\s+on\b/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return null;
}

// What is typed at the prompt, as plain text.
function promptText(screen) {
  const lines = plainLines(screen);
  let i = lines.length - 1;
  for (; i >= 0; i--) if (/^\s*❯/.test(lines[i])) break;
  if (i < 0) return '';
  const out = [lines[i].replace(/^\s*❯\s?/, '')];
  for (let j = i + 1; j < lines.length; j++) {
    if (RULE.test(lines[j])) break;
    out.push(lines[j].replace(/^\s{0,2}/, ''));
  }
  return out.join('\n').replace(/\s+$/, '');
}

module.exports = { promptState, parseActivity, parseMenu, parseMode, promptText, strip };

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

// A numbered choice menu with a ❯ on the current option, as Claude Code
// draws for permission prompts and AskUserQuestion.
function parseMenu(screen) {
  const lines = plainLines(screen);
  const start = Math.max(0, lines.length - 40);
  const opts = [];
  for (let i = start; i < lines.length; i++) {
    const m = /^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/.exec(lines[i]);
    if (m) opts.push({ i, n: Number(m[2]), label: m[3], on: !!m[1] });
  }
  let best = null;
  for (let a = 0; a < opts.length; a++) {
    if (opts[a].n !== 1) continue;
    const group = [opts[a]];
    for (let b = a + 1; b < opts.length; b++) {
      const prev = group[group.length - 1];
      if (opts[b].n !== prev.n + 1 || opts[b].i - prev.i > 4) break;
      group.push(opts[b]);
    }
    if (group.length >= 2 && group.some((o) => o.on)) best = group;
  }
  if (!best) return null;
  const first = best[0].i;
  const last = best[best.length - 1].i;
  const near = lines.slice(Math.max(0, first - 1), Math.min(lines.length, last + 8)).join('\n');
  if (!/esc to (cancel|exit|close)|enter to (select|confirm)|to navigate|\(esc\)/i.test(near)) return null;
  let question = '';
  for (let i = first - 1; i >= Math.max(0, first - 6); i--) {
    const t = lines[i].trim();
    if (!t) {
      if (question) break;
      continue;
    }
    if (RULE.test(t) || /^[╭╰┌└]/.test(t)) break;
    question = question ? `${t} ${question}` : t;
    if (/[?:]$/.test(t)) break;
  }
  return {
    question,
    selected: (best.find((o) => o.on) || best[0]).n,
    options: best.map((o) => ({ n: o.n, label: o.label.replace(/\s*\(esc\)\s*$/i, '') })),
  };
}

module.exports = { promptState, parseActivity, parseMenu, strip };

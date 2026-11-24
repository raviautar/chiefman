// The questions a box asks in chiefman's reply shape: one block at the end
// of its reply,
//
//   ```questions
//   1. Merge the fix now? [yes/no]
//   2. Which environment first? [one: dev | stage]
//   3. Which checks should run? [any: api | ui | load]
//   ```
//
// Each line becomes a widget under the reply. A numbered line without a
// tag gets only "Reply in your words". Any other line in the block, or a
// number twice, and the block is not read at all: a wrong widget is worse
// than none.

const BLOCK = /(^|\n)[ \t]*```[ \t]*questions[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/i;
const LINE = /^\s*(\d{1,2})[.)]\s+(.+?)\s*$/;
const TAG = /^(.*?)\s*\[\s*(yes\s*\/\s*no|one\s*:([^\]]*)|any\s*:([^\]]*))\s*\]\s*$/i;

function askOf(line) {
  const m = LINE.exec(line);
  if (!m) return null;
  const n = Number(m[1]);
  const t = TAG.exec(m[2]);
  if (!t) return { n, q: m[2], kind: 'words', options: [] };
  const q = t[1].trim();
  if (!q) return null;
  if (/^yes/i.test(t[2])) return { n, q, kind: 'yesno', options: [] };
  const options = [...new Set((t[3] != null ? t[3] : t[4]).split('|').map((o) => o.trim()).filter(Boolean))];
  const kind = t[3] != null ? 'one' : 'any';
  if (options.length < 2 || options.length > 8 || options.some((o) => o.length > 80)) return { n, q, kind: 'words', options: [] };
  return { n, q, kind, options };
}

// The reply without its block, and the questions; null when there is no
// block it can read.
function splitAsks(text) {
  const m = BLOCK.exec(String(text || ''));
  if (!m) return null;
  const asks = [];
  for (const line of m[2].split('\n')) {
    if (!line.trim()) continue;
    const a = askOf(line);
    if (!a || asks.some((x) => x.n === a.n)) return null;
    asks.push(a);
  }
  if (!asks.length) return null;
  const at = m.index + m[1].length;
  const rest = (text.slice(0, at) + text.slice(m.index + m[0].length)).replace(/\n{3,}/g, '\n\n').trim();
  return { text: rest, asks };
}

module.exports = { splitAsks };

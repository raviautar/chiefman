import type { Item } from './api';
import { Icon } from './icons';
import { plainText } from './plain';

// Cmd+F in the open chat: what he looks for, every place it is, the one he
// is on. A folded part that holds that one opens (Unfolded, in Markdown).

// Every string in a card's data; its kind and tone are not words he reads.
function strings(v: unknown, out: string[], key = '') {
  if (typeof v === 'string') {
    if (key !== 'kind' && key !== 'tone' && key !== 'url') out.push(v);
  } else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, out, k);
}

// The words of one chat row as he reads them, folded parts too.
export function wordsOf(m: Item): string {
  const parts: string[] = [m.t || '', m.tail || ''];
  for (const a of m.asks || []) {
    parts.push(a.q);
    strings(a.options, parts);
  }
  for (const r of m.asked || []) parts.push(r.q, r.a);
  if (m.cards) strings(m.cards, parts);
  const t = m.turn;
  if (t) {
    parts.push(...t.files.map((f) => f.path), ...t.outside.map((o) => o.say), ...t.git.map((g) => g.say));
    parts.push(...t.failed.map((f) => [f.say, ...f.tail].join(' ')), ...(t.agents || []).map((a) => a.say), ...(t.background || []).map((b) => b.say), ...t.other.map((o) => o.say));
  }
  return (m.mono ? parts.join(' ').replace(/\s+/g, ' ') : plainText(parts.filter(Boolean).join('\n\n'))).toLowerCase();
}

export function countIn(hay: string, q: string) {
  let n = 0;
  for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) n++;
  return n;
}

// Each place the words are, in the chat's order: its row, and which one of
// that row's places it is.
export function findAll(items: Item[], q: string) {
  const out: { id: string; nth: number }[] = [];
  if (!q) return out;
  for (const m of items) {
    const n = countIn(wordsOf(m), q);
    for (let k = 0; k < n; k++) out.push({ id: m.id, nth: k });
  }
  return out;
}

interface Highlights {
  set(name: string, h: unknown): void;
  delete(name: string): void;
}
const reg = () => (globalThis.CSS as unknown as { highlights?: Highlights }).highlights;
const HL = () => (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;

export function unpaint() {
  reg()?.delete('cm-find');
  reg()?.delete('cm-find-now');
}

// Marks every place the words show in the chat, the one he is on darker,
// and gives that one back.
export function paint(root: HTMLElement, q: string, holder: Element | null, nth: number): Range | null {
  const r = reg();
  const H = HL();
  unpaint();
  if (!r || !H || !q) return null;
  const all: Range[] = [];
  const mine: Range[] = [];
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.find-bar, .md-copy, .md-more') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const s = (n.nodeValue || '').toLowerCase();
    for (let i = s.indexOf(q); i >= 0; i = s.indexOf(q, i + q.length)) {
      const g = document.createRange();
      g.setStart(n, i);
      g.setEnd(n, i + q.length);
      all.push(g);
      if (holder && holder.contains(n)) mine.push(g);
    }
  }
  r.set('cm-find', new H(...all));
  const now = mine[Math.min(nth, mine.length - 1)] || null;
  if (now) r.set('cm-find-now', new H(now));
  return now;
}

// The bar at the top of the chat: the words, "3 of 12", previous, next.
export function FindBar({ q, at, total, onQ, onStep, onClose }: { q: string; at: number; total: number; onQ: (q: string) => void; onStep: (d: 1 | -1) => void; onClose: () => void }) {
  return (
    <div className="find-dock">
      <div className="find-bar" role="search">
        <input
          className="find-q"
          autoFocus
          value={q}
          placeholder="Find in this chat"
          aria-label="Find in this chat"
          onChange={(e) => onQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }
          }}
        />
        <span className="find-n" aria-live="polite">
          {q.trim() ? (total ? `${at + 1} of ${total}` : 'None') : ''}
        </span>
        <button type="button" className="find-btn" aria-label="Previous" title="Previous (Shift+Enter)" disabled={!total} onClick={() => onStep(-1)}>
          <Icon name="above" />
        </button>
        <button type="button" className="find-btn" aria-label="Next" title="Next (Enter)" disabled={!total} onClick={() => onStep(1)}>
          <Icon name="down" />
        </button>
        <button type="button" className="find-btn" aria-label="Close" title="Esc" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
    </div>
  );
}

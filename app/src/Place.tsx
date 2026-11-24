import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Item } from './api';

// The newest reply he has seen in each box, kept on this computer only.
const KEY = 'chiefman.seen.';
type Seen = { id: string; ts?: string };

function read(key: string): Seen | null {
  try {
    const v = localStorage.getItem(KEY + key);
    const s = v ? JSON.parse(v) : null;
    return s && typeof s.id === 'string' ? s : null;
  } catch {
    return null;
  }
}

function write(key: string, s: Seen) {
  try {
    localStorage.setItem(KEY + key, JSON.stringify(s));
  } catch {}
}

const isReply = (i: Item) => i.k === 'box';

// The id of the thin "New" line in the chat's list.
export const NEW_LINE = 'new-line';

// Where he left a box. When he opens it with replies he has not seen, a thin
// New line sits above the first one and the chat opens there. Replies that
// come while he reads higher up are counted on a round ↓.
// reset: counts the chat's full loads; the first one after the box opens
// says what is new.
export function usePlace({
  key,
  items,
  loaded,
  reset,
  fresh,
  scroller,
  stick,
}: {
  key: string;
  items: Item[];
  loaded: boolean;
  reset: number;
  fresh: Set<string> | undefined;
  scroller: RefObject<HTMLDivElement | null>;
  stick: RefObject<boolean>;
}) {
  const base = useRef(reset);
  const newAt = useRef<string | null | undefined>(undefined);
  const placed = useRef(false);
  const [late, setLate] = useState(false);
  const [below, setBelow] = useState(0);
  const latest = useRef(items);
  latest.current = items;

  // A load that came before the box opened is not waited for long.
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 1500);
    return () => clearTimeout(t);
  }, []);

  if (newAt.current === undefined && loaded && (reset > base.current || late)) {
    newAt.current = null;
    const s = read(key);
    if (s) {
      const from = items.findIndex((i) => i.id === s.id);
      const at = from >= 0 ? items.findIndex((i, n) => n > from && isReply(i)) : s.ts ? items.findIndex((i) => isReply(i) && !!i.ts && i.ts > s.ts!) : -1;
      if (at >= 0) newAt.current = items[at].id;
    }
  }
  const decided = newAt.current !== undefined;

  function markSeen() {
    if (!decided || !document.hasFocus()) return;
    const list = latest.current;
    for (let i = list.length - 1; i >= 0; i--)
      if (isReply(list[i])) {
        const s = read(key);
        if (!s || s.id !== list[i].id) write(key, { id: list[i].id, ts: list[i].ts });
        return;
      }
  }

  // The chat opens at the New line, not at the bottom, when the new replies
  // are taller than the window.
  useLayoutEffect(() => {
    if (placed.current || !decided) return;
    placed.current = true;
    const el = scroller.current;
    const line = el?.querySelector('.new-line') as HTMLElement | null;
    if (!el || !line) return;
    const top = line.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 20;
    if (top >= el.scrollTop) return;
    el.scrollTop = Math.max(0, top);
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (!stick.current) {
      const at = items.findIndex((i) => i.id === newAt.current);
      setBelow(items.slice(at).filter(isReply).length);
    }
  });

  // Seen: what shows while he is at the bottom with the window in front.
  useEffect(() => {
    if (stick.current) markSeen();
  });
  useEffect(() => {
    const onFocus = () => stick.current && markSeen();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  });

  // New replies while he reads higher up.
  useEffect(() => {
    if (!decided || !fresh || !fresh.size || stick.current) return;
    const n = latest.current.filter((i) => fresh.has(i.id) && isReply(i)).length;
    if (n) setBelow((b) => b + n);
  }, [fresh]);

  // The list with the New line in it, and how many items must show so the
  // line is among them.
  const at = newAt.current ? items.findIndex((i) => i.id === newAt.current) : -1;
  return {
    newAt: at >= 0 ? newAt.current! : null,
    need: at >= 0 ? items.length - at + 5 : 0,
    below,
    withLine(shown: Item[]) {
      const i = at >= 0 ? shown.findIndex((x) => x.id === newAt.current) : -1;
      if (i < 0) return shown;
      return [...shown.slice(0, i), { id: NEW_LINE, k: 'work' as const, t: 'New' }, ...shown.slice(i)];
    },
    // He scrolled: at the bottom, all is seen and the count goes.
    onScroll(atBottom: boolean) {
      if (!atBottom) return;
      if (below) setBelow(0);
      markSeen();
    },
    jump() {
      const el = scroller.current;
      if (!el) return;
      stick.current = true;
      setBelow(0);
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    },
  };
}

function Down() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14 M6 13l6 6l6-6" />
    </svg>
  );
}

// The round ↓ with a count, at the foot of the chat while he reads higher up.
export function Jump({ n, onClick }: { n: number; onClick: () => void }) {
  if (n <= 0) return null;
  return (
    <div className="jump-dock">
      <button type="button" className="jump" onClick={onClick} aria-label={`${n} new ${n === 1 ? 'reply' : 'replies'}, go down`}>
        <Down />
        <span className="jump-n">{n > 99 ? '99+' : n}</span>
      </button>
    </div>
  );
}

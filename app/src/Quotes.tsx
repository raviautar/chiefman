import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { Bundle, Entry } from './Answers';
import { Check } from './icons';

// A longer quote is cut: the box already has the whole text.
const MAX = 1500;

export function cleanQuote(s: string) {
  const t = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return t.length > MAX ? t.slice(0, MAX).trimEnd() + '…' : t;
}

// His quote replies in the bundle, in the order he made them.
export const quotesOf = (b: Bundle | undefined) => Object.entries(b || {}).filter(([, e]) => e.quote != null);

export const quoteKey = () => 'quote:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Each quote as plain quoted lines with his reply under it, so the box reads
// them the same in the terminal.
export function quoteText(b: Bundle | undefined) {
  return quotesOf(b)
    .map(([, e]) => [...e.quote!.split('\n').map((l) => '> ' + l), e.text.trim()].filter(Boolean).join('\n'))
    .join('\n\n');
}

interface Pick {
  text: string;
  range: Range;
}

// The selection, when it lies inside one of the box's replies and not in the
// answer widgets under it.
function readPick(root: HTMLElement): Pick | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const host = el?.closest('[data-quote]');
  if (!host || !root.contains(host)) return null;
  const asks = host.querySelector('.asks');
  if (asks && range.intersectsNode(asks)) return null;
  const text = cleanQuote(sel.toString());
  return text ? { text, range: range.cloneRange() } : null;
}

// Where the range ends, in the chat's scrolled content. Null once its text
// is gone from the page.
function endOf(range: Range, root: HTMLElement) {
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  const last = rects[rects.length - 1];
  if (!last) return null;
  const o = root.getBoundingClientRect();
  return { x: last.right - o.left + root.scrollLeft, y: last.bottom - o.top + root.scrollTop };
}

// A small text field: Enter keeps, Escape drops, Shift or Option+Enter makes
// a new line.
function Field({
  value,
  label,
  placeholder,
  onChange,
  onKeep,
  onDrop,
  onBlur,
}: {
  value: string;
  label: string;
  placeholder?: string;
  onChange: (t: string) => void;
  onKeep: () => void;
  onDrop: () => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      spellCheck={false}
      aria-label={label}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDrop();
        } else if (e.key === 'Enter' && e.altKey) {
          e.preventDefault();
          document.execCommand('insertText', false, '\n');
        } else if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          onKeep();
        }
      }}
    />
  );
}

// Lives inside the scrolling chat. A selection in a box's reply gets a small
// Reply button at its end; Reply opens a bubble there for his words.
export function Quoter({
  scroller,
  on,
  onKeep,
  onLeave,
  onDone,
}: {
  scroller: RefObject<HTMLDivElement | null>;
  on: boolean;
  onKeep: (quote: string, reply: string) => void;
  // The chat goes away with words still in the bubble: keep them.
  onLeave: (quote: string, reply: string) => void;
  onDone: () => void;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [open, setOpen] = useState<Pick | null>(null);
  const [reply, setReply] = useState('');
  const btn = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const now = useRef({ open, reply, onKeep, onLeave, onDone });
  now.current = { open, reply, onKeep, onLeave, onDone };

  function finish(keep: boolean, refocus = true) {
    const { open: o, reply: r } = now.current;
    if (!o) return;
    if (keep) now.current.onKeep(o.text, r.trim());
    setOpen(null);
    setReply('');
    if (refocus) now.current.onDone();
  }

  useEffect(() => {
    const root = scroller.current;
    if (!on || !root) {
      setPick(null);
      if (now.current.open) finish(!!now.current.reply.trim(), false);
      return;
    }
    const inside = (el: HTMLElement | null, t: EventTarget | null) => !!el && t instanceof Node && el.contains(t);
    const up = (e: MouseEvent) => {
      if (inside(bubble.current, e.target) || inside(btn.current, e.target)) return;
      setTimeout(() => setPick(readPick(root)), 0);
    };
    // A click elsewhere closes the bubble: his words are kept, an empty one goes.
    const down = (e: MouseEvent) => {
      if (inside(btn.current, e.target)) return;
      setPick(null);
      if (now.current.open && !inside(bubble.current, e.target)) finish(!!now.current.reply.trim(), false);
    };
    const change = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setPick(null);
    };
    document.addEventListener('mouseup', up);
    document.addEventListener('mousedown', down, true);
    document.addEventListener('selectionchange', change);
    return () => {
      document.removeEventListener('mouseup', up);
      document.removeEventListener('mousedown', down, true);
      document.removeEventListener('selectionchange', change);
    };
  }, [on]);

  useEffect(
    () => () => {
      const { open: o, reply: r } = now.current;
      if (o && r.trim()) now.current.onLeave(o.text, r.trim());
    },
    [],
  );

  // The button or bubble follows its text when the chat moves under it.
  useLayoutEffect(() => {
    const root = scroller.current;
    const cur = open ?? pick;
    const el = open ? bubble.current : btn.current;
    if (!root || !cur || !el) return;
    const end = endOf(cur.range, root);
    if (!end) return;
    const left = Math.max(12, Math.min(end.x - (open ? 40 : 6), root.clientWidth - el.offsetWidth - 12));
    el.style.left = left + 'px';
    el.style.top = end.y + 6 + 'px';
  });

  // A bubble opened low in the chat scrolls into view.
  useLayoutEffect(() => {
    const root = scroller.current;
    const el = bubble.current;
    if (!open || !root || !el) return;
    const bottom = el.offsetTop + el.offsetHeight + 12;
    if (bottom > root.scrollTop + root.clientHeight) root.scrollTop = bottom - root.clientHeight;
  }, [open]);

  // The quoted piece stays marked while he writes.
  useEffect(() => {
    const reg = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    const Mark = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
    if (!open || !reg || !Mark) return;
    reg.set('cm-quote', new Mark(open.range));
    return () => {
      reg.delete('cm-quote');
    };
  }, [open]);

  return (
    <>
      {pick && !open && (
        <button
          ref={btn}
          className="quote-btn"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setOpen(pick);
            setPick(null);
            setReply('');
          }}
        >
          Reply
        </button>
      )}
      {open && (
        <div ref={bubble} className="quote-bubble">
          <Field value={reply} label="Your reply to the quote" placeholder="Reply" onChange={setReply} onKeep={() => finish(true)} onDrop={() => finish(false)} />
          <button className="qb-add" aria-label="Add this reply" onClick={() => finish(true)}>
            <Check size={12} />
          </button>
        </div>
      )}
    </>
  );
}

// What waits for Send, just above the message field: the widget answers as
// one line, then one line per quote reply. A click on a reply edits it.
export function Tray({
  answers,
  quotes,
  onClearAnswers,
  onReply,
  onRemove,
  onDone,
}: {
  answers: string;
  quotes: [string, Entry][];
  onClearAnswers: () => void;
  onReply: (key: string, text: string) => void;
  onRemove: (key: string) => void;
  onDone: () => void;
}) {
  const [editing, setEditing] = useState<{ key: string; text: string } | null>(null);
  // Leaving the field saves, unless Enter or Escape already closed it.
  const cur = useRef(editing);
  cur.current = editing;
  if (!answers && !quotes.length) return null;
  const save = () => {
    const e = cur.current;
    if (!e) return;
    cur.current = null;
    onReply(e.key, e.text.trim());
    setEditing(null);
  };
  const drop = () => {
    cur.current = null;
    setEditing(null);
  };
  return (
    <div className="quote-tray">
      {answers && (
        <div className="qt-line">
          <span className="qt-main qt-answers" title={answers}>
            <Check size={12} />
            {answers}
          </span>
          <button className="qt-x" aria-label="Clear these answers" onClick={onClearAnswers}>
            ×
          </button>
        </div>
      )}
      {quotes.map(([key, e]) =>
        editing?.key === key ? (
          <div key={key} className="qt-line editing">
            <span className="qt-quote">{e.quote}</span>
            <Field
              value={editing.text}
              label="Your reply to the quote"
              placeholder="Reply"
              onChange={(t) => setEditing({ key, text: t })}
              onKeep={() => {
                save();
                onDone();
              }}
              onDrop={() => {
                drop();
                onDone();
              }}
              onBlur={save}
            />
          </div>
        ) : (
          <div key={key} className="qt-line">
            <button className="qt-main" title="Edit your reply" onClick={() => setEditing({ key, text: e.text })}>
              <span className="qt-quote">{e.quote}</span>
              {e.text && <span className="qt-reply">{e.text}</span>}
            </button>
            <button className="qt-x" aria-label="Remove this reply" onClick={() => onRemove(key)}>
              ×
            </button>
          </div>
        ),
      )}
    </div>
  );
}

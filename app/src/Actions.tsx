import { useEffect, useRef, useState } from 'react';
import { Box } from './api';
import { StateMark } from './icons';
import { badChars, nameInput } from './NewBox';

// parent: a click on what sits beside it (the button that opened it) is its
// own, so that button's click closes it.
function useAway(ref: React.RefObject<HTMLElement | null>, onClose: () => void, parent = false) {
  useEffect(() => {
    const away = (e: MouseEvent) => {
      const own = parent ? ref.current?.parentElement ?? ref.current : ref.current;
      if (own && !own.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    const t = setTimeout(() => document.addEventListener('mousedown', away), 0);
    window.addEventListener('keydown', esc, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [ref, onClose]);
}

export interface Action {
  label: string;
  // Its shortcut, shown on the right.
  hint?: string;
  run: () => void;
}

export function MoreMenu({ actions, onClose }: { actions: Action[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useAway(ref, onClose, true);
  return (
    <div className="menu" ref={ref} role="menu">
      {actions.map((a) => (
        <button
          key={a.label}
          role="menuitem"
          onClick={() => {
            onClose();
            a.run();
          }}
        >
          <span>{a.label}</span>
          {a.hint && <span className="hint">{a.hint}</span>}
        </button>
      ))}
    </div>
  );
}

const kTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

function money(n: number) {
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

// What the box cost and how full its context is, for where he looks: the
// card under its name, its sidebar row, the model picker.
export function meterOf(b: Box) {
  const parts = [];
  if (b.cost != null && b.cost > 0) parts.push(money(b.cost));
  if (b.context != null) parts.push(`${Math.round(b.context * 100)}% context`);
  if (b.tokens) parts.push(`${kTokens(b.tokens.used)} of ${kTokens(b.tokens.max)} tokens`);
  return parts.join(' · ');
}

export const costOf = (b: Box) => (b.cost != null && b.cost > 0 ? money(b.cost) : '');

// One question, asked in the app, never in a browser dialog. Esc or a click
// outside says no; the one button says yes. When yes ends or deletes
// something, it is not the default button, so Enter alone does nothing.
export function Confirm({
  title,
  body,
  quote,
  yes,
  ending,
  onYes,
  onClose,
}: {
  title: string;
  body?: string;
  quote?: string;
  yes: string;
  ending?: boolean;
  onYes: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useAway(ref, onClose);
  useEffect(() => {
    if (ending) ref.current?.focus();
  }, []);
  return (
    <>
      <div className="scrim" />
      <div className="sheet small" role="dialog" aria-label={title} ref={ref} tabIndex={-1}>
        <h2>{title}</h2>
        {quote && <blockquote className="sheet-quote">{quote}</blockquote>}
        {body && <p className="sheet-body">{body}</p>}
        <div className="sheet-foot">
          <button
            className={ending ? 'btn ending' : 'btn dark'}
            autoFocus={!ending}
            onClick={() => {
              onYes();
              onClose();
            }}
          >
            {yes}
          </button>
        </div>
      </div>
    </>
  );
}

// The name, selected, and Enter. Esc or a click outside keeps the old one.
export function RenameSheet({ box, taken, onRename, onClose }: { box: Box; taken: string[]; onRename: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(box.name);
  const ref = useRef<HTMLDivElement>(null);
  useAway(ref, onClose);
  const clean = name.replace(/-+$/, '');
  const bad = badChars(clean);
  const err = bad
    ? `${bad} can't be in a name. Use letters, digits and dashes.`
    : clean && clean !== box.name && taken.includes(clean)
      ? 'That name is taken.'
      : '';
  const ok = !!clean && !err && clean !== box.name;
  const go = () => {
    if (!ok) return;
    onClose();
    onRename(clean);
  };
  return (
    <>
      <div className="scrim" />
      <div className="sheet small rename" role="dialog" aria-label="Rename" ref={ref}>
        <div className="rename-row">
          <input
            autoFocus
            aria-label="Name"
            value={name}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(nameInput(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
          <button className="btn dark" disabled={!ok} onClick={go}>
            Rename
          </button>
        </div>
        {err && <span className="err">{err}</span>}
      </div>
    </>
  );
}

// Cmd+K: every box and every action, each with its shortcut, filtered as he
// types.
export function Palette({
  boxes,
  hints,
  actions,
  onPick,
  onClose,
}: {
  boxes: Box[];
  hints: Record<string, string>;
  actions: Action[];
  onPick: (b: Box) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const needle = q.trim().toLowerCase();
  const rows: { key: string; label: string; hint?: string; box?: Box; run: () => void }[] = [
    ...boxes.filter((b) => b.name.includes(needle)).map((b) => ({ key: 'b:' + b.id, label: b.name, hint: hints[b.name], box: b, run: () => onPick(b) })),
    ...actions.filter((a) => a.label.toLowerCase().includes(needle)).map((a) => ({ key: 'a:' + a.label, label: a.label, hint: a.hint, run: a.run })),
  ];
  const cur = rows[Math.min(at, rows.length - 1)];
  const go = (r: (typeof rows)[number]) => {
    onClose();
    r.run();
  };
  return (
    <>
      <div className="scrim clear" onClick={onClose} />
      <div className="switcher" role="dialog" aria-label="Go to">
        <input
          autoFocus
          value={q}
          aria-label="Box or action"
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (rows.length) setAt((Math.min(at, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
            } else if (e.key === 'Enter' && cur) go(cur);
          }}
        />
        <div className="switcher-list">
          {rows.map((r) => (
            <button key={r.key} className={r === cur ? 'on' : ''} onMouseDown={() => go(r)}>
              {r.box ? <StateMark box={r.box} /> : <span className="mark" />}
              <span className="label">
                {r.label}
                {r.box?.ended && <span className="sub"> · ended</span>}
              </span>
              {r.hint && <kbd className="hint">{r.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Box } from './api';
import { BoxIcon } from './icons';

function useAway(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
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
  hint?: string;
  run: () => void;
}

export function MoreMenu({ actions, onClose }: { actions: Action[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useAway(ref, onClose);
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

export function ContextPop({ text, onClose }: { text: string | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useAway(ref, onClose);
  return (
    <div className="context-pop" ref={ref} role="dialog" aria-label="Context">
      {text === null ? <span className="muted">Reading…</span> : <pre>{text}</pre>}
    </div>
  );
}

// One question, asked in the app, never in a browser dialog.
export function Confirm({
  title,
  body,
  yes,
  onYes,
  onClose,
}: {
  title: string;
  body: string;
  yes: string;
  onYes: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet small" role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>{title}</h2>
        <p className="sheet-body">{body}</p>
        <div className="sheet-foot">
          <span className="err" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn dark"
            autoFocus
            onClick={() => {
              onClose();
              onYes();
            }}
          >
            {yes}
          </button>
        </div>
      </div>
    </>
  );
}

const slug = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 32);

export function RenameSheet({ box, taken, onRename, onClose }: { box: Box; taken: string[]; onRename: (name: string) => void; onClose: () => void }) {
  const [name, setName] = useState(box.name);
  const clean = name.replace(/-+$/, '');
  const err = clean && clean !== box.name && taken.includes(clean) ? 'That name is taken.' : '';
  const ok = !!clean && !err && clean !== box.name;
  const go = () => {
    if (!ok) return;
    onClose();
    onRename(clean);
  };
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="sheet small" role="dialog" aria-label="Rename" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Rename</h2>
        <div className="field">
          <input
            autoFocus
            aria-label="Name"
            value={name}
            onChange={(e) => setName(slug(e.target.value))}
            onKeyDown={(e) => e.key === 'Enter' && go()}
          />
        </div>
        <div className="sheet-foot">
          <span className="err">{err}</span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn dark" disabled={!ok} onClick={go}>
            Rename
          </button>
        </div>
      </div>
    </>
  );
}

// cmd+K: boxes and actions in one list, filtered as he types.
export function Palette({
  boxes,
  actions,
  onPick,
  onClose,
}: {
  boxes: Box[];
  actions: Action[];
  onPick: (b: Box) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const needle = q.trim().toLowerCase();
  const rows: { key: string; label: string; box?: Box; run: () => void }[] = [
    ...boxes.filter((b) => b.name.includes(needle)).map((b) => ({ key: 'b:' + b.id, label: b.name, box: b, run: () => onPick(b) })),
    ...actions.filter((a) => a.label.toLowerCase().includes(needle)).map((a) => ({ key: 'a:' + a.label, label: a.label, run: a.run })),
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
          placeholder="Box or action"
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
              {r.box ? <BoxIcon icon={r.box.icon} color={r.box.color} size={15} /> : <span className="dot-action" />}
              <span>{r.label}</span>
              {r.box && r.box.status === 'working' && <span className="dot-working" />}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

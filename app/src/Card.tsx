import { useId, useState, type ReactNode } from 'react';
import './card.css';

// The state word on the right takes a colour only for a state.
export type Tone = 'failed' | 'passed' | 'asks' | 'working' | 'waiting';

export interface CardButton {
  label: string;
  onClick: () => void;
  // The one main button is black.
  main?: boolean;
  disabled?: boolean;
  title?: string;
}

function Fold({ open }: { open: boolean }) {
  return (
    <svg className={'wcard-fold' + (open ? ' open' : '')} width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

// One card for every widget: white, a thin line, 12px corners. A title row
// (a 16px icon, the title, a state word on the right), a body that folds and
// unfolds on a click of that row, and an optional row of buttons with the
// main one in black. A finished card (done) is one grey line in place: a
// click opens it, and its title row folds it back to the line.
export function Card({
  icon,
  title,
  state,
  tone,
  children,
  buttons,
  done,
  line,
  bare,
  hint,
  open,
  onOpen,
  defaultOpen = true,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  state?: ReactNode;
  tone?: Tone;
  children?: ReactNode;
  buttons?: CardButton[];
  done?: boolean;
  // What the finished card's one line says; the title when not given.
  line?: ReactNode;
  // The finished line without its icon.
  bare?: boolean;
  // Shown on hover of the line or the title row.
  hint?: string;
  // Open from outside; otherwise the card keeps its own.
  open?: boolean;
  onOpen?: (open: boolean) => void;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [own, setOwn] = useState<boolean | null>(null);
  const bodyId = useId();
  const isOpen = open ?? own ?? (done ? false : defaultOpen);
  const set = (v: boolean) => {
    if (open === undefined) setOwn(v);
    onOpen?.(v);
  };
  const cls = (base: string) => [base, tone, className].filter(Boolean).join(' ');

  if (done && !isOpen)
    return (
      <button type="button" className={cls('wcard-line')} aria-expanded={false} title={hint} onClick={() => set(true)}>
        {icon && !bare && <span className="wcard-icon">{icon}</span>}
        <span className="wcard-line-t">{line ?? title}</span>
        {state != null && <span className="wcard-state">{state}</span>}
      </button>
    );

  const folds = !!children || !!done;
  const head = (
    <>
      {icon && <span className="wcard-icon">{icon}</span>}
      <span className="wcard-title">{title}</span>
      {state != null && <span className="wcard-state">{state}</span>}
      {folds && <Fold open={isOpen} />}
    </>
  );
  return (
    <section className={cls('wcard') + (isOpen ? ' open' : '')}>
      {folds ? (
        <button type="button" className="wcard-head" aria-expanded={isOpen} aria-controls={bodyId} title={hint} onClick={() => set(!isOpen)}>
          {head}
        </button>
      ) : (
        <div className="wcard-head still">{head}</div>
      )}
      {isOpen && children && (
        <div className="wcard-body" id={bodyId}>
          {children}
        </div>
      )}
      {(isOpen || !folds) && buttons && buttons.length > 0 && (
        <div className="wcard-buttons">
          {buttons.map((b) => (
            <button key={b.label} type="button" className={'wcard-btn' + (b.main ? ' main' : '')} disabled={b.disabled} title={b.title} onClick={b.onClick}>
              {b.label}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

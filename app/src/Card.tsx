import { useId, useState, type ReactNode } from 'react';
import { Icon } from './icons';
import './card.css';

// The state word on the right takes a colour only for a state.
export type Tone = 'failed' | 'passed' | 'asks' | 'working' | 'waiting';

export interface CardButton {
  label: string;
  onClick: () => void;
  // The one main button is black.
  main?: boolean;
  // Quiet: grey words, no frame, for a choice he needs only sometimes.
  quiet?: boolean;
  // At the row's left edge, apart from the others.
  left?: boolean;
  disabled?: boolean;
  title?: string;
}

// The fold arrow: the app's 16px "right" mark, turned down when open.
export function Fold({ open }: { open: boolean }) {
  return <Icon name="right" className={'wcard-fold' + (open ? ' open' : '')} />;
}

// One button as every card draws it.
export function CardBtn({ b }: { b: CardButton }) {
  return (
    <button type="button" className={'wcard-btn' + (b.main ? ' wcard-main' : '') + (b.quiet ? ' wcard-quiet' : '') + (b.left ? ' wcard-left' : '')} disabled={b.disabled} title={b.title} onClick={b.onClick}>
      {b.label}
    </button>
  );
}

function Buttons({ list, only, hint }: { list: CardButton[]; only?: boolean; hint?: string }) {
  return (
    <div className={only ? 'wcard-only' : 'wcard-buttons'} title={hint}>
      {list.map((b) => (
        <CardBtn key={b.label} b={b} />
      ))}
    </div>
  );
}

// One card for every widget: white, a thin line, 12px corners. A title row
// (a 16px icon, the title, a state word on the right), a body that folds and
// unfolds on a click of that row, and an optional row of buttons with the
// main one in black. A finished card (done) is one grey line in place: a
// click opens it, and its title row folds it back to the line.
// Its other forms: buttons only (no title: the row of buttons alone), fixed
// (always open, its title row does not fold it), floating (a shadow, for a
// card over the window), and a finished line of several lines (lines).
export function Card({
  icon,
  title,
  state,
  tone,
  children,
  buttons,
  done,
  line,
  lines,
  bare,
  hint,
  open,
  onOpen,
  defaultOpen = true,
  fixed,
  float,
  className,
}: {
  icon?: ReactNode;
  // None: the card is its row of buttons only.
  title?: ReactNode;
  state?: ReactNode;
  tone?: Tone;
  children?: ReactNode;
  buttons?: CardButton[];
  done?: boolean;
  // What the finished card's one line says; the title when not given.
  line?: ReactNode;
  // The finished line runs over several lines, its icon at the top.
  lines?: boolean;
  // The finished line without its icon.
  bare?: boolean;
  // Shown on hover of the line or the title row.
  hint?: string;
  // Open from outside; otherwise the card keeps its own.
  open?: boolean;
  onOpen?: (open: boolean) => void;
  defaultOpen?: boolean;
  fixed?: boolean;
  float?: boolean;
  className?: string;
}) {
  const [own, setOwn] = useState<boolean | null>(null);
  const bodyId = useId();
  const isOpen = fixed || (open ?? own ?? (done ? false : defaultOpen));
  const set = (v: boolean) => {
    if (open === undefined) setOwn(v);
    onOpen?.(v);
  };
  // Prefixed: the app has bare classes such as .main and .asks.
  const cls = (base: string) => [base, tone && 'wcard-' + tone, float && 'wcard-float', className].filter(Boolean).join(' ');

  if (title == null) return buttons && buttons.length ? <Buttons list={buttons} only hint={hint} /> : null;

  if (done && !isOpen)
    return (
      <button type="button" className={cls('wcard-line') + (lines ? ' wcard-lines' : '')} aria-expanded={false} title={hint} onClick={() => set(true)}>
        {icon && !bare && <span className="wcard-icon">{icon}</span>}
        <span className="wcard-line-t">{line ?? title}</span>
        {state != null && <span className="wcard-state">{state}</span>}
      </button>
    );

  const folds = !fixed && (!!children || !!done);
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
        <div className="wcard-head still" title={hint}>
          {head}
        </div>
      )}
      {isOpen && children && (
        <div className="wcard-body" id={bodyId}>
          {children}
        </div>
      )}
      {(isOpen || !folds) && buttons && buttons.length > 0 && <Buttons list={buttons} />}
    </section>
  );
}

import { useEffect, useRef } from 'react';
import { EFFORTS, MODELS } from './api';

// Quiet rows: what the box cost so far and how full its context is, which
// model, how much effort, and for a running box its mode, which a click
// moves on as Shift+Tab does.
export function Picker({
  meter,
  model,
  effort,
  mode,
  onMode,
  onPick,
  onClose,
}: {
  meter?: string;
  model: string | null;
  effort: string | null;
  mode?: string;
  onMode?: () => void;
  onPick: (kind: 'model' | 'effort', value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Its own button closes it with its click.
    const away = (e: MouseEvent) => {
      const own = ref.current?.parentElement ?? ref.current;
      if (own && !own.contains(e.target as Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    setTimeout(() => document.addEventListener('mousedown', away), 0);
    window.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  return (
    <div className="picker" ref={ref} role="dialog" aria-label="Model and effort">
      {meter && <div className="picker-meter">{meter}</div>}
      <div className="picker-row">
        {MODELS.map(([id, label]) => (
          <button key={id} className={id === model ? 'on' : ''} onClick={() => onPick('model', id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="picker-row">
        {EFFORTS.map((e) => (
          <button key={e} className={e === effort ? 'on' : ''} onClick={() => onPick('effort', e)}>
            {e}
          </button>
        ))}
      </div>
      {mode && onMode && (
        <div className="picker-row picker-mode">
          <span className="picker-label">Mode</span>
          <button onClick={onMode} title="Next mode (Shift+Tab)">
            {mode}
            <span className="picker-key">⇧⇥</span>
          </button>
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef } from 'react';
import { EFFORTS, MODELS } from './api';

// Two quiet rows: which model, how much effort.
export function Picker({
  model,
  effort,
  onPick,
  onClose,
}: {
  model: string | null;
  effort: string | null;
  onPick: (kind: 'model' | 'effort', value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && onClose();
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
    </div>
  );
}

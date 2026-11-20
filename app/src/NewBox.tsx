import { useEffect, useRef, useState } from 'react';
import { api, BoxSpec, MODELS, Recent } from './api';
import { BoxIcon, PALETTE, SYMBOLS } from './icons';
import { Picker } from './Picker';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// "Release Notes 2" becomes "release-notes-2".
const slug = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 32);

export function NewBoxSheet({
  taken,
  onCancel,
  onStart,
}: {
  taken: string[];
  onCancel: () => void;
  onStart: (spec: BoxSpec) => void;
}) {
  const [model, setModel] = useState('claude-opus-5-5');
  const [effort, setEffort] = useState('xhigh');
  const [picking, setPicking] = useState(false);
  const fired = useRef(false);
  const [recent, setRecent] = useState<Recent[]>([]);
  const [resume, setResume] = useState<string | null>(null);
  useEffect(() => {
    api()
      .recent()
      .then(setRecent)
      .catch(() => {});
  }, []);
  const ago = (t: number) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 60 ? `${Math.max(1, m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  const [name, setName] = useState('');
  const [color, setColor] = useState(PALETTE[4][1]);
  const [icon, setIcon] = useState('doc');
  const [message, setMessage] = useState('');
  const clean = name.trim();
  const err = !clean ? '' : !NAME.test(clean) ? 'Lowercase letters, digits and dashes.' : taken.includes(clean) ? 'That name is taken.' : '';
  const ready = !!clean && !err;
  return (
    <>
      <div className="scrim" onClick={onCancel} />
      <div className="sheet" role="dialog" aria-label="New box" onKeyDown={(e) => e.key === 'Escape' && !picking && onCancel()}>
        <div className="sheet-head">
          <h2>New box</h2>
          <div style={{ position: 'relative' }}>
            <button className="pill" onClick={() => setPicking(!picking)} aria-label="Model and effort">
              {(MODELS.find((m) => m[0] === model) || ['', model])[1]} · {effort}
            </button>
            {picking && (
              <Picker
                model={model}
                effort={effort}
                onClose={() => setPicking(false)}
                onPick={(k, v) => (k === 'model' ? setModel(v) : setEffort(v))}
              />
            )}
          </div>
        </div>
        <div className="field">
          <label htmlFor="boxname">Name</label>
          <input id="boxname" autoFocus autoComplete="off" value={name} placeholder="release-notes" onChange={(e) => setName(slug(e.target.value))} />
        </div>
        <div className="field" style={{ gap: 8 }}>
          <span className="label">Icon</span>
          <div className="dots">
            {PALETTE.map(([label, c]) => (
              <button
                key={c}
                aria-label={label}
                onClick={() => setColor(c)}
                style={{ background: c, boxShadow: c === color ? `0 0 0 2px #FCFCFB, 0 0 0 4px ${c}` : 'none' }}
              />
            ))}
          </div>
          <div className="tiles">
            {SYMBOLS.map((s) => (
              <button
                key={s}
                aria-label={s}
                onClick={() => setIcon(s)}
                style={s === icon ? { borderColor: color, background: color + '14' } : undefined}
              >
                <BoxIcon icon={s} color={s === icon ? color : '#5B5B59'} size={17} />
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="firstmsg">First message</label>
          <textarea id="firstmsg" rows={4} value={message} placeholder="What should this box do?" onChange={(e) => setMessage(e.target.value)} />
        </div>
        {recent.length > 0 && (
          <div className="field">
            <span className="label">Or resume an earlier session</span>
            <div className="recent">
              {recent.slice(0, 6).map((r) => (
                <button
                  key={r.id}
                  className={resume === r.id ? 'on' : ''}
                  onClick={() => {
                    const pick = resume === r.id ? null : r.id;
                    setResume(pick);
                    if (pick && !name && r.title) setName(slug(r.title));
                  }}
                >
                  <span className="t">{r.title || r.first}</span>
                  <span className="when">{ago(r.at)}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="sheet-foot">
          <span className="err">{err}</span>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn dark"
            disabled={!ready}
            onClick={() => {
              if (fired.current) return;
              fired.current = true;
              onStart({ name: clean.replace(/-+$/, ''), icon, color, message: message.trim(), model, effort, ...(resume ? { resume } : {}) });
            }}
          >
            {resume ? 'Resume' : 'Start box'}
          </button>
        </div>
      </div>
    </>
  );
}

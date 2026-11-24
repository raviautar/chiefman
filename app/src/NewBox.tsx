import { useEffect, useRef, useState } from 'react';
import { api, Box, BoxSpec, MODELS, Recent } from './api';
import { PALETTE, SYMBOLS } from './icons';
import { Picker } from './Picker';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// "Release Notes 2" becomes "release-notes-2".
const slug = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 32);

// A box's icon and colour come from its name. The crown stays the chief's.
const AUTO = SYMBOLS.filter((s) => s !== 'crown');
function lookFor(name: string) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return { icon: AUTO[h % AUTO.length], color: PALETTE[(h >>> 8) % PALETTE.length][1] };
}

// What he typed as a name, as the name field keeps it: lowercase, spaces as
// dashes. Characters a name cannot have stay, so the field can say so.
export const nameInput = (s: string) => Array.from(s.toLowerCase().replace(/[\s_]+/g, '-').replace(/^-+/, '')).slice(0, 32).join('');

// Those characters, for "🚀 can't be in a name", or ''.
export function badChars(s: string) {
  return [...new Set(Array.from(s.replace(/[a-z0-9-]/g, '')))].join(' ');
}

export function NewBoxSheet({
  boxes,
  model: firstModel,
  effort: firstEffort,
  initialMessage,
  onMessage,
  onCancel,
  onStart,
}: {
  boxes: Box[];
  // The model and effort his last box started with.
  model: string;
  effort: string;
  initialMessage: string;
  onMessage: (text: string) => void;
  onCancel: () => void;
  onStart: (spec: BoxSpec, note?: string) => void;
}) {
  const taken = boxes.map((b) => b.name);
  const [model, setModel] = useState(firstModel);
  const [effort, setEffort] = useState(firstEffort);
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
  // What he typed himself. Name shows it again when no session is picked.
  const [own, setOwn] = useState('');
  // His message survives a restart, as a draft, until it is sent.
  const [message, setMessage] = useState(initialMessage);
  const clean = name.trim();

  // A session's own name: its title, or the first words he sent it.
  const nameOf = (r: Recent) => slug(r.title || r.first.split(/\s+/).slice(0, 4).join(' ')).replace(/-+$/, '');
  const base = (r: Recent) => (NAME.test(nameOf(r)) ? nameOf(r) : 'resumed');
  const freeName = (r: Recent) => {
    let n = base(r);
    for (let i = 2; taken.includes(n); i++) n = `${base(r).slice(0, 28)}-${i}`;
    return n;
  };
  // One row per conversation: a session that has a row keeps that row's name.
  const rowOf = (id: string) => boxes.find((b) => b.session === id);
  const nameFor = (r: Recent) => rowOf(r.id)?.name ?? freeName(r);
  const pick = (r: Recent) => {
    setResume(r.id);
    setName(nameFor(r));
  };
  const pickNew = () => {
    setResume(null);
    setName(own);
  };
  const start = (id: string | null, raw: string) => {
    const n = raw.replace(/-+$/, '');
    const row = id ? rowOf(id) : undefined;
    if (fired.current || !NAME.test(n) || (!row && taken.includes(n))) return;
    fired.current = true;
    const r = id ? recent.find((x) => x.id === id) : undefined;
    const note = r && !row && n !== base(r) ? `${base(r)} is a different conversation, so this one is ${n}.` : undefined;
    const lk = lookFor(n);
    onStart({ name: n, icon: lk.icon, color: lk.color, message: message.trim(), model, effort, ...(id ? { resume: id } : {}) }, note);
  };
  const picked = recent.find((r) => r.id === resume);
  const pickedRow = picked ? rowOf(picked.id) : undefined;
  const why = !picked
    ? ''
    : pickedRow
      ? `Already in your list as ${pickedRow.name}. Resume brings it back there.`
      : clean !== base(picked)
        ? `${base(picked)} is a different conversation, so this one is ${clean}.`
        : '';
  const bad = resume ? '' : badChars(clean);
  const err = resume || !clean || bad ? '' : !NAME.test(clean) ? 'Lowercase letters, digits and dashes.' : taken.includes(clean) ? 'That name is taken.' : '';
  const ready = !!clean && !err && !bad;
  const usedBefore = !resume && clean && !err ? recent.find((r) => nameOf(r) === clean.replace(/-+$/, '')) : undefined;
  const shown = recent.slice(0, 6);
  if (picked && !shown.includes(picked)) shown.push(picked);
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
        {picked ? (
          // A picked session keeps its own name and look: only what it is shows.
          <div className="field">
            <span className="label">Resuming</span>
            <div className="picked">
              <span className="picked-name">{clean}</span>
              {picked.first && <span className="sub"> · {picked.first}</span>}
            </div>
            {why && <div className="used-before">{why}</div>}
          </div>
        ) : (
          <div className="field">
            <label htmlFor="boxname">Name</label>
            <input
              id="boxname"
              autoFocus
              autoComplete="off"
              value={name}
              placeholder="release-notes"
              onChange={(e) => {
                const v = nameInput(e.target.value);
                setName(v);
                setOwn(v);
              }}
              onKeyDown={(e) => {
                // Enter starts the box, as Start box does.
                if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                e.preventDefault();
                if (ready) start(null, clean);
              }}
            />
            {bad && (
              <div className="used-before" role="alert">
                {bad} can't be in a name. Use letters, digits and dashes.
              </div>
            )}
            {usedBefore && (
              <div className="used-before">
                This name was used before.{' '}
                <button className="text-btn" onClick={() => pick(usedBefore)}>
                  Resume it instead?
                </button>
              </div>
            )}
          </div>
        )}
        <div className="field">
          <label htmlFor="firstmsg">{picked ? 'Message (optional)' : 'First message'}</label>
          <textarea
            id="firstmsg"
            rows={picked ? 2 : 4}
            value={message}
            placeholder={picked ? 'Sent once it is back' : 'What should this box do?'}
            onChange={(e) => {
              setMessage(e.target.value);
              onMessage(e.target.value);
            }}
          />
        </div>
        {recent.length > 0 && (
          <div className="field">
            <span className="label">Or resume an earlier session</span>
            {/* One click picks a row; a double click resumes it at once. */}
            <div className="recent">
              <button className={resume === null ? 'on' : ''} onClick={pickNew}>
                <span className="t">New</span>
              </button>
              {shown.map((r) => (
                <button
                  key={r.id}
                  className={resume === r.id ? 'on' : ''}
                  onClick={() => pick(r)}
                  onDoubleClick={() => start(r.id, nameFor(r))}
                  title="Double-click to resume"
                >
                  {/* Same-name sessions differ by what he first asked them. */}
                  <span className="t">
                    {r.title || r.first}
                    {r.title && r.first && <span className="sub"> · {r.first}</span>}
                  </span>
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
            onClick={() => start(resume, clean)}
          >
            {resume ? (message.trim() ? 'Resume and send' : 'Resume') : 'Start box'}
          </button>
        </div>
      </div>
    </>
  );
}

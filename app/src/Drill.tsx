import { useEffect, useRef, useState } from 'react';
import { Drill, DrillItem } from './api';
import { Arrow, Check } from './icons';

function ReplyField({ n, onSend }: { n: number; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState('');
  const go = async () => {
    if (text.trim()) await onSend(text.trim());
  };
  return (
    <div className="reply">
      <label htmlFor={'reply' + n} style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        Reply to {n}
      </label>
      <input
        id={'reply' + n}
        autoFocus
        value={text}
        placeholder="Your words"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && go()}
      />
      <button aria-label={'Send reply to ' + n} onClick={go}>
        <Arrow size={13} />
      </button>
    </div>
  );
}

// One click answers once. A new card ignores clicks for its first 600 ms,
// so the second half of a double click on the last card cannot answer it.
function Card({ item, onSend }: { item: DrillItem; onSend: (text: string) => Promise<boolean> }) {
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const born = useRef(Date.now());
  const once = useRef(false);
  const answer = async (text: string) => {
    if (once.current || Date.now() - born.current < 600) return false;
    once.current = true;
    setBusy(true);
    const ok = await onSend(text);
    if (!ok) {
      once.current = false;
      setBusy(false);
    }
    return ok;
  };
  return (
    <div className="card rise" key={item.n}>
      <div className="card-text" title={item.full}>
        {item.text}
      </div>
      {replying ? (
        <ReplyField n={item.n} onSend={answer} />
      ) : (
        <div className="chips">
          {item.words.map((w, i) => (
            <button key={w} className={'chip' + (i === 0 ? ' primary' : '')} disabled={busy} onClick={() => answer(w)}>
              {w}
            </button>
          ))}
          <button className="chip" disabled={busy} onClick={() => Date.now() - born.current >= 600 && setReplying(true)}>
            Reply
          </button>
        </div>
      )}
    </div>
  );
}

// Only what needs him now, one card at a time. A sent answer takes its card
// away at once; the chief's own log then keeps it away.
export function DrillPanel({
  drill,
  sent,
  onSend,
}: {
  drill: Drill | null;
  sent: Record<string, string>;
  onSend: (n: number, text: string) => Promise<boolean>;
}) {
  const open = drill ? drill.items.filter((i) => !sent[`${drill.id}:${i.n}`]) : [];
  const [at, setAt] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (at >= open.length) setAt(Math.max(0, open.length - 1));
  }, [open.length, at]);
  const item = open[at];
  return (
    <aside className="drill" aria-label="Needs you">
      <div className="drill-head">
        <span className="sub">{open.length ? `${at + 1} of ${open.length}` : ''}</span>
        {open.length > 1 && (
          <span className="pager">
            <button className="round" aria-label="Previous" onClick={() => setAt((at - 1 + open.length) % open.length)}>
              <Arrow size={12} dir="left" />
            </button>
            <button className="round" aria-label="Next" onClick={() => setAt((at + 1) % open.length)}>
              <Arrow size={12} dir="right" />
            </button>
          </span>
        )}
      </div>
      {item ? (
        <Card
          key={`${drill!.id}:${item.n}`}
          item={item}
          onSend={async (t) => {
            const ok = await onSend(item.n, t);
            if (ok) setLast(`${item.n}. ${t}`);
            return ok;
          }}
        />
      ) : (
        <div className="drill-empty">Nothing needs you.</div>
      )}
      {drill?.also && <div className="drill-also">Also: {drill.also}</div>}
      {last && (
        <span className="sent-line" key={last}>
          <Check />
          Sent “{last}”
        </span>
      )}
    </aside>
  );
}

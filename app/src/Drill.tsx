import { useEffect, useRef, useState } from 'react';
import { Drill, DrillItem } from './api';
import { Arrow, Check } from './icons';
import { arrange } from './Chat';

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
// The big number is the chief's own, the one he answers by.
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
  const words = arrange(item.words.map((w, i) => ({ n: i, label: w })));
  return (
    <div className="card rise" key={item.n}>
      <div className="card-top">
        <span className="card-n" aria-label={'Item ' + item.n}>
          {item.n}
        </span>
        <div className="card-text" title={item.full}>
          {item.text}
        </div>
      </div>
      {replying ? (
        <ReplyField n={item.n} onSend={answer} />
      ) : (
        <div className="chips">
          {words.map((w) => (
            <button key={w.label} className="chip" disabled={busy} onClick={() => answer(w.label)}>
              {w.label}
            </button>
          ))}
          <button className="reply-link" disabled={busy} onClick={() => Date.now() - born.current >= 600 && setReplying(true)}>
            Reply in your words
          </button>
        </div>
      )}
    </div>
  );
}

// Only what needs him now, one card at a time. A sent answer folds its card
// to one line that says what was sent; the chief's own log then keeps it away.
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
  const [done, setDone] = useState<{ n: number; t: string; id: number } | null>(null);
  useEffect(() => {
    if (at >= open.length) setAt(Math.max(0, open.length - 1));
  }, [open.length, at]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 10000);
    return () => clearTimeout(t);
  }, [done?.id]);
  const item = open[at];
  return (
    <aside className="drill" aria-label="From the chief">
      <div className="drill-head">
        <h2 className="drill-title">From the chief</h2>
        {open.length > 1 && (
          <span className="pager">
            <span className="sub">
              {at + 1} of {open.length}
            </span>
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
            if (ok) setDone({ n: item.n, t, id: Date.now() });
            return ok;
          }}
        />
      ) : (
        <div className="drill-empty">Nothing needs you.</div>
      )}
      {done && (
        <div className="card done-line rise" key={`done:${done.id}`}>
          <span className="card-n small">{done.n}</span>
          <span className="sent-line">
            <Check />
            Sent “{done.t}”
          </span>
        </div>
      )}
      {drill?.also && <div className="drill-also">Also: {drill.also}</div>}
    </aside>
  );
}

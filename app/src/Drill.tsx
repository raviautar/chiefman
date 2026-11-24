import { useEffect, useRef, useState } from 'react';
import { Drill, DrillItem } from './api';
import { Arrow, Check } from './icons';
import { arrange } from './Chat';
import { Bundle, Controls, Entry, entryFor, oneLine } from './Answers';

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
// An item that asks something specific (a list made for his Drill down
// click) has a widget instead: his picks wait with the others for one Send.
function Card({
  item,
  entry,
  onEntry,
  onSend,
}: {
  item: DrillItem;
  entry: Entry | undefined;
  onEntry: (e: Entry | null) => void;
  onSend: (text: string) => Promise<boolean>;
}) {
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
  const ask = item.ask;
  const words = arrange(item.words.map((w, i) => ({ n: i, label: w })));
  const picks = entry?.picks ?? [];
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
        <ReplyField
          n={item.n}
          onSend={async (t) => {
            if (!ask) return answer(t);
            // His words join the other picks and all go at once.
            onEntry(entryFor(item.n, ask.kind, picks, t));
            return onSend(t);
          }}
        />
      ) : (
        <div className="chips">
          {ask ? (
            <Controls kind={ask.kind} options={ask.options} picks={picks} onPicks={(p) => Date.now() - born.current >= 600 && onEntry(entryFor(item.n, ask.kind, p, ''))} />
          ) : (
            words.map((w) => (
              <button key={w.label} className="chip" disabled={busy} onClick={() => answer(w.label)}>
                {w.label}
              </button>
            ))
          )}
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
// Picks made with widgets wait under the cards until one Send sends them all.
export function DrillPanel({
  drill,
  sent,
  floating,
  onSend,
}: {
  drill: Drill | null;
  sent: Record<string, string>;
  floating: boolean;
  onSend: (list: { n: number; text: string }[]) => Promise<boolean>;
}) {
  const open = drill ? drill.items.filter((i) => !sent[`${drill.id}:${i.n}`]) : [];
  const [at, setAt] = useState(0);
  const [done, setDone] = useState<{ t: string; id: number } | null>(null);
  const [bundle, setBundle] = useState<Bundle>({});
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (at >= open.length) setAt(Math.max(0, open.length - 1));
  }, [open.length, at]);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 10000);
    return () => clearTimeout(t);
  }, [done?.id]);
  const item = open[at];
  const keyOf = (n: number) => `${drill?.id}:${n}`;
  const picked = open.filter((i) => i.ask && bundle[keyOf(i.n)]?.text).map((i) => ({ n: i.n, text: bundle[keyOf(i.n)].text }));
  const preview = picked.map((a) => `${a.n}. ${a.text}`).join('\n');

  async function send(list: { n: number; text: string }[]) {
    if (!list.length || sending) return false;
    setSending(true);
    const ok = await onSend(list);
    setSending(false);
    if (ok) {
      setDone({ t: oneLine(list.map((a) => `${a.n}. ${a.text}`).join('\n')), id: Date.now() });
      setBundle((b) => {
        const next = { ...b };
        for (const a of list) delete next[keyOf(a.n)];
        return next;
      });
    }
    return ok;
  }

  return (
    <aside className={'drill' + (floating ? ' float' : '')} aria-label="From the chief">
      <div className="drill-head">
        <h2 className="drill-title">From the chief</h2>
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
          entry={bundle[keyOf(item.n)]}
          onEntry={(e) =>
            setBundle((b) => {
              const next = { ...b };
              if (e) next[keyOf(item.n)] = e;
              else delete next[keyOf(item.n)];
              return next;
            })
          }
          onSend={(t) => {
            if (!item.ask) return send([{ n: item.n, text: t }]);
            return send([...picked.filter((a) => a.n !== item.n), { n: item.n, text: t }].sort((x, y) => x.n - y.n));
          }}
        />
      ) : (
        <div className="drill-empty">Nothing needs you.</div>
      )}
      {preview && (
        <div className="q-send drill-send">
          <button className="chip primary" disabled={sending} onClick={() => send(picked)}>
            Send
          </button>
          <span className="q-preview" title={preview}>
            {oneLine(preview)}
          </span>
        </div>
      )}
      {done && (
        <div className="card done-line rise" key={`done:${done.id}`}>
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

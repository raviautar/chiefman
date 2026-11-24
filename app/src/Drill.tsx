import { useEffect, useRef, useState } from 'react';
import { Drill, DrillItem } from './api';
import { Arrow, Check } from './icons';
import { arrange } from './Chat';
import { Bundle, Controls, Entry, entryFor, oneLine } from './Answers';

function ReplyField({ n, onSend, onClose }: { n: number; onSend: (text: string) => Promise<boolean>; onClose: () => void }) {
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
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') go();
          else if (e.key === 'Escape' && !text) {
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <button aria-label={'Send reply to ' + n} onClick={go}>
        <Arrow size={13} />
      </button>
    </div>
  );
}

// One click answers once. A new item ignores clicks for its first 250 ms,
// so the second half of a double click on the last one cannot answer it.
const WAKE = 250;
// One item: the chief's number, its line (two lines at most; a click shows
// all of it), and its answers right after. An item that asks something
// specific (a list made for his Drill down click) has a widget instead: his
// picks wait with the others for one Send.
function Item({
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
  const [whole, setWhole] = useState(false);
  const born = useRef(Date.now());
  const once = useRef(false);
  const answer = async (text: string) => {
    if (once.current || Date.now() - born.current < WAKE) return false;
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
  const more = item.full && item.full !== item.text;
  return (
    <div className="item rise">
      <span className="item-n" aria-label={'Item ' + item.n}>
        {item.n}
      </span>
      <div className="item-body">
        <span
          className={'item-text' + (more ? ' more' : '') + (whole ? ' whole' : '')}
          title={whole || !more ? undefined : item.full}
          onClick={() => more && setWhole(!whole)}
        >
          {whole ? item.full : item.text}
        </span>
        {replying ? (
          <ReplyField
            n={item.n}
            onClose={() => setReplying(false)}
            onSend={async (t) => {
              if (!ask) return answer(t);
              // His words join the other picks and all go at once.
              onEntry(entryFor(item.n, ask.kind, picks, t));
              return onSend(t);
            }}
          />
        ) : (
          <span className="item-acts">
            {ask ? (
              <Controls kind={ask.kind} options={ask.options} picks={picks} onPicks={(p) => Date.now() - born.current >= WAKE && onEntry(entryFor(item.n, ask.kind, p, ''))} />
            ) : (
              words.map((w) => (
                <button key={w.label} className="chip" disabled={busy} onClick={() => answer(w.label)}>
                  {w.label}
                </button>
              ))
            )}
            <button
              className="reply-link"
              disabled={busy}
              title="Reply in your words"
              onClick={() => Date.now() - born.current >= WAKE && setReplying(true)}
            >
              Reply
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// Only what needs him now, every item at once in a compact list. A sent
// answer folds away to one line that says what was sent; the chief's own log
// then keeps it away. Picks made with widgets wait under the list until one
// Send (or Enter on a pick) sends them all.
export function DrillPanel({
  drill,
  sent,
  floating,
  onSend,
  onClose,
}: {
  drill: Drill | null;
  sent: Record<string, string>;
  floating: boolean;
  onSend: (list: { n: number; text: string }[]) => Promise<boolean>;
  onClose: () => void;
}) {
  const open = drill ? drill.items.filter((i) => !sent[`${drill.id}:${i.n}`]) : [];
  const [done, setDone] = useState<{ t: string; id: number } | null>(null);
  const [bundle, setBundle] = useState<Bundle>({});
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(null), 10000);
    return () => clearTimeout(t);
  }, [done?.id]);
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
    <aside
      className={'drill' + (floating ? ' float' : '')}
      aria-label="From the chief"
      onKeyDown={(e) => {
        // Enter on a pick sends the picks, as Enter in the message field does.
        if (e.key === 'Enter' && picked.length && (e.target as Element).closest('.chip.pick')) {
          e.preventDefault();
          send(picked);
        }
      }}
    >
      <div className="drill-head">
        <button className="icon-btn tip drill-hide" aria-label="Hide" data-tip="Hide" onClick={onClose}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {open.length ? (
        <div className="items">
          {open.map((it) => (
            <Item
              key={`${drill!.id}:${it.n}`}
              item={it}
              entry={bundle[keyOf(it.n)]}
              onEntry={(e) =>
                setBundle((b) => {
                  const next = { ...b };
                  if (e) next[keyOf(it.n)] = e;
                  else delete next[keyOf(it.n)];
                  return next;
                })
              }
              onSend={(t) => {
                if (!it.ask) return send([{ n: it.n, text: t }]);
                return send([...picked.filter((a) => a.n !== it.n), { n: it.n, text: t }].sort((x, y) => x.n - y.n));
              }}
            />
          ))}
        </div>
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
        <div className="done-line rise" key={`done:${done.id}`}>
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

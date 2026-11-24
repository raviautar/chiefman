import { useRef, useState } from 'react';
import { Drill, DrillItem } from './api';
import { Icon } from './icons';
import { arrange } from './Chat';
import { answerText, Bundle, choiceOf, entryFor, given, QRow, QuestionCard, type Kind } from './Answers';

// An item as a card row. One with its own widget (ask) keeps it; the words
// the chief offers ("merge it", "wait") are choices to pick one; an item
// with neither takes a line of his words.
function rowOf(it: DrillItem, key: string, b: Bundle): QRow {
  const kind: Kind = it.ask ? it.ask.kind : it.words.length ? 'one' : 'text';
  const labels: unknown[] = it.ask ? it.ask.options : arrange(it.words.map((w, i) => ({ n: i, label: w }))).map((o) => o.label);
  const e = b[key];
  return { key, n: it.n, q: it.text, kind, choices: labels.map(choiceOf), picks: e?.picks ?? [], words: e?.words ?? '' };
}

// Only what needs him now, every item at once, as one question card: a row
// each, one Send at its foot. A sent answer stays as a grey row, "item ·
// answer"; once all are answered the card is those rows.
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
  // His answers by number, and his own words after them.
  onSend: (list: { n: number; text: string }[], words?: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [bundle, setBundle] = useState<Bundle>({});
  const [words, setWords] = useState('');
  const [sending, setSending] = useState(false);
  // Every item this list showed, so the answered ones keep their row.
  const seen = useRef<{ id: string; items: Map<number, DrillItem> }>({ id: '', items: new Map() });
  if (drill && seen.current.id !== drill.id) seen.current = { id: drill.id, items: new Map() };
  if (drill) for (const it of drill.items) seen.current.items.set(it.n, it);
  const keyOf = (n: number) => `${drill?.id}:${n}`;
  const rows: QRow[] = !drill
    ? []
    : [...seen.current.items.values()]
        .sort((a, b) => a.n - b.n)
        .map((it) => {
          const k = keyOf(it.n);
          const open = sent[k] == null && drill.items.some((x) => x.n === it.n);
          const r = rowOf(it, k, open ? bundle : {});
          return open ? r : { ...r, done: sent[k] ?? 'answered' };
        });
  const open = rows.filter((r) => r.done == null);
  const total = Math.max(drill?.total ?? 0, rows.length);
  const title = `${total - open.length + open.filter(given).length} of ${total} answered`;

  async function send() {
    const list = open.filter(given).map((r) => ({ n: r.n, text: answerText(r.kind, r.picks, r.words) }));
    const w = words.trim();
    if ((!list.length && !w) || sending) return;
    setSending(true);
    const ok = await onSend(list, w || undefined);
    setSending(false);
    if (!ok) return;
    setWords('');
    setBundle((b) => {
      const next = { ...b };
      for (const a of list) delete next[keyOf(a.n)];
      return next;
    });
  }

  const setEntry = (r: QRow, picks: string[], text: string) =>
    setBundle((b) => {
      const next = { ...b };
      const e = entryFor(r.n, r.kind, picks, text);
      if (e) next[r.key] = e;
      else delete next[r.key];
      return next;
    });

  return (
    <aside className={'drill' + (floating ? ' float' : '')} aria-label="From the chief">
      <div className="drill-head">
        <button className="icon-btn tip drill-hide" aria-label="Hide" data-tip="Hide" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>
      {rows.length ? (
        <QuestionCard
          key={drill!.id}
          rows={rows}
          live
          done={!open.length}
          title={title}
          words={words}
          onWords={setWords}
          onPick={(r, p) => setEntry(r, p, r.words)}
          onField={(r, t) => setEntry(r, r.picks, t)}
          onSend={send}
          onClear={() => {
            setWords('');
            setBundle({});
          }}
          sending={sending}
        />
      ) : (
        <div className="drill-empty">Nothing needs you.</div>
      )}
      {drill?.also && <div className="drill-also">Also: {drill.also}</div>}
    </aside>
  );
}

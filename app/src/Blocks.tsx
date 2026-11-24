import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { api, Widget } from './api';
import { Card, type CardButton } from './Card';
import { Markdown, shortUrl } from './Markdown';
import { Check } from './icons';
import './blocks.css';

// The cards a box's blocks make under its reply (electron/blocks.js reads
// them). Each replaces text he would have read or typed. A card is open
// until he sends something after its reply; then it is one grey line, or
// gone where his own message already says it.

// What a card under a reply shows; hint: the line an inferred button row
// replaced, shown on hover.
export type CardData = Widget & { hint?: string };

// The newest open card takes the keys while the message field is empty:
// 1 to 9 pick, Enter the main button, Escape puts it away.
export interface CardKeys {
  // False when the card has no such pick.
  pick?: (n: number) => boolean;
  main?: () => void;
  dismiss: () => void;
}

// Cards he put away with Escape, while the app runs.
const dismissed = new Set<string>();
export const isDismissed = (key: string) => dismissed.has(key);

// A last line shaped 'Reply "post it" to go ahead.' (older replies, and
// boxes that never got the rules): its words become buttons, the line goes.
const SAY = /^(?:reply|say|type|answer|send)(?:\s+with)?\s+((?:["“][^"”\n]{1,40}["”](?:\s*,?\s*(?:or\s+)?)?){1,4})(?:\s+(?:to|and|if|when|so|once|for)\b.*|[.!]?)$/i;

export function inferActions(text: string) {
  const t = text.replace(/\s+$/, '');
  const at = t.lastIndexOf('\n');
  const last = t
    .slice(at + 1)
    .replace(/\*\*|__/g, '')
    .trim();
  const m = SAY.exec(last);
  if (!m) return null;
  const buttons = [...new Set([...m[1].matchAll(/["“]([^"”]+)["”]/g)].map((x) => x[1].trim()).filter(Boolean))].slice(0, 4);
  return buttons.length ? { text: at < 0 ? '' : t.slice(0, at).trimEnd(), buttons, line: last } : null;
}

// The card that takes the keys hands them over while it is shown.
function useKeys(keys: MutableRefObject<CardKeys | null> | undefined, k: CardKeys) {
  const cur = useRef(k);
  cur.current = k;
  useEffect(() => {
    if (!keys) return;
    const own: CardKeys = {
      pick: (n) => cur.current.pick?.(n) ?? false,
      main: () => cur.current.main?.(),
      dismiss: () => cur.current.dismiss(),
    };
    keys.current = own;
    return () => {
      if (keys.current === own) keys.current = null;
    };
  }, [keys]);
}

// One send per card: a second click waits for the first.
function useSend(onSend: (text: string) => Promise<boolean>) {
  const [busy, setBusy] = useState(false);
  const go = async (text: string) => {
    if (busy) return;
    setBusy(true);
    if (!(await onSend(text))) setBusy(false);
  };
  return { busy, go };
}

const svg = (d: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const PEN = svg('M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4');
const HAND = svg('M8 13V5.5a1.5 1.5 0 0 1 3 0V12 M11 11V4.5a1.5 1.5 0 0 1 3 0V12 M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.5 1.5 0 0 1 2.5-1.7L8 16');
const PASS = svg('M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8 12.5l3 3l5-6.5');
const FAIL = svg('M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9 9l6 6 M15 9l-6 6');
const CLOCK = svg('M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 2');

interface Common {
  live: boolean;
  keys?: MutableRefObject<CardKeys | null>;
  onDismiss: () => void;
}

const enter = (keys: unknown) => (keys ? 'Enter' : undefined);
const away = (keys: unknown) => (keys ? 'Esc puts it away' : undefined);

// Up to four buttons under the reply, the first the main one; a click sends
// its words. Once he answered, his own message says it: the row goes.
function Actions({ buttons, hint, live, keys, onDismiss, onSend }: Common & { buttons: string[]; hint?: string; onSend: (t: string) => Promise<boolean> }) {
  const { busy, go } = useSend(onSend);
  useKeys(keys, {
    pick: (n) => {
      if (!buttons[n - 1]) return false;
      go(buttons[n - 1]);
      return true;
    },
    main: () => go(buttons[0]),
    dismiss: onDismiss,
  });
  if (!live) return null;
  return (
    <div className="bk-actions" title={hint}>
      {buttons.map((b, i) => (
        <button key={b} type="button" className={'wcard-btn' + (i === 0 ? ' main' : '')} disabled={busy} title={keys ? (i === 0 ? 'Enter' : String(i + 1)) : undefined} onClick={() => go(b)}>
          {b}
        </button>
      ))}
    </div>
  );
}

const WHERE: Record<string, string> = { slack: 'Slack', ticket: 'Ticket', pr: 'Pull request', email: 'Email', mail: 'Email', jira: 'Jira', github: 'GitHub', notion: 'Notion', linear: 'Linear', confluence: 'Confluence' };

function whereTitle(where: string) {
  const [w, ...rest] = where.split(/\s+/).filter(Boolean);
  if (!w) return 'Draft';
  const head = WHERE[w.toLowerCase()] || w.charAt(0).toUpperCase() + w.slice(1);
  return rest.length ? `${head} · ${rest.join(' ')}` : head;
}

// Text he posts himself: where it goes, the text, Copy and Change.
function Draft({ where, text, live, keys, onDismiss, onQuote }: Common & { where: string; text: string; onQuote: (q: string) => void }) {
  const [copied, setCopied] = useState(false);
  const title = whereTitle(where);
  const copy = () => {
    api().copy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  // Change: a quote reply on the draft, his words go in the message field.
  const first = text.split('\n').find((l) => l.trim()) || '';
  const change = () => onQuote(`${title} draft: ${first.length > 120 ? first.slice(0, 117).trimEnd() + '…' : first}`);
  useKeys(keys, { main: copy, dismiss: onDismiss });
  const buttons: CardButton[] = [
    { label: 'Change', onClick: change },
    { label: copied ? 'Copied' : 'Copy', main: true, onClick: copy, title: enter(keys) },
  ];
  return (
    <Card icon={PEN} title={title} done={!live} line={`${title} draft`} hint={away(keys)} buttons={buttons}>
      <div className="bk-draft">
        <Markdown text={text} fold={false} />
      </div>
    </Card>
  );
}

// Steps only he can do: a checklist; Done says which he left.
function Turn({ steps, live, keys, onDismiss, onSend }: Common & { steps: { text: string; url?: string }[]; onSend: (t: string) => Promise<boolean> }) {
  const [on, setOn] = useState<Set<number>>(() => new Set());
  const { busy, go } = useSend(onSend);
  const toggle = (i: number) =>
    setOn((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  // Nothing ticked reads as all done; a step left unticked is named.
  const done = () => {
    const not = steps.map((_s, i) => i + 1).filter((n) => !on.has(n - 1));
    go(on.size && not.length ? `done, not ${not.join(', ')}` : 'done');
  };
  useKeys(keys, {
    pick: (n) => {
      if (n > steps.length) return false;
      toggle(n - 1);
      return true;
    },
    main: done,
    dismiss: onDismiss,
  });
  const n = steps.length;
  return (
    <Card
      icon={HAND}
      title="Your turn"
      state={live ? (on.size ? `${on.size} of ${n}` : n === 1 ? '1 step' : `${n} steps`) : undefined}
      tone={live ? 'asks' : undefined}
      done={!live}
      line={`Your turn · ${n === 1 ? '1 step' : `${n} steps`}`}
      hint={away(keys)}
      buttons={live ? [{ label: 'Done', main: true, onClick: done, disabled: busy, title: enter(keys) }] : undefined}
    >
      <ol className="bk-steps">
        {steps.map((s, i) => (
          <li
            key={i}
            className={on.has(i) ? 'on' : undefined}
            onClick={(e) => live && !(e.target as Element).closest('a, button, .md-file') && toggle(i)}
          >
            <button type="button" role="checkbox" aria-checked={on.has(i)} aria-label={`Step ${i + 1}`} className="bk-tick" disabled={!live} title={keys ? String(i + 1) : undefined} onClick={() => toggle(i)}>
              {on.has(i) && <Check size={11} />}
            </button>
            <span className="bk-step">
              <Markdown text={s.text} fold={false} />
            </span>
            {s.url && (
              <a className="bk-open" title={s.url} onClick={() => api().openUrl(s.url!)}>
                {shortUrl(s.url)}
              </a>
            )}
          </li>
        ))}
      </ol>
    </Card>
  );
}

// A test run: one count line in green or red, the failed names, a reason
// under a name on a click, and the run.
function Result({ label, passed, failed, fails, url, live, keys, onDismiss }: Common & Extract<Widget, { kind: 'result' }>) {
  const [why, setWhy] = useState<number | null>(null);
  const bad = (failed ?? 0) > 0;
  const count = [bad ? `${failed} failed` : '', passed != null ? `${passed} passed` : bad ? '' : 'none failed'].filter(Boolean).join(' · ');
  const open = () => url && api().openUrl(url);
  useKeys(keys, { main: url ? open : undefined, dismiss: onDismiss });
  return (
    <Card
      icon={bad ? FAIL : PASS}
      title={label || 'Test run'}
      state={count}
      tone={bad ? 'failed' : 'passed'}
      done={!live}
      hint={away(keys)}
      buttons={url ? [{ label: 'Open run', onClick: open, title: enter(keys) }] : undefined}
    >
      {fails.length > 0 ? (
        <ul className="bk-fails">
          {fails.map((f, i) => (
            <li key={i}>
              {f.why ? (
                <button type="button" className="bk-fail more" aria-expanded={why === i} onClick={() => setWhy(why === i ? null : i)}>
                  {f.name}
                </button>
              ) : (
                <span className="bk-fail">{f.name}</span>
              )}
              {why === i && f.why && <div className="bk-why">{f.why}</div>}
            </li>
          ))}
        </ul>
      ) : undefined}
    </Card>
  );
}

function ago(ms: number) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d`;
}

// "Merge it" reads "then merge it"; "PR 12 …" keeps its capitals.
const lead = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

const CHECK_NOW = 'Check it again now and tell me where it stands.';

// What the box waits on, for how long, what it does after; Check now asks
// for a fresh look.
function Waiting({ on, then, url, since, live, keys, onDismiss, onSend }: Common & Extract<Widget, { kind: 'waiting' }> & { since: number | null; onSend: (t: string) => Promise<boolean> }) {
  const { busy, go } = useSend(onSend);
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!live || since == null) return;
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, [live, since]);
  useKeys(keys, { main: () => go(CHECK_NOW), dismiss: onDismiss });
  const buttons: CardButton[] = [];
  if (url) buttons.push({ label: 'Open', onClick: () => api().openUrl(url) });
  if (live) buttons.push({ label: 'Check now', main: true, onClick: () => go(CHECK_NOW), disabled: busy, title: enter(keys) });
  return (
    <Card
      icon={CLOCK}
      title={`Waiting on ${on}`}
      state={live && since != null ? ago(Date.now() - since) : undefined}
      tone={live ? 'waiting' : undefined}
      done={!live}
      line={`Waited on ${on}`}
      hint={away(keys)}
      buttons={buttons}
    >
      {then ? <div className="bk-then">Then {lead(then)}</div> : undefined}
    </Card>
  );
}

// The cards under one reply, in the order written. live: he has not sent
// anything since the reply; waitLive: nor has the box said more. keys: this
// reply's newest open card takes the keys.
export function Cards({
  id,
  cards,
  live,
  waitLive,
  since,
  keys,
  onSend,
  onQuote,
  onDismiss,
}: {
  id: string;
  cards: CardData[];
  live: boolean;
  waitLive: boolean;
  since: number | null;
  keys?: MutableRefObject<CardKeys | null>;
  onSend: (text: string) => Promise<boolean>;
  onQuote: (quote: string) => void;
  onDismiss: () => void;
}) {
  const [, setTick] = useState(0);
  const open = (i: number) => (cards[i].kind === 'waiting' ? waitLive : live) && !dismissed.has(`${id}:${i}`);
  let newest = -1;
  cards.forEach((_c, i) => {
    if (open(i)) newest = i;
  });
  return (
    <div className="bk-cards">
      {cards.map((c, i) => {
        const common: Common = {
          live: open(i),
          keys: i === newest ? keys : undefined,
          onDismiss: () => {
            dismissed.add(`${id}:${i}`);
            setTick((t) => t + 1);
            onDismiss();
          },
        };
        if (c.kind === 'actions') return <Actions key={i} {...common} buttons={c.buttons} hint={c.hint} onSend={onSend} />;
        if (c.kind === 'draft') return <Draft key={i} {...common} where={c.where} text={c.text} onQuote={onQuote} />;
        if (c.kind === 'turn') return <Turn key={i} {...common} steps={c.steps} onSend={onSend} />;
        if (c.kind === 'result') return <Result key={i} {...common} {...c} />;
        return <Waiting key={i} {...common} {...c} since={since} onSend={onSend} />;
      })}
    </div>
  );
}

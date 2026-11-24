import { useRef, useState, type KeyboardEvent } from 'react';
import { Card, type CardButton } from './Card';
import { Check, Icon } from './icons';
import { Markdown } from './Markdown';
import { plainText } from './plain';

// His answers waiting to go, by key: a question's answer (n), his own words
// for a whole card (no n), or a quote reply (quote: the piece of the box's
// text, text: his words). One Send sends them all in one message: numbered
// answers first, as "n. text", by number; the rest after.
export interface Entry {
  n?: number;
  text: string;
  picks?: string[];
  words?: string;
  quote?: string;
}
export type Bundle = Record<string, Entry>;

export function compose(b: Bundle, keys: string[]) {
  const list = keys.map((k) => b[k]).filter((e): e is Entry => !!e && !!e.text.trim());
  const num = list.filter((e) => e.n != null).sort((x, y) => x.n! - y.n!);
  const rest = list.filter((e) => e.n == null);
  return [...num.map((e) => `${e.n}. ${e.text}`), ...rest.map((e) => e.text)].join('\n');
}

// One line of what goes, for the tray above the field.
export const oneLine = (text: string) => text.split('\n').filter(Boolean).join(' · ');

// yesno: Yes and No; one: pick one; any: pick several; words and text: a
// one-line field.
export type Kind = 'yesno' | 'one' | 'any' | 'words' | 'text';

// The answer a question gives: his words in its field, else his picks.
export function answerText(kind: string, picks: string[], words: string) {
  const w = words.replace(/\s+/g, ' ').trim();
  if (w) return w;
  if (kind === 'any') return picks.join(', ');
  return picks[0] || '';
}

export function entryFor(n: number, kind: string, picks: string[], words: string): Entry | null {
  const text = answerText(kind, picks, words);
  return text || words ? { n, text, picks, words } : null;
}

// A choice as the block reader gives it: plain words, or with a mark that
// it is the recommended one (a trailing *, or Claude's "(Recommended)") and
// a note (after " · ", or a note field).
export interface Choice {
  label: string;
  recommended?: boolean;
  note?: string;
}

export function choiceOf(o: unknown): Choice {
  if (o && typeof o === 'object') {
    const c = o as Record<string, unknown>;
    const base = choiceOf(String(c.label ?? c.text ?? c.value ?? ''));
    const note = typeof c.note === 'string' && c.note.trim() ? c.note.trim() : base.note;
    return { label: base.label, ...(c.recommended || base.recommended ? { recommended: true } : {}), ...(note ? { note } : {}) };
  }
  let s = String(o ?? '').trim();
  let note: string | undefined;
  const dot = s.indexOf(' · ');
  if (dot > 0) {
    note = s.slice(dot + 3).trim() || undefined;
    s = s.slice(0, dot).trim();
  }
  let recommended = false;
  if (/\s*\*$/.test(s) || /\s*\(recommended\)$/i.test(s)) {
    recommended = true;
    s = s.replace(/\s*(\*|\(recommended\))$/i, '');
  }
  return { label: s, ...(recommended ? { recommended } : {}), ...(note ? { note } : {}) };
}

// One question on a card: its number and words, what kind of answer it
// takes, and what he gave so far. done: the answer it went with, once sent
// ("skipped" when he moved past it).
export interface QRow {
  key: string;
  n: number;
  q: string;
  kind: Kind;
  choices: Choice[];
  picks: string[];
  words: string;
  done?: string;
}

const YESNO: Choice[] = [{ label: 'yes' }, { label: 'no' }];
const choicesOf = (r: QRow) => (r.kind === 'yesno' ? (r.choices.length ? r.choices : YESNO) : r.kind === 'one' || r.kind === 'any' ? r.choices : []);
const shown = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
// An open question he gave an answer to, not sent yet.
export const given = (r: QRow) => r.done == null && (r.picks.length > 0 || !!r.words.trim());
const counts = (r: QRow) => (r.done != null ? r.done !== 'skipped' : given(r));

// The question the keys go to: the first open one without an answer, else
// the last open one.
export const currentRow = (rows: QRow[]) => {
  const open = rows.filter((r) => r.done == null);
  return open.find((r) => !given(r)) ?? open[open.length - 1] ?? rows[rows.length - 1];
};

// What key 1 to 9 picks on a question: its choice by number; a second press
// takes it back. Null when it has no such choice.
export function keyPick(r: QRow, d: number): string[] | null {
  const c = choicesOf(r)[d - 1];
  if (!c || r.done != null) return null;
  const on = r.picks.includes(c.label);
  if (r.kind === 'any') return on ? r.picks.filter((p) => p !== c.label) : [...r.picks, c.label];
  return on ? [] : [c.label];
}

// What Enter picks on a question not answered yet: its recommended choice
// (once he took that back).
export function recommendedPick(r: QRow | undefined): string[] | null {
  if (!r || r.done != null || given(r)) return null;
  const c = choicesOf(r).find((x) => x.recommended);
  return c ? [c.label] : null;
}

// One click answers once: a new card ignores clicks for its first 250 ms, so
// the second half of a double click that sent the last one cannot answer it.
const WAKE = 250;

function Row({
  r,
  live,
  now,
  onPick,
  onField,
  onEnter,
}: {
  r: QRow;
  live: boolean;
  now: boolean;
  onPick: (picks: string[]) => void;
  onField: (text: string) => void;
  onEnter: () => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const choices = choicesOf(r);
  live = live && r.done == null;
  const lit = hover != null ? choices.filter((c) => c.label === hover) : choices.filter((c) => r.picks.includes(c.label));
  const note = lit
    .map((c) => c.note)
    .filter(Boolean)
    .join(' · ');
  const gave = r.done ?? answerText(r.kind, r.picks, r.words);
  return (
    <div className={'q-row' + (now ? ' q-cur' : '')}>
      <span className="q-n">{r.n}</span>
      <div className="q-main">
        <div className="q-q">
          <Markdown text={r.q} fold={false} />
        </div>
        {!live ? (
          gave && <span className={'q-ans' + (r.done === 'skipped' ? ' skipped' : '')}>{gave}</span>
        ) : choices.length ? (
          <span className="q-chips" role="group" aria-label={`Answers to ${r.n}`}>
            {choices.map((c, i) => {
              const on = r.picks.includes(c.label);
              const next = r.kind === 'any' ? (on ? r.picks.filter((p) => p !== c.label) : [...r.picks, c.label]) : on ? [] : [c.label];
              return (
                <button
                  key={c.label}
                  type="button"
                  className={'q-chip' + (on ? ' on' : '') + (c.recommended ? ' rec' : '') + (r.kind === 'any' ? ' check' : '')}
                  aria-pressed={on}
                  title={(c.recommended ? 'Recommended · ' : '') + `Key ${i + 1}`}
                  onMouseEnter={() => setHover(c.label)}
                  onMouseLeave={() => setHover(null)}
                  onClick={(e) => e.detail < 2 && onPick(next)}
                >
                  {r.kind === 'any' && <span className="q-box">{on && <Check />}</span>}
                  {r.kind === 'yesno' ? shown(c.label) : c.label}
                </button>
              );
            })}
          </span>
        ) : (
          <input
            className="q-field"
            value={r.words}
            placeholder="Your answer"
            aria-label={`Your answer to ${r.n}`}
            onChange={(e) => onField(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                onEnter();
              }
            }}
          />
        )}
      </div>
      {live && note && <div className="q-note">{note}</div>}
    </div>
  );
}

// Questions as one card: a row each with its number, its words and its
// choices; "In your words" for an answer of his own; one Send. Sent, the
// card is grey rows, "question · answer", and a click opens it again.
export function QuestionCard({
  rows,
  live,
  done,
  title,
  words,
  onWords,
  onPick,
  onField,
  onSend,
  onCancel,
  onClear,
  sending,
}: {
  rows: QRow[];
  live: boolean;
  done?: boolean;
  title?: string;
  // The card's own words; undefined: the card has no "In your words".
  words?: string;
  onWords?: (text: string) => void;
  onPick?: (r: QRow, picks: string[]) => void;
  onField?: (r: QRow, text: string) => void;
  onSend?: () => void;
  onCancel?: () => void;
  onClear?: () => void;
  sending?: boolean;
}) {
  const [writing, setWriting] = useState(false);
  const born = useRef(Date.now());
  const on = live && !done;
  const count = rows.filter(counts).length;
  const ready = rows.some(given) || !!words?.trim();
  const head = title ?? (rows.length === 1 && (done || !count) ? (done ? (count ? 'Answered' : 'Skipped') : 'One question') : `${count} of ${rows.length} answered`);
  const cur = on ? currentRow(rows) : undefined;
  const awake = () => Date.now() - born.current >= WAKE;
  const send = () => {
    if (ready && !sending) onSend?.();
  };

  // Keys on the card itself: 1 to 9 pick on the current question, Enter on
  // a choice takes the recommended one or sends, Escape clears the picks.
  function key(e: KeyboardEvent) {
    if (!on || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA';
    if (/^[1-9]$/.test(e.key) && !typing && cur) {
      const p = keyPick(cur, Number(e.key));
      if (p && awake()) onPick?.(cur, p);
      e.preventDefault();
    } else if (e.key === 'Enter' && !typing && t.closest('.q-chip')) {
      e.preventDefault();
      const rec = recommendedPick(cur);
      if (rec && cur) onPick?.(cur, rec);
      else send();
    } else if (e.key === 'Escape' && (!typing || !(t as HTMLInputElement).value) && (ready || writing)) {
      e.preventDefault();
      e.stopPropagation();
      setWriting(false);
      onClear?.();
    }
  }

  const list = (
    <div className="q-rows">
      {rows.map((r) => (
        <Row
          key={r.key}
          r={r}
          live={on}
          now={!!cur && r === cur && rows.length > 1}
          onPick={(p) => awake() && onPick?.(r, p)}
          onField={(t) => onField?.(r, t)}
          onEnter={send}
        />
      ))}
      {on && words != null && (writing || !!words) && (
        <input
          className="q-field q-own"
          autoFocus={writing}
          value={words}
          placeholder="In your words"
          aria-label="Your answer in your words"
          onChange={(e) => onWords?.(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
        />
      )}
    </div>
  );

  if (done)
    return (
      <div className="qcard-wrap">
        <Card
          className="qcard"
          done
          bare
          lines
          icon={<Icon name="ask" />}
          title={head}
          hint="Show the questions"
          line={
            <span className="q-lines">
              {rows.map((r) => (
                <span key={r.key} className="q-line">
                  {plainText(r.q)} · {r.done || 'skipped'}
                </span>
              ))}
            </span>
          }
        >
          {list}
        </Card>
      </div>
    );

  const buttons: CardButton[] = [];
  if (on && words != null && onWords) buttons.push({ label: 'In your words', quiet: true, left: true, onClick: () => setWriting((w) => !w || !words), title: 'Answer in your own words' });
  if (on && onCancel) buttons.push({ label: 'Cancel', quiet: true, onClick: onCancel, title: 'Esc' });
  if (on && onSend) buttons.push({ label: 'Send', main: true, onClick: send, disabled: !ready || sending, title: 'Enter' });
  return (
    <div className="qcard-wrap" onKeyDown={key}>
      <Card className={'qcard' + (on ? '' : ' still')} icon={<Icon name="ask" />} title={head} hint={on ? '1 to 9 picks, Enter sends, Esc clears' : undefined} buttons={buttons}>
        {list}
      </Card>
    </div>
  );
}

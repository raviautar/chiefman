import { useState } from 'react';
import { Ask } from './api';
import { Check } from './icons';
import { Markdown } from './Markdown';

// His answers waiting to go, by key: a widget's answer to question n, or a
// quote reply (quote: the piece of the box's text, text: his words). One
// Send sends them all in one message: numbered answers first, as "n. text",
// by number; the rest after.
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

// One line of what goes, for the Send row and the folded line after.
export const oneLine = (text: string) => text.split('\n').filter(Boolean).join(' · ');

// The answer a widget gives: his words if he wrote some, else his picks.
export function answerText(kind: Ask['kind'], picks: string[], words: string) {
  const w = words.replace(/\s+/g, ' ').trim();
  if (w) return w;
  if (kind === 'yesno') return picks.includes('yes') ? 'yes' : '';
  if (kind === 'one') return picks[0] || '';
  if (kind === 'any') return picks.join(', ');
  return '';
}

export function entryFor(n: number, kind: Ask['kind'], picks: string[], words: string): Entry | null {
  const text = answerText(kind, picks, words);
  return text || words ? { n, text, picks, words } : null;
}

// A check mark for yes; choices to pick one; check boxes to pick several.
export function Controls({ kind, options, picks, onPicks }: { kind: Ask['kind']; options: string[]; picks: string[]; onPicks: (p: string[]) => void }) {
  if (kind === 'yesno') {
    const on = picks.includes('yes');
    return (
      <button className={'chip pick' + (on ? ' on' : '')} aria-pressed={on} onClick={() => onPicks(on ? [] : ['yes'])}>
        <span className="tick" aria-hidden="true">{on && <Check size={11} />}</span>
        Yes
      </button>
    );
  }
  if (kind !== 'one' && kind !== 'any') return null;
  return (
    <>
      {options.map((o) => {
        const on = picks.includes(o);
        const next = kind === 'one' ? (on ? [] : [o]) : on ? picks.filter((p) => p !== o) : [...picks, o];
        return (
          <button key={o} className={'chip pick' + (on ? ' on' : '')} aria-pressed={on} onClick={() => onPicks(next)}>
            {kind === 'any' && <span className="tick" aria-hidden="true">{on && <Check size={11} />}</span>}
            {o}
          </button>
        );
      })}
    </>
  );
}

// His own words for one question. Enter sends everything picked so far.
export function Words({ label, value, onChange, onEnter, onClose }: { label: string; value: string; onChange: (t: string) => void; onEnter: () => void; onClose: () => void }) {
  return (
    <div className="reply q-words">
      <input
        autoFocus
        aria-label={label}
        value={value}
        placeholder="Your words"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
    </div>
  );
}

// The questions under a box's reply. Live: a widget under each; what he
// picks waits above the message field for its Send. Answered: the questions
// only; the line of what was sent shows where his answer is.
export function AskList({
  id,
  asks,
  live,
  bundle,
  onEntry,
  onSend,
}: {
  id: string;
  asks: Ask[];
  live: boolean;
  bundle: Bundle;
  onEntry: (key: string, e: Entry | null) => void;
  onSend: () => void;
}) {
  const [writing, setWriting] = useState<Set<number>>(() => new Set());
  return (
    <div className="asks">
      {asks.map((a) => {
        const key = `${id}:${a.n}`;
        const e = bundle[key];
        const picks = e?.picks ?? [];
        const words = e?.words ?? '';
        const open = writing.has(a.n);
        const set = (p: string[], w: string) => onEntry(key, entryFor(a.n, a.kind, p, w));
        return (
          <div key={a.n} className="q">
            <span className="q-n">{a.n}</span>
            <div className="q-body">
              <div className="q-text">
                <Markdown text={a.q} />
              </div>
              {live && (
                <div className="q-controls">
                  <Controls kind={a.kind} options={a.options} picks={picks} onPicks={(p) => set(p, words)} />
                  {!open && (
                    <button className="reply-link" onClick={() => setWriting((s) => new Set(s).add(a.n))}>
                      Reply in your words
                    </button>
                  )}
                </div>
              )}
              {live && open && (
                <Words
                  label={`Your words for ${a.n}`}
                  value={words}
                  onChange={(w) => set(picks, w)}
                  onEnter={onSend}
                  onClose={() => {
                    set(picks, '');
                    setWriting((s) => {
                      const next = new Set(s);
                      next.delete(a.n);
                      return next;
                    });
                  }}
                />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

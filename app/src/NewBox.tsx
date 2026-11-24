import { useEffect, useState } from 'react';
import { api, Box, Recent } from './api';
import { PALETTE, SYMBOLS } from './icons';

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

// "Release Notes 2" becomes "release-notes-2".
const slug = (s: string) => s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+/, '').slice(0, 32);

// A box's icon and colour come from its name. The crown stays the chief's.
const AUTO = SYMBOLS.filter((s) => s !== 'crown');
export function lookFor(name: string) {
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

// Words that say nothing about what a box is for.
const WEAK = new Set(
  (
    'a an the and or but nor so yet if then than as at by for from in into onto of off on out over under up down to with without about after before ' +
    'while because since until via per i me my mine we us our you your yours he she him her it its they them their this that these those there here ' +
    'what why how when where which who whom whose is are was were be been being am do does did done doing have has had having ' +
    'can could would should will shall may might must let lets please pls plz hey hi hello ok okay thanks thank yes no not just also really very ' +
    'much many more most some any all each every both other same such own way get got gets make makes made go goes going went want wants need ' +
    'needs like see look looks check help try use using new one two thing things stuff something anything everything start started sure know ' +
    'think tell say said give take put keep still again only even well too now today tomorrow yesterday time work working find found box chief ' +
    'write create show run reply answer short quick small little simple brief briefly line lines sentence sentences word words tool tools ' +
    'don doesn didn isn aren wasn won wouldn couldn shouldn ll re ve'
  ).split(' '),
);

// Two or three telling words from his first message, lowercase with dashes:
// "Can you fix the login bug on settings?" becomes "fix-login-bug". Unique
// among his boxes, and never "chief".
export function inferName(text: string, taken: string[]) {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(^|\s)[~/][^\s]*/g, ' ')
    .replace(/^> .*$/gm, ' ')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const words: string[] = [];
  for (const w of plain.match(/[a-z]{2,10}-\d+|[a-z0-9]+/g) || []) {
    if (w.length < 2 || WEAK.has(w) || /^\d+$/.test(w) || words.includes(w)) continue;
    words.push(w);
    if (words.length === 3) break;
  }
  let pick = words.join('-');
  if (pick.length > 24 && words.length > 2) pick = words.slice(0, 2).join('-');
  pick = pick.slice(0, 28).replace(/-+$/, '');
  const base = NAME.test(pick) && pick !== 'chief' ? pick : 'box';
  const used = new Set([...taken, 'chief']);
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  return name;
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 60 ? `${Math.max(1, m)} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};

// A session's own name: its title, or the first words he sent it.
const nameOf = (r: Recent) => slug(r.title || r.first.split(/\s+/).slice(0, 4).join(' ')).replace(/-+$/, '');
const baseOf = (r: Recent) => (NAME.test(nameOf(r)) ? nameOf(r) : 'resumed');

// The name a resumed session gets: the name of the row that already holds
// it, else its own, made unique. note: why it is not its own name.
export function resumeName(r: Recent, boxes: Box[]) {
  const row = boxes.find((b) => b.session === r.id);
  if (row) return { name: row.name };
  const base = baseOf(r);
  const taken = boxes.map((b) => b.name);
  let n = base;
  for (let i = 2; taken.includes(n); i++) n = `${base.slice(0, 28)}-${i}`;
  return { name: n, note: n !== base ? `${base} is a different conversation, so this one is ${n}.` : undefined };
}

// Cmd+K, "Resume an earlier session": the sessions in the working folder,
// newest first, filtered as he types. Enter or a click resumes one.
export function ResumeList({ boxes, onPick, onClose }: { boxes: Box[]; onPick: (r: Recent) => void; onClose: () => void }) {
  const [recent, setRecent] = useState<Recent[] | null>(null);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  useEffect(() => {
    api()
      .recent()
      .then(setRecent)
      .catch(() => setRecent([]));
  }, []);
  const needle = q.trim().toLowerCase();
  const rows = (recent || []).filter((r) => !needle || `${r.title} ${r.first}`.toLowerCase().includes(needle));
  const cur = rows[Math.min(at, rows.length - 1)];
  const go = (r: Recent) => {
    onClose();
    onPick(r);
  };
  return (
    <>
      <div className="scrim clear" onClick={onClose} />
      <div className="switcher" role="dialog" aria-label="Resume an earlier session">
        <input
          autoFocus
          value={q}
          placeholder="Resume an earlier session"
          aria-label="Resume an earlier session"
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              if (rows.length) setAt((Math.min(at, rows.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length);
            } else if (e.key === 'Enter' && cur) go(cur);
          }}
        />
        <div className="switcher-list">
          {recent && !rows.length && <div className="switcher-none">{recent.length ? 'Nothing matches.' : 'No earlier sessions.'}</div>}
          {rows.map((r) => {
            const row = boxes.find((b) => b.session === r.id);
            return (
              <button key={r.id} className={r === cur ? 'on' : ''} onMouseDown={() => go(r)} title={row ? `Already in your list as ${row.name}` : undefined}>
                <span className="label">
                  {r.title || r.first}
                  {r.title && r.first && <span className="sub"> · {r.first}</span>}
                </span>
                <span className="hint">{ago(r.at)}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

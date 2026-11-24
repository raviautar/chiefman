import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, Ask, Box, Draft, Item, Menu, Result } from './api';
import { Arrow, Check } from './icons';
import { Markdown } from './Markdown';
import { AskList, Bundle, compose, Entry, oneLine } from './Answers';
import { quoteKey, quotesOf, quoteText, Quoter, Tray } from './Quotes';

export interface ChatState {
  items: Item[];
  fresh: Set<string>;
  steps: number;
  loaded: boolean;
}

export interface Pending {
  id: string;
  t: string;
  n: string;
  base: number;
  queued: boolean;
  // A skill button's run: a quiet line, not his bubble.
  skill?: boolean;
  // His answers from the widgets: one folded line, not his bubble.
  answer?: boolean;
}

// A message of his that answers a reply's questions by number, every line
// "n. ...": the one line it folds to, or null.
function answerLine(text: string, asks: Ask[]) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const ok = lines.length > 0 && lines.every((l) => {
    const m = /^(\d{1,2})[.)]\s+\S/.exec(l);
    return !!m && asks.some((a) => a.n === Number(m[1]));
  });
  return ok ? oneLine(lines.join('\n')) : null;
}

// Which reply's questions are still open (live), and which of his messages
// answered questions and fold to one line. A reply's questions close at his
// next message, or a skill run, or one waiting to go.
function askState(items: Item[], waiting: boolean) {
  const answered: Record<string, string> = {};
  let live: string | null = null;
  const turn = (i: Item) => i.k === 'you' || (i.k === 'work' && i.id.startsWith('u:'));
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.k !== 'box' || !it.asks?.length) continue;
    const next = items.slice(i + 1).find(turn);
    if (!next) {
      live = waiting ? null : it.id;
      continue;
    }
    if (next.k === 'you') {
      const line = answerLine(next.t, it.asks);
      if (line) answered[next.id] = line;
    }
  }
  return { live, answered };
}

type Attachment = Draft['atts'][number];

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// A picture he attached, served by the app from its attachments folder.
export const attUrl = (p: string) => 'cm-att://f/' + encodeURIComponent(p.slice(p.lastIndexOf('/') + 1));

// His message with any attachment path shown as its picture, or its name.
// A long paste folds as the terminal folds it: the first lines and a count
// of the rest, which a click opens.
const FOLD_OVER = 12;
const FOLD_SHOW = 3;

// His quote replies: each quoted piece as a quiet line, his words under it.
function Quoted({ text }: { text: string }) {
  if (!/^> /m.test(text)) return <>{text}</>;
  const parts: { q: boolean; t: string[] }[] = [];
  for (const l of text.split('\n')) {
    const q = l.startsWith('> ');
    const last = parts[parts.length - 1];
    if (last && last.q === q) last.t.push(q ? l.slice(2) : l);
    else parts.push({ q, t: [q ? l.slice(2) : l] });
  }
  return (
    <>
      {parts.map((p, i) => {
        const t = p.t.join('\n').replace(/^\n+|\n+$/g, '');
        return t ? (
          <span key={i} className={p.q ? 'you-quote' : 'you-line'}>
            {t}
          </span>
        ) : null;
      })}
    </>
  );
}

function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  // Quoted lines do not count toward the fold.
  if (open || lines.filter((l) => !l.startsWith('> ')).length <= FOLD_OVER) return <Quoted text={text} />;
  return (
    <>
      <Quoted text={lines.slice(0, FOLD_SHOW).join('\n')} />
      {'\n'}
      <button className="paste-fold" onClick={() => setOpen(true)} title="Show all of it">
        [Pasted text +{lines.length - FOLD_SHOW} lines]
      </button>
    </>
  );
}

export function YouText({ text, attachDir, onOpen }: { text: string; attachDir: string; onOpen: (url: string) => void }) {
  if (!attachDir || !text.includes(attachDir + '/')) return <Folded text={text} />;
  const esc = attachDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${esc}/[A-Za-z0-9._-]+)`));
  const words = parts.filter((_p, i) => i % 2 === 0).join(' ').trim();
  const files = parts.filter((_p, i) => i % 2 === 1);
  return (
    <>
      {words && (
        <span>
          <Folded text={words} />
        </span>
      )}
      <span className="you-atts">
        {files.map((f) =>
          IMAGE.test(f) ? (
            <button key={f} className="you-img" onClick={() => onOpen(attUrl(f))} aria-label="Open the picture">
              <img src={attUrl(f)} alt="" />
            </button>
          ) : (
            <span key={f} className="att-doc">
              {f.slice(f.lastIndexOf('/') + 1).replace(/^[\dT-]+Z-/, '')}
            </span>
          ),
        )}
      </span>
    </>
  );
}

type Pop =
  | { kind: 'edit'; at: number }
  | { kind: 'search'; at: number; q: string }
  | { kind: 'files'; at: number; q: string; list: string[] };

// A message as compared with its copy in the log: line endings, trailing
// spaces, empty lines, quote style and spacing do not count.
export const norm = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .replace(/[“”„‟]/g, '"')
    .replace(/[‘’‚‛]/g, "'")
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();

// An option that ends, exits, denies or deletes something.
const ENDING = /^\s*(no\b|never ?mind|cancel|exit|quit|deny|decline|reject|delete|remove|discard|abort|stop|don'?t|do not|go back)/i;

// The safe or continuing option is the dark one; an ending option is a plain
// button placed last. Each keeps its number for the pick.
// A list that marks the current choice (the model menu) has no dark option.
export function arrange(options: Menu['options']) {
  const keep = options.filter((o) => !ENDING.test(o.label));
  const end = options.filter((o) => ENDING.test(o.label));
  const lead = options.some((o) => o.current) ? -1 : 0;
  return [...keep.map((o, i) => ({ ...o, primary: i === lead })), ...end.map((o) => ({ ...o, primary: false }))];
}

// Claude's own way out of a menu, unless an option already is one.
const OUT = /^\s*(cancel|never ?mind|no,? go back|go back)\b/i;
export const canCancel = (menu: Menu) => !!menu.esc && !menu.options.some((o) => OUT.test(o.label));

function OptionLabel({ label }: { label: string }) {
  const [main, ...rest] = label.split(' · ');
  return (
    <>
      <span>{main}</span>
      {rest.length > 0 && <span className="opt-note">{rest.join(' · ')}</span>}
    </>
  );
}

const PAGE = 150;
const AT = /(^|\s)@([^\s@]*)$/;

function Live({ text }: { text: string }) {
  return (
    <div className="live rise" aria-live="polite">
      <span className="bars" aria-hidden="true">
        <span className="b1" />
        <span className="b2" />
        <span className="b3" />
        <span className="b4" />
      </span>
      <span className="shimmer">{text}</span>
    </div>
  );
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
}

export function ChatView({
  box,
  chat,
  pending,
  quiet,
  folds,
  incoming,
  initial,
  attachDir,
  onTaken,
  onDraft,
  onRemove,
  note,
  waiting,
  onResume,
  underEnded,
  onOpen,
  onSend,
  onError,
  foot,
}: {
  box: Box;
  chat: ChatState | undefined;
  pending: Pending[];
  quiet: Set<string>;
  folds: Record<string, string>;
  incoming: { text: string; seq: number } | undefined;
  initial: Draft | undefined;
  attachDir: string;
  onTaken: () => void;
  onDraft: (d: Draft | null) => void;
  onRemove: () => Promise<Result>;
  note?: string;
  waiting?: string;
  onResume: () => Promise<Result>;
  // The box sits under Ended in the list, not as a row.
  underEnded?: boolean;
  onOpen: (url: string) => void;
  onSend: (text: string, opts?: { answer?: boolean }) => Promise<boolean>;
  onError: (text: string) => void;
  // The row under the message box: the skill buttons.
  foot?: ReactNode;
}) {
  const [draft, setDraft] = useState(initial?.text ?? '');
  const [sending, setSending] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [hist, setHist] = useState<number | null>(null);
  const [pop, setPop] = useState<Pop | null>(null);
  const [atts, setAtts] = useState<Attachment[]>(initial?.atts ?? []);
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const [retrying, setRetrying] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [endWhy, setEndWhy] = useState<string | null>(null);
  // His answers to a reply's questions and his quote replies, waiting for
  // Send. Kept with the box's draft, so each box keeps its own.
  const [bundle, setBundle] = useState<Bundle>(initial?.bundle ?? {});
  // His ticks on Claude's own question with check boxes, for that question.
  const [ticks, setTicks] = useState<{ key: string; on: number[] } | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const keep = useRef<{ h: number; top: number } | null>(null);
  const lastEsc = useRef(0);
  const shut = useRef<string | null>(null);
  const items = chat?.items ?? [];
  const shown = items.length > limit ? items.slice(-limit) : items;
  const menu = box.menu;
  const starting = box.status === 'starting';
  const resuming = box.status === 'resuming';
  const failed = box.status === 'failed';
  const working = box.status === 'working' && !menu;
  const off = box.status === 'off';
  const ended = box.status === 'ended' || !!box.ended;
  const closed = off || starting || resuming || failed || ended;
  const quotes = quotesOf(bundle);
  const typed = !!draft.trim() || atts.length > 0 || quotes.length > 0;
  // An ended box takes text for Resume and send; it does not send itself.
  const typeAhead = !!ended && !!box.ended?.start;
  const history = [...items.filter((i) => i.k === 'you').map((i) => i.t), ...pending.filter((p) => !p.skill).map((p) => p.t)];
  // His messages that Claude's rewind menu lists: no commands, no shell lines.
  const earlier = items.filter((i) => i.k === 'you' && !/^[/!]/.test(i.t));
  const asked = askState(items, pending.length > 0);
  const liveItem = asked.live ? items.find((i) => i.id === asked.live) : undefined;
  const liveKeys = liveItem?.asks ? liveItem.asks.map((a) => `${liveItem.id}:${a.n}`) : [];
  const answers = compose(bundle, liveKeys);
  // Claude's own question with check boxes: what is ticked, his ticks first.
  const menuKey = menu ? menu.question + '|' + menu.options.map((o) => `${o.n}.${o.label}`).join('|') : '';
  const ticked = menu?.multi
    ? ticks?.key === menuKey
      ? ticks.on
      : menu.options.filter((o) => o.box && o.checked && o.n !== menu.free).map((o) => o.n)
    : [];

  function setEntry(key: string, e: Entry | null) {
    setBundle((b) => {
      const next = { ...b };
      if (e) next[key] = e;
      else delete next[key];
      return next;
    });
  }

  function keepQuote(quote: string, reply: string) {
    setBundle((b) => ({ ...b, [quoteKey()]: { text: reply, quote } }));
  }

  // The chat closes (another box) with words in the reply bubble: they join
  // this box's saved draft.
  const now = useRef({ draft, atts, bundle, onDraft });
  now.current = { draft, atts, bundle, onDraft };
  function leaveQuote(quote: string, reply: string) {
    const n = now.current;
    n.onDraft({ text: n.draft, caret: n.draft.length, atts: n.atts, bundle: { ...n.bundle, [quoteKey()]: { text: reply, quote } } });
  }

  async function submitTicks(words?: string) {
    if (!box.paneId || !menu?.multi || menuBusy) return false;
    setMenuBusy(true);
    const r = await api().submitMenu(box.paneId, ticked, words);
    setMenuBusy(false);
    if (!r.ok) onError(r.reason || 'Not sent.');
    else setTicks(null);
    return r.ok;
  }

  // Ticks belong to the question on screen: the same question asked again
  // later starts from what the box shows.
  const multiUp = !!menu?.multi;
  useEffect(() => {
    if (!multiUp) setTicks(null);
  }, [multiUp]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current) {
      el.scrollTop = el.scrollHeight - keep.current.h + keep.current.top;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  });

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = Math.min(160, el.scrollHeight) + 'px';
  }, [draft]);

  // The floating drill-down stops above the message field, so the field and
  // its send button are never under it.
  useLayoutEffect(() => {
    const el = dock.current;
    const frame = el?.closest('.app') as HTMLElement | null;
    if (!el || !frame) return;
    const ro = new ResizeObserver(() => frame.style.setProperty('--field-h', `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // A narrower window or a picture that loads late makes the chat taller;
  // a chat read at its bottom stays there.
  const hasCol = !!chat?.loaded && items.length > 0;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [hasCol, starting, resuming]);

  // His saved draft comes back with the cursor where he left it.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el || !initial) return;
    const at = Math.min(initial.caret, el.value.length);
    el.focus();
    el.setSelectionRange(at, at);
  }, []);

  function report() {
    const caret = input.current ? input.current.selectionStart ?? draft.length : draft.length;
    const held = Object.keys(bundle).length > 0;
    onDraft(draft || atts.length || held ? { text: draft, caret, atts, ...(held ? { bundle } : {}) } : null);
  }

  useEffect(report, [draft, atts, bundle]);

  // His message, back from an edit, goes in the field.
  useEffect(() => {
    if (!incoming) return;
    setDraft(incoming.text);
    setHist(null);
    onTaken();
    setTimeout(() => input.current?.focus(), 0);
  }, [incoming?.seq]);

  // The @ file list follows what he types after the @.
  useEffect(() => {
    const el = input.current;
    const before = el ? draft.slice(0, el.selectionStart ?? draft.length) : draft;
    const m = AT.exec(before);
    if (!m || !box.paneId) {
      shut.current = null;
      if (pop?.kind === 'files') setPop(null);
      return;
    }
    const q = m[2];
    if (shut.current === q) return;
    shut.current = null;
    const paneId = box.paneId;
    const t = setTimeout(async () => {
      const list = await api().files(paneId, q);
      setPop((p) => (p && p.kind !== 'files' ? p : { kind: 'files', at: 0, q, list }));
    }, 120);
    return () => clearTimeout(t);
  }, [draft]);

  // One Send: widget answers by number, then each quote with his reply, then
  // what he typed, all in one message. A question menu takes only his words.
  async function submit(textIn?: string) {
    const typed = (textIn ?? draft).trim();
    const paths = atts.map((a) => a.path);
    const quoted = quoteText(bundle);
    const body = menu ? typed : [answers, quoted, typed].filter(Boolean).join('\n\n');
    const text = [body, ...paths].filter(Boolean).join(' ');
    if (!text || sending || closed) return;
    // While a question shows, the field answers it in his own words where
    // Claude offers that; otherwise the note above the field says what to do.
    if (menu && (!menu.free || !typed)) return;
    setSending(true);
    stick.current = true;
    let ok: boolean;
    if (menu?.multi) ok = await submitTicks(typed);
    else if (menu) {
      const r = await api().answer(box.paneId!, typed);
      if (!r.ok) onError(r.reason || 'Not sent.');
      ok = r.ok;
    } else ok = await onSend(text, { answer: !!answers && !quoted && !typed && !paths.length });
    setSending(false);
    if (ok) {
      setDraft('');
      setAtts([]);
      setHist(null);
      if (!menu) setBundle({});
    }
  }

  function walk(dir: -1 | 1) {
    if (!history.length) return false;
    const browsing = hist !== null && draft === history[hist];
    if (draft && !browsing) return false;
    let next = (browsing ? hist! : history.length) + dir;
    if (next < 0) next = 0;
    if (next >= history.length) {
      setHist(null);
      setDraft('');
      return true;
    }
    setHist(next);
    setDraft(history[next]);
    return true;
  }

  async function choose(n: number) {
    if (!box.paneId) return;
    const r = await api().choose(box.paneId, n);
    if (!r.ok) onError(r.reason || 'Not sent.');
  }

  // A box that ended starts again on its session, or is closed with its draft.
  // A click that does not do its job says why, on a line under the buttons.
  async function resume() {
    setEndBusy(true);
    setEndWhy(null);
    // What he typed goes with it: out of the field now, back if it did not start.
    const text = draft;
    const files = atts;
    const held = bundle;
    const p = onResume();
    setDraft('');
    setAtts([]);
    setBundle({});
    const r = await p;
    setEndBusy(false);
    if (!r.ok) {
      setEndWhy(r.reason || "Couldn't resume it.");
      setDraft(text);
      setAtts(files);
      setBundle(held);
    }
  }

  async function closeEnded() {
    setEndBusy(true);
    setEndWhy(null);
    const r = await onRemove();
    setEndBusy(false);
    if (!r.ok) setEndWhy(r.reason || "Couldn't remove it.");
  }

  async function dismiss() {
    if (!box.paneId) return;
    const r = await api().dismiss(box.paneId);
    if (!r.ok) onError(r.reason || 'Not sent.');
  }

  async function retry() {
    if (!box.paneId || retrying) return;
    setRetrying(true);
    const r = await api().retry(box.paneId);
    setRetrying(false);
    if (!r.ok) onError(r.reason || 'Could not start it again.');
  }

  // A dropped or pasted file is saved by the app and shows as a chip; its
  // path goes in the message when he sends.
  async function attach(files: FileList | File[]) {
    for (const f of Array.from(files)) {
      const image = f.type.startsWith('image/');
      const name = f.name && f.name !== 'image.png' ? f.name : image ? 'pasted.png' : 'file';
      const r = await api().attach(name, await f.arrayBuffer());
      if (!r.ok || !r.path) {
        onError(r.reason || 'Could not add the file.');
        continue;
      }
      const path = r.path;
      setAtts((a) => [...a, { path, name, image: image && IMAGE.test(path) }]);
    }
    input.current?.focus();
  }

  async function cycleMode() {
    if (!box.paneId) return;
    const r = await api().cycleMode(box.paneId);
    if (!r.ok) onError(r.reason || 'Not changed.');
  }

  // Picks an earlier message: Claude's own rewind menu opens on it, and its
  // question shows as buttons here.
  async function editEarlier(i: number) {
    setPop(null);
    const list = [...earlier].reverse();
    const m = list[i];
    if (!m || !box.paneId) return;
    const at = earlier.indexOf(m);
    // Claude's menu shows a message's first line, so later ones that start
    // the same way are skipped on the way up.
    const head = (s: string) => norm(s.split('\n')[0]).slice(0, 60);
    const dupAfter = earlier.slice(at + 1).filter((x) => head(x.t) === head(m.t)).length;
    const r = await api().rewind(box.paneId, { text: m.t, id: m.id, dupAfter });
    if (!r.ok) onError(r.reason || 'Could not open that message.');
  }

  function searchHits(q: string) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...history].reverse()) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (!q || t.toLowerCase().includes(q.toLowerCase())) out.push(t);
      if (out.length >= 30) break;
    }
    return out;
  }

  function insertFile(f: string) {
    const el = input.current;
    const caret = el ? el.selectionStart ?? draft.length : draft.length;
    const before = draft.slice(0, caret).replace(AT, (_m, sp) => `${sp}@${f} `);
    setDraft(before + draft.slice(caret));
    setPop(null);
    shut.current = null;
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(before.length, before.length);
    }, 0);
  }

  const popList: string[] =
    pop?.kind === 'edit' ? [...earlier].reverse().map((i) => i.t) : pop?.kind === 'search' ? searchHits(pop.q) : pop?.kind === 'files' ? pop.list : [];

  function pick(i: number) {
    if (!pop) return;
    const t = popList[i];
    if (t == null) return;
    if (pop.kind === 'edit') return editEarlier(i);
    if (pop.kind === 'files') return insertFile(t);
    setDraft(t);
    setPop(null);
    setTimeout(() => input.current?.focus(), 0);
  }

  // Up, Down, Enter and Esc inside an open list. True when the key was used.
  function popKey(e: KeyboardEvent) {
    if (!pop) return false;
    const n = popList.length;
    if (e.key === 'Escape') {
      if (pop.kind === 'files') shut.current = pop.q;
      setPop(null);
      input.current?.focus();
    } else if (e.key === 'ArrowDown' || (e.key === 'r' && e.ctrlKey && pop.kind === 'search')) {
      if (n) setPop({ ...pop, at: (pop.at + 1) % n });
    } else if (e.key === 'ArrowUp') {
      if (n) setPop({ ...pop, at: (pop.at - 1 + n) % n });
    } else if (e.key === 'Enter' || (e.key === 'Tab' && pop.kind === 'files')) {
      if (!n && pop.kind === 'files') return false;
      pick(pop.at);
    } else return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  let middle;
  if (starting && !menu && !waiting)
    middle = (
      <div className="empty">
        <Live text="Starting…" />
      </div>
    );
  else if (chat?.loaded && !items.length && !pending.length && !working && !menu && !resuming && !failed && !ended && !waiting && !draft.trim())
    middle = <div className="empty">{off ? 'Nothing runs in this window.' : 'No messages yet.'}</div>;
  else
    middle = (
      <div className="chat-col">
        {note && <div className="ended-note">{note}</div>}
        {shown.map((m) => {
          const isFresh = chat!.fresh.has(m.id);
          const folded = folds[m.id];
          // An older drill-down list: only the newest one shows.
          if (folded === '') return null;
          if (folded && !unfolded.has(m.id))
            return (
              <button key={m.id} className="work fold" onClick={() => setUnfolded((s) => new Set(s).add(m.id))} title="Show the whole message">
                <Chevron />
                {folded}
              </button>
            );
          // His answers from the widgets: the one line they folded to.
          if (m.k === 'you' && asked.answered[m.id])
            return (
              <div key={m.id} className={'work answered' + (isFresh && !quiet.has(m.id) ? ' rise' : '')} title={m.t}>
                <Check />
                {asked.answered[m.id]}
              </div>
            );
          if (m.k === 'you')
            return (
              <div key={m.id} className={'you' + (isFresh && !quiet.has(m.id) ? ' sent' : '')}>
                <YouText text={m.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
            );
          if (m.k === 'work')
            return (
              <div key={m.id} className={'work' + (isFresh && !quiet.has(m.id) ? ' rise' : '')}>
                <Chevron />
                {m.t}
              </div>
            );
          if (m.mono)
            return (
              <pre key={m.id} className={'say shell-out' + (isFresh ? ' rise' : '')}>
                {m.t}
              </pre>
            );
          return (
            <div key={m.id} className={'say' + (isFresh ? ' rise' : '')} data-quote="">
              <Markdown text={m.t} />
              {m.asks && m.asks.length > 0 && (
                <AskList
                  id={m.id}
                  asks={m.asks}
                  live={m.id === asked.live && !closed}
                  bundle={bundle}
                  onEntry={setEntry}
                  onSend={() => submit()}
                />
              )}
            </div>
          );
        })}
        {pending.map((p) =>
          p.skill ? (
            <div key={p.id} className="work rise">
              <Chevron />
              {p.t}
              {p.queued && <span className="queued">queued</span>}
            </div>
          ) : p.answer ? (
            <div key={p.id} className="work answered rise" title={p.t}>
              <Check />
              {oneLine(p.t)}
              {p.queued && <span className="queued">queued</span>}
            </div>
          ) : (
            <div key={p.id} className="pending">
              <div className="you sent">
                <YouText text={p.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
              {p.queued && <span className="queued">queued</span>}
            </div>
          ),
        )}
        {menu?.multi && (
          // Several picks: check boxes, then Submit, as the terminal's menu.
          <div className="ask rise" key={menuKey}>
            {menu.question && <div className="say">{menu.question}</div>}
            <div className="choices">
              {menu.options
                .filter((o) => o.box && o.n !== menu.free)
                .map((o) => {
                  const on = ticked.includes(o.n);
                  return (
                    <button
                      key={o.n}
                      className={'chip pick' + (on ? ' on' : '')}
                      aria-pressed={on}
                      disabled={menuBusy}
                      onClick={() => setTicks({ key: menuKey, on: on ? ticked.filter((n) => n !== o.n) : [...ticked, o.n] })}
                    >
                      <span className="tick" aria-hidden="true">{on && <Check size={11} />}</span>
                      <OptionLabel label={o.label} />
                    </button>
                  );
                })}
            </div>
            <div className="choices">
              <button className="chip primary" disabled={menuBusy} onClick={() => submitTicks()}>
                {menu.button === 'Next' ? 'Next' : 'Submit'}
              </button>
              {menu.free != null && (
                <button className="chip" onClick={() => input.current?.focus()} title="Type it in the field below">
                  Your own answer…
                </button>
              )}
              {menu.options
                .filter((o) => !o.box)
                .map((o) => (
                  <button key={o.n} className="chip" disabled={menuBusy} onClick={() => choose(o.n)}>
                    <OptionLabel label={o.label} />
                  </button>
                ))}
              {canCancel(menu) && (
                <button className="menu-cancel" onClick={dismiss}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {menu && !menu.multi && (
          <div className="ask rise" key={menu.question + menu.options.length}>
            {menu.question && <div className="say">{menu.question}</div>}
            <div className="choices">
              {arrange(menu.options).map((o) =>
                o.n === menu.free ? (
                  <button key={o.n} className="chip" onClick={() => input.current?.focus()} title="Type it in the field below">
                    Your own answer…
                  </button>
                ) : (
                  <button
                    key={o.n}
                    className={'chip' + (o.primary ? ' primary' : '') + (o.current ? ' current' : '')}
                    aria-current={o.current ? 'true' : undefined}
                    onClick={() => choose(o.n)}
                  >
                    {o.current && <Check color="currentColor" size={13} />}
                    <OptionLabel label={o.label} />
                  </button>
                ),
              )}
              {canCancel(menu) && (
                <button className="menu-cancel" onClick={dismiss}>
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {/* His first message until it is sent: under a start-up question, and
            while the box comes up after his answer. */}
        {waiting && (
          <div className="pending waiting" title="Sent once the box is ready">
            <div className="you">{waiting}</div>
            <span className="queued">Waiting to send</span>
          </div>
        )}
        {starting && !menu && <Live text="Starting…" />}
        {resuming && !menu && <Live text="Coming back…" />}
        {ended && (
          <div className="ended rise" role="status">
            {/* The reason has its own line, above the actions it explains. */}
            {(endWhy || box.ended?.why) && (
              <div className="ended-why" role="alert">
                {endWhy || box.ended?.why}
              </div>
            )}
            <div className="ended-line">
              <span>{box.name} ended</span>
              {box.ended?.start && (
                <button className="text-btn" onClick={resume} disabled={endBusy}>
                  {typed ? 'Resume and send' : 'Resume'}
                </button>
              )}
              <button className="text-btn" onClick={closeEnded} disabled={endBusy}>
                Remove
              </button>
            </div>
            {box.ended?.start ? (
              underEnded && <div className="ended-note">Kept under Ended. Resume brings it back.</div>
            ) : (
              typed && <div className="ended-note">Remove takes your typed text too.</div>
            )}
          </div>
        )}
        {failed && (
          <div className="ask rise">
            <div className="say">Didn't start. Claude did not come up in this window.</div>
            <div className="choices">
              <button className="chip primary" onClick={retry} disabled={retrying}>
                {retrying ? 'Starting…' : 'Retry'}
              </button>
            </div>
          </div>
        )}
        {working && <Live text={box.activity || 'Working'} />}
      </div>
    );

  const popTitle = pop?.kind === 'edit' ? 'Edit an earlier message' : pop?.kind === 'search' ? 'Search what you sent' : 'Files';

  return (
    <>
      <div
        className="chat"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (el.scrollTop < 300 && items.length > limit && !keep.current) {
            keep.current = { h: el.scrollHeight, top: el.scrollTop };
            setLimit((l) => l + PAGE);
          }
        }}
      >
        {middle}
        <Quoter scroller={scroller} on={!closed || typeAhead} onKeep={keepQuote} onLeave={leaveQuote} onDone={() => input.current?.focus()} />
      </div>
      <div
        className="composer-wrap"
        ref={dock}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
        }}
      >
        {pop && (
          <div className="pop-list" role="listbox" aria-label={popTitle}>
            <div className="pop-title">{popTitle}</div>
            {pop.kind === 'search' && (
              <input
                className="pop-search"
                autoFocus
                aria-expanded="true"
                placeholder="Type to filter"
                value={pop.q}
                onChange={(e) => setPop({ kind: 'search', q: e.target.value, at: 0 })}
                onKeyDown={(e) => popKey(e)}
              />
            )}
            <div className="pop-items">
              {popList.length ? (
                popList.map((t, i) => (
                  <button
                    key={i + t}
                    role="option"
                    aria-selected={pop.at === i}
                    className={'pop-item' + (pop.at === i ? ' on' : '') + (pop.kind === 'files' ? ' mono' : '')}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(i)}
                  >
                    {t}
                  </button>
                ))
              ) : (
                <div className="pop-none">{pop.kind === 'edit' ? 'No earlier messages here.' : 'Nothing matches.'}</div>
              )}
            </div>
          </div>
        )}
        <Tray
          answers={answers ? oneLine(answers) : ''}
          quotes={quotes}
          onClearAnswers={() => {
            for (const k of liveKeys) setEntry(k, null);
          }}
          onReply={(k, text) => setBundle((b) => (b[k] ? { ...b, [k]: { ...b[k], text } } : b))}
          onRemove={(k) => setEntry(k, null)}
          onDone={() => input.current?.focus()}
        />
        {atts.length > 0 && (
          <div className="att-row">
            {atts.map((a) => (
              <span key={a.path} className="att-chip" title={a.path}>
                {a.image ? <img src={attUrl(a.path)} alt="" /> : <span className="att-doc">{a.name}</span>}
                <button aria-label={'Remove ' + a.name} onClick={() => setAtts((l) => l.filter((x) => x.path !== a.path))}>
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {menu && (closed || !menu.free) && (
          <div className="field-note" role="status">
            {menu.esc ? 'Pick an option above, or Esc to cancel' : 'Pick an option above'}
          </div>
        )}
        <div className={'composer' + (draft.includes('\n') || draft.length > 70 ? ' tall' : '') + (draft.startsWith('!') ? ' shell' : '') + (ended ? ' dim' : '')}>
          <label htmlFor="composer" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Message {box.name}
          </label>
          <textarea
            id="composer"
            ref={input}
            rows={1}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            readOnly={closed && !typeAhead}
            aria-expanded={pop ? 'true' : 'false'}
            placeholder={typeAhead ? 'Type, then Resume and send' : closed ? '' : menu?.free ? 'Type your own answer' : 'Message'}
            onChange={(e) => {
              setDraft(e.target.value);
              setHist(null);
            }}
            onSelect={report}
            onKeyUp={report}
            onMouseUp={report}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.defaultPrevented) return;
              if (closed) {
                if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
                return;
              }
              if (popKey(e)) return;
              if (e.key === 'Escape') {
                // Esc twice in an empty field: edit an earlier message.
                if (draft || working || menu || box.status === 'working') return;
                const now = Date.now();
                if (now - lastEsc.current < 600) {
                  lastEsc.current = 0;
                  setPop({ kind: 'edit', at: 0 });
                } else lastEsc.current = now;
                return;
              }
              if (e.key === 'r' && e.ctrlKey && !e.metaKey) {
                e.preventDefault();
                setPop({ kind: 'search', q: draft, at: 0 });
                return;
              }
              if (e.key === 'Tab' && e.shiftKey && !menu) {
                e.preventDefault();
                cycleMode();
              } else if (e.key === 'Enter' && e.altKey) {
                // Option+Enter makes a new line, as in Claude Code.
                e.preventDefault();
                document.execCommand('insertText', false, '\n');
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.metaKey && !e.altKey) {
                if (walk(e.key === 'ArrowUp' ? -1 : 1)) e.preventDefault();
              }
            }}
          />
          <button aria-label="Send" className={'send' + (!closed && (draft.trim() || atts.length || answers || quotes.length) ? ' ready' : '')} onClick={() => submit()} disabled={closed}>
            <Arrow />
          </button>
        </div>
        {!closed && (foot || draft.startsWith('!')) && (
          <div className="composer-foot">{draft.startsWith('!') ? <span className="shell-hint">Runs in {box.name}'s shell</span> : foot}</div>
        )}
      </div>
    </>
  );
}

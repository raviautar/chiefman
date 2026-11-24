import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, Ask, Box, Draft, Item, MAX_SEND, Menu, Result, tooLong, type TurnNow } from './api';
import { Arrow, Check } from './icons';
import { Markdown, More, useFold } from './Markdown';
import { AskList, Bundle, compose, Entry, oneLine } from './Answers';
import { quoteKey, quotesOf, quoteText, Quoter, Tray } from './Quotes';

export interface ChatState {
  items: Item[];
  fresh: Set<string>;
  // The turn that runs now, if any.
  now: TurnNow | null;
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

// A message of his that answers a reply's questions by number, its first
// lines "n. ...": the one line those fold to, and what he wrote after them
// (rest), or null.
export function answerLine(text: string, asks?: Ask[]) {
  const lines = text.split('\n');
  const nums: string[] = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m = /^(\d{1,2})[.)]\s+\S/.exec(l);
    if (!m || (asks && !asks.some((a) => a.n === Number(m[1])))) break;
    nums.push(l);
  }
  if (!nums.length) return null;
  return { line: oneLine(nums.join('\n')), rest: lines.slice(i).join('\n').trim() };
}

// His answers folded to their line, with any words he sent along under it.
function AnswerTag({
  line,
  rest,
  title,
  fresh,
  pending,
  queued,
  attachDir,
  onOpen,
}: {
  line: string;
  rest: string;
  title: string;
  fresh: boolean;
  pending?: boolean;
  queued?: boolean;
  attachDir: string;
  onOpen: (url: string) => void;
}) {
  const bubble = rest ? (
    <div className={'you' + (fresh ? ' sent' : '')}>
      <YouText text={rest} attachDir={attachDir} onOpen={onOpen} />
    </div>
  ) : null;
  return (
    <>
      <div className={'tag answered' + (fresh ? ' rise' : '')} title={title}>
        <Check />
        <span className="tag-t">{line}</span>
        {queued && !rest && <span className="queued">queued</span>}
      </div>
      {bubble && pending ? (
        <div className="pending">
          {bubble}
          {queued && <span className="queued">queued</span>}
        </div>
      ) : (
        bubble
      )}
    </>
  );
}

// Which reply's questions are still open (live), which of his messages
// answered questions and fold to one line, and how the other questions
// closed. His message right after them answers them: by number from the
// widgets (answered), or in his own words (words). A skill run, a command,
// a shell line or a newer reply with questions of its own moves past them
// (skipped). next: what waits to go, first in line.
function askState(items: Item[], next?: Pending) {
  const answered: Record<string, { line: string; rest: string }> = {};
  const words = new Set<string>();
  const skipped = new Set<string>();
  let live: string | null = null;
  const turn = (i: Item) => i.k === 'you' || (i.k === 'work' && i.id.startsWith('u:'));
  const asks = (i: Item) => i.k === 'box' && !!i.asks?.length;
  const said = (t: string) => !/^\s*[/!]/.test(t);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!asks(it)) continue;
    const after = items.slice(i + 1).find((x) => turn(x) || asks(x));
    if (after && !turn(after)) skipped.add(it.id);
    else if (!after) {
      if (!next) live = it.id;
      else if (next.skill || !said(next.t)) skipped.add(it.id);
      else if (!next.answer) words.add(it.id);
    } else {
      const line = after.k === 'you' ? answerLine(after.t, it.asks!) : null;
      if (line) answered[after.id] = line;
      else if (after.k === 'you' && said(after.t)) words.add(it.id);
      else skipped.add(it.id);
    }
  }
  return { live, answered, words, skipped };
}

type Attachment = Draft['atts'][number];

const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// A picture he attached, served by the app from its attachments folder.
export const attUrl = (p: string) => 'cm-att://f/' + encodeURIComponent(p.slice(p.lastIndexOf('/') + 1));

// His words read as the box's do (Markdown); a command or a shell line stays
// as he typed it.
function Words({ text }: { text: string }) {
  if (/^\s*[/!]/.test(text)) return <>{text}</>;
  return <Markdown text={text} fold={false} />;
}

// His quote replies: each quoted piece as a quiet line, his words under it.
function Quoted({ text }: { text: string }) {
  if (!/^> /m.test(text)) return <Words text={text} />;
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
        if (!t) return null;
        return p.q ? (
          <span key={i} className="you-quote">
            {t}
          </span>
        ) : (
          <div key={i} className="you-line">
            <Words text={t} />
          </div>
        );
      })}
    </>
  );
}

// His whole message as he sent it. A long one shows its first lines, with
// Show all.
const CLIP_OVER = 10;

function Clip({ text }: { text: string }) {
  const f = useFold();
  const long = text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 64)), 0) > CLIP_OVER;
  return (
    <>
      <div ref={f.ref} className={'you-text' + (long ? (f.open ? ' open' : ' cut') : '')}>
        <Quoted text={text} />
      </div>
      {long && <More open={f.open} onClick={f.toggle} />}
    </>
  );
}

export function YouText({ text, attachDir, onOpen }: { text: string; attachDir: string; onOpen: (url: string) => void }) {
  if (!attachDir || !text.includes(attachDir + '/')) return <Clip text={text} />;
  const esc = attachDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${esc}/[A-Za-z0-9._-]+)`));
  const words = parts.filter((_p, i) => i % 2 === 0).join(' ').trim();
  const files = parts.filter((_p, i) => i % 2 === 1);
  return (
    <>
      {words && <Clip text={words} />}
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

// The options a question menu shows as buttons. His own words go in the
// message field, so "Type something" and "Chat about this" need none.
const CHAT = /^chat about this\.?$/i;
const shownOptions = (menu: Menu) => menu.options.filter((o) => o.n !== menu.free && !(menu.free != null && CHAT.test(o.label)));

// The question a click is made on, as the hub checks it (Hub.askOf).
const askOf = (menu: Menu) => `${menu.question}|${menu.options.length}`;

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
  onOpen,
  onSend,
  onLost,
  onError,
  foot,
  tools,
  onFold,
  foldTip,
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
  onOpen: (url: string) => void;
  onSend: (text: string, opts?: { answer?: boolean }) => Promise<boolean>;
  // A message that did not go, after this chat closed: back to the box's draft.
  onLost: (text: string) => void;
  onError: (text: string) => void;
  // Inside the message box, under his text: the skill buttons on the left,
  // the model and effort on the right, before Send.
  foot?: ReactNode;
  tools?: ReactNode;
  // A click on a folded line: true when it was used (the drill-down panel
  // opened) instead of showing the whole message.
  onFold?: (id: string) => boolean;
  foldTip?: (id: string) => string | undefined;
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
  // tickNow has the newest ones before they show, so two fast clicks both count.
  const [ticks, setTicks] = useState<{ key: string; on: number[] } | null>(null);
  const tickNow = useRef<{ key: string; on: number[] } | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const scrolled = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useRef<{ h: number; top: number } | null>(null);
  const lastEsc = useRef(0);
  const shut = useRef<string | null>(null);
  const alive = useRef(true);
  const sentNow = useRef<{ draft: string; atts: Attachment[]; bundle: Bundle } | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
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
  // A box on its way up takes his messages: they wait, marked queued, and go
  // once it is ready.
  const early = starting || resuming;
  const blocked = closed && !early;
  const quotes = quotesOf(bundle);
  const typed = !!draft.trim() || atts.length > 0 || quotes.length > 0;
  // An ended box takes text for Resume and send; it does not send itself.
  const typeAhead = !!ended && !!box.ended?.start;
  const history = [...items.filter((i) => i.k === 'you').map((i) => i.t), ...pending.filter((p) => !p.skill).map((p) => p.t)];
  // His messages that Claude's rewind menu lists: no commands, no shell lines.
  const earlier = items.filter((i) => i.k === 'you' && !/^[/!]/.test(i.t));
  const asked = askState(items, pending[0]);
  const liveItem = asked.live ? items.find((i) => i.id === asked.live) : undefined;
  const liveKeys = liveItem?.asks ? liveItem.asks.map((a) => `${liveItem.id}:${a.n}`) : [];
  const answers = compose(bundle, liveKeys);
  // Claude Code's own question (it offers "Type something"): it works as the
  // widgets under a reply do. A click marks a pick; the field's Send sends
  // his picks or his words. Other menus answer on the click.
  const question = !!menu && (menu.free != null || !!menu.multi);
  // What is picked, his picks first; check boxes start as the box shows them.
  const menuKey = menu ? menu.question + '|' + menu.options.map((o) => `${o.n}.${o.label}`).join('|') : '';
  const ticked = !menu
    ? []
    : ticks?.key === menuKey
      ? ticks.on
      : menu.multi
        ? menu.options.filter((o) => o.box && o.checked && o.n !== menu.free).map((o) => o.n)
        : [];
  const menuPicks = question ? ticked.map((n) => menu!.options.find((o) => o.n === n)?.label || '').filter(Boolean).join(', ') : '';

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

  function clearTicks() {
    tickNow.current = null;
    setTicks(null);
  }

  function setPicks(on: number[]) {
    const next = { key: menuKey, on };
    tickNow.current = next;
    setTicks(next);
  }

  const picksNow = () => (tickNow.current?.key === menuKey ? tickNow.current.on : ticked);

  // Several picks toggle; one pick replaces the last, and a second click
  // takes it back.
  function tick(n: number) {
    const cur = picksNow();
    setPicks(cur.includes(n) ? cur.filter((x) => x !== n) : menu?.multi ? [...cur, n] : [n]);
  }

  async function submitTicks(words?: string) {
    if (!box.paneId || !menu?.multi || menuBusy) return false;
    setMenuBusy(true);
    const r = await api().submitMenu(box.paneId, picksNow(), words, askOf(menu));
    setMenuBusy(false);
    if (!r.ok && !r.stale) onError(r.reason || 'Not sent.');
    else clearTicks();
    return r.ok;
  }

  // The one Send on Claude Code's question: his words win over a single
  // pick, and go with the ticks where several are allowed.
  async function answerQuestion(words: string) {
    if (!box.paneId || !menu || menuBusy) return;
    const on = picksNow();
    if (!words && !on.length) return;
    setSending(true);
    stick.current = true;
    // His words leave the field at once, as a message does.
    const was = draft;
    if (words) {
      sentNow.current = { draft, atts, bundle };
      setDraft('');
      setHist(null);
    }
    let ok: boolean;
    if (menu.multi) ok = await submitTicks(words);
    else if (words) {
      const r = await api().answer(box.paneId, words, askOf(menu));
      if (!r.ok) onError(r.reason || 'Not sent.');
      ok = r.ok;
    } else ok = await choose(on[0]);
    if (!alive.current) {
      if (!ok && words) onLost(was);
      return;
    }
    setSending(false);
    if (ok) clearTicks();
    else if (words) setDraft((d) => [was, d].filter(Boolean).join('\n'));
  }

  // Picks belong to the question on screen: the same question asked again
  // later starts from what the box shows.
  useEffect(() => {
    if (!question) clearTicks();
  }, [question]);

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

  // A box he switches to has the cursor in its message field; a saved draft
  // comes back with the cursor where he left it. A field he types in
  // elsewhere (a sheet, the drill-down) keeps it.
  useLayoutEffect(() => {
    const el = input.current;
    const busy = document.activeElement?.closest('.drill, [role="dialog"], [role="menu"]');
    if (!el || busy) return;
    const at = initial ? Math.min(initial.caret, el.value.length) : el.value.length;
    el.focus();
    el.setSelectionRange(at, at);
  }, []);

  function report() {
    // A report still owed from before his Send must not bring back what he sent.
    const s = sentNow.current;
    if (s && s.draft === draft && s.atts === atts && s.bundle === bundle) return;
    sentNow.current = null;
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

  // Cmd+K opens the same lists as Esc twice and Ctrl+R.
  useEffect(() => {
    const open = (e: Event) => {
      const kind = (e as CustomEvent).detail;
      if (kind === 'edit') setPop({ kind: 'edit', at: 0 });
      else if (kind === 'search') setPop({ kind: 'search', q: '', at: 0 });
      if (kind === 'edit') setTimeout(() => input.current?.focus(), 0);
    };
    window.addEventListener('chiefman:pop', open);
    return () => window.removeEventListener('chiefman:pop', open);
  }, []);

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
  // what he typed, all in one message. Claude Code's question takes his
  // picks and words; any other menu is answered by its buttons, and the note
  // above the field says so.
  async function submit(textIn?: string) {
    const typed = (textIn ?? draft).trim();
    if (menu) {
      if (question && !sending && !closed) await answerQuestion(typed);
      return;
    }
    const paths = atts.map((a) => a.path);
    const quoted = quoteText(bundle);
    const body = [answers, quoted, typed].filter(Boolean).join('\n\n');
    const text = [body, ...paths].filter(Boolean).join(' ');
    if (!text || blocked) return;
    if (text.length > MAX_SEND) return onError(tooLong(text.length));
    // What he sends leaves the field at once, whatever he clicks next. It
    // comes back only if it did not go: here, or in the box's saved draft
    // when he is on another box by then.
    const was = { draft, atts, bundle };
    sentNow.current = was;
    setDraft('');
    setAtts([]);
    setHist(null);
    setBundle({});
    onDraft(null);
    stick.current = true;
    const ok = await onSend(text, { answer: !!answers });
    if (ok) return;
    if (!alive.current) return onLost(text);
    setDraft((d) => [was.draft, d].filter(Boolean).join('\n'));
    setAtts((a) => [...was.atts, ...a.filter((x) => !was.atts.some((y) => y.path === x.path))]);
    setBundle((b) => ({ ...was.bundle, ...b }));
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
    if (!box.paneId || !menu || menuBusy) return false;
    setMenuBusy(true);
    const r = await api().choose(box.paneId, n, askOf(menu));
    setMenuBusy(false);
    if (!r.ok && !r.stale) onError(r.reason || 'Not sent.');
    return r.ok;
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
  if (starting && !menu && !waiting && !pending.length)
    middle = (
      <div className="empty">
        <Live text="Starting…" />
      </div>
    );
  else if (chat?.loaded && !items.length && !pending.length && !working && !menu && !resuming && !failed && !ended && !waiting && !draft.trim())
    middle = <div className="empty">{off ? 'Nothing runs in this window.' : ''}</div>;
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
              <button
                key={m.id}
                className="work fold"
                onClick={() => onFold?.(m.id) || setUnfolded((s) => new Set(s).add(m.id))}
                title={foldTip?.(m.id) || 'Show the whole message'}
              >
                <Chevron />
                {folded}
              </button>
            );
          // His answers from the widgets: the one line they folded to, a tag
          // on his side like a button press.
          if (m.k === 'you' && asked.answered[m.id])
            return (
              <AnswerTag
                key={m.id}
                line={asked.answered[m.id].line}
                rest={asked.answered[m.id].rest}
                title={m.t}
                fresh={isFresh && !quiet.has(m.id)}
                attachDir={attachDir}
                onOpen={onOpen}
              />
            );
          if (m.k === 'you')
            return (
              <div key={m.id} className={'you' + (isFresh && !quiet.has(m.id) ? ' sent' : '')}>
                <YouText text={m.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
            );
          // A skill button he pressed: a small tag on his side.
          if (m.k === 'work' && m.id.startsWith('u:'))
            return (
              <div key={m.id} className={'tag' + (isFresh && !quiet.has(m.id) ? ' rise' : '')}>
                {m.t}
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
          // The box's reply sits in a soft bubble; its questions' widgets sit
          // under it, outside the bubble.
          if (!m.asks?.length)
            return (
              <div key={m.id} className={'say' + (isFresh ? ' rise' : '')} data-quote="">
                <Markdown text={m.t} />
              </div>
            );
          return (
            <div key={m.id} className={'reply-group' + (isFresh ? ' rise' : '')}>
              {m.t.trim() && (
                <div className="say" data-quote="">
                  <Markdown text={m.t} />
                </div>
              )}
              {/* Questions he answered in his words, or skipped, fold to one
                  quiet line; a click shows them. */}
              {(asked.words.has(m.id) || asked.skipped.has(m.id)) && !unfolded.has(m.id + ':q') ? (
                <button
                  className="work fold q-fold"
                  onClick={() => setUnfolded((s) => new Set(s).add(m.id + ':q'))}
                  title={m.asks.map((a) => `${a.n}. ${a.q}`).join('\n')}
                >
                  <Chevron />
                  {asked.words.has(m.id)
                    ? 'Answered in your words'
                    : m.asks.length === 1
                      ? 'Question skipped'
                      : `${m.asks.length} questions skipped`}
                </button>
              ) : (
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
        {/* His first message until it is sent: under a start-up question, and
            while the box comes up after his answer. What he sends after it
            waits below it. */}
        {waiting && (
          <div className="pending waiting" title="Sent once the box is ready">
            <div className="you">{waiting}</div>
            <span className="queued">Waiting to send</span>
          </div>
        )}
        {pending.map((p) =>
          p.skill ? (
            <div key={p.id} className="tag rise">
              {p.t}
              {p.queued && <span className="queued">queued</span>}
            </div>
          ) : p.answer ? (
            <AnswerTag
              key={p.id}
              {...(answerLine(p.t) || { line: oneLine(p.t), rest: '' })}
              title={p.t}
              fresh
              pending
              queued={p.queued}
              attachDir={attachDir}
              onOpen={onOpen}
            />
          ) : (
            <div key={p.id} className="pending">
              <div className="you sent">
                <YouText text={p.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
              {p.queued && <span className="queued">queued</span>}
            </div>
          ),
        )}
        {menu && question && (
          // As the widgets under a reply: picks mark, the field's Send sends.
          <div className="ask rise" key={menuKey}>
            {menu.question && <div className="say">{menu.question}</div>}
            <div className="choices">
              {shownOptions(menu)
                .filter((o) => !menu.multi || o.box)
                .map((o) => {
                  const on = ticked.includes(o.n);
                  return (
                    <button
                      key={o.n}
                      className={'chip pick' + (on ? ' on' : '')}
                      aria-pressed={on}
                      disabled={menuBusy || sending}
                      onClick={(e) => e.detail < 2 && tick(o.n)}
                    >
                      {menu.multi && <span className="tick" aria-hidden="true">{on && <Check size={11} />}</span>}
                      <OptionLabel label={o.label} />
                    </button>
                  );
                })}
              {canCancel(menu) && (
                <button className="menu-cancel" onClick={dismiss} title="Esc">
                  Cancel
                </button>
              )}
            </div>
          </div>
        )}
        {menu && !question && (
          <div className="ask rise" key={menu.question + menu.options.length}>
            {menu.question && <div className="say">{menu.question}</div>}
            <div className="choices">
              {arrange(shownOptions(menu)).map((o) => (
                <button
                  key={o.n}
                  className={'chip' + (o.primary ? ' primary' : '') + (o.current ? ' current' : '')}
                  aria-current={o.current ? 'true' : undefined}
                  disabled={menuBusy}
                  onClick={() => choose(o.n)}
                >
                  {o.current && <Check color="currentColor" size={13} />}
                  <OptionLabel label={o.label} />
                </button>
              ))}
              {canCancel(menu) && (
                <button className="menu-cancel" onClick={dismiss} title="Esc">
                  Cancel
                </button>
              )}
            </div>
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
              <span>Ended</span>
              {box.ended?.start && (
                <button className="text-btn" onClick={resume} disabled={endBusy}>
                  {typed ? 'Resume and send' : 'Resume'}
                </button>
              )}
              <button className="text-btn" onClick={closeEnded} disabled={endBusy}>
                Remove
              </button>
            </div>
            {!box.ended?.start && typed && <div className="ended-note">Remove takes your typed text too.</div>}
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
        onClick={(e) => {
          // A pick made with the mouse leaves the cursor in the message
          // field, so Enter sends it instead of taking the pick back.
          if (e.detail > 0 && (e.target as Element).closest('.chip.pick')) input.current?.focus();
        }}
        onWheel={(e) => {
          // The thin scrollbar shows only while he scrolls, not when a new
          // message moves the chat down.
          const el = e.currentTarget;
          if (el.scrollHeight <= el.clientHeight) return;
          el.classList.add('scrolling');
          if (scrolled.current) clearTimeout(scrolled.current);
          scrolled.current = setTimeout(() => el.classList.remove('scrolling'), 800);
        }}
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
        {/* One white box: what waits to go, his text, then the skills, the
            model and Send. A click on its empty parts puts the cursor in. */}
        <div className={'composer' + (draft.startsWith('!') ? ' shell' : '') + (ended ? ' dim' : '')} onMouseDown={(e) => e.target === e.currentTarget && (e.preventDefault(), input.current?.focus())}>
          <Tray
            answers={menuPicks || (answers ? oneLine(answers) : '')}
            quotes={quotes}
            onClearAnswers={() => {
              if (menuPicks) return setPicks([]);
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
          <label htmlFor="composer" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
            Message {box.name || 'a new box'}
          </label>
          <textarea
            id="composer"
            ref={input}
            rows={1}
            autoComplete="off"
            spellCheck={false}
            value={draft}
            readOnly={blocked && !typeAhead}
            aria-expanded={pop ? 'true' : 'false'}
            placeholder={menu && (closed || !menu.free) ? 'Pick an option above' : ''}
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
              if (blocked) {
                if (e.key === 'Enter' && !e.shiftKey) e.preventDefault();
                return;
              }
              if (popKey(e)) return;
              if (e.key === 'Escape') {
                // Esc twice in an empty field: edit an earlier message.
                if (draft || working || menu || early || box.status === 'working') return;
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
                if (!early) cycleMode();
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
          <div className="tools">
            {draft.startsWith('!') && box.paneId ? <span className="shell-hint">Runs in {box.name}'s shell</span> : !closed && foot}
            <span className="tools-gap" />
            {tools}
            <button aria-label="Send" data-tip="Send" className={'send tip up' + (!blocked && (menu ? question && !closed && (draft.trim() || ticked.length) : draft.trim() || atts.length || answers || quotes.length) ? ' ready' : '')} onClick={() => submit()} disabled={blocked}>
              <Arrow />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

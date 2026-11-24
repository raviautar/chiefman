import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, Ask, Box, Draft, Item, MAX_SEND, Menu, Result, tooLong, type TurnNow } from './api';
import { Arrow, Check, Icon } from './icons';
import { Markdown, More, PictureOpen, useFold } from './Markdown';
import { Bundle, choiceOf, compose, currentRow, Entry, entryFor, keyPick, oneLine, QRow, QuestionCard, recommendedPick, type Kind } from './Answers';
import { quoteKey, quotesOf, quoteText, Quoter, Tray } from './Quotes';
import { NowFailed, NowLine, nowText, TurnCard } from './Turn';
import { Jump, NEW_LINE, usePlace } from './Place';
import { CardData, CardKeys, Cards, inferActions, isDismissed } from './Blocks';
import { LiveDock } from './Live';
import { PermCard, permOptions, PlanCard } from './Approve';

export interface ChatState {
  items: Item[];
  fresh: Set<string>;
  // The turn that runs now, if any.
  now: TurnNow | null;
  loaded: boolean;
  // How many full loads this chat had.
  reset?: number;
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
// lines "n. ...": the one line those fold to, each answer by its number,
// and what he wrote after them (rest), or null.
export function answerLine(text: string, asks?: Ask[]) {
  const lines = text.split('\n');
  const nums: string[] = [];
  const by: Record<number, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m = /^(\d{1,2})[.)]\s+(\S.*)$/.exec(l);
    if (!m || (asks && !asks.some((a) => a.n === Number(m[1])))) break;
    nums.push(l);
    by[Number(m[1])] = m[2].trim();
  }
  if (!nums.length) return null;
  return { line: oneLine(nums.join('\n')), by, rest: lines.slice(i).join('\n').trim() };
}

// How a reply's questions closed: answered by number from the card (by:
// each answer), in his own words, or skipped.
interface Closed {
  how: 'answered' | 'words' | 'skipped';
  by?: Record<number, string>;
}

// Which reply's questions are still open (live), which of his messages
// answered questions (only what he wrote after the answers shows), and how
// the other questions closed. His message right after them answers them: by
// number from the card (answered), or in his own words (words). A skill
// run, a command, a shell line or a newer reply with questions of its own
// moves past them (skipped). next: what waits to go, first in line.
export function askState(items: Item[], next?: Pending) {
  const answers: Record<string, string> = {};
  const closed: Record<string, Closed> = {};
  let live: string | null = null;
  const turn = (i: Item) => i.k === 'you' || (i.k === 'work' && i.id.startsWith('u:'));
  const asks = (i: Item) => i.k === 'box' && !!i.asks?.length;
  const said = (t: string) => !/^\s*[/!]/.test(t);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!asks(it)) continue;
    const after = items.slice(i + 1).find((x) => turn(x) || asks(x));
    if (after && !turn(after)) closed[it.id] = { how: 'skipped' };
    else if (!after) {
      const a = next?.answer ? answerLine(next.t, it.asks!) : null;
      if (!next) live = it.id;
      else if (next.skill || !said(next.t)) closed[it.id] = { how: 'skipped' };
      else closed[it.id] = a ? { how: 'answered', by: a.by } : { how: 'words' };
    } else {
      const a = after.k === 'you' ? answerLine(after.t, it.asks!) : null;
      if (a) {
        answers[after.id] = a.rest;
        closed[it.id] = { how: 'answered', by: a.by };
      } else closed[it.id] = { how: after.k === 'you' && said(after.t) ? 'words' : 'skipped' };
    }
  }
  return { live, answers, closed };
}

// A reply's questions as card rows, with his picks so far, or once closed
// with what each went with.
function askRows(id: string, asks: Ask[], bundle: Bundle, closed?: Closed): QRow[] {
  return asks.map((a) => {
    const key = `${id}:${a.n}`;
    const e = closed ? undefined : bundle[key];
    const done = !closed ? undefined : closed.how === 'words' ? 'in your words' : closed.by?.[a.n] || 'skipped';
    return { key, n: a.n, q: a.q, kind: a.kind as Kind, choices: (a.options as unknown[]).map(choiceOf), picks: e?.picks ?? [], words: e?.words ?? '', done };
  });
}

// How each of the box's replies shows: its text, and the cards under it.
// The cards are open (live) until he sends something after the reply; a
// waiting card also closes when the box says more. A last line shaped
// 'Reply "X" to …' on the newest reply becomes a button. A block not closed
// yet shows only once the box is done. owner: the reply whose newest open
// card takes the keys.
function replyViews(items: Item[], open: boolean, busy: boolean) {
  let lastTurn = -1;
  let lastReply = -1;
  items.forEach((x, i) => {
    if (x.k === 'you' || (x.k === 'work' && x.id.startsWith('u:'))) lastTurn = i;
    if (x.k === 'box' && !x.mono && !x.id.startsWith('o:')) lastReply = i;
  });
  const views = new Map<string, { text: string; cards: CardData[]; live: boolean; waitLive: boolean }>();
  let owner: string | null = null;
  items.forEach((m, i) => {
    if (m.k !== 'box' || m.mono) return;
    const live = open && i > lastTurn;
    const cards: CardData[] = [...(m.cards ?? [])];
    let text = m.t;
    const inferred = live && i === lastReply && !m.asks?.length && !cards.some((c) => c.kind === 'actions') && !isDismissed(`${m.id}:${cards.length}`) ? inferActions(m.t) : null;
    if (inferred) {
      text = inferred.text;
      cards.push({ kind: 'actions', buttons: inferred.buttons, hint: inferred.line });
    }
    if (m.tail && !(busy && i === items.length - 1)) text = [text, m.tail].filter(Boolean).join('\n\n');
    if (!cards.length && text === m.t) return;
    views.set(m.id, { text, cards, live, waitLive: live && i === lastReply });
    if (live && cards.length) owner = m.id;
  });
  return { views, owner };
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

// His whole message as he sent it. One over about 8 lines shows its first
// lines, with Show all.
const CLIP_OVER = 8;

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

const Chevron = () => <Icon name="right" />;

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
  // His own words on Claude Code's question card.
  const [menuWords, setMenuWords] = useState('');
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
  // The cards under the replies; the newest open one takes the keys.
  const cardKeys = useRef<CardKeys | null>(null);
  const [, setCardTick] = useState(0);
  const replies = replyViews(items, !pending.length && !closed, box.status === 'working');
  const liveItem = asked.live ? items.find((i) => i.id === asked.live) : undefined;
  // The live card's own "In your words" waits under this key.
  const ownKey = liveItem ? `${liveItem.id}:words` : '';
  const liveKeys = liveItem?.asks ? [...liveItem.asks.map((a) => `${liveItem.id}:${a.n}`), ownKey] : [];
  const answers = compose(bundle, liveKeys);
  const liveRows = liveItem?.asks && !closed ? askRows(liveItem.id, liveItem.asks, bundle) : [];
  // Claude Code's own question (it offers "Type something"): it works as the
  // widgets under a reply do. A click marks a pick; the field's Send sends
  // his picks or his words. Other menus answer on the click.
  const question = !!menu && (menu.free != null || !!menu.multi);
  // Claude Code's permission ask and its plan approval have cards of their own.
  const special = !!menu && (!!menu.perm || menu.plan !== undefined);
  // What is picked, his picks first; check boxes start as the box shows them.
  const menuKey = menu ? menu.question + '|' + menu.options.map((o) => `${o.n}.${o.label}`).join('|') : '';
  const ticked = !menu
    ? []
    : ticks?.key === menuKey
      ? ticks.on
      : menu.multi
        ? menu.options.filter((o) => o.box && o.checked && o.n !== menu.free).map((o) => o.n)
        : [];
  const menuPicks = question ? ticked.map((n) => choiceOf(menu!.options.find((o) => o.n === n)?.label || '').label).filter(Boolean).join(', ') : '';
  // Claude Code's question as one card row: its choices, his picks.
  const menuChoices = menu && question ? shownOptions(menu).filter((o) => !menu.multi || o.box) : [];
  const menuN = (label: string) => menuChoices.find((o) => choiceOf(o.label).label === label)?.n;
  const menuRow: QRow | null =
    menu && question && !special
      ? {
          key: 'menu',
          n: 1,
          q: menu.question,
          kind: menu.multi ? 'any' : 'one',
          choices: menuChoices.map((o) => choiceOf(o.label)),
          picks: ticked.map((n) => choiceOf(menuChoices.find((o) => o.n === n)?.label || '').label).filter(Boolean),
          words: '',
        }
      : null;
  // The newest open card takes the keys of an empty message field.
  const cardRows = menuRow ? [menuRow] : liveRows;
  const cardHeld = menuRow ? ticked.length > 0 || !!menuWords : liveKeys.some((k) => bundle[k]);
  const at = (id: string | null) => (id ? items.findIndex((i) => i.id === id) : -1);
  const questionsFirst = !!menuRow || (liveRows.length > 0 && at(asked.live) >= at(replies.owner));

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

  // A card's button sends its words as his message; Change on a draft
  // quotes it, and his words go in the message field.
  function sendCard(text: string) {
    stick.current = true;
    return onSend(text);
  }
  function quoteCard(quote: string) {
    keepQuote(quote, '');
    input.current?.focus();
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

  const setMenuPicks = (labels: string[]) => setPicks(labels.map(menuN).filter((n): n is number => n != null));

  function pickOn(r: QRow, picks: string[]) {
    if (r.key === 'menu') setMenuPicks(picks);
    else setEntry(r.key, entryFor(r.n, r.kind, picks, r.words));
  }

  function clearCard() {
    if (menuRow) {
      setPicks([]);
      setMenuWords('');
    } else for (const k of liveKeys) setEntry(k, null);
  }

  // The card's Send: only its answers go, by number, his own words after;
  // what he typed in the field stays there.
  async function sendAnswers() {
    if (!answers || blocked) return;
    const keys = new Set(liveKeys);
    const was = Object.fromEntries(Object.entries(bundle).filter(([k]) => keys.has(k)));
    setBundle((b) => Object.fromEntries(Object.entries(b).filter(([k]) => !keys.has(k))));
    stick.current = true;
    const ok = await onSend(answers, { answer: true });
    if (!ok && alive.current) setBundle((b) => ({ ...was, ...b }));
  }

  // 1 to 9 pick on the newest open card's current question, Enter takes its
  // recommended choice, Escape clears its picks. True when the key was used.
  function cardKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !cardRows.length || closed) return false;
    const cur = currentRow(cardRows);
    let p: string[] | null = null;
    if (/^[1-9]$/.test(e.key)) p = keyPick(cur, Number(e.key));
    else if (e.key === 'Enter') p = recommendedPick(cur);
    else if (e.key === 'Escape' && cardHeld) {
      e.preventDefault();
      e.stopPropagation();
      clearCard();
      return true;
    }
    if (!p) return false;
    e.preventDefault();
    pickOn(cur, p);
    return true;
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
  // pick, and go with the ticks where several are allowed. field: the words
  // come from the message field, not the card.
  async function answerQuestion(words: string, field = true) {
    if (!box.paneId || !menu || menuBusy) return;
    const on = picksNow();
    if (!words && !on.length) return;
    setSending(true);
    stick.current = true;
    // His words leave the field at once, as a message does.
    const was = draft;
    if (!field) words = words.trim();
    else if (words) {
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
      if (!ok && words && field) onLost(was);
      return;
    }
    setSending(false);
    if (ok) {
      clearTicks();
      if (!field) setMenuWords('');
    } else if (words && field) setDraft((d) => [was, d].filter(Boolean).join('\n'));
  }

  // Picks belong to the question on screen: the same question asked again
  // later starts from what the box shows.
  useEffect(() => {
    if (!question) {
      clearTicks();
      setMenuWords('');
    }
  }, [question]);

  // Claude Code's permission ask: Enter allows and Esc denies, while the
  // message field is empty.
  useEffect(() => {
    if (!menu?.perm || !box.paneId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const el = document.activeElement;
      if (el !== input.current && el && el !== document.body && el.closest('input, textarea, button, select, [role="dialog"], [role="menu"], .drill')) return;
      if ((input.current?.value || '').trim() || atts.length || pop) return;
      e.preventDefault();
      e.stopPropagation();
      if (menuBusy) return;
      const { yes, no } = permOptions(menu);
      if (e.key === 'Enter') yes && void choose(yes.n);
      else if (no) void choose(no.n);
      else void dismiss();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menuKey, box.paneId, atts.length, !!pop, menuBusy]);

  // "Made in this box" shows a question in the chat: its reply comes into
  // the list if it is further up, and the chat moves to it.
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      const i = items.findIndex((x) => x.id === id);
      if (i < 0) return;
      setLimit((l) => Math.max(l, items.length - i + 4));
      setJumpTo(id);
    };
    window.addEventListener('cm-jump', on);
    return () => window.removeEventListener('cm-jump', on);
  }, [items]);
  useLayoutEffect(() => {
    if (!jumpTo) return;
    const el = scroller.current?.querySelector(`[data-item="${CSS.escape(jumpTo)}"]`);
    if (!el) return;
    setJumpTo(null);
    stick.current = false;
    el.scrollIntoView({ block: 'center' });
  });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (keep.current) {
      el.scrollTop = el.scrollHeight - keep.current.h + keep.current.top;
      keep.current = null;
    } else if (stick.current) el.scrollTop = el.scrollHeight;
  });

  // His place: a New line above the first reply he has not seen, and a ↓
  // with a count for replies that come while he reads higher up.
  const place = usePlace({ key: box.session || box.name, items, loaded: !!chat?.loaded, reset: chat?.reset ?? 0, fresh: chat?.fresh, scroller, stick });
  const keepN = Math.max(limit, place.need);
  const rows = place.withLine(items.length > keepN ? items.slice(-keepN) : items);

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
      if (question && !sending && !closed) await (typed || !menuWords.trim() ? answerQuestion(typed) : answerQuestion(menuWords, false));
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

  // A turn's line of facts sits under the reply it closes, in that reply's
  // column: the same left edge and width.
  const under = new Map<string, Item>();
  for (let i = 1; i < rows.length; i++) {
    const t = rows[i];
    const r = rows[i - 1];
    if (t.k === 'work' && t.turn && r.k === 'box' && !r.mono && (!folds[r.id] || unfolded.has(r.id))) under.set(r.id, t);
  }
  const taken = new Set([...under.values()].map((t) => t.id));
  const turnCard = (t: Item) => (
    <TurnCard
      key={t.id}
      item={t}
      paneId={box.paneId ?? box.lastPane ?? null}
      canAsk={!blocked}
      onAsk={(x) => {
        stick.current = true;
        onSend(x);
      }}
    />
  );

  let middle;
  if (starting && !menu && !waiting && !pending.length)
    middle = (
      <div className="empty">
        <NowLine text="Starting…" />
      </div>
    );
  else if (chat?.loaded && !items.length && !pending.length && !working && !menu && !resuming && !failed && !ended && !waiting && !draft.trim())
    middle = <div className="empty">{off ? 'Nothing runs in this window.' : ''}</div>;
  else
    middle = (
      <div className="chat-col">
        {note && <div className="ended-note">{note}</div>}
        {rows.map((m) => {
          if (taken.has(m.id)) return null;
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
          // His answers from a card show on the card; only what he wrote
          // after them is his bubble.
          if (m.k === 'you' && asked.answers[m.id] != null)
            return asked.answers[m.id] ? (
              <div key={m.id} className={'you' + (isFresh && !quiet.has(m.id) ? ' sent' : '')}>
                <YouText text={asked.answers[m.id]} attachDir={attachDir} onOpen={onOpen} />
              </div>
            ) : null;
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
          // Where his unseen replies start.
          if (m.id === NEW_LINE)
            return (
              <div key={m.id} className="new-line" role="separator">
                New
              </div>
            );
          // A turn's one line of facts; a click opens what it did.
          if (m.k === 'work' && m.turn) return <div key={m.id} className="reply-group">{turnCard(m)}</div>;
          // "Interrupted", "Compacted": one small centred word.
          if (m.k === 'work')
            return (
              <div key={m.id} className={'mark-word' + (isFresh && !quiet.has(m.id) ? ' rise' : '')}>
                {m.t}
              </div>
            );
          if (m.mono)
            return (
              <pre key={m.id} className={'say shell-out' + (isFresh ? ' rise' : '')}>
                {m.t}
              </pre>
            );
          // The box's reply sits in a soft bubble; its cards (its questions,
          // its blocks, the turn's facts) sit under it, outside the bubble,
          // in its column.
          const view = replies.views.get(m.id);
          const text = view ? view.text : m.t;
          const cards = view && view.cards.length ? view : null;
          const t = under.get(m.id);
          if (!m.asks?.length && !cards && !t)
            return (
              <div key={m.id} className={'say' + (isFresh ? ' rise' : '')} data-quote="">
                <Markdown text={text} />
              </div>
            );
          const isLive = m.id === asked.live && !closed;
          return (
            <div key={m.id} className={'reply-group' + (cards ? ' has-cards' : '') + (isFresh ? ' rise' : '')} data-item={m.id}>
              {text.trim() && (
                <div className="say" data-quote="">
                  <Markdown text={text} />
                </div>
              )}
              {!!m.asks?.length && (
                <QuestionCard
                  rows={isLive ? liveRows : askRows(m.id, m.asks, bundle, asked.closed[m.id])}
                  live={isLive}
                  done={!!asked.closed[m.id]}
                  words={isLive ? bundle[ownKey]?.text ?? '' : undefined}
                  onWords={(w) => setEntry(ownKey, w ? { text: w, words: w } : null)}
                  onPick={pickOn}
                  onField={(r, w) => setEntry(r.key, entryFor(r.n, r.kind, r.picks, w))}
                  onSend={sendAnswers}
                  onClear={() => liveKeys.forEach((k) => setEntry(k, null))}
                />
              )}
              {cards && (
                <Cards
                  id={m.id}
                  cards={cards.cards}
                  live={cards.live}
                  waitLive={cards.waitLive}
                  since={m.ts ? Date.parse(m.ts) : null}
                  keys={m.id === replies.owner ? cardKeys : undefined}
                  onSend={sendCard}
                  onQuote={quoteCard}
                  onDismiss={() => setCardTick((n) => n + 1)}
                />
              )}
              {t && turnCard(t)}
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
            // His answers show on the card at once; only his own words after
            // them are a bubble.
            (() => {
              const a = answerLine(p.t);
              const rest = a ? a.rest : p.t;
              if (!rest && !p.queued) return null;
              return (
                <div key={p.id} className="pending">
                  {rest && (
                    <div className="you sent">
                      <YouText text={rest} attachDir={attachDir} onOpen={onOpen} />
                    </div>
                  )}
                  {p.queued && <span className="queued">{rest ? 'queued' : 'Answers queued'}</span>}
                </div>
              );
            })()
          ) : (
            <div key={p.id} className="pending">
              <div className="you sent">
                <YouText text={p.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
              {p.queued && <span className="queued">queued</span>}
            </div>
          ),
        )}
        {menu && menu.perm && <PermCard key={menuKey} menu={menu} busy={menuBusy} onPick={choose} onDeny={dismiss} />}
        {menu && menu.plan !== undefined && <PlanCard key={menuKey} menu={menu} busy={menuBusy || sending} onPick={choose} onKeep={dismiss} />}
        {menuRow && menu && (
          // The same card as a reply's questions: picks mark, Send sends.
          <div className="ask rise" key={menuKey}>
            <QuestionCard
              rows={[menuRow]}
              live={!closed}
              words={menu.free != null ? menuWords : undefined}
              onWords={setMenuWords}
              onPick={(_r, p) => setMenuPicks(p)}
              onSend={() => answerQuestion(menuWords, false)}
              onCancel={canCancel(menu) ? dismiss : undefined}
              onClear={clearCard}
              sending={menuBusy || sending}
            />
          </div>
        )}
        {menu && !question && !special && (
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
                  {o.current && <Check />}
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
        {starting && !menu && <NowLine text="Starting…" />}
        {resuming && !menu && <NowLine text="Coming back…" />}
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
        {/* The turn that runs: a failure shows at once, in red; then what it
            does now, in plain words. */}
        {chat?.now && chat.now.failed.length > 0 && !closed && <NowFailed now={chat.now} />}
        {working && <NowLine text={nowText(chat?.now)} since={chat?.now?.since ? Date.parse(chat.now.since) : box.since} />}
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
          if (e.detail > 0 && (e.target as Element).closest('.q-chip')) input.current?.focus();
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
          place.onScroll(stick.current);
          if (el.scrollTop < 300 && items.length > limit && !keep.current) {
            keep.current = { h: el.scrollHeight, top: el.scrollTop };
            setLimit((l) => l + PAGE);
          }
        }}
      >
        <PictureOpen.Provider value={onOpen}>{middle}</PictureOpen.Provider>
        <Jump n={place.below} onClick={place.jump} />
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
        {!pop && !closed && <LiveDock box={box} />}
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
            // Escape here clears the newest card's picks first (App reads it).
            data-held={cardHeld && !draft ? '' : undefined}
            placeholder={menu?.perm && !closed ? 'Enter allows · Esc denies' : menu?.plan !== undefined && !closed ? 'Or tell it what to change' : menu && (closed || !menu.free) ? 'Pick an option above' : ''}
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
              // The newest open card takes the keys while the field is empty:
              // Claude's question first, then the newer of the reply's
              // questions (1 to 9 pick, Enter the recommended one, Esc
              // clears) and its other cards (1 to 9 pick, Enter the main
              // button, Esc puts it away).
              const ck = cardKeys.current;
              // Claude Code's permission ask and plan approval keep the keys.
              if (!special && !draft && !atts.length && !quotes.length && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                if (questionsFirst) {
                  if (cardKey(e)) return;
                } else if (ck && !answers && !menu) {
                  if (/^[1-9]$/.test(e.key) && ck.pick?.(Number(e.key))) return e.preventDefault();
                  if (e.key === 'Enter' && ck.main) {
                    e.preventDefault();
                    return ck.main();
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    return ck.dismiss();
                  }
                }
              }
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
            <button aria-label="Send" data-tip="Send" className={'send tip up' + (!blocked && (menu ? question && !closed && (draft.trim() || ticked.length || menuWords.trim()) : draft.trim() || atts.length || answers || quotes.length) ? ' ready' : '')} onClick={() => submit()} disabled={blocked}>
              <Arrow />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, Box, Draft, Item, Menu, Result } from './api';
import { Arrow, Check } from './icons';
import { Markdown } from './Markdown';

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
function Folded({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n');
  if (open || lines.length <= FOLD_OVER) return <>{text}</>;
  return (
    <>
      {lines.slice(0, FOLD_SHOW).join('\n')}
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
  onOpen,
  onSend,
  onError,
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
  onOpen: (url: string) => void;
  onSend: (text: string) => Promise<boolean>;
  onError: (text: string) => void;
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
  const typed = !!draft.trim() || atts.length > 0;
  const history = [...items.filter((i) => i.k === 'you').map((i) => i.t), ...pending.map((p) => p.t)];
  // His messages that Claude's rewind menu lists: no commands, no shell lines.
  const earlier = items.filter((i) => i.k === 'you' && !/^[/!]/.test(i.t));

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
    onDraft(draft || atts.length ? { text: draft, caret, atts } : null);
  }

  useEffect(report, [draft, atts]);

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

  async function submit(textIn?: string) {
    const typed = (textIn ?? draft).trim();
    const paths = atts.map((a) => a.path);
    const text = [typed, ...paths].filter(Boolean).join(' ');
    if (!text || sending || closed) return;
    // While a question shows, the field answers it in his own words where
    // Claude offers that; otherwise the note above the field says what to do.
    if (menu && (!menu.free || !typed)) return;
    setSending(true);
    stick.current = true;
    let ok: boolean;
    if (menu) {
      const r = await api().answer(box.paneId!, typed);
      if (!r.ok) onError(r.reason || 'Not sent.');
      ok = r.ok;
    } else ok = await onSend(text);
    setSending(false);
    if (ok) {
      setDraft('');
      setAtts([]);
      setHist(null);
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
  async function startAgain() {
    setEndBusy(true);
    setEndWhy(null);
    const r = await api().startAgain(box.name);
    setEndBusy(false);
    if (!r.ok) setEndWhy(r.reason || "Couldn't start it again.");
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
  if (starting && !menu)
    middle = (
      <div className="empty">
        <Live text="Starting…" />
      </div>
    );
  else if (chat?.loaded && !items.length && !pending.length && !working && !menu && !resuming && !failed && !ended)
    middle = <div className="empty">{off ? 'Nothing runs in this window.' : 'No messages yet.'}</div>;
  else
    middle = (
      <div className="chat-col">
        {note && <div className="ended-note">{note}</div>}
        {shown.map((m) => {
          const isFresh = chat!.fresh.has(m.id);
          const folded = folds[m.id];
          if (folded && !unfolded.has(m.id))
            return (
              <button key={m.id} className="work fold" onClick={() => setUnfolded((s) => new Set(s).add(m.id))} title="Show the whole message">
                <Chevron />
                {folded}
              </button>
            );
          if (m.k === 'you')
            return (
              <div key={m.id} className={'you' + (isFresh && !quiet.has(m.id) ? ' sent' : '')}>
                <YouText text={m.t} attachDir={attachDir} onOpen={onOpen} />
              </div>
            );
          if (m.k === 'work')
            return (
              <div key={m.id} className={'work' + (isFresh ? ' rise' : '')}>
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
            <div key={m.id} className={'say' + (isFresh ? ' rise' : '')}>
              <Markdown text={m.t} />
            </div>
          );
        })}
        {pending.map((p) => (
          <div key={p.id} className="pending">
            <div className="you sent">
              <YouText text={p.t} attachDir={attachDir} onOpen={onOpen} />
            </div>
            {p.queued && <span className="queued">queued</span>}
          </div>
        ))}
        {menu && (
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
        {resuming && !menu && <Live text="Coming back…" />}
        {ended && (
          <div className="ended rise" role="status">
            <div className="ended-line">
              <span>{box.name} ended</span>
              {box.ended?.start && (
                <button className="text-btn" onClick={startAgain} disabled={endBusy}>
                  Start it again
                </button>
              )}
              <button className="text-btn" onClick={closeEnded} disabled={endBusy}>
                Remove from list
              </button>
            </div>
            {endWhy && (
              <div className="ended-why" role="alert">
                {endWhy}
              </div>
            )}
            {box.ended?.later ? (
              <div className="ended-note">
                {typed
                  ? 'The conversation and your typed text stay saved. You can resume them later from New Box.'
                  : 'The conversation stays saved. You can resume it later from New Box.'}
              </div>
            ) : (
              typed && <div className="ended-note">Your typed text goes too.</div>
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
        <div className={'composer' + (draft.includes('\n') || draft.length > 70 ? ' tall' : '') + (draft.startsWith('!') ? ' shell' : '')}>
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
            readOnly={closed}
            aria-expanded={pop ? 'true' : 'false'}
            placeholder={closed ? '' : menu?.free ? 'Type your own answer' : 'Message'}
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
              if (e.key === 'Tab' && e.shiftKey && box.mode) {
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
          <button aria-label="Send" className={'send' + (!closed && (draft.trim() || atts.length) ? ' ready' : '')} onClick={() => submit()} disabled={closed}>
            <Arrow />
          </button>
        </div>
        {!closed && (box.mode || draft.startsWith('!')) && (
          <div className="composer-foot">
            {draft.startsWith('!') ? (
              <span className="shell-hint">Runs in {box.name}'s shell</span>
            ) : (
              <button className={'mode-chip' + (/plan/i.test(box.mode || '') ? ' plan' : '')} onClick={cycleMode} title="Change mode (Shift+Tab)">
                {box.mode}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}

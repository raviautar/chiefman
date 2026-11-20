import { useLayoutEffect, useRef, useState } from 'react';
import { api, Box, Item } from './api';
import { Arrow } from './icons';
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

const PAGE = 150;

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
  onSend,
  onError,
}: {
  box: Box;
  chat: ChatState | undefined;
  pending: Pending[];
  quiet: Set<string>;
  onSend: (text: string) => Promise<boolean>;
  onError: (text: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [hist, setHist] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const keep = useRef<{ h: number; top: number } | null>(null);
  const items = chat?.items ?? [];
  const shown = items.length > limit ? items.slice(-limit) : items;
  const menu = box.menu;
  const starting = box.status === 'starting';
  const working = box.status === 'working' && !menu;
  const off = box.status === 'off';
  const history = [...items.filter((i) => i.k === 'you').map((i) => i.t), ...pending.map((p) => p.t)];

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

  async function submit(textIn?: string) {
    const text = (textIn ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    stick.current = true;
    const ok = await onSend(text);
    setSending(false);
    if (ok) {
      setDraft('');
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

  // A dropped or pasted file is saved by the app; its path goes in the message.
  async function attach(files: FileList | File[]) {
    const paths: string[] = [];
    for (const f of Array.from(files)) {
      const r = await api().attach(f.name || 'pasted.png', await f.arrayBuffer());
      if (r.ok && r.path) paths.push(r.path);
      else onError(r.reason || 'Could not add the file.');
    }
    if (!paths.length) return;
    setDraft((d) => (d && !/\s$/.test(d) ? d + ' ' : d) + paths.join(' ') + ' ');
    input.current?.focus();
  }

  async function cycleMode() {
    if (!box.paneId) return;
    const r = await api().cycleMode(box.paneId);
    if (!r.ok) onError(r.reason || 'Not changed.');
  }

  let middle;
  if (starting && !menu)
    middle = (
      <div className="empty">
        <Live text="Starting…" />
      </div>
    );
  else if (chat?.loaded && !items.length && !pending.length && !working && !menu)
    middle = <div className="empty">{off ? 'Nothing runs in this window.' : 'No messages yet.'}</div>;
  else
    middle = (
      <div className="chat-col">
        {shown.map((m) => {
          const isFresh = chat!.fresh.has(m.id);
          if (m.k === 'you')
            return (
              <div key={m.id} className={'you' + (isFresh && !quiet.has(m.id) ? ' sent' : '')}>
                {m.t}
              </div>
            );
          if (m.k === 'work')
            return (
              <div key={m.id} className={'work' + (isFresh ? ' rise' : '')}>
                <Chevron />
                {m.t}
              </div>
            );
          return (
            <div key={m.id} className={'say' + (isFresh ? ' rise' : '')}>
              <Markdown text={m.t} />
            </div>
          );
        })}
        {pending.map((p) => (
          <div key={p.id} className="pending">
            <div className="you sent">{p.t}</div>
            {p.queued && <span className="queued">queued</span>}
          </div>
        ))}
        {menu && (
          <div className="ask rise" key={menu.question + menu.options.length}>
            {menu.question && <div className="say">{menu.question}</div>}
            <div className="choices">
              {menu.options.map((o) => (
                <button key={o.n} className={'chip' + (o.n === menu.selected ? ' primary' : '')} onClick={() => choose(o.n)}>
                  {o.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {working && <Live text={box.activity || 'Working'} />}
      </div>
    );

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
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length) attach(e.dataTransfer.files);
        }}
      >
        <div className={'composer' + (draft.includes('\n') || draft.length > 70 ? ' tall' : '')}>
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
            disabled={off || starting}
            placeholder={off || starting ? '' : 'Message'}
            onChange={(e) => {
              setDraft(e.target.value);
              setHist(null);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                attach(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
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
          <button aria-label="Send" className={'send' + (draft.trim() ? ' ready' : '')} onClick={() => submit()} disabled={off || starting}>
            <Arrow />
          </button>
        </div>
        {box.mode && !starting && (
          <div className="composer-foot">
            <button className="mode-chip" onClick={cycleMode} title="Change mode (Shift+Tab)">
              {box.mode}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

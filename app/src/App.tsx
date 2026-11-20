import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Box, BoxSpec, Drill, HubEvent, PhaseInfo, Snapshot } from './api';
import { BoxIcon, Check, Spinner } from './icons';
import { Picker } from './Picker';
import { Action, Confirm, ContextPop, MoreMenu, Palette, RenameSheet } from './Actions';
import { ChatState, ChatView, Pending, norm } from './Chat';
import { TerminalView } from './Terminal';
import { DrillPanel } from './Drill';
import { NewBoxSheet } from './NewBox';

type Toast = { text: string; bad?: boolean; id: number };

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};

function money(n: number | null) {
  if (n == null) return '';
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

function meterLine(b: Box) {
  const parts = [];
  if (b.cost != null && b.cost > 0) parts.push(money(b.cost));
  if (b.context != null) parts.push(`${Math.round(b.context * 100)}% context`);
  return parts.join(' · ');
}

export function App() {
  const [info, setInfo] = useState<PhaseInfo>({ phase: 'starting', error: null, restore: null });
  const [config, setConfig] = useState<Snapshot['config'] | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [selected, setSelected] = useState<string | null>(store.get('chiefman.selected'));
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [panel, setPanel] = useState(store.get('chiefman.panel') === '1');
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [overlay, setOverlay] = useState<'newbox' | 'switch' | 'clear' | 'compact' | 'rename' | null>(null);
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState(false);
  const [ctx, setCtx] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ title: string; typed: string; answer: (yes: boolean) => void } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [, setTick] = useState(0);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, { text: string; seq: number }>>({});
  const pending = useRef<Record<string, Pending[]>>({});
  const quiet = useRef(new Set<string>());
  const wantSelect = useRef<string | null>(null);
  const wantPane = useRef<string | null>(null);
  const boxesRef = useRef<Box[]>([]);
  boxesRef.current = boxes;

  const show = (text: string, bad = false) => setToast({ text, bad, id: Date.now() });

  useEffect(() => {
    const off = api().onEvent((ev: HubEvent) => {
      switch (ev.type) {
        case 'phase':
          setInfo({ phase: ev.phase, error: ev.error, restore: ev.restore });
          break;
        case 'boxes':
          setBoxes(ev.boxes);
          if ('restore' in ev) setInfo((i) => ({ ...i, restore: ev.restore ?? null }));
          break;
        case 'draft':
          setDrafts((d) => ({ ...d, [ev.paneId]: { text: ev.text, seq: Date.now() } }));
          break;
        case 'drill':
          setDrill(ev.drill);
          break;
        case 'notice':
          show(ev.text, !!ev.bad);
          break;
        case 'select':
          wantPane.current = ev.paneId;
          setTick((t) => t + 1);
          break;
        case 'chat-reset':
          setChats((c) => ({ ...c, [ev.paneId]: { items: ev.items, fresh: new Set(), steps: ev.steps, loaded: true } }));
          break;
        case 'chat-add': {
          const fresh = new Set(ev.added.map((a) => a.item.id));
          // His message, back from the log, replaces its sent bubble quietly.
          const list = pending.current[ev.paneId] || [];
          for (const a of ev.added) if (a.item.k === 'you' && list.some((p) => p.n === norm(a.item.t))) quiet.current.add(a.item.id);
          setChats((c) => {
            const prev = c[ev.paneId];
            const items = prev ? [...prev.items] : [];
            for (const { item, after } of ev.added) {
              if (items.some((i) => i.id === item.id)) continue;
              if (after === null) items.unshift(item);
              else {
                const at = items.findIndex((i) => i.id === after);
                if (at < 0) items.push(item);
                else items.splice(at + 1, 0, item);
              }
            }
            return { ...c, [ev.paneId]: { items, fresh, steps: ev.steps, loaded: true } };
          });
          break;
        }
      }
    });
    api()
      .init()
      .then((s) => {
        setInfo({ phase: s.phase, error: s.error, restore: s.restore });
        setConfig(s.config);
        setBoxes(s.boxes);
        setDrill(s.drill);
      });
    const clock = setInterval(() => setNow(Date.now()), 20000);
    return () => {
      off();
      clearInterval(clock);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.bad ? 4200 : 2600);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const p = wantPane.current;
    const hit = p && boxesRef.current.find((b) => b.paneId === p);
    if (hit) {
      setSelected(hit.name);
      setView('chat');
      wantPane.current = null;
    }
  });

  useEffect(() => {
    if (wantSelect.current && boxes.some((b) => b.name === wantSelect.current)) {
      setSelected(wantSelect.current);
      setView('chat');
      wantSelect.current = null;
    }
  }, [boxes]);

  const box = useMemo(() => boxes.find((b) => b.name === selected) || boxes[0] || null, [boxes, selected]);
  const paneId = box ? box.paneId : null;

  useEffect(() => {
    if (box) store.set('chiefman.selected', box.name);
  }, [box?.name]);

  useEffect(() => {
    store.set('chiefman.panel', panel ? '1' : '0');
  }, [panel]);

  useEffect(() => {
    if (paneId) api().watch(paneId);
  }, [paneId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.metaKey && !overlay && !ask && !picking && !more && !ctx && view === 'chat' && box?.paneId && box.status === 'working') {
        const el = document.activeElement;
        if (el && (el.closest('.drill') || el.getAttribute('aria-expanded') === 'true')) return;
        e.preventDefault();
        api()
          .interrupt(box.paneId)
          .then((r) => r.ok && show(`Interrupted ${box.name}`));
        return;
      }
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const at = boxes.findIndex((b) => b.name === box?.name);
      let next: Box | undefined;
      if (/^[1-9]$/.test(k)) next = boxes[Number(k) - 1];
      else if (k === '[' || e.code === 'BracketLeft') next = boxes[(at - 1 + boxes.length) % boxes.length];
      else if (k === ']' || e.code === 'BracketRight') next = boxes[(at + 1) % boxes.length];
      else if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        setOverlay('newbox');
        return;
      } else if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        setOverlay((o) => (o === 'switch' ? null : 'switch'));
        return;
      } else if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        setView((v) => (v === 'chat' ? 'terminal' : 'chat'));
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (next) setSelected(next.name);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [boxes, box, overlay, view, picking, more, ctx, ask]);

  // Asks once, in the app, before typed text of his is replaced.
  function askReplace(name: string, typed: string) {
    return new Promise<boolean>((resolve) => {
      let done = false;
      const answer = (yes: boolean) => {
        if (done) return;
        done = true;
        setAsk(null);
        resolve(yes);
      };
      setAsk({ title: `Replace what's typed in ${name}?`, typed, answer });
    });
  }

  async function sendToBox(text: string) {
    if (!box || !box.paneId) return false;
    const p = box.paneId;
    const name = box.name;
    // A command gets no bubble: the log shows it, or it is one the app hides.
    // A message gets its bubble before delivery ends, and keeps it until the
    // log holds one more copy of the same text than it did now.
    // The bubble shows the text as the log will: secrets masked.
    const id = 'p' + Date.now();
    if (!text.startsWith('/')) {
      const shown = await api().mask(text);
      const n = norm(shown);
      const list = pending.current[p] || [];
      const base = youCount(p, n) + list.filter((x) => x.n === n).length;
      pending.current[p] = [...list, { id, t: shown, n, base, queued: box.status === 'working' }];
      setTick((t) => t + 1);
    }
    const drop = () => {
      pending.current[p] = (pending.current[p] || []).filter((x) => x.id !== id);
      setTick((t) => t + 1);
    };
    let r = await api().send(p, text);
    if (!r.ok && r.ask === 'replace') {
      if (!(await askReplace(name, r.typed || ''))) {
        drop();
        return false;
      }
      r = await api().send(p, text, true);
    }
    if (!r.ok) {
      drop();
      show(r.reason || 'Not sent.', true);
      return false;
    }
    if (r.duplicate) {
      drop();
      return true;
    }
    pending.current[p] = (pending.current[p] || []).map((x) => (x.id === id ? { ...x, queued: !!r.queued } : x));
    setTick((t) => t + 1);
    return true;
  }

  async function sendDrill(n: number, text: string) {
    const chief = boxes.find((b) => b.name === 'chief');
    let r = await api().sendChief(`${n}. ${text}`);
    if (!r.ok && r.ask === 'replace') {
      if (!(await askReplace(chief ? chief.name : 'chief', r.typed || ''))) return false;
      r = await api().sendChief(`${n}. ${text}`, true);
    }
    if (!r.ok) {
      show(r.reason || 'Not sent.', true);
      return false;
    }
    setSent((s) => ({ ...s, [`${drill?.id}:${n}`]: text }));
    return true;
  }

  function youCount(paneId: string, n: string) {
    const items = chats[paneId]?.items || [];
    return items.filter((i) => i.k === 'you' && norm(i.t) === n).length;
  }

  // Sent bubbles whose message the log now holds are gone.
  function pendingFor(paneId: string) {
    const list = pending.current[paneId] || [];
    const keep = list.filter((x) => youCount(paneId, x.n) <= x.base);
    if (keep.length !== list.length) pending.current[paneId] = keep;
    return keep;
  }

  function startBox(spec: BoxSpec) {
    setOverlay(null);
    wantSelect.current = spec.name;
    api()
      .newBox(spec)
      .then((r) => !r.ok && show(r.reason || 'Could not start the box.', true));
  }

  async function switchBox(kind: 'model' | 'effort', value: string) {
    if (!box?.paneId) return;
    setPicking(false);
    const r = await api().switchBox(box.paneId, kind, value);
    if (!r.ok) show(r.reason || 'Not switched.', true);
  }

  async function remote() {
    if (!box?.paneId) return;
    const r = await api().remote(box.paneId);
    if (!r.ok) return show(r.reason || 'Not sent.', true);
    if (r.url) {
      api().copy(r.url);
      setLinkFor(box.paneId);
    }
  }

  async function act(kind: 'compact' | 'clear') {
    if (!box?.paneId) return;
    const r = await api().action(box.paneId, kind);
    if (!r.ok) show(r.reason || 'Not sent.', true);
  }

  function openContext() {
    if (!box?.paneId) return;
    setCtx(ctx === box.paneId ? null : box.paneId);
  }

  async function rename(name: string) {
    if (!box?.paneId) return;
    const r = await api().rename(box.paneId, name);
    if (!r.ok) show(r.reason || 'Not renamed.', true);
    else setSelected(name);
  }

  const boxActions: Action[] =
    box && box.paneId && box.status !== 'off' && box.status !== 'starting' && box.status !== 'resuming' && box.status !== 'failed'
      ? [
          { label: 'Compact', run: () => setOverlay('compact') },
          { label: 'Clear', run: () => setOverlay('clear') },
          { label: 'Rename', run: () => setOverlay('rename') },
          { label: box.remote ? 'Copy Remote Control link' : 'Turn on Remote Control', hint: box.remote ? 'on' : '', run: remote },
        ]
      : [];
  const paletteActions: Action[] = [
    ...boxActions,
    { label: 'Model and effort', run: () => setPicking(true) },
    { label: 'New box', run: () => setOverlay('newbox') },
    { label: view === 'chat' ? 'Terminal' : 'Chat', run: () => setView(view === 'chat' ? 'terminal' : 'chat') },
  ];

  const asks = drill ? drill.items.filter((i) => !sent[`${drill.id}:${i.n}`]).length : 0;
  const title = box ? box.name : 'chiefman';
  const meter = box ? meterLine(box) : '';
  const live = box && box.paneId && box.status !== 'off' && box.status !== 'starting' && box.status !== 'resuming' && box.status !== 'failed';
  const fold = panel && box && box.name === 'chief' && drill ? { id: drill.id, count: asks } : null;

  let body;
  if (!box || !box.paneId) {
    body = (
      <div className="chat">
        <div className="empty">
          {info.phase === 'error' ? (
            <>
              <h2>tmux is out of reach</h2>
              {info.error}
            </>
          ) : (
            <>
              <h2>Connecting</h2>
              Looking for the {config?.session ?? 'chief'} session in tmux.
            </>
          )}
        </div>
      </div>
    );
  } else if (view === 'terminal') {
    body = <TerminalView key={box.paneId} paneId={box.paneId} />;
  } else {
    body = (
      <ChatView
        key={box.paneId}
        box={box}
        chat={chats[box.paneId]}
        pending={pendingFor(box.paneId)}
        quiet={quiet.current}
        fold={fold}
        incoming={drafts[box.paneId]}
        onTaken={() => {
          const p = box.paneId!;
          setDrafts((d) => {
            const next = { ...d };
            delete next[p];
            return next;
          });
        }}
        onSend={sendToBox}
        onError={(t) => show(t, true)}
      />
    );
  }

  return (
    <div className="app">
      <nav className="nav" aria-label="Sidebar">
        <div className="nav-lights" />
        <div className="nav-list">
          {boxes.map((b, i) => {
            const on = box?.name === b.name;
            return (
              <button
                key={b.id}
                className={'row' + (on ? ' on' : '') + (b.status === 'off' || b.status === 'failed' ? ' off' : '')}
                onClick={() => setSelected(b.name)}
                title={i < 9 ? `${b.name}  ⌘${i + 1}` : b.name}
              >
                <BoxIcon icon={b.icon} color={b.status === 'off' ? '#B3B2AD' : b.color} />
                <span className="name">{b.name}</span>
                {b.cost != null && b.cost > 0 && <span className="row-cost">{money(b.cost)}</span>}
                {b.menu ? (
                  <span className="dot-asks" aria-label="asks you" title="Asks you" />
                ) : (
                  b.status === 'working' && <span className="dot-working" aria-label="working" />
                )}
                {b.status === 'resuming' && !b.menu && <Spinner />}
                {b.status === 'resumed' && <Check color="#034F46" />}
              </button>
            );
          })}
        </div>
        {info.restore && (
          <div className="nav-quiet" role="status">
            {info.restore.label} · {info.restore.done} of {info.restore.total}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button className="row" onClick={() => setOverlay('newbox')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B5B59" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 8v8 M8 12h8" />
          </svg>
          <span style={{ color: '#5B5B59' }}>New Box</span>
        </button>
      </nav>

      <main className="main">
        <div className="bar">
          <div className="bar-title">
            <h1>{title}</h1>
            {live && (
              <div className="bar-meta">
                {meter && (
                  <span style={{ position: 'relative' }}>
                    <button className="pill meter" onClick={openContext} title="What fills the context">
                      {meter}
                    </button>
                    {ctx === box!.paneId && <ContextPop tokens={box!.tokens} onClose={() => setCtx(null)} />}
                  </span>
                )}
                {box!.modelName && (
                  <span style={{ position: 'relative' }}>
                    <button className="pill" onClick={() => setPicking(!picking)} title="Model and effort" disabled={!!box!.switching}>
                      {box!.switching && !box!.switching.asking ? (
                        'Switching…'
                      ) : (
                        <>
                          {box!.modelName}
                          {box!.effort ? ` · ${box!.effort}` : ''}
                        </>
                      )}
                    </button>
                    {picking && <Picker model={box!.model} effort={box!.effort} onPick={switchBox} onClose={() => setPicking(false)} />}
                  </span>
                )}
                <span style={{ position: 'relative' }}>
                  <button className="icon-btn" onClick={() => setMore(!more)} aria-label="More" title="More">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                  {more && <MoreMenu actions={boxActions} onClose={() => setMore(false)} />}
                </span>
                {linkFor === box!.paneId && box!.remote && (
                  <span className="copied">
                    Link copied ·{' '}
                    <button
                      className="text-btn"
                      onClick={async () => {
                        const r = await api().remote(box!.paneId!);
                        if (r.url) api().openUrl(r.url);
                        setLinkFor(null);
                      }}
                    >
                      Open
                    </button>
                  </span>
                )}
              </div>
            )}
          </div>
          {box && (
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>
                Chat
              </button>
              <button className={view === 'terminal' ? 'on' : ''} onClick={() => setView('terminal')}>
                Terminal
              </button>
            </div>
          )}
          <button
            className={'drill-btn' + (panel ? ' on' : '')}
            aria-label="Drill-down"
            title="Drill-down: what needs you"
            aria-pressed={panel}
            onClick={() => setPanel(!panel)}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M15 4v16" />
            </svg>
            {asks > 0 && <span className="badge">{asks}</span>}
          </button>
        </div>

        {toast && (
          <div className="toast" key={toast.id} role="status">
            {toast.bad ? <span className="bang">!</span> : <Check color="#D1F2EE" size={14} />}
            {toast.text}
          </div>
        )}

        {body}

        {overlay === 'newbox' && (
          <NewBoxSheet taken={boxes.map((b) => b.name)} onCancel={() => setOverlay(null)} onStart={startBox} />
        )}
        {overlay === 'switch' && (
          <Palette
            boxes={boxes}
            actions={paletteActions}
            onClose={() => setOverlay(null)}
            onPick={(b) => {
              setSelected(b.name);
              setView('chat');
            }}
          />
        )}
        {(overlay === 'clear' || overlay === 'compact') && box && (
          <Confirm
            title={overlay === 'clear' ? `Clear ${box.name}?` : `Compact ${box.name}?`}
            body={
              overlay === 'clear'
                ? 'It starts a fresh conversation. The old one stays on disk and can be resumed from New Box.'
                : 'It shrinks the conversation to a summary, so the box has room again.'
            }
            yes={overlay === 'clear' ? 'Clear' : 'Compact'}
            ending={overlay === 'clear'}
            onYes={() => act(overlay)}
            onClose={() => setOverlay(null)}
          />
        )}
        {ask && (
          <Confirm title={ask.title} body="Your typed text in this box goes away, and this message is sent." quote={ask.typed} yes="Replace" ending onYes={() => ask.answer(true)} onClose={() => ask.answer(false)} />
        )}
        {overlay === 'rename' && box && (
          <RenameSheet box={box} taken={boxes.map((b) => b.name)} onRename={rename} onClose={() => setOverlay(null)} />
        )}
      </main>

      {panel && <DrillPanel drill={drill} sent={sent} onSend={sendDrill} />}
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, Box, BoxSpec, Drill, HubEvent, PhaseInfo, Snapshot } from './api';
import { AppMark, BoxIcon, Check, Spinner } from './icons';
import { Picker } from './Picker';
import { Action, Confirm, ContextPop, MoreMenu, Palette, RenameSheet } from './Actions';
import { ChatState, ChatView, Pending } from './Chat';
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
  const [ctx, setCtx] = useState<{ paneId: string; text: string | null } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [, setTick] = useState(0);
  const [linkFor, setLinkFor] = useState<string | null>(null);
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
          break;
        case 'drill':
          setDrill(ev.drill);
          break;
        case 'context':
          setCtx((c) => (c && c.paneId === ev.paneId ? { paneId: ev.paneId, text: ev.text } : c));
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
          const youFresh = ev.added.map((a) => a.item).filter((i) => i.k === 'you');
          const list = pending.current[ev.paneId] || [];
          if (youFresh.length && list.length) {
            const n = Math.min(list.length, youFresh.length);
            youFresh.slice(0, n).forEach((y) => quiet.current.add(y.id));
            pending.current[ev.paneId] = list.slice(n);
          }
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

  const restoring = info.phase === 'restoring' || info.phase === 'fresh';
  const box = useMemo(() => boxes.find((b) => b.name === selected) || boxes[0] || null, [boxes, selected]);
  const paneId = !restoring && box ? box.paneId : null;

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
      if (restoring) return;
      if (e.key === 'Escape' && !e.metaKey && !overlay && !picking && !more && !ctx && view === 'chat' && box?.paneId && box.status === 'working') {
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
  }, [boxes, box, overlay, view, restoring, picking, more, ctx]);

  async function sendToBox(text: string) {
    if (!box || !box.paneId) return false;
    const p = box.paneId;
    const r = await api().send(p, text);
    if (!r.ok) {
      show(r.reason || 'Not sent.', true);
      return false;
    }
    pending.current[p] = [...(pending.current[p] || []), { id: 'p' + Date.now(), t: text, queued: !!r.queued }];
    setTick((t) => t + 1);
    return true;
  }

  async function sendDrill(n: number, text: string) {
    const r = await api().sendChief(`${n}. ${text}`);
    if (!r.ok) {
      show(r.reason || 'Not sent.', true);
      return false;
    }
    setSent((s) => ({ ...s, [`${drill?.id}:${n}`]: text }));
    return true;
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

  async function openContext() {
    if (!box?.paneId) return;
    const p = box.paneId;
    setCtx({ paneId: p, text: null });
    const r = await api().action(p, 'context');
    if (!r.ok) {
      setCtx(null);
      show(r.reason || 'Not sent.', true);
    }
  }

  async function rename(name: string) {
    if (!box?.paneId) return;
    const r = await api().rename(box.paneId, name);
    if (!r.ok) show(r.reason || 'Not renamed.', true);
    else setSelected(name);
  }

  const boxActions: Action[] =
    box && box.paneId && box.status !== 'off' && box.status !== 'starting' && !restoring
      ? [
          { label: 'Context', run: openContext },
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
  const title = restoring ? 'chiefman' : box ? box.name : 'chiefman';
  const meter = !restoring && box ? meterLine(box) : '';
  const live = !restoring && box && box.paneId && box.status !== 'off' && box.status !== 'starting';

  let body;
  if (restoring) {
    const r = info.restore || { total: 1, done: 0 };
    body = (
      <div className="restore">
        <AppMark />
        <h2>{info.phase === 'fresh' ? 'Starting your chief' : 'Bringing your boxes back'}</h2>
        <p>
          No tmux session was running.
          <br />
          {info.phase === 'fresh'
            ? `No saved boxes, so a fresh chief starts in ${config?.workdir ?? 'your home folder'}.`
            : `Restoring ${r.total} ${r.total === 1 ? 'box' : 'boxes'} from ${config?.stateFile ?? '~/.chiefman/state.json'}.`}
        </p>
        <div className="progress">
          <div style={{ width: `${r.total ? Math.max(4, (r.done / r.total) * 100) : 4}%` }} />
        </div>
        <span className="count">
          {r.done} of {r.total}
        </span>
      </div>
    );
  } else if (!box || !box.paneId) {
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
        pending={pending.current[box.paneId] || []}
        quiet={quiet.current}
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
            const on = !restoring && box?.name === b.name;
            return (
              <button
                key={b.id}
                className={'row' + (on ? ' on' : '') + (b.status === 'off' ? ' off' : '')}
                onClick={() => setSelected(b.name)}
                title={i < 9 ? `${b.name}  ⌘${i + 1}` : b.name}
              >
                <BoxIcon icon={b.icon} color={b.status === 'off' ? '#B3B2AD' : b.color} />
                <span className="name">{b.name}</span>
                {b.cost != null && b.cost > 0 && <span className="row-cost">{money(b.cost)}</span>}
                {b.status === 'working' && <span className="dot-working" aria-label="working" />}
                {b.status === 'resuming' && <Spinner />}
                {b.status === 'resumed' && <Check color="#034F46" />}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1 }} />
        <button className="row" onClick={() => setOverlay('newbox')} disabled={restoring}>
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
                <span style={{ position: 'relative' }}>
                  <button className="pill meter" onClick={openContext} title="What fills the context">
                    {meter || 'context'}
                  </button>
                  {ctx && ctx.paneId === box!.paneId && <ContextPop text={ctx.text} onClose={() => setCtx(null)} />}
                </span>
                {box!.modelName && (
                  <span style={{ position: 'relative' }}>
                    <button className="pill" onClick={() => setPicking(!picking)} title="Model and effort">
                      {box!.modelName}
                      {box!.effort ? ` · ${box!.effort}` : ''}
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
          {!restoring && box && (
            <div className="seg" role="group" aria-label="View">
              <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>
                Chat
              </button>
              <button className={view === 'terminal' ? 'on' : ''} onClick={() => setView('terminal')}>
                Terminal
              </button>
            </div>
          )}
          {!restoring && (
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
          )}
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
            onYes={() => act(overlay)}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === 'rename' && box && (
          <RenameSheet box={box} taken={boxes.map((b) => b.name)} onRename={rename} onClose={() => setOverlay(null)} />
        )}
      </main>

      {panel && !restoring && <DrillPanel drill={drill} sent={sent} onSend={sendDrill} />}
    </div>
  );
}

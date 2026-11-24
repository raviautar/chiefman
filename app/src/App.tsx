import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Box, BoxSpec, Draft, Drill, EFFORTS, HubEvent, MODELS, PhaseInfo, PlanInfo, Recent, Result, Snapshot } from './api';
import { Avatar, Check } from './icons';
import { Picker } from './Picker';
import { Action, Confirm, costOf, meterOf, MoreMenu, Palette, RenameSheet } from './Actions';
import { ChatState, ChatView, Pending, norm } from './Chat';
import { quotesOf, quoteText } from './Quotes';
import { TerminalView } from './Terminal';
import { DrillPanel } from './Drill';
import { inferName, lookFor, resumeName, ResumeList } from './NewBox';
import { copyLink, RemoteButton } from './Remote';

type Toast = { text: string; bad?: boolean; id: number };

// New Box's message is kept with the drafts, under a key no box name can have.
const NEW_BOX = 'new.box';

// The new conversation has nothing in it yet.
const NO_CHAT: ChatState = { items: [], fresh: new Set(), steps: 0, loaded: true };

const Chevron = () => (
  <svg className="pill-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9l6 6 6-6" />
  </svg>
);

// Below this width the drill-down floats over the chat instead of taking room.
const NARROW = '(max-width: 1179px)';

// The skill buttons under the message box. Each sends the bare name, as he
// would type it. label is also the quiet tag the chat shows for a run
// (transcript.js).
const SKILLS = [
  { name: 'plain-english', label: 'Plain English' },
  { name: 'explain', label: 'Explain' },
  { name: 'drill-down', label: 'Drill down' },
];
type Skill = (typeof SKILLS)[number];

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

// New Box starts with the model and effort he started his last box with,
// else the app's own.
const LAST_PICK = 'chiefman.newbox.pick';
function lastPick(config: Snapshot['config'] | null) {
  let p: { model?: unknown; effort?: unknown } = {};
  try {
    p = JSON.parse(store.get(LAST_PICK) || '{}') || {};
  } catch {}
  const model = MODELS.some(([id]) => id === p.model) ? (p.model as string) : config?.model ?? 'claude-opus-5-5';
  const effort = EFFORTS.includes(p.effort as string) ? (p.effort as string) : config?.effort ?? 'xhigh';
  return { model, effort };
}

// A wide window remembers whether the panel was docked open. A narrow one
// always starts with it closed: there it opens only on his click.
function panelFor(narrow: boolean) {
  if (narrow) return false;
  const v = store.get('chiefman.panel.wide');
  return (v ?? store.get('chiefman.panel')) === '1';
}

// How long ago a box last said something: now, 4m, 2h, 3d.
function ago(at: number, now: number) {
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

// The quiet grey line under a box's name in the sidebar: what it does now,
// what it asks, or the last line it said.
function lineOf(b: Box) {
  if (b.status === 'starting') return 'Starting…';
  if (b.status === 'resuming') return 'Coming back…';
  if (b.status === 'failed') return "Didn't start";
  if (b.ended || b.status === 'ended') return 'Ended';
  if (b.menu) return b.menu.question.split('\n')[0] || 'Asks you';
  if (b.status === 'working' && b.activity) return b.activity;
  return b.said?.line || '';
}

const modelLabel = (id: string) => (MODELS.find((m) => m[0] === id) || ['', id])[1];

// Time left until a plan limit resets, as the tmux status bar says it:
// 47m, 2h 47m, 3d 15h.
function until(at: number, now: number) {
  const mins = Math.max(0, Math.floor((at - now) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

// Every box the app starts runs in bypass permissions, so the message box
// names the mode only when it is another one. With no mode line under its
// prompt, Claude asks before it edits.
const USUAL_MODE = /bypass/i;
const DEFAULT_MODE = 'ask before edits';

export function App() {
  const [info, setInfo] = useState<PhaseInfo>({ phase: 'starting', error: null, restore: null });
  const [config, setConfig] = useState<Snapshot['config'] | null>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [planInfo, setPlanInfo] = useState<PlanInfo>({ plan: null, workspace: null });
  const [selected, setSelected] = useState<string | null>(store.get('chiefman.selected'));
  const [view, setView] = useState<'chat' | 'terminal'>('chat');
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW).matches);
  const [panel, setPanel] = useState(() => panelFor(window.matchMedia(NARROW).matches));
  const [full, setFull] = useState<string | null>(null);
  const [draftsReady, setDraftsReady] = useState(false);
  const saved = useRef<Record<string, Draft>>({});
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [linger, setLinger] = useState(false);
  // Why a resumed box got "<name>-2", shown at the top of its chat.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [nothing, setNothing] = useState(false);
  const [chats, setChats] = useState<Record<string, ChatState>>({});
  const [overlay, setOverlay] = useState<'resume' | 'switch' | 'clear' | 'rename' | 'close' | null>(null);
  // New Box: an empty conversation until his first message starts the box.
  // name: the name that message gave it, while the box comes up.
  const [newConv, setNewConv] = useState<{ name?: string } | null>(null);
  const newRef = useRef(newConv);
  newRef.current = newConv;
  // The model and effort the new box starts with; a new key brings his words
  // back into a fresh field.
  const [newPick, setNewPick] = useState({ model: 'claude-opus-5-5', effort: 'xhigh' });
  const [newSeq, setNewSeq] = useState(0);
  const [picking, setPicking] = useState(false);
  // The menu under the box's name.
  const [more, setMore] = useState(false);
  const [ask, setAsk] = useState<{ title: string; typed: string; answer: (yes: boolean) => void } | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({});
  const [now, setNow] = useState(Date.now());
  const [, setTick] = useState(0);
  const [incoming, setIncoming] = useState<Record<string, { text: string; seq: number }>>({});
  // The Remote Control link just copied, shown under its icon for 4 s.
  const [linkCopied, setLinkCopied] = useState<{ pane: string; url: string } | null>(null);
  // First messages held while their box starts, by box name.
  const [held, setHeld] = useState<Record<string, string>>({});
  // The docked drill panel while it slides shut.
  const [closing, setClosing] = useState(false);
  const pending = useRef<Record<string, Pending[]>>({});
  const quiet = useRef(new Set<string>());
  const wantSelect = useRef<string | null>(null);
  const wantPane = useRef<string | null>(null);
  // His Drill down click in the chief: the list it had then, and when.
  const drillAsked = useRef<{ id: string | null; at: number } | null>(null);
  const viewing = useRef<string | null>(null);
  const boxesRef = useRef<Box[]>([]);
  boxesRef.current = boxes;

  const asks = drill ? drill.items.filter((i) => !sent[`${drill.id}:${i.n}`]).length : 0;
  // The panel takes room only while something needs him, and for 2 s after
  // his answer to the last item.
  const drillShown = panel && (asks > 0 || linger);
  // A docked panel slides shut instead of vanishing, so the chat glides wide.
  const wasShown = useRef(drillShown);
  useLayoutEffect(() => {
    if (wasShown.current && !drillShown && !narrow) setClosing(true);
    if (drillShown) setClosing(false);
    wasShown.current = drillShown;
  }, [drillShown]);

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
          setIncoming((d) => ({ ...d, [ev.paneId]: { text: ev.text, seq: Date.now() } }));
          break;
        case 'drill':
          setDrill(ev.drill);
          break;
        case 'plan':
          setPlanInfo({ plan: ev.plan, workspace: ev.workspace });
          break;
        case 'notice':
          show(ev.text, !!ev.bad);
          break;
        case 'select':
          wantPane.current = ev.paneId;
          setTick((t) => t + 1);
          break;
        case 'chat-reset':
          setChats((c) => ({ ...c, [ev.paneId]: { items: ev.items, fresh: new Set(), now: ev.now, loaded: true } }));
          break;
        case 'chat-add': {
          const fresh = new Set(ev.added.map((a) => a.item.id));
          // His message, back from the log, replaces its sent bubble quietly.
          const list = pending.current[ev.paneId] || [];
          for (const a of ev.added) {
            if (a.item.k === 'you' && list.some((p) => !p.skill && p.n === norm(a.item.t))) quiet.current.add(a.item.id);
            if (a.item.k === 'work' && list.some((p) => p.skill && p.n === a.item.t)) quiet.current.add(a.item.id);
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
            return { ...c, [ev.paneId]: { items, fresh, now: ev.now, loaded: true } };
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
        setPlanInfo({ plan: s.plan, workspace: s.workspace });
      });
    api()
      .drafts()
      .then((d) => {
        saved.current = d || {};
        setDraftsReady(true);
      });
    const clock = setInterval(() => setNow(Date.now()), 20000);
    const mq = window.matchMedia(NARROW);
    // An open panel stays open as the window narrows or widens.
    const onWidth = () => {
      setNarrow(mq.matches);
      setPanel((p) => p || panelFor(mq.matches));
    };
    mq.addEventListener('change', onWidth);
    return () => {
      off();
      clearInterval(clock);
      mq.removeEventListener('change', onWidth);
    };
  }, []);

  // Drafts reach the disk 300 ms after the last change.
  function keepDrafts() {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => api().saveDrafts(saved.current), 300);
  }

  function setDraftFor(name: string, d: Draft | null) {
    const cur = saved.current[name];
    if (!d && !cur) return;
    if (d && cur && JSON.stringify(d) === JSON.stringify(cur)) return;
    const next = { ...saved.current };
    if (d) next[name] = d;
    else delete next[name];
    saved.current = next;
    keepDrafts();
  }

  // A box removed from the list leaves its draft under its session
  // ("session.<id>"), for New Box. Six are kept, the newest.
  function keepForSession(id: string, d: Draft) {
    const next = { ...saved.current };
    delete next[`session.${id}`];
    next[`session.${id}`] = d;
    const old = Object.keys(next).filter((k) => k.startsWith('session.'));
    for (const k of old.slice(0, Math.max(0, old.length - 6))) delete next[k];
    saved.current = next;
    keepDrafts();
  }

  async function removeEnded(name: string) {
    const d = saved.current[name];
    const r = await api().closeEnded(name);
    if (r.ok && r.session && d) keepForSession(r.session, d);
    return r;
  }

  // A resumed session's box gets that draft once the box shows.
  const adopt = useRef<{ name: string; key: string } | null>(null);
  useEffect(() => {
    const a = adopt.current;
    if (!a || !boxes.some((b) => b.name === a.name)) return;
    adopt.current = null;
    const d = saved.current[a.key];
    if (!d) return;
    if (!saved.current[a.name]) setDraftFor(a.name, d);
    setDraftFor(a.key, null);
  }, [boxes]);

  // A box that is gone takes its draft with it.
  useEffect(() => {
    if (!draftsReady || info.phase !== 'ready' || !boxes.length) return;
    const names = new Set(boxes.map((b) => b.name));
    const gone = Object.keys(saved.current).filter((n) => !n.includes('.') && !names.has(n));
    if (!gone.length) return;
    const next = { ...saved.current };
    for (const n of gone) delete next[n];
    saved.current = next;
    keepDrafts();
  }, [boxes, info.phase, draftsReady]);

  // "Nothing needs you." closes on a click anywhere else, or after 6 s.
  useEffect(() => {
    if (!nothing) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t || !t.closest('.skills')) setNothing(false);
    };
    document.addEventListener('mousedown', away, true);
    const t = setTimeout(() => setNothing(false), 6000);
    return () => {
      document.removeEventListener('mousedown', away, true);
      clearTimeout(t);
    };
  }, [nothing]);

  useEffect(() => {
    if (!linkCopied) return;
    const t = setTimeout(() => setLinkCopied(null), 4000);
    return () => clearTimeout(t);
  }, [linkCopied]);

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
      setNewConv(null);
      wantPane.current = null;
    }
  });

  // A box he just started is shown once it is in the list, unless he is
  // writing the first message of another new box by then.
  useEffect(() => {
    const w = wantSelect.current;
    if (!w || !boxes.some((b) => b.name === w)) return;
    wantSelect.current = null;
    const n = newRef.current;
    if (n && n.name !== w) return;
    setSelected(w);
    setView('chat');
    setNewConv(null);
  }, [boxes]);

  // Ended boxes leave the list: Cmd+K finds them by name. The chief always
  // stays a row, and so does an ended box while he reads it.
  const hasText = (name: string) => {
    const d = saved.current[name];
    return !!d && (!!d.text.trim() || d.atts.length > 0 || quotesOf(d.bundle).length > 0);
  };
  const tucked = (b: Box) => !!b.ended && b.name !== 'chief';
  const listed = boxes.filter((b) => !tucked(b));
  const endedLine = boxes.filter(tucked);

  const box = useMemo(() => boxes.find((b) => b.name === selected) || listed[0] || null, [boxes, selected]);
  const paneId = box ? box.paneId : null;
  viewing.current = box ? box.name : null;

  // Resume, or Resume and send: what he typed in an ended box goes along,
  // the way New Box's first message does, or stays in its field.
  // The text leaves the field for a dim "Waiting to send" bubble until it is
  // sent; if it is not, it goes back to the field.
  async function resumeBox(name: string): Promise<Result> {
    const d = saved.current[name];
    const words = d ? [quoteText(d.bundle), d.text.trim()].filter(Boolean).join('\n\n') : '';
    const text = d ? [words, ...d.atts.map((a) => a.path)].filter(Boolean).join(' ') : '';
    if (text) {
      setDraftFor(name, null);
      setHeld((w) => ({ ...w, [name]: text }));
    }
    const r = await api().startAgain(name, text || undefined);
    setHeld((w) => {
      const next = { ...w };
      delete next[name];
      return next;
    });
    if (r.ok && r.unsent) giveBack(name, r.paneId, r.unsent);
    if (r.ok && r.unsent && r.reason) show(r.reason, true);
    return r;
  }

  async function clearEnded(names: string[]) {
    for (const n of names) await removeEnded(n);
  }

  // A box he picks: the new conversation, if one was open, is left behind
  // (its words stay for the next New Box).
  function goTo(name: string, keepView = false) {
    wantSelect.current = null;
    setNewConv(null);
    setMore(false);
    setPicking(false);
    setSelected(name);
    if (!keepView) setView('chat');
  }

  // New Box (and Cmd+N): an empty conversation with the cursor in its field.
  function openNew() {
    setOverlay(null);
    setPicking(false);
    setMore(false);
    if (!newConv || newConv.name) {
      setNewPick(lastPick(config));
      setNewConv({});
    }
    setView('chat');
    setTimeout(() => document.getElementById('composer')?.focus(), 0);
  }

  // His first message starts the box, named after what it asks.
  async function startNew(text: string) {
    if (!newConv || newConv.name) return false;
    const name = inferName(text, boxes.map((b) => b.name));
    const lk = lookFor(name);
    setNewConv({ name });
    startBox({ name, icon: lk.icon, color: lk.color, message: text, model: newPick.model, effort: newPick.effort });
    return true;
  }

  // Cmd+K, Resume an earlier session.
  function resumeSession(r: Recent) {
    const { name, note } = resumeName(r, boxes);
    const lk = lookFor(name);
    setNewConv(null);
    startBox({ name, icon: lk.icon, color: lk.color, message: '', ...lastPick(config), resume: r.id }, note);
  }

  const toggleView = () => setView((v) => (v === 'chat' ? 'terminal' : 'chat'));

  // Cmd+K's "Edit an earlier message" and "Search what you sent" open the
  // message box's own lists.
  const popIn = (kind: 'edit' | 'search') => {
    setView('chat');
    setTimeout(() => window.dispatchEvent(new CustomEvent('chiefman:pop', { detail: kind })), 60);
  };

  useEffect(() => {
    if (box) store.set('chiefman.selected', box.name);
  }, [box?.name]);

  // Cmd+K or a sheet put away gives the cursor back to the message field.
  const hadOverlay = useRef(false);
  useEffect(() => {
    const was = hadOverlay.current;
    hadOverlay.current = !!overlay;
    if (!was || overlay) return;
    const t = setTimeout(() => {
      const a = document.activeElement;
      if (!a || a === document.body) document.getElementById('composer')?.focus();
    }, 0);
    return () => clearTimeout(t);
  }, [overlay]);

  // Only his click or key opens or closes the panel, and only that is saved.
  function showPanel(open: boolean) {
    setPanel(open);
    if (!narrow) store.set('chiefman.panel.wide', open ? '1' : '0');
  }

  // A box whose window closed is still read from its old pane's log.
  const watchId = box ? box.paneId ?? box.lastPane ?? null : null;
  useEffect(() => {
    if (watchId) api().watch(watchId);
  }, [watchId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && full) {
        e.preventDefault();
        setFull(null);
        return;
      }
      if (e.key === 'Escape' && nothing) {
        e.preventDefault();
        e.stopPropagation();
        setNothing(false);
        return;
      }
      // Esc leaves a new conversation he has not sent yet: no box is left
      // behind, and his words wait for the next New Box.
      if (e.key === 'Escape' && newConv && !newConv.name && !overlay && !ask && !picking && !more) {
        if (document.activeElement?.getAttribute('aria-expanded') === 'true') return;
        e.preventDefault();
        e.stopPropagation();
        setNewConv(null);
        return;
      }
      // Below 1180 px the panel floats over the chat and stays while he
      // types; Esc on it, or with nothing in focus, puts it away. Esc in its
      // reply field closes only the field.
      const fa = document.activeElement;
      const onPanel = !fa || fa === document.body || (!!fa.closest('.drill') && fa.tagName !== 'INPUT');
      if (e.key === 'Escape' && narrow && drillShown && !overlay && !ask && onPanel) {
        e.preventDefault();
        e.stopPropagation();
        showPanel(false);
        return;
      }
      // Esc on a menu leaves it, as in the terminal, where Claude allows that.
      // A menu without that (the trust question) gets no Esc at all.
      if (e.key === 'Escape' && !e.metaKey && !overlay && !ask && !picking && !more && !newConv && view === 'chat' && box?.paneId && box.menu) {
        const el = document.activeElement;
        if (el && (el.closest('.drill, .asks, .quote-bubble, .quote-tray') || el.getAttribute('aria-expanded') === 'true')) return;
        e.preventDefault();
        if (box.menu.esc) api().dismiss(box.paneId).then((r) => !r.ok && r.reason && show(r.reason, true));
        return;
      }
      if (e.key === 'Escape' && !e.metaKey && !overlay && !ask && !picking && !more && !newConv && view === 'chat' && box?.paneId && box.status === 'working') {
        const el = document.activeElement;
        if (el && (el.closest('.drill, .asks, .quote-bubble, .quote-tray') || el.getAttribute('aria-expanded') === 'true')) return;
        e.preventDefault();
        api()
          .interrupt(box.paneId)
          .then((r) => r.ok && show(`Interrupted ${box.name}`));
        return;
      }
      if (!e.metaKey || e.altKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const at = listed.findIndex((b) => b.name === box?.name);
      let next: Box | undefined;
      if (/^[1-9]$/.test(k)) next = listed[Number(k) - 1];
      else if (k === '[' || e.code === 'BracketLeft') next = listed[(at - 1 + listed.length) % listed.length];
      else if (k === ']' || e.code === 'BracketRight') next = listed[(at + 1) % listed.length];
      else if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        openNew();
        return;
      } else if (k === 'k' && !e.shiftKey) {
        e.preventDefault();
        setOverlay((o) => (o === 'switch' ? null : 'switch'));
        return;
      } else if (k === 't' && !e.shiftKey) {
        e.preventDefault();
        if (!newConv) toggleView();
        return;
      } else return;
      e.preventDefault();
      e.stopPropagation();
      if (next) goTo(next.name, true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [boxes, box, overlay, view, picking, more, ask, full, narrow, drillShown, nothing, newConv, config]);

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
      setAsk({ title: `Something else is typed in ${name}'s terminal. Replace it?`, typed, answer });
    });
  }

  // skill: the quiet line a skill button's run shows until the log has it.
  // answer: his answers from the widgets, shown as one folded line.
  async function sendToBox(text: string, opts: { skill?: string; answer?: boolean } = {}) {
    if (!box || !box.paneId) return false;
    const p = box.paneId;
    const name = box.name;
    const skill = opts.skill;
    // A busy box, or one still on its way up, takes it next: "queued".
    const later = box.status === 'working' || box.status === 'starting' || box.status === 'resuming';
    // A command gets no bubble: the log shows it, or it is one the app hides.
    // A message gets its bubble before delivery ends, and keeps it until the
    // log holds one more copy of the same text than it did now.
    // The bubble shows the text as the log will: secrets masked.
    const id = 'p' + Date.now();
    if (skill) {
      const list = pending.current[p] || [];
      const base = workCount(p, skill) + list.filter((x) => x.skill && x.n === skill).length;
      pending.current[p] = [...list, { id, t: skill, n: skill, base, queued: later, skill: true }];
      setTick((t) => t + 1);
    } else if (!text.startsWith('/')) {
      const shown = await api().mask(text);
      const n = norm(shown);
      const list = pending.current[p] || [];
      const base = youCount(p, n) + list.filter((x) => !x.skill && x.n === n).length;
      pending.current[p] = [...list, { id, t: shown, n, base, queued: later, ...(opts.answer ? { answer: true } : {}) }];
      setTick((t) => t + 1);
    }
    const drop = () => {
      pending.current[p] = (pending.current[p] || []).filter((x) => x.id !== id);
      setTick((t) => t + 1);
    };
    let r = await api().send(p, text);
    if (!r.ok && r.ask === 'replace') {
      // His message shows as sent only once he picks Replace.
      const held = (pending.current[p] || []).find((x) => x.id === id);
      drop();
      if (!(await askReplace(name, r.typed || ''))) return false;
      if (held) {
        pending.current[p] = [...(pending.current[p] || []), held];
        setTick((t) => t + 1);
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
    // A box that came back in a new window got it there: its bubble moves too.
    const to = r.paneId && r.paneId !== p ? r.paneId : p;
    const mine = (pending.current[p] || []).find((x) => x.id === id);
    if (to === p) pending.current[p] = (pending.current[p] || []).map((x) => (x.id === id ? { ...x, queued: !!r.queued } : x));
    else {
      pending.current[p] = (pending.current[p] || []).filter((x) => x.id !== id);
      if (mine) pending.current[to] = [...(pending.current[to] || []), { ...mine, queued: !!r.queued }];
    }
    setTick((t) => t + 1);
    return true;
  }

  // Answers to the chief's list, one or several, in one message by number.
  async function sendDrill(list: { n: number; text: string }[]) {
    if (!list.length) return false;
    const chief = boxes.find((b) => b.name === 'chief');
    const msg = list.map((a) => `${a.n}. ${a.text}`).join('\n');
    let r = await api().sendChief(msg);
    if (!r.ok && r.ask === 'replace') {
      if (!(await askReplace(chief ? chief.name : 'chief', r.typed || ''))) return false;
      r = await api().sendChief(msg, true);
    }
    if (!r.ok) {
      show(r.reason || 'Not sent.', true);
      return false;
    }
    setSent((s) => ({ ...s, ...Object.fromEntries(list.map((a) => [`${drill?.id}:${a.n}`, a.text])) }));
    // The last answer keeps the panel up, in the same render, for 2 s.
    const done = new Set(list.map((a) => a.n));
    if (drill && !drill.items.some((i) => !done.has(i.n) && !sent[`${drill.id}:${i.n}`])) setLinger(true);
    return true;
  }

  // A skill button runs its skill in the open box, as if he typed it there.
  // Drill down in the chief also opens the panel once the new list comes.
  async function runSkill(s: Skill) {
    if (!box?.paneId) return;
    const chiefList = s.name === 'drill-down' && box.name === 'chief';
    if (chiefList) {
      setNothing(false);
      drillAsked.current = { id: drill ? drill.id : null, at: Date.now() };
    }
    const ok = await sendToBox('/' + s.name, { skill: s.label });
    if (!ok && chiefList) drillAsked.current = null;
  }

  function youCount(paneId: string, n: string) {
    const items = chats[paneId]?.items || [];
    return items.filter((i) => i.k === 'you' && norm(i.t) === n).length;
  }

  function workCount(paneId: string, t: string) {
    const items = chats[paneId]?.items || [];
    return items.filter((i) => i.k === 'work' && i.t === t).length;
  }

  // Sent bubbles whose message the log now holds are gone.
  function pendingFor(paneId: string) {
    const list = pending.current[paneId] || [];
    const keep = list.filter((x) => (x.skill ? workCount(paneId, x.n) : youCount(paneId, x.n)) <= x.base);
    if (keep.length !== list.length) pending.current[paneId] = keep;
    return keep;
  }

  // A message that did not go in waits in the box's field, after anything
  // he typed there, and is saved like any draft.
  function giveBack(name: string, paneId: string | undefined, text: string) {
    const cur = saved.current[name];
    const full = cur?.text ? `${cur.text}\n${text}` : text;
    setDraftFor(name, { text: full, caret: full.length, atts: cur?.atts ?? [], ...(cur?.bundle ? { bundle: cur.bundle } : {}) });
    const p = paneId ?? boxesRef.current.find((b) => b.name === name)?.paneId;
    if (p) setIncoming((d) => ({ ...d, [p]: { text: full, seq: Date.now() } }));
  }

  function startBox(spec: BoxSpec, note?: string) {
    setOverlay(null);
    store.set(LAST_PICK, JSON.stringify({ model: spec.model, effort: spec.effort }));
    if (note) setNotes((n) => ({ ...n, [spec.name]: note }));
    wantSelect.current = spec.name;
    // A conversation that already has a row comes back in that row.
    const row = spec.resume ? boxes.find((b) => b.session === spec.resume) : undefined;
    if (row) {
      wantSelect.current = null;
      setSelected(row.name);
      setView('chat');
    } else if (spec.resume) adopt.current = { name: spec.name, key: `session.${spec.resume}` };
    // His message shows dim under a start-up question until the box is up.
    const target = row ? row.name : spec.name;
    if (spec.message) setHeld((w) => ({ ...w, [target]: spec.message }));
    api()
      .newBox(spec)
      .finally(() =>
        setHeld((w) => {
          const next = { ...w };
          delete next[target];
          return next;
        }),
      )
      .then((r) => {
        if (r.name && r.name !== spec.name && !r.existing) {
          if (adopt.current?.name === spec.name) adopt.current = { ...adopt.current, name: r.name };
          wantSelect.current = r.name;
          if (boxesRef.current.some((b) => b.name === r.name)) setSelected(r.name);
        }
        if (r.existing && r.name) setSelected(r.name);
        if (r.renamed && r.name) setNotes((n) => ({ ...n, [r.name!]: `${r.renamed} is a different conversation, so this one is ${r.name}.` }));
        // His first message: sent, or put in the box's field.
        if (r.unsent) giveBack(r.name || spec.name, r.paneId, r.unsent);
        // Refused before any window opened: his words go back to New Box.
        if (!r.ok && !r.unsent && !r.paneId && !r.existing && !spec.resume && spec.message) {
          setDraftFor(NEW_BOX, { text: spec.message, caret: spec.message.length, atts: [] });
          if (wantSelect.current === spec.name) wantSelect.current = null;
          setNewSeq((s) => s + 1);
          setNewConv((n) => (n && n.name === spec.name ? {} : n));
        }
        // A box that ended as it started says why above its own ended line.
        if (!r.ok && !r.ended) show(r.reason || "Couldn't start the box.", true);
        else if (r.unsent && r.reason) show(r.reason, true);
      });
  }

  async function switchBox(kind: 'model' | 'effort', value: string) {
    if (!box?.paneId) return;
    setPicking(false);
    const r = await api().switchBox(box.paneId, kind, value);
    if (!r.ok) show(r.reason || 'Not switched.', true);
  }

  // Shift+Tab in the box: the mode under its prompt moves to the next one.
  async function cycleMode() {
    if (!box?.paneId) return;
    const r = await api().cycleMode(box.paneId);
    if (!r.ok) show(r.reason || 'Not changed.', true);
  }

  async function act(kind: 'compact' | 'clear') {
    if (!box?.paneId) return;
    const r = await api().action(box.paneId, kind);
    if (!r.ok) show(r.reason || 'Not sent.', true);
  }

  // Remote Control on or off, from the name's menu or Cmd+K. A click still on
  // its way counts as done.
  const remoteOn = (b: Box) => {
    const going = b.remoteAsk && (b.remoteAsk === 'on') !== b.remote ? b.remoteAsk : null;
    return going ? going === 'on' : b.remote;
  };
  async function toggleRemote(b: Box) {
    if (!b.paneId) return;
    const r = await api().remote(b.paneId, remoteOn(b) ? 'off' : 'on');
    if (!r.ok) show(r.reason || 'Not sent.', true);
  }

  async function interrupt(b: Box) {
    if (!b.paneId) return;
    const r = await api().interrupt(b.paneId);
    if (r.ok) show(`Interrupted ${b.name}`);
  }

  async function rename(name: string) {
    if (!box?.paneId) return;
    const old = box.name;
    const r = await api().rename(box.paneId, name);
    if (!r.ok) return show(r.reason || 'Not renamed.', true);
    setSelected(name);
    const d = saved.current[old];
    if (d) {
      setDraftFor(old, null);
      setDraftFor(name, d);
    }
  }

  // Close box: its Claude stops and its window closes. As with Remove on an
  // ended box, the conversation stays for New Box, with his typed text.
  async function closeLive(b: Box) {
    if (!b.paneId) return;
    const d = saved.current[b.name];
    const r = await api().closeBox(b.paneId);
    if (!r.ok) return show(r.reason || "Couldn't close it.", true);
    if (r.session && d) keepForSession(r.session, d);
  }

  const live = !!box && !!box.paneId && box.status !== 'off' && box.status !== 'starting' && box.status !== 'resuming' && box.status !== 'failed';
  // Compact keeps the conversation, so it runs at once; Clear and Close ask.
  const boxActions: Action[] =
    box && live
      ? [
          { label: 'Rename', run: () => setOverlay('rename') },
          { label: 'Compact', run: () => void act('compact') },
          { label: 'Clear', run: () => setOverlay('clear') },
          ...(box.name !== 'chief' ? [{ label: 'Close box', run: () => setOverlay('close') }] : []),
          { label: remoteOn(box) ? 'Turn Remote Control off' : 'Turn Remote Control on', run: () => void toggleRemote(box) },
          ...(box.remote ? [{ label: 'Copy Remote Control link', run: () => void remoteLink(box) }] : []),
        ]
      : [];
  // An ended box: Resume (and send what he typed), or Remove.
  const endedActions: Action[] = box?.ended
    ? [
        ...(box.ended.start
          ? [{ label: hasText(box.name) ? 'Resume and send' : 'Resume', run: () => void resumeBox(box.name).then((r) => !r.ok && show(r.reason || "Couldn't resume it.", true)) }]
          : []),
        { label: 'Remove', run: () => void removeEnded(box.name).then((r) => !r.ok && show(r.reason || "Couldn't remove it.", true)) },
      ]
    : [];
  const remoteLink = (b: Box) =>
    copyLink(b, (t) => show(t, true)).then((url) => url && b.paneId && setLinkCopied({ pane: b.paneId, url }));
  // The menu a click on the box's name opens.
  const nameMenu: Action[] = [...boxActions, ...endedActions];

  // His answer to the last card: "Nothing needs you." shows for 2 s, then the
  // panel folds away. A wide window shows it again when a new item comes, if
  // he had it open; a narrow one opens it only on his click.
  useEffect(() => {
    if (asks > 0) {
      setLinger(false);
      setNothing(false);
      return;
    }
    if (linger) {
      const t = setTimeout(() => {
        setLinger(false);
        if (narrow) setPanel(false);
      }, 2000);
      return () => clearTimeout(t);
    }
    if (narrow) setPanel(false);
  }, [asks]);

  // The list his Drill down click asked the chief for: the panel opens with
  // it. With nothing for him, he is told so, if he is still on the chief.
  useEffect(() => {
    const w = drillAsked.current;
    if (!w || !drill || drill.id === w.id) return;
    drillAsked.current = null;
    if (Date.now() - w.at > 20 * 60000) return;
    if (drill.items.length) showPanel(true);
    else if (viewing.current === 'chief') setNothing(true);
  }, [drill?.id]);
  const meter = box && live ? meterOf(box) : '';
  // A skill the open box cannot run has no button.
  const skills: Skill[] = live ? SKILLS.filter((s) => box!.skills?.includes(s.name)) : [];
  const waiting = info.restore ? boxes.find((b) => b.menu) : undefined;
  const at = listed.findIndex((b) => b.name === box?.name);
  const step = (d: number) => listed.length && goTo(listed[(at + d + listed.length) % listed.length].name, true);

  // Cmd+K: every action the app has, with its shortcut. Box actions only
  // while a box (not a new conversation) is open.
  const onBox = !!box && !newConv;
  const paletteActions: Action[] = [
    { label: 'New box', hint: '⌘N', run: openNew },
    { label: 'Resume an earlier session', run: () => setOverlay('resume') },
    ...(onBox ? nameMenu : []),
    ...(onBox && live && box!.modelName
      ? [
          {
            label: 'Model and effort',
            run: () => {
              setView('chat');
              setPicking(true);
            },
          },
        ]
      : []),
    ...(onBox && live && box!.mode ? [{ label: 'Next mode', hint: '⇧⇥', run: () => void cycleMode() }] : []),
    ...(onBox && live && box!.status === 'working' ? [{ label: 'Interrupt', hint: 'Esc', run: () => void interrupt(box!) }] : []),
    ...(onBox ? skills.map((s) => ({ label: s.label, run: () => void runSkill(s) })) : []),
    ...(onBox && box!.name === 'chief' && asks > 0 && !drillShown ? [{ label: 'Show the drill-down', run: () => showPanel(true) }] : []),
    ...(drillShown ? [{ label: 'Hide the drill-down', run: () => showPanel(false) }] : []),
    ...(onBox && live ? [{ label: 'Edit an earlier message', hint: 'Esc Esc', run: () => popIn('edit') }] : []),
    ...(onBox && live ? [{ label: 'Search what you sent', hint: '⌃R', run: () => popIn('search') }] : []),
    ...(onBox && box!.paneId ? [{ label: view === 'chat' ? 'Terminal' : 'Chat', hint: '⌘T', run: toggleView }] : []),
    ...(listed.length > 1 ? [{ label: 'Next box', hint: '⌘]', run: () => step(1) }, { label: 'Previous box', hint: '⌘[', run: () => step(-1) }] : []),
    ...(endedLine.length
      ? [{ label: endedLine.length === 1 ? 'Remove the ended box' : `Remove the ${endedLine.length} ended boxes`, run: () => void clearEnded(endedLine.map((b) => b.name)) }]
      : []),
  ];
  const hints = Object.fromEntries(listed.slice(0, 9).map((b, i) => [b.name, `⌘${i + 1}`]));

  // The skill buttons, grey chips inside the message box: things he asks the
  // box, so they sit where he types.
  const skillRow =
    skills.length > 0 ? (
      <span className="skills" role="group" aria-label="Skills">
        {skills.map((s) => {
          // The chief's own list fills the panel; its count shows here.
          const chiefList = s.name === 'drill-down' && box!.name === 'chief';
          return (
            <Fragment key={s.name}>
              <button
                className={'skill-btn' + (chiefList && (drillShown || nothing) ? ' on' : '')}
                title={`Runs ${s.name} in ${box!.name}`}
                onClick={() => runSkill(s)}
              >
                {s.label}
              </button>
              {/* The list he has not answered yet: its count opens it again. */}
              {chiefList && asks > 0 && !drillShown && (
                <button className="skill-btn count" title={`Show the ${asks} that need${asks === 1 ? 's' : ''} you`} onClick={() => showPanel(true)}>
                  <span className="badge">{asks}</span>
                </button>
              )}
            </Fragment>
          );
        })}
        {nothing && (
          <div className="nothing-pop rise" role="status">
            Nothing needs you.
          </div>
        )}
      </span>
    ) : null;

  let body;
  // A box whose window closed has no pane, but keeps its chat and draft. Its
  // chat keeps the old pane's key, so the field keeps his text and focus.
  const shownPane = box ? box.paneId ?? box.lastPane ?? null : null;
  // The chief's lists fold to one line each: the newest while some of it
  // needs him (a click opens the panel) or once all of it is answered. Only
  // the newest list shows at all; an older one is hidden (an empty fold). A
  // list that never had items stays plain text.
  const folds: Record<string, string> = {};
  if (box && box.name === 'chief' && drill) {
    for (const [id, kind] of Object.entries(drill.folds || {})) folds[id] = kind === 'answered' ? 'Drill-down · all answered' : 'Earlier drill-down';
    if (asks > 0) folds[drill.id] = `Drill-down · ${asks} need${asks === 1 ? 's' : ''} you`;
    else if (asks === 0 && (drill.total ?? 0) > 0) folds[drill.id] = 'Drill-down · all answered';
    const lists = ((shownPane && chats[shownPane]?.items) || []).filter((i) => i.id in folds || i.id === drill.id);
    for (const i of lists.slice(0, -1)) if (i.id in folds) folds[i.id] = '';
  }
  // Inside the message box, right of the skills: the mode when it is not the
  // usual one, then the model and effort, whose picker also says what the
  // box cost and how full its context is.
  const boxTools =
    box && live && box.modelName ? (
      <>
        {box.mode && !USUAL_MODE.test(box.mode) && (
          <button className={'tool-pill mode' + (/plan/i.test(box.mode) ? ' plan' : '')} onClick={cycleMode} title="Next mode  ⇧⇥">
            {box.mode}
          </button>
        )}
        <span className="model-wrap">
          <button className={'tool-pill' + (picking ? ' open' : '')} onClick={() => setPicking(!picking)} aria-label="Model and effort" disabled={!!box.switching}>
            {box.switching && !box.switching.asking ? (
              'Switching…'
            ) : (
              <>
                {box.modelName}
                {box.effort ? ` · ${box.effort}` : ''}
                <Chevron />
              </>
            )}
          </button>
          {picking && <Picker meter={meter} model={box.model} effort={box.effort} mode={box.mode ?? DEFAULT_MODE} onMode={cycleMode} onPick={switchBox} onClose={() => setPicking(false)} />}
        </span>
      </>
    ) : null;
  // A new box starts on the model and effort he picked last; the picker
  // changes them before his first message.
  const newTools = (
    <span className="model-wrap">
      <button className={'tool-pill' + (picking ? ' open' : '')} onClick={() => setPicking(!picking)} aria-label="Model and effort">
        {modelLabel(newPick.model)} · {newPick.effort}
        <Chevron />
      </button>
      {picking && <Picker model={newPick.model} effort={newPick.effort} onPick={(k, v) => setNewPick((p) => ({ ...p, [k]: v }))} onClose={() => setPicking(false)} />}
    </span>
  );

  if (newConv && draftsReady) {
    const named = newConv.name;
    const pseudo: Box = {
      id: 'new',
      name: named || '',
      paneId: null,
      icon: 'doc',
      color: '',
      status: named ? 'starting' : 'idle',
      tab: null,
      since: null,
      activity: null,
      menu: null,
      cost: null,
      context: null,
      model: newPick.model,
      modelName: null,
      effort: newPick.effort,
      remote: false,
      skills: [],
      mode: null,
      switching: null,
      tokens: null,
    };
    body = (
      <ChatView
        key={'new:' + newSeq}
        box={pseudo}
        chat={NO_CHAT}
        pending={[]}
        quiet={quiet.current}
        folds={{}}
        incoming={undefined}
        initial={saved.current[NEW_BOX]}
        attachDir={config?.attachDir ?? ''}
        onTaken={() => {}}
        onDraft={(d) => setDraftFor(named || NEW_BOX, d)}
        onRemove={async () => ({ ok: false })}
        onResume={async () => ({ ok: false })}
        waiting={named ? held[named] : undefined}
        onOpen={setFull}
        onSend={startNew}
        onLost={() => {}}
        onError={(t) => show(t, true)}
        tools={named ? null : newTools}
      />
    );
  } else if (!box || (!box.paneId && box.status !== 'ended')) {
    body = (
      <div className="chat">
        <div className="empty">
          {info.phase === 'error' ? (
            <>
              <h2>tmux is out of reach</h2>
              {info.error}
            </>
          ) : (
            'Connecting…'
          )}
        </div>
      </div>
    );
  } else if (view === 'terminal' && box.paneId) {
    body = <TerminalView key={box.paneId} paneId={box.paneId} />;
  } else if (!draftsReady) {
    body = <div className="chat" />;
  } else {
    body = (
      <ChatView
        key={shownPane ?? `ended:${box.name}`}
        box={box}
        chat={shownPane ? chats[shownPane] : undefined}
        pending={shownPane ? pendingFor(shownPane) : []}
        quiet={quiet.current}
        folds={folds}
        incoming={box.paneId ? incoming[box.paneId] : undefined}
        initial={saved.current[box.name] ?? (adopt.current?.name === box.name ? saved.current[adopt.current.key] : undefined)}
        attachDir={config?.attachDir ?? ''}
        onTaken={() => {
          const p = box.paneId!;
          setIncoming((d) => {
            const next = { ...d };
            delete next[p];
            return next;
          });
        }}
        onDraft={(d) => setDraftFor(box.name, d)}
        onRemove={() => removeEnded(box.name)}
        onResume={() => resumeBox(box.name)}
        note={notes[box.name]}
        waiting={held[box.name]}
        onOpen={setFull}
        onSend={sendToBox}
        onLost={(t) => giveBack(box.name, undefined, t)}
        onError={(t) => show(t, true)}
        foot={skillRow}
        tools={boxTools}
        onFold={(id) => {
          if (!drill || id !== drill.id || asks === 0 || drillShown) return false;
          showPanel(true);
          return true;
        }}
        foldTip={(id) => (drill && id === drill.id && asks > 0 && !drillShown ? 'Show it to answer' : undefined)}
      />
    );
  }

  return (
    <div className="app">
      <nav className="nav" aria-label="Sidebar">
        {/* The window's lights sit here; New Box sits at the other end. */}
        <div className="nav-top">
          <button className={'new-btn tip' + (newConv ? ' on' : '')} onClick={openNew} aria-label="New box" data-tip="New box  ⌘N">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        <div className="nav-list">
          {(box && tucked(box) && !newConv ? [...listed, box] : listed).map((b, i) => {
            const on = !newConv && box?.name === b.name;
            const line = lineOf(b);
            const when = b.status !== 'working' && b.said?.at ? ago(b.said.at, now) : '';
            const cost = costOf(b);
            const off = b.status === 'off' || b.status === 'failed' || b.status === 'ended' || !!b.ended;
            return (
              <button
                key={b.id}
                className={'row' + (on ? ' on' : '') + (off ? ' off' : '')}
                onClick={() => goTo(b.name)}
                title={i < 9 && !tucked(b) ? `${b.name}  ⌘${i + 1}` : b.name}
              >
                <Avatar box={b} />
                <span className="txt">
                  <span className="top">
                    <span className="name">{b.name}</span>
                    {/* On hover the time gives way to what the box cost. */}
                    {cost && <span className="row-cost">{cost}</span>}
                    {when && <time className="when">{when}</time>}
                  </span>
                  {line && <span className={'pv' + (b.menu || b.tab === 'asks' ? ' need' : '')}>{line}</span>}
                </span>
              </button>
            );
          })}
        </div>
        {info.restore && (
          <div className="nav-quiet" role="status">
            {waiting ? `${waiting.name} needs you` : info.restore.label} · {info.restore.done} of {info.restore.total} back
          </div>
        )}
        <div style={{ flex: 1 }} />
        {planInfo.plan && (
          <div className="usage" role="group" aria-label="Plan usage">
            {planInfo.plan.map((l) => (
              <div key={l.label} className={'u' + (l.pct >= 80 ? ' high' : '')}>
                <div className="u-top">
                  <b>{l.label.charAt(0).toUpperCase() + l.label.slice(1)}</b>
                  <span>
                    {Math.round(l.pct)}%{l.resets != null ? ` · ${until(l.resets, now)} left` : ''}
                  </span>
                </div>
                <div className="u-bar">
                  <i style={{ width: `${Math.max(0, Math.min(100, l.pct))}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
        {planInfo.workspace && (
          <div className="ws" title="Workspace">
            <i>{planInfo.workspace.name.charAt(0).toUpperCase()}</i>
            {planInfo.workspace.name}
          </div>
        )}
      </nav>

      <main className="main">
        {/* No header bar: the box's name sits quietly at the top, and only
            what matters shows on the right. */}
        <header className="head">
          <div className="head-name">
            {newConv ? (
              <span className={'name-new' + (newConv.name ? ' set' : '')}>{newConv.name || 'New box'}</span>
            ) : box ? (
              <>
                <button
                  className={'name-btn' + (more ? ' open' : '')}
                  onClick={() => nameMenu.length > 0 && setMore(!more)}
                  aria-haspopup="menu"
                  aria-expanded={more}
                >
                  {box.name}
                  {nameMenu.length > 0 && <Chevron />}
                </button>
                {meter && !more && (
                  <div className="meter-card" role="tooltip">
                    {meter}
                  </div>
                )}
                {more && <MoreMenu actions={nameMenu} onClose={() => setMore(false)} />}
              </>
            ) : null}
          </div>
          <div className="head-right">
            {box && live && !newConv && (
              <RemoteButton
                box={box}
                copied={linkCopied && linkCopied.pane === box.paneId ? linkCopied.url : null}
                onCopied={(url) => setLinkCopied(url && box.paneId ? { pane: box.paneId, url } : null)}
                onError={(t) => show(t, true)}
              />
            )}
            {box && box.paneId && !newConv && (
              <button
                className="icon-btn tip view-btn"
                onClick={toggleView}
                aria-label={view === 'chat' ? 'Terminal' : 'Chat'}
                data-tip={view === 'chat' ? 'Terminal  ⌘T' : 'Chat  ⌘T'}
              >
                {view === 'chat' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <rect x="3" y="4.5" width="18" height="15" rx="3" />
                    <path d="M7.5 9.5l3 2.5-3 2.5 M12.5 15h4" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
                  </svg>
                )}
              </button>
            )}
          </div>
        </header>

        {toast && (
          <div className="toast" key={toast.id} role="status">
            {toast.bad ? <span className="bang">!</span> : <Check color="#ffffff" size={14} />}
            {toast.text}
          </div>
        )}

        {body}

        {overlay === 'resume' && <ResumeList boxes={boxes} onPick={resumeSession} onClose={() => setOverlay(null)} />}
        {overlay === 'switch' && (
          <Palette boxes={boxes} hints={hints} actions={paletteActions} onClose={() => setOverlay(null)} onPick={(b) => goTo(b.name)} />
        )}
        {overlay === 'clear' && box && (
          <Confirm
            title={`Clear ${box.name}?`}
            body="A fresh conversation starts. Cmd+K brings the old one back."
            yes="Clear"
            ending
            onYes={() => void act('clear')}
            onClose={() => setOverlay(null)}
          />
        )}
        {overlay === 'close' && box && (
          <Confirm
            title={`Close ${box.name}?`}
            body="Its Claude stops and the box goes away. Cmd+K brings it back."
            yes="Close box"
            ending
            onYes={() => void closeLive(box)}
            onClose={() => setOverlay(null)}
          />
        )}
        {ask && (
          <Confirm title={ask.title} body="That text goes away, and your message is sent." quote={ask.typed} yes="Replace" ending onYes={() => ask.answer(true)} onClose={() => ask.answer(false)} />
        )}
        {overlay === 'rename' && box && (
          <RenameSheet box={box} taken={boxes.map((b) => b.name)} onRename={rename} onClose={() => setOverlay(null)} />
        )}
        {full && (
          <div className="lightbox" role="dialog" aria-label="Picture" onClick={() => setFull(null)}>
            <img src={full} alt="" />
          </div>
        )}
      </main>

      {drillShown && narrow && <DrillPanel drill={drill} sent={sent} floating onSend={sendDrill} onClose={() => showPanel(false)} />}
      {(drillShown || closing) && !narrow && (
        <div className={'drill-dock' + (drillShown ? '' : ' closing')} onAnimationEnd={(e) => e.target === e.currentTarget && !drillShown && setClosing(false)}>
          <DrillPanel drill={drill} sent={sent} floating={false} onSend={sendDrill} onClose={() => showPanel(false)} />
        </div>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, Box, BoxSpec, Draft, Drill, HubEvent, PhaseInfo, PlanInfo, Result, Snapshot } from './api';
import { Check, StateMark } from './icons';
import { Picker } from './Picker';
import { Action, Confirm, ContextPop, MoreMenu, Palette, RenameSheet } from './Actions';
import { ChatState, ChatView, Pending, norm } from './Chat';
import { quotesOf, quoteText } from './Quotes';
import { TerminalView } from './Terminal';
import { DrillPanel } from './Drill';
import { NewBoxSheet } from './NewBox';

type Toast = { text: string; bad?: boolean; id: number };

// New Box's message is kept with the drafts, under a key no box name can have.
const NEW_BOX = 'new.box';

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

// A wide window remembers whether the panel was docked open. A narrow one
// always starts with it closed: there it opens only on his click.
function panelFor(narrow: boolean) {
  if (narrow) return false;
  const v = store.get('chiefman.panel.wide');
  return (v ?? store.get('chiefman.panel')) === '1';
}

function money(n: number | null) {
  if (n == null) return '';
  return n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n)}`;
}

// Time left until a plan limit resets, as the tmux status bar says it:
// 47m, 2h 47m, 3d 15h.
function until(at: number, now: number) {
  const mins = Math.max(0, Math.floor((at - now) / 60000));
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
}

// Every box the app starts runs in bypass permissions, so the header names
// the mode only when it is another one. With no mode line under its prompt,
// Claude asks before it edits.
const USUAL_MODE = /bypass/i;
const DEFAULT_MODE = 'ask before edits';

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
  const [incoming, setIncoming] = useState<Record<string, { text: string; seq: number }>>({});
  // First messages held while their box starts, by box name.
  const [held, setHeld] = useState<Record<string, string>>({});
  const [endedOpen, setEndedOpen] = useState(false);
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
          setChats((c) => ({ ...c, [ev.paneId]: { items: ev.items, fresh: new Set(), steps: ev.steps, loaded: true } }));
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
    const onWidth = () => {
      setNarrow(mq.matches);
      setPanel(panelFor(mq.matches));
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

  useEffect(() => {
    if (!linkFor) return;
    const t = setTimeout(() => setLinkFor(null), 4000);
    return () => clearTimeout(t);
  }, [linkFor]);

  // Below 1180 px the panel floats over the chat; a click outside closes it.
  useEffect(() => {
    if (!narrow || !drillShown) return;
    const away = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (t && !t.closest('.drill, .skills, .scrim, .sheet')) showPanel(false);
    };
    document.addEventListener('mousedown', away, true);
    return () => document.removeEventListener('mousedown', away, true);
  }, [narrow, drillShown]);

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

  // Ended boxes leave the list for the quiet "Ended" line, which shows only
  // while there are some. The chief always stays a row.
  const hasText = (name: string) => {
    const d = saved.current[name];
    return !!d && (!!d.text.trim() || d.atts.length > 0 || quotesOf(d.bundle).length > 0);
  };
  const tucked = (b: Box) => !!b.ended && b.name !== 'chief';
  const listed = boxes.filter((b) => !tucked(b));
  const endedLine = boxes.filter(tucked);
  // The line stays open while he reads one of its boxes.
  const endedShown = endedOpen || endedLine.some((b) => b.name === selected);

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

  useEffect(() => {
    if (box) store.set('chiefman.selected', box.name);
  }, [box?.name]);

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
      if (e.key === 'Escape' && narrow && drillShown && !overlay && !ask) {
        e.preventDefault();
        e.stopPropagation();
        showPanel(false);
        return;
      }
      // Esc on a menu leaves it, as in the terminal, where Claude allows that.
      // A menu without that (the trust question) gets no Esc at all.
      if (e.key === 'Escape' && !e.metaKey && !overlay && !ask && !picking && !more && !ctx && view === 'chat' && box?.paneId && box.menu) {
        const el = document.activeElement;
        if (el && (el.closest('.drill, .asks, .quote-bubble, .quote-tray') || el.getAttribute('aria-expanded') === 'true')) return;
        e.preventDefault();
        if (box.menu.esc) api().dismiss(box.paneId).then((r) => !r.ok && r.reason && show(r.reason, true));
        return;
      }
      if (e.key === 'Escape' && !e.metaKey && !overlay && !ask && !picking && !more && !ctx && view === 'chat' && box?.paneId && box.status === 'working') {
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
  }, [boxes, box, overlay, view, picking, more, ctx, ask, full, narrow, drillShown, nothing]);

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
    // A command gets no bubble: the log shows it, or it is one the app hides.
    // A message gets its bubble before delivery ends, and keeps it until the
    // log holds one more copy of the same text than it did now.
    // The bubble shows the text as the log will: secrets masked.
    const id = 'p' + Date.now();
    if (skill) {
      const list = pending.current[p] || [];
      const base = workCount(p, skill) + list.filter((x) => x.skill && x.n === skill).length;
      pending.current[p] = [...list, { id, t: skill, n: skill, base, queued: box.status === 'working', skill: true }];
      setTick((t) => t + 1);
    } else if (!text.startsWith('/')) {
      const shown = await api().mask(text);
      const n = norm(shown);
      const list = pending.current[p] || [];
      const base = youCount(p, n) + list.filter((x) => !x.skill && x.n === n).length;
      pending.current[p] = [...list, { id, t: shown, n, base, queued: box.status === 'working', ...(opts.answer ? { answer: true } : {}) }];
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
    pending.current[p] = (pending.current[p] || []).map((x) => (x.id === id ? { ...x, queued: !!r.queued } : x));
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
        // His first message: sent, or put in the box's field. New Box keeps
        // it only when the box never came up.
        if (r.sent) setDraftFor(NEW_BOX, null);
        if (r.unsent) {
          giveBack(r.name || spec.name, r.paneId, r.unsent);
          setDraftFor(NEW_BOX, null);
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

  const boxActions: Action[] =
    box && box.paneId && box.status !== 'off' && box.status !== 'starting' && box.status !== 'resuming' && box.status !== 'failed'
      ? [
          { label: 'Compact', run: () => setOverlay('compact') },
          { label: 'Clear', run: () => setOverlay('clear') },
          { label: 'Rename', run: () => setOverlay('rename') },
          { label: box.remote ? 'Copy Remote Control link' : 'Turn on Remote Control', hint: box.remote ? 'on' : '', run: remote },
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
  const paletteActions: Action[] = [
    ...boxActions,
    ...endedActions,
    { label: 'Model and effort', run: () => setPicking(true) },
    { label: 'New box', run: () => setOverlay('newbox') },
    { label: view === 'chat' ? 'Terminal' : 'Chat', run: () => setView(view === 'chat' ? 'terminal' : 'chat') },
  ];

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
  const title = box ? box.name : 'chiefman';
  const meter = box ? meterLine(box) : '';
  const live = box && box.paneId && box.status !== 'off' && box.status !== 'starting' && box.status !== 'resuming' && box.status !== 'failed';
  // A skill the open box cannot run has no button.
  const skills: Skill[] = live ? SKILLS.filter((s) => box!.skills?.includes(s.name)) : [];
  const waiting = info.restore ? boxes.find((b) => b.menu) : undefined;

  // The skill buttons, as quiet words under the message box: things he asks
  // the box, so they sit where he types.
  const skillRow =
    skills.length > 0 ? (
      <span className="skills" role="group" aria-label="Skills">
        {skills.map((s) => {
          // The chief's own list fills the panel; its count shows here.
          const chiefList = s.name === 'drill-down' && box!.name === 'chief';
          return (
            <button
              key={s.name}
              className={'skill-btn' + (chiefList && (drillShown || nothing) ? ' on' : '')}
              title={chiefList && asks > 0 ? `${asks} need${asks === 1 ? 's' : ''} you · runs drill-down` : `Runs ${s.name} in ${box!.name}`}
              onClick={() => runSkill(s)}
            >
              {s.label}
              {chiefList && asks > 0 && !drillShown && <span className="badge">{asks}</span>}
            </button>
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
  // The chief's lists fold to one line each: the newest while the panel shows
  // it or once all of it is answered. Only the newest list shows at all; an
  // older one is hidden (an empty fold). A list that never had items stays
  // plain text.
  const folds: Record<string, string> = {};
  if (box && box.name === 'chief' && drill) {
    for (const [id, kind] of Object.entries(drill.folds || {})) folds[id] = kind === 'answered' ? 'Drill-down · all answered' : 'Earlier drill-down';
    if (asks > 0 && drillShown) folds[drill.id] = `Drill-down · ${asks} need${asks === 1 ? 's' : ''} you`;
    else if (asks === 0 && (drill.total ?? 0) > 0) folds[drill.id] = 'Drill-down · all answered';
    const lists = ((shownPane && chats[shownPane]?.items) || []).filter((i) => i.id in folds || i.id === drill.id);
    for (const i of lists.slice(0, -1)) if (i.id in folds) folds[i.id] = '';
  }
  if (!box || (!box.paneId && box.status !== 'ended')) {
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
        underEnded={endedLine.some((b) => b.name === box.name)}
        note={notes[box.name]}
        waiting={held[box.name]}
        onOpen={setFull}
        onSend={sendToBox}
        onError={(t) => show(t, true)}
        foot={skillRow}
      />
    );
  }

  return (
    <div className="app">
      <nav className="nav" aria-label="Sidebar">
        <div className="nav-lights" />
        <div className="nav-list">
          {listed.map((b, i) => {
            const on = box?.name === b.name;
            return (
              <button
                key={b.id}
                className={'row' + (on ? ' on' : '') + (b.status === 'off' || b.status === 'failed' || b.status === 'ended' ? ' off' : '')}
                onClick={() => setSelected(b.name)}
                title={i < 9 ? `${b.name}  ⌘${i + 1}` : b.name}
              >
                <StateMark box={b} />
                <span className="name">{b.name}</span>
                {b.cost != null && b.cost > 0 && <span className="row-cost">{money(b.cost)}</span>}
              </button>
            );
          })}
        </div>
        {endedLine.length > 0 && (
          <div className="ended-group">
            <button className="ended-toggle" aria-expanded={endedShown} onClick={() => setEndedOpen(!endedShown)}>
              <svg className={'ended-chev' + (endedShown ? ' open' : '')} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Ended ({endedLine.length})
            </button>
            {endedShown && (
              <div className="ended-items">
                {/* A click opens its chat to read; only Resume there brings it back. */}
                {endedLine.map((b) => (
                  <div key={b.id} className={'ended-item' + (box?.name === b.name ? ' on' : '')}>
                    <button
                      className="ended-open"
                      title={b.name}
                      onClick={() => {
                        setSelected(b.name);
                        setView('chat');
                      }}
                    >
                      {b.name}
                    </button>
                    <button className="text-btn" onClick={() => clearEnded([b.name])}>
                      Remove
                    </button>
                  </div>
                ))}
                {endedLine.length > 1 && (
                  <button className="text-btn ended-all" onClick={() => clearEnded(endedLine.map((b) => b.name))}>
                    Remove all
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {info.restore && (
          <div className="nav-quiet" role="status">
            {waiting ? `${waiting.name} needs you` : info.restore.label} · {info.restore.done} of {info.restore.total} back
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button className="row" onClick={() => setOverlay('newbox')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5B5B59" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
            <path d="M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 8v8 M8 12h8" />
          </svg>
          <span style={{ color: '#5B5B59' }}>New Box</span>
        </button>
        {(planInfo.plan || planInfo.workspace) && (
          <div className="foot">
            {planInfo.workspace && (
              <div className="ws" title="Workspace">
                <span className="ws-dot" style={{ background: planInfo.workspace.colour }} />
                {planInfo.workspace.name}
              </div>
            )}
            {planInfo.plan && (
              <div className="plan" role="group" aria-label="Plan usage">
                {planInfo.plan.map((l) => (
                  <div key={l.label} className={'plan-line' + (l.pct >= 80 ? ' high' : '')}>
                    <div className="plan-text">
                      <span>
                        {l.label.charAt(0).toUpperCase() + l.label.slice(1)} {Math.round(l.pct)}% used
                      </span>
                      {l.resets != null && <span>resets in {until(l.resets, now)}</span>}
                    </div>
                    <div className="plan-track">
                      <span className="plan-fill" style={{ width: `${Math.max(0, Math.min(100, l.pct))}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      <main className="main">
        <div className="bar">
          <div className="bar-title">
            <h1>{title}</h1>
            {live && (
              <div className="bar-meta">
                {meter && (
                  <span className="meter-wrap">
                    <button className="pill meter" onClick={openContext} title={meter}>
                      {meter}
                    </button>
                    {ctx === box!.paneId && <ContextPop tokens={box!.tokens} onClose={() => setCtx(null)} />}
                  </span>
                )}
                {box!.modelName && (
                  <span className="keep">
                    <button className="pill" onClick={() => setPicking(!picking)} title="Model and effort" disabled={!!box!.switching}>
                      {box!.switching && !box!.switching.asking ? (
                        'Switching…'
                      ) : (
                        <>
                          {box!.modelName}
                          {box!.effort ? ` · ${box!.effort}` : ''}
                          <svg className="pill-chevron" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M6 9l6 6 6-6" />
                          </svg>
                        </>
                      )}
                    </button>
                    {picking && <Picker model={box!.model} effort={box!.effort} mode={box!.mode ?? DEFAULT_MODE} onMode={cycleMode} onPick={switchBox} onClose={() => setPicking(false)} />}
                  </span>
                )}
                {/* The mode shows here only when it is not the boxes' usual one. */}
                {box!.mode && !USUAL_MODE.test(box!.mode) && (
                  <span className="keep">
                    <button className={'pill mode' + (/plan/i.test(box!.mode) ? ' plan' : '')} onClick={cycleMode} title="Next mode (Shift+Tab)">
                      {box!.mode}
                    </button>
                  </span>
                )}
                <span className="keep">
                  <button className="icon-btn tip" onClick={() => setMore(!more)} aria-label="More actions" data-tip="More actions">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.8" />
                      <circle cx="12" cy="12" r="1.8" />
                      <circle cx="19" cy="12" r="1.8" />
                    </svg>
                  </button>
                  {more && <MoreMenu actions={boxActions} onClose={() => setMore(false)} />}
                </span>
                {linkFor === box!.paneId && box!.remote && (
                  <span className="copied keep" key={linkFor}>
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
              <button className={'tip' + (view === 'chat' ? ' on' : '')} onClick={() => setView('chat')} aria-label="Chat" data-tip="Chat">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
                </svg>
                <span className="seg-label">Chat</span>
              </button>
              <button className={'tip' + (view === 'terminal' ? ' on' : '')} onClick={() => setView('terminal')} aria-label="Terminal" data-tip="Terminal">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 7l5 5-5 5 M12 18h7" />
                </svg>
                <span className="seg-label">Terminal</span>
              </button>
            </div>
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
          <NewBoxSheet
            boxes={boxes}
            initialMessage={saved.current[NEW_BOX]?.text ?? ''}
            onMessage={(t) => setDraftFor(NEW_BOX, t ? { text: t, caret: t.length, atts: [] } : null)}
            onCancel={() => setOverlay(null)}
            onStart={startBox}
          />
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

      {drillShown && narrow && <DrillPanel drill={drill} sent={sent} floating onSend={sendDrill} />}
      {(drillShown || closing) && !narrow && (
        <div className={'drill-dock' + (drillShown ? '' : ' closing')} onAnimationEnd={(e) => e.target === e.currentTarget && !drillShown && setClosing(false)}>
          <DrillPanel drill={drill} sent={sent} floating={false} onSend={sendDrill} />
        </div>
      )}
    </div>
  );
}

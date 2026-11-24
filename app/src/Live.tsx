import { useEffect, useState } from 'react';
import { api, type Box, type LiveItem, type LiveSum, type Todo } from './api';
import { Card, type Tone } from './Card';
import { Markdown } from './Markdown';
import { AgentIcon, Check, RunsIcon, ShellIcon, TodoIcon, WatchIcon } from './icons';
import { meterOf } from './Actions';
import './live.css';

// Re-renders every `ms`, for the minutes on screen.
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// How long since: "4m", "1h 5m"; nothing under a minute.
export function mins(since: number, now = Date.now()) {
  const m = Math.floor((now - since) / 60000);
  if (!(m >= 1)) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const count = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : '');

// "2 agents · 1 command".
export function runsText(l: LiveSum) {
  return [count(l.agents, 'agent', 'agents'), count(l.commands, 'command', 'commands'), count(l.watches, 'watch', 'watches')].filter(Boolean).join(' · ');
}

// Its words as part of a sentence: "Run the tests" reads "run the tests";
// a name such as "CI" or "PR 12" keeps its capital.
const inLine = (s: string) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

// The line under a waiting box's name: "Waiting on run the tests · 12m".
export function waitText(l: LiveSum, now = Date.now()) {
  const time = mins(l.since, now);
  return `Waiting on ${inLine(l.on)}${l.more ? ` and ${l.more} more` : ''}${time ? ` · ${time}` : ''}`;
}

const KIND_ICON = { agent: <AgentIcon size={14} />, command: <ShellIcon size={14} />, watch: <WatchIcon size={14} /> };

// One thing that runs, or ran in this batch: its words, its minutes, a tick
// once done; an agent's report folds under it, a command shows its last line.
function RunRow({ it, now }: { it: LiveItem; now: number }) {
  const [open, setOpen] = useState(false);
  const ended = it.done != null;
  const bad = it.status === 'failed';
  const time = ended ? mins(it.since, it.done!) || '<1m' : mins(it.since, now) || '<1m';
  const head = (
    <>
      <span className="live-ic">{KIND_ICON[it.kind]}</span>
      <span className="live-say">{it.say}</span>
      {ended && (bad ? <span className="live-bad">failed</span> : it.status === 'completed' ? <span className="live-tick" aria-label="done"><Check size={12} /></span> : <span className="live-kind">stopped</span>)}
      <span className="live-time">{time}</span>
    </>
  );
  return (
    <div className={'live-item' + (ended ? ' ended' : '')}>
      {it.report ? (
        <button type="button" className="live-row" aria-expanded={open} title={open ? undefined : 'Its report'} onClick={() => setOpen(!open)}>
          {head}
        </button>
      ) : (
        <div className="live-row still">{head}</div>
      )}
      {it.last && <div className="live-last">{it.last}</div>}
      {open && it.report && (
        <div className="live-report">
          <Markdown text={it.report} />
        </div>
      )}
    </div>
  );
}

// "2 agents · 1 command · 4m", one quiet line above the message box while
// things run in the open box. A click opens each one.
function RunsCard({ paneId, sum }: { paneId: string; sum: LiveSum }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LiveItem[] | null>(null);
  const now = useNow(open ? 5000 : 20000);
  const key = `${sum.agents}.${sum.commands}.${sum.watches}.${sum.since}`;
  useEffect(() => {
    if (!open) return;
    let on = true;
    const get = () =>
      api()
        .live(paneId)
        .then((r) => on && setItems(r || []))
        .catch(() => {});
    get();
    const t = setInterval(get, 2500);
    return () => {
      on = false;
      clearInterval(t);
    };
  }, [open, paneId, key]);
  const time = mins(sum.since, now);
  const what = runsText(sum);
  return (
    <Card
      className="live-card"
      done
      open={open}
      onOpen={setOpen}
      icon={<RunsIcon />}
      line={time ? `${what} · ${time}` : what}
      title={what}
      state={open ? time : undefined}
      hint={open ? undefined : 'What runs now'}
    >
      <div className="live-list">{items === null ? <div className="live-note">Loading…</div> : items.length ? items.map((it) => <RunRow key={it.id} it={it} now={now} />) : <div className="live-note">Nothing runs now.</div>}</div>
    </Card>
  );
}

// Claude Code's todo list: "3 of 7 · what it does now", opening to the list
// with ticks.
function TodoCard({ todo }: { todo: Todo }) {
  const line = `${todo.done} of ${todo.total}${todo.now ? ` · ${todo.now}` : ''}`;
  return (
    <Card className="todo-card" done icon={<TodoIcon />} line={line} title={`${todo.done} of ${todo.total} done`} hint="Its todo list">
      <ul className="todo-list">
        {todo.list.map((x, i) => (
          <li key={i} className={'todo-' + x.s}>
            <span className="todo-box" aria-hidden="true">
              {x.s === 'completed' && <Check size={10} />}
            </span>
            <span className="todo-t">{x.t}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// Above the message box, only while there is something: what runs on its
// own, and the todo list while some of it is left.
export function LiveDock({ box }: { box: Box }) {
  const l = box.live;
  // A list left half done when the box stopped says nothing new.
  const t = box.status === 'working' || box.tab === 'waiting' || box.menu ? box.todo : null;
  if ((!l || !box.paneId) && !t) return null;
  return (
    <div className="live-dock">
      {l && box.paneId && <RunsCard paneId={box.paneId} sum={l} />}
      {t && <TodoCard todo={t} />}
    </div>
  );
}

const WORD: Record<string, [string, Tone | undefined]> = {
  working: ['Working', 'working'],
  asks: ['Asks you', 'asks'],
  waiting: ['Waiting', 'waiting'],
  done: ['Done', 'passed'],
};

function ago(at: number, now: number) {
  const m = Math.floor((now - at) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

// A sidebar row at a glance, on hover: its state, what it asks or waits on,
// what its last turn did, what it cost and how full its context is.
export function Peek({ box, top, left, hint }: { box: Box; top: number; left: number; hint?: string }) {
  const now = Date.now();
  const gone = box.status === 'off' || box.status === 'ended' || box.status === 'failed' || !!box.ended;
  const [word, tone] = box.tab ? WORD[box.tab] : gone ? ['Ended', undefined] : box.status === 'starting' || box.status === 'resuming' ? ['Starting', undefined] : ['Idle', undefined];
  const asks = box.menu ? box.menu.perm?.say || (box.menu.plan !== undefined ? 'Approve its plan' : box.menu.question.split('\n')[0]) : box.tab === 'asks' ? box.said?.line : null;
  const lines: { k: string; t: string; c?: string; when?: string }[] = [];
  if (asks) lines.push({ k: 'asks', t: asks, c: 'peek-asks' });
  if (box.live && box.tab === 'waiting') lines.push({ k: 'wait', t: waitText(box.live, now) });
  else if (box.live) lines.push({ k: 'runs', t: `${runsText(box.live)} running` });
  if (box.status === 'working' && box.activity) lines.push({ k: 'now', t: box.activity });
  if (box.todo) lines.push({ k: 'todo', t: `${box.todo.done} of ${box.todo.total} done${box.todo.now ? ` · ${box.todo.now}` : ''}` });
  if (box.last) lines.push({ k: 'last', t: box.last.line, c: 'peek-last', when: ago(box.last.at, now) });
  const meter = [meterOf(box), hint].filter(Boolean).join(' · ');
  return (
    <div className="peek" style={{ top, left }} role="tooltip">
      <Card className="peek-card" title={box.name} state={word} tone={tone} open>
        {lines.map((l) => (
          <div key={l.k} className={'peek-line ' + (l.c || '')}>
            <span className="peek-t">{l.t}</span>
            {l.when && <span className="peek-ago">{l.when}</span>}
          </div>
        ))}
        {meter && <div className="peek-meter">{meter}</div>}
        {!lines.length && !meter && <div className="peek-line">Nothing yet.</div>}
      </Card>
    </div>
  );
}

import type { Box } from './api';

// Every icon in the app: drawn on a 24 grid, shown at 16px, one line weight.
// Colour comes from the text around it (currentColor), so the stylesheet
// sets it.
const W = 2;

export const ICON: Record<string, string> = {
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  columns: 'M12 3l9 5H3z M5 10v8 M9.5 10v8 M14.5 10v8 M19 10v8 M3 21h18',
  check: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M8 12.5l3 3l5-6.5',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L4 17l3 3l5.3-5.3a4 4 0 0 0 5.4-5.4l-2.5 2.5l-2.4-.6l-.6-2.4z',
  eye: 'M2 12s3.5-7 10-7s10 7 10 7s-3.5 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  bubble: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  window: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M3 9h18',
  doc: 'M7 3h7l4 4v14H7z M14 3v4h4 M10 12h5 M10 16h5',
};

// The marks the app draws itself, besides a box's own picture.
const MARK: Record<string, string> = {
  tick: 'M5 12.5l4.5 4.5L19 7.5',
  up: 'M12 19V5M5.5 11.5L12 5l6.5 6.5',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6L6 18',
  down: 'M6 9l6 6 6-6',
  right: 'M9 5l7 7-7 7',
  terminal: 'M6 4.5h12a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3z M7.5 9.5l3 2.5-3 2.5 M12.5 15h4',
  chat: ICON.bubble,
  ask: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.4 M12 17h.01',
  phone: 'M7.6 2.5h4.8a2.6 2.6 0 0 1 2.6 2.6v13.8a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 18.9V5.1a2.6 2.6 0 0 1 2.6-2.6z M9 18.3h2',
  waves: 'M18.2 8.6a4.6 4.6 0 0 1 0 6.8 M20.9 6.2a8.2 8.2 0 0 1 0 11.6',
  cross: 'M3 3l18 18',
  steps: 'M9 6h11 M9 12h11 M9 18h11 M4.5 6h.01 M4.5 12h.01 M4.5 18h.01',
  out: 'M7 17L17 7 M9 7h8v8',
  jump: 'M12 5v14 M6 13l6 6l6-6',
  pen: 'M4 20h4L19 9l-4-4L4 16z M13.5 6.5l4 4',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12 M11 11V4.5a1.5 1.5 0 0 1 3 0V12 M14 11.5V6a1.5 1.5 0 0 1 3 0v8a7 7 0 0 1-7 7h-.5a6 6 0 0 1-5-2.7L3 15.5a1.5 1.5 0 0 1 2.5-1.7L8 16',
  passed: ICON.check,
  failed: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M9 9l6 6 M15 9l-6 6',
  clock: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 7v5l3 2',
};

export const SYMBOLS = ['doc', 'crown', 'columns', 'check', 'wrench', 'eye', 'bubble', 'window'];

function Svg({ d, className }: { d: string; className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={W} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

// One of the app's marks by name: tick, up, plus, close, down, right,
// terminal, chat, ask, steps, out, jump, pen, hand, passed, failed, clock.
export function Icon({ name, className }: { name: string; className?: string }) {
  return <Svg d={MARK[name] || MARK.tick} className={className} />;
}

export function BoxIcon({ icon }: { icon: string }) {
  return <Svg d={ICON[icon] || ICON.doc} />;
}

// The chief's crown, filled, as in the logo.
function Crown() {
  return (
    <svg width="16" height="16" viewBox="28 6 44 44" aria-hidden="true">
      <path d="M30 41 L35 21 L44 31 L50 16 L56 31 L65 21 L70 41 Z" fill="currentColor" stroke="currentColor" strokeWidth="3" strokeLinejoin="round" />
    </svg>
  );
}

// A box's state: working, asks him something, waits on something it
// started, done.
const SAID: Record<string, string> = { working: 'working', asks: 'asks you', waiting: 'waiting', done: 'done' };

// The mark before a box's name (Cmd+K): its state as a dot, or the chief's
// crown in its state's colour. Grey while idle, a ring once it is off.
export function StateMark({ box }: { box: Box }) {
  if (box.status === 'resuming' && !box.tab)
    return (
      <span className="mark">
        <Spinner />
      </span>
    );
  const gone = box.status === 'off' || box.status === 'ended' || box.status === 'failed';
  const said = box.tab ? SAID[box.tab] : gone ? 'off' : 'idle';
  const state = box.tab || (gone ? 'gone' : 'idle');
  if (box.name === 'chief')
    return (
      <span className={'mark crown ' + state} role="img" aria-label={said}>
        <BoxIcon icon="crown" />
      </span>
    );
  return (
    <span className="mark" role="img" aria-label={said}>
      <span className={'dot ' + state} />
    </span>
  );
}

// A sidebar row's picture: the box's icon on a grey disc (the chief's crown
// on black), with its state as a small dot at the corner.
export function Avatar({ box }: { box: Box }) {
  const gone = box.status === 'off' || box.status === 'ended' || box.status === 'failed';
  const chief = box.name === 'chief';
  const said = box.tab ? SAID[box.tab] : gone ? 'off' : 'idle';
  return (
    <span className={'av' + (chief ? ' chief' : '') + (gone ? ' gone' : '')} role="img" aria-label={said}>
      {box.status === 'resuming' && !box.tab ? <Spinner /> : chief ? <Crown /> : <BoxIcon icon={box.icon} />}
      {box.tab && <i className={'av-dot ' + box.tab} />}
    </span>
  );
}

export function Check() {
  return <Svg d={MARK.tick} />;
}

export function Arrow() {
  return <Svg d={MARK.up} />;
}

// Remote Control: a phone, with waves while it is on, crossed out when off.
export function Phone({ on }: { on: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={W} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={MARK.phone} />
      <path d={on ? MARK.waves : MARK.cross} />
    </svg>
  );
}

export function Spinner() {
  const op = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.15];
  const d = ['M12 3v3', 'M18.4 5.6l-2.1 2.1', 'M21 12h-3', 'M18.4 18.4l-2.1-2.1', 'M12 21v-3', 'M5.6 18.4l2.1-2.1', 'M3 12h3', 'M5.6 5.6l2.1 2.1'];
  return (
    <svg className="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={W} strokeLinecap="round" aria-label="resuming">
      {d.map((p, i) => (
        <path key={i} d={p} opacity={op[i]} />
      ))}
    </svg>
  );
}

// The cards for what runs, what it asks and what it made.
// An agent: a small figure.
export const AgentIcon = () => <Svg d="M12 4a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7z M5 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6" />;
// A command: a prompt and a line.
export const ShellIcon = () => <Svg d="M5 7l5 5-5 5 M12.5 17H19" />;
// A watch: an eye on something.
export const WatchIcon = () => <Svg d={ICON.eye} />;
// Several things running at once.
export const RunsIcon = () => <Svg d="M4 6h10 M4 12h16 M4 18h7 M18 4.5v3 M16.5 6h3" />;
// A permission he gives: a shield.
export const ShieldIcon = () => <Svg d="M12 3l7.5 3v5.5c0 4.6-3.2 8.2-7.5 9.5c-4.3-1.3-7.5-4.9-7.5-9.5V6z" />;
// A plan: a sheet with lines.
export const PlanIcon = () => <Svg d="M6 3.5h12v17H6z M9 8h6 M9 12h6 M9 16h3.5" />;
// A todo list: ticks beside lines.
export const TodoIcon = () => <Svg d="M4 7l1.8 1.8L9 5.5 M4 15.5l1.8 1.8L9 14 M12.5 7.5H20 M12.5 16H20" />;
// What a box made: a box.
export const MadeIcon = () => <Svg d="M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8" />;
// A todo step: an empty circle while left, ticked once done.
export const StepIcon = ({ done }: { done: boolean }) => <Svg d={done ? ICON.check : 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z'} />;

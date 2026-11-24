import type { Box } from './api';

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

export const SYMBOLS = ['doc', 'crown', 'columns', 'check', 'wrench', 'eye', 'bubble', 'window'];

export const PALETTE: [string, string][] = [
  ['plum', '#6C358C'],
  ['blue', '#0052B4'],
  ['rust', '#C2410C'],
  ['forest', '#034F46'],
  ['orchid', '#A3398F'],
  ['moss', '#496E2D'],
  ['graphite', '#5B5B59'],
];

export function BoxIcon({ icon, color, size = 16 }: { icon: string; color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[icon] || ICON.doc} />
    </svg>
  );
}

// A box's state, the same colours as its tmux tab: blue while it works,
// orange when it asked him something, green when its task is done.
const TAB: Record<string, string> = { working: '#3e7bfa', asks: '#f5843a', done: '#5ea83a' };
const SAID: Record<string, string> = { working: 'working', asks: 'asks you', done: 'done' };

// The mark before a box's name: its state dot, or the chief's crown in the
// state's colour. Grey while idle, a ring once it is off.
export function StateMark({ box }: { box: Box }) {
  if (box.status === 'resuming' && !box.tab)
    return (
      <span className="mark">
        <Spinner />
      </span>
    );
  const gone = box.status === 'off' || box.status === 'ended' || box.status === 'failed';
  const said = box.tab ? SAID[box.tab] : gone ? 'off' : 'idle';
  if (box.name === 'chief')
    return (
      <span className={'mark' + (box.tab === 'working' ? ' pulse' : '')} role="img" aria-label={said}>
        <BoxIcon icon="crown" color={box.tab ? TAB[box.tab] : gone ? '#B3B2AD' : box.color} size={15} />
      </span>
    );
  return (
    <span className="mark" role="img" aria-label={said}>
      <span className={'dot ' + (box.tab || (gone ? 'gone' : 'idle'))} />
    </span>
  );
}

export function Check({ color = 'currentColor', size = 13 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function Arrow({ size = 14, dir = 'up' }: { size?: number; dir?: 'up' | 'left' | 'right' }) {
  const rot = dir === 'left' ? -90 : dir === 'right' ? 90 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={rot ? { transform: `rotate(${rot}deg)` } : undefined}>
      <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
    </svg>
  );
}

export function Link({ on }: { on: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="7" y="2.5" width="10" height="19" rx="2.5" />
      <path d="M11 18.5h2" />
      {on && <circle cx="19.5" cy="4.5" r="2.5" fill="currentColor" stroke="none" />}
    </svg>
  );
}

export function Spinner() {
  const op = [1, 0.85, 0.7, 0.55, 0.45, 0.35, 0.25, 0.15];
  const d = ['M12 3v3', 'M18.4 5.6l-2.1 2.1', 'M21 12h-3', 'M18.4 18.4l-2.1-2.1', 'M12 21v-3', 'M5.6 18.4l2.1-2.1', 'M3 12h3', 'M5.6 5.6l2.1 2.1'];
  return (
    <svg className="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#5B5B59" strokeWidth="2.6" strokeLinecap="round" aria-label="resuming">
      {d.map((p, i) => (
        <path key={i} d={p} opacity={op[i]} />
      ))}
    </svg>
  );
}

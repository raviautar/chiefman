import type { Bundle } from './Answers';

export type Status = 'working' | 'idle' | 'off' | 'resuming' | 'resumed' | 'starting' | 'failed' | 'ended';

export interface Box {
  id: string;
  name: string;
  paneId: string | null;
  icon: string;
  color: string;
  status: Status;
  // The same state as the box's tmux tab: working, asks (it asked him
  // something), waiting (its turn is over but something it started still
  // runs), done. Shown only as a coloured dot.
  tab: 'working' | 'asks' | 'waiting' | 'done' | null;
  // What it started that runs on its own now; its todo list while some is
  // left; its last turn's line of facts.
  live?: LiveSum | null;
  todo?: Todo | null;
  last?: { line: string; at: number } | null;
  since: number | null;
  activity: string | null;
  menu: Menu | null;
  cost: number | null;
  context: number | null;
  model: string | null;
  modelName: string | null;
  effort: string | null;
  remote: boolean;
  // His click on the Remote Control icon, until the box has done it.
  remoteAsk?: 'on' | 'off' | null;
  // Which of the skill buttons (plain-english, explain, drill-down) this box can run.
  skills?: string[];
  mode: string | null;
  switching: { kind: 'model' | 'effort'; value: string; asking: boolean } | null;
  tokens: { used: number; max: number } | null;
  // Set when the box ended: its window closed (window false), or its Claude exited.
  // later: New Box can resume its conversation after it is removed.
  // why: it ended as it started, for this reason.
  ended?: { start: boolean; window: boolean; later?: boolean; why?: string | null } | null;
  // The conversation this row holds. One row per conversation.
  session?: string | null;
  // The last line the box said (its first question, when it asks him
  // something), and when, for its sidebar row.
  said?: { line: string; at: number } | null;
  lastPane?: string | null;
}

export interface Recent {
  id: string;
  at: number;
  title: string;
  first: string;
}

export interface Menu {
  question: string;
  selected: number;
  // box: a check box (a question with several picks), ticked when checked.
  options: { n: number; label: string; current?: boolean; box?: boolean; checked?: boolean }[];
  // Esc leaves it (the app shows Cancel); free is the "Type something." option.
  esc?: boolean;
  free?: number | null;
  // Several picks allowed; button is the line that sends them (Submit, Next).
  multi?: boolean;
  button?: string | null;
  // Claude Code's own permission question: what it asks to do.
  perm?: Perm;
  // Claude Code's approval of a plan: the plan, as Markdown.
  plan?: string;
}

// A tool call he is asked to allow. say: what it does in plain words; what:
// the command, file or page; body: the change or the content (a diff when
// diff); note: the box's own words for it.
export interface Perm {
  say: string;
  what: string;
  body: string | null;
  note: string | null;
  diff?: boolean;
}

// What a box started that runs on its own: how many of each, since when the
// oldest runs, and its words (on).
export interface LiveSum {
  agents: number;
  commands: number;
  watches: number;
  since: number;
  on: string;
  kind: 'agent' | 'command' | 'watch';
  more: number;
}

// One of them in full: done is when it ended (with its status), report is
// an agent's answer, last is the last line a command printed.
export interface LiveItem {
  id: string;
  kind: 'agent' | 'command' | 'watch';
  say: string;
  since: number;
  done: number | null;
  status: 'completed' | 'failed' | 'killed' | 'stopped' | null;
  report: string | null;
  last: string | null;
}

// A box's todo list: s is pending, in_progress or completed; now is what it
// does at the moment.
export interface Todo {
  done: number;
  total: number;
  now: string | null;
  list: { t: string; s: string }[];
}

// One choice of a question: recommended when the box marked it with a *,
// note: the line under it.
export interface Choice {
  label: string;
  recommended?: true;
  note?: string;
}

// A question a box asks in chiefman's reply shape. yesno: Yes and No (its
// options are yes and no); one: pick one option; any: pick several; text: a
// one-line field; words: only his own words.
export interface Ask {
  n: number;
  q: string;
  kind: 'yesno' | 'one' | 'any' | 'text' | 'words';
  options: Choice[];
}

// The other blocks a box writes under a reply (electron/blocks.js), each a
// card. actions: buttons, the first the main one; draft: text he posts
// himself, where: where it goes; turn: steps only he can do; result: a test
// run; waiting: what the box waits on, then what it does next.
export type Widget =
  | { kind: 'actions'; buttons: string[] }
  | { kind: 'draft'; where: string; text: string }
  | { kind: 'turn'; steps: { text: string; url?: string }[] }
  | { kind: 'result'; label: string; passed: number | null; failed: number | null; fails: { name: string; why?: string }[]; url?: string }
  | { kind: 'waiting'; on: string; then?: string; url?: string };

export interface Item {
  id: string;
  k: 'you' | 'box' | 'work';
  t: string;
  ts?: string;
  mono?: boolean;
  // His message came from the app (it carried the mark).
  app?: boolean;
  // The questions at the end of a reply to a message from the app.
  asks?: Ask[];
  // Its other blocks, as cards under it.
  cards?: Widget[];
  // A block not closed yet: shown as text only once the reply is done.
  tail?: string;
  // A turn's line of facts: what the turn did, by kind.
  turn?: Turn;
}

// What one turn of work did. Each row names the steps it came from (ids),
// whose change or output loads when he opens it.
export interface Turn {
  ms: number | null;
  n: number;
  files: { path: string; name: string; add: number; del: number; ids: string[]; created?: boolean }[];
  // Writes to other systems: draft, sent, or another change.
  outside: { id: string; say: string; service: string; write: 'draft' | 'sent' | 'change'; link?: string }[];
  git: { id: string; kind: 'commit' | 'push' | 'opened' | 'merged' | 'closed' | 'ready' | 'rebased' | 'branch' | 'pr'; say: string; link?: string; n?: number }[];
  failed: { id: string; say: string; tail: string[] }[];
  // The steps that only read (missed: it failed, and the box went on).
  other: { id: string; say: string; missed?: boolean }[];
}

// The turn that runs now: its newest step as it reads while it runs, when
// it started, and what failed so far.
export interface TurnNow {
  n: number;
  say: string | null;
  since: string | null;
  failed: { id: string; say: string }[];
}

// A step read again from the log: a file's change, or what it printed.
export interface StepDetail {
  id: string;
  diff?: string;
  out?: string;
  cut?: number;
  cmd?: string;
}

export interface DrillItem {
  n: number;
  text: string;
  full: string;
  words: string[];
  ask?: { kind: 'yesno' | 'one' | 'any'; options: Choice[] };
}

export interface Drill {
  id: string;
  at?: string;
  items: DrillItem[];
  total?: number;
  // Older lists in the chief's chat, by message id: all answered, or
  // replaced by a newer list that still has some of their items open.
  folds?: Record<string, 'answered' | 'earlier'>;
  rest: number;
  also: string | null;
}

export type Phase = 'starting' | 'ready' | 'restoring' | 'fresh' | 'error';

export interface PhaseInfo {
  phase: Phase;
  error: string | null;
  restore: { total: number; done: number; label: string } | null;
}

// One of the plan's usage limits: session, week, or a model's own (Fable).
// resets: when it resets, in ms.
export interface Limit {
  label: string;
  pct: number;
  resets: number | null;
}

// The machine's workspace name, where one is set.
export interface Workspace {
  name: string;
  colour: string;
}

export interface PlanInfo {
  plan: Limit[] | null;
  workspace: Workspace | null;
}

export interface Snapshot extends PhaseInfo, PlanInfo {
  boxes: Box[];
  drill: Drill | null;
  config: { session: string; workdir: string; stateFile: string; attachDir: string; model: string; effort: string };
}

// What he typed but did not send in one box, kept across switches and restarts.
export interface Draft {
  text: string;
  caret: number;
  atts: { path: string; name: string; image: boolean }[];
  // Widget answers and quote replies waiting for Send.
  bundle?: Bundle;
}

export type HubEvent =
  | ({ type: 'phase' } & PhaseInfo)
  | { type: 'boxes'; boxes: Box[]; restore?: PhaseInfo['restore'] }
  | { type: 'draft'; paneId: string; text: string }
  | { type: 'select'; paneId: string }
  | { type: 'context'; paneId: string; text: string }
  | { type: 'notice'; text: string; bad?: boolean }
  | { type: 'chat-reset'; paneId: string; items: Item[]; now: TurnNow | null }
  | { type: 'chat-add'; paneId: string; added: { item: Item; after: string | null }[]; now: TurnNow | null }
  | { type: 'drill'; drill: Drill | null }
  | ({ type: 'plan' } & PlanInfo)
  | { type: 'term'; paneId: string; data: string }
  | { type: 'term-reset'; paneId: string; cols: number; rows: number; data: string };

export interface Result {
  ok: boolean;
  reason?: string;
  paneId?: string;
  queued?: boolean;
  url?: string;
  started?: boolean;
  path?: string;
  ask?: 'replace';
  typed?: string;
  // A click on a question Claude had already moved past: nothing was done.
  stale?: boolean;
  duplicate?: boolean;
  pending?: boolean;
  session?: string;
  // New Box: the row it used (existing: an earlier row of that conversation),
  // and the name it asked for when that one was taken.
  name?: string;
  existing?: boolean;
  renamed?: string;
  // The first message: seen sent, or given back to go in the box's field.
  sent?: boolean;
  unsent?: string;
  // The box ended as it started (its Claude quit at a start-up question).
  ended?: boolean;
}

interface Bridge {
  init(): Promise<Snapshot>;
  watch(paneId: string): void;
  term(paneId: string | null): void;
  termInput(paneId: string, data: string): void;
  send(paneId: string, text: string, replace?: boolean): Promise<Result>;
  sendChief(text: string, replace?: boolean): Promise<Result>;
  cycleMode(paneId: string): Promise<Result>;
  mask(text: string): Promise<string>;
  newBox(spec: BoxSpec): Promise<Result>;
  interrupt(paneId: string): Promise<Result>;
  action(paneId: string, kind: 'compact' | 'clear'): Promise<Result>;
  rename(paneId: string, name: string): Promise<Result>;
  recent(): Promise<Recent[]>;
  switchBox(paneId: string, kind: 'model' | 'effort', value: string): Promise<Result>;
  remote(paneId: string, what: 'on' | 'off' | 'link'): Promise<Result>;
  copy(text: string): void;
  attach(name: string, data: ArrayBuffer): Promise<Result>;
  // ask: the question the click was made on, as askOf in Chat.tsx makes it.
  choose(paneId: string, n: number, ask?: string): Promise<Result>;
  dismiss(paneId: string): Promise<Result>;
  answer(paneId: string, text: string, ask?: string): Promise<Result>;
  // Ticks exactly these check boxes, adds his words if any, and submits.
  submitMenu(paneId: string, picks: number[], text?: string, ask?: string): Promise<Result>;
  retry(paneId: string): Promise<Result>;
  // With a message: Resume and send.
  startAgain(name: string, message?: string): Promise<Result>;
  closeEnded(name: string): Promise<Result>;
  // Stops a running box's Claude and closes its window.
  closeBox(paneId: string): Promise<Result>;
  rewind(paneId: string, spec: { text: string; id: string; dupAfter: number }): Promise<Result>;
  files(paneId: string, query: string): Promise<string[]>;
  steps(paneId: string, ids: string[]): Promise<StepDetail[]>;
  // What the box started that runs on its own, in full.
  live(paneId: string): Promise<LiveItem[]>;
  drafts(): Promise<Record<string, Draft>>;
  saveDrafts(d: Record<string, Draft>): void;
  openUrl(url: string): void;
  // A full local path: opens in the Mac's default app.
  openPath(path: string): void;
  onEvent(cb: (ev: HubEvent) => void): () => void;
}

declare global {
  interface Window {
    chiefman: Bridge;
  }
}

export const api = (): Bridge => window.chiefman;

export interface BoxSpec {
  name: string;
  icon: string;
  color: string;
  message: string;
  model: string;
  effort: string;
  resume?: string;
  // The app made the name from his first message: the box's first reply may
  // name it better, once (a title block).
  auto?: boolean;
}

// The longest message the app sends (the hub checks it too).
export const MAX_SEND = 50000;
export const tooLong = (n: number) => `Messages can be up to ${MAX_SEND.toLocaleString('en-US')} characters. This one has ${n.toLocaleString('en-US')}.`;

export const MODELS: [string, string][] = [
  ['claude-fable-5-2', 'Fable 5.2'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export type Status = 'working' | 'idle' | 'off' | 'resuming' | 'resumed' | 'starting' | 'failed' | 'ended';

export interface Box {
  id: string;
  name: string;
  paneId: string | null;
  icon: string;
  color: string;
  status: Status;
  // The same state as the box's tmux tab: working, asks (it asked him
  // something), done. Shown only as a coloured dot.
  tab: 'working' | 'asks' | 'done' | null;
  since: number | null;
  activity: string | null;
  menu: Menu | null;
  cost: number | null;
  context: number | null;
  model: string | null;
  modelName: string | null;
  effort: string | null;
  remote: boolean;
  // Which of the header's skills (plain-english, drill-down) this box can run.
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
  options: { n: number; label: string; current?: boolean }[];
  // Esc leaves it (the app shows Cancel); free is the "Type something." option.
  esc?: boolean;
  free?: number | null;
}

export interface Item {
  id: string;
  k: 'you' | 'box' | 'work';
  t: string;
  ts?: string;
  mono?: boolean;
}

export interface DrillItem {
  n: number;
  text: string;
  full: string;
  words: string[];
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
}

export type HubEvent =
  | ({ type: 'phase' } & PhaseInfo)
  | { type: 'boxes'; boxes: Box[]; restore?: PhaseInfo['restore'] }
  | { type: 'draft'; paneId: string; text: string }
  | { type: 'select'; paneId: string }
  | { type: 'context'; paneId: string; text: string }
  | { type: 'notice'; text: string; bad?: boolean }
  | { type: 'chat-reset'; paneId: string; items: Item[]; steps: number }
  | { type: 'chat-add'; paneId: string; added: { item: Item; after: string | null }[]; steps: number }
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
  remote(paneId: string): Promise<Result>;
  copy(text: string): void;
  attach(name: string, data: ArrayBuffer): Promise<Result>;
  choose(paneId: string, n: number): Promise<Result>;
  dismiss(paneId: string): Promise<Result>;
  answer(paneId: string, text: string): Promise<Result>;
  retry(paneId: string): Promise<Result>;
  // With a message: Resume and send.
  startAgain(name: string, message?: string): Promise<Result>;
  closeEnded(name: string): Promise<Result>;  rewind(paneId: string, spec: { text: string; id: string; dupAfter: number }): Promise<Result>;
  files(paneId: string, query: string): Promise<string[]>;
  drafts(): Promise<Record<string, Draft>>;
  saveDrafts(d: Record<string, Draft>): void;
  openUrl(url: string): void;
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
}

export const MODELS: [string, string][] = [
  ['claude-fable-5-2', 'Fable 5.2'],
  ['claude-opus-5-5', 'Opus 5.5'],
  ['claude-sonnet-5-5', 'Sonnet 5.5'],
  ['claude-haiku-5-5', 'Haiku 5.5'],
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

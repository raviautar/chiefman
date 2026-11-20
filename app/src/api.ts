export type Status = 'working' | 'idle' | 'off' | 'resuming' | 'resumed' | 'starting';

export interface Box {
  id: string;
  name: string;
  paneId: string | null;
  icon: string;
  color: string;
  status: Status;
  since: number | null;
  activity: string | null;
  menu: Menu | null;
  cost: number | null;
  context: number | null;
  model: string | null;
  modelName: string | null;
  effort: string | null;
  remote: boolean;
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
  options: { n: number; label: string }[];
}

export interface Item {
  id: string;
  k: 'you' | 'box' | 'work';
  t: string;
  ts?: string;
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
  rest: number;
}

export type Phase = 'starting' | 'ready' | 'restoring' | 'fresh' | 'error';

export interface PhaseInfo {
  phase: Phase;
  error: string | null;
  restore: { total: number; done: number } | null;
}

export interface Snapshot extends PhaseInfo {
  boxes: Box[];
  drill: Drill | null;
  config: { session: string; workdir: string; stateFile: string; model: string; effort: string };
}

export type HubEvent =
  | ({ type: 'phase' } & PhaseInfo)
  | { type: 'boxes'; boxes: Box[] }
  | { type: 'select'; paneId: string }
  | { type: 'context'; paneId: string; text: string }
  | { type: 'chat-reset'; paneId: string; items: Item[]; steps: number }
  | { type: 'chat-add'; paneId: string; added: { item: Item; after: string | null }[]; steps: number }
  | { type: 'drill'; drill: Drill | null }
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
}

interface Bridge {
  init(): Promise<Snapshot>;
  watch(paneId: string): void;
  term(paneId: string | null): void;
  termInput(paneId: string, data: string): void;
  send(paneId: string, text: string): Promise<Result>;
  sendChief(text: string): Promise<Result>;
  newBox(spec: BoxSpec): Promise<Result>;
  interrupt(paneId: string): Promise<Result>;
  action(paneId: string, kind: 'compact' | 'clear' | 'context'): Promise<Result>;
  rename(paneId: string, name: string): Promise<Result>;
  recent(): Promise<Recent[]>;
  switchBox(paneId: string, kind: 'model' | 'effort', value: string): Promise<Result>;
  remote(paneId: string): Promise<Result>;
  copy(text: string): void;
  attach(name: string, data: ArrayBuffer): Promise<Result>;
  choose(paneId: string, n: number): Promise<Result>;
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

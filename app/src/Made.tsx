import { useEffect } from 'react';
import type { Item, Turn } from './api';
import { Card } from './Card';
import { FileRow, LinkRow, Section } from './Turn';
import { MadeIcon } from './icons';
import './live.css';

type Row = { key: string; say: string; link?: string; kind?: string; at: number };
type FileSum = Turn['files'][number] & { at: number };

export interface Made {
  prs: Row[];
  commits: Row[];
  drafts: Row[];
  outside: Row[];
  files: FileSum[];
  questions: { id: string; q: string; at: number }[];
}

const GH = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const STATE: Record<string, string> = { opened: 'open', ready: 'ready', merged: 'merged', closed: 'closed' };
const newest = <T extends { at: number }>(l: T[]) => l.sort((a, b) => b.at - a.at);

// Everything the session made, from each turn's facts: PRs with their
// newest state, commits, drafts, writes to other systems, files changed,
// and the questions it asked that are still open (open).
export function madeOf(items: Item[], open: { id: string; q: string }[]): Made {
  const prs = new Map<string, Row & { n?: number }>();
  const commits: Row[] = [];
  const drafts: Row[] = [];
  const outside: Row[] = [];
  const files = new Map<string, FileSum>();
  for (const it of items) {
    const t = it.turn;
    if (!t) continue;
    const at = it.ts ? Date.parse(it.ts) || 0 : 0;
    for (const g of t.git) {
      if (g.kind === 'commit') commits.push({ key: g.id + g.say, say: g.say, link: g.link, at });
      else if (g.kind in STATE || g.kind === 'pr') {
        const m = g.link ? GH.exec(g.link) : null;
        const n = g.n ?? (m ? Number(m[2]) : undefined);
        const key = n != null ? `#${n}` : g.link || g.say;
        const prev = prs.get(key);
        const repo = m ? m[1] : prev?.say.split(' · ')[1];
        prs.set(key, {
          key,
          n,
          say: n != null ? `PR ${n}${repo ? ` · ${repo}` : ''}` : g.say,
          link: g.link || prev?.link,
          kind: STATE[g.kind] || prev?.kind,
          at: Math.max(at, prev?.at ?? 0),
        });
      }
    }
    for (const o of t.outside) {
      const row = { key: o.id + o.say, say: o.say, link: o.link, kind: o.write === 'sent' ? 'sent' : undefined, at };
      (o.write === 'draft' ? drafts : outside).push(row);
    }
    for (const f of t.files) {
      const p = files.get(f.path);
      if (!p) files.set(f.path, { ...f, ids: [...f.ids], at });
      else {
        p.add += f.add;
        p.del += f.del;
        p.created = p.created || f.created;
        p.ids = [...p.ids, ...f.ids].slice(-50);
        p.at = at;
      }
    }
  }
  const atOf = (id: string) => {
    const it = items.find((i) => i.id === id);
    return it?.ts ? Date.parse(it.ts) || 0 : 0;
  };
  return {
    prs: newest([...prs.values()]),
    commits: newest(commits),
    drafts: newest(drafts),
    outside: newest(outside),
    files: newest([...files.values()]),
    questions: newest(open.map((q) => ({ ...q, at: atOf(q.id) }))),
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "Made in this box": one card with all of it, grouped by kind, newest
// first, each row opening its link, its change or its message.
export function MadeSheet({ name, paneId, made, onJump, onClose }: { name: string; paneId: string | null; made: Made; onJump: (id: string) => void; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', esc, true);
    return () => window.removeEventListener('keydown', esc, true);
  }, [onClose]);
  const m = made;
  const total = m.prs.length + m.commits.length + m.drafts.length + m.outside.length + m.files.length;
  const state = [m.prs.length ? plural(m.prs.length, 'PR', 'PRs') : '', m.files.length ? plural(m.files.length, 'file', 'files') : ''].filter(Boolean).join(' · ');
  return (
    <>
      <div className="scrim" onMouseDown={onClose} />
      <div className="made-sheet" role="dialog" aria-label={`Made in ${name}`}>
        <Card className="made-card" icon={<MadeIcon />} title={`Made in ${name}`} state={state || undefined} open>
          {m.prs.length > 0 && (
            <Section title="PRs">
              {m.prs.map((r) => (
                <LinkRow key={r.key} say={r.say} link={r.link} kind={r.kind} />
              ))}
            </Section>
          )}
          {m.commits.length > 0 && (
            <Section title="Commits">
              {m.commits.map((r) => (
                <LinkRow key={r.key} say={r.say} link={r.link} />
              ))}
            </Section>
          )}
          {m.drafts.length > 0 && (
            <Section title="Drafts">
              {m.drafts.map((r) => (
                <LinkRow key={r.key} say={r.say} link={r.link} />
              ))}
            </Section>
          )}
          {m.outside.length > 0 && (
            <Section title="Sent and changed elsewhere">
              {m.outside.map((r) => (
                <LinkRow key={r.key} say={r.say} link={r.link} kind={r.kind} />
              ))}
            </Section>
          )}
          {m.files.length > 0 && (
            <Section title="Files changed">
              {m.files.map((f) => (
                <FileRow key={f.path} f={f} paneId={paneId} />
              ))}
            </Section>
          )}
          {m.questions.length > 0 && (
            <Section title="Open questions">
              {m.questions.map((q) => (
                <button key={q.id + q.q} type="button" className="turn-row" title="Show it in the chat" onClick={() => onJump(q.id)}>
                  <span className="turn-say">{q.q}</span>
                </button>
              ))}
            </Section>
          )}
          {!total && !m.questions.length && <div className="made-none">Nothing made yet.</div>}
        </Card>
      </div>
    </>
  );
}

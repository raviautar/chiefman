import { useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Item, type StepDetail, type Turn, type TurnNow } from './api';
import { Card } from './Card';
import { Icon } from './icons';
import { Markdown, Unfolded } from './Markdown';
import './turn.css';

// How long a turn took: "37s", "4m", "1h 5m".
export function took(ms: number | null | undefined) {
  if (ms == null || !(ms >= 0)) return '';
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const Out = () => <Icon name="out" className="turn-out" />;

// The facts of the line; a failure count in red.
function Facts({ text }: { text: string }) {
  const parts = text.split(' · ');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i} className={/^\d+ failed$/.test(p) ? 'turn-bad' : undefined}>
          {i > 0 && ' · '}
          {p}
        </span>
      ))}
    </>
  );
}

// A change or an output, read from the box's log when he opens it.
function useDetail(paneId: string | null, ids: string[], on: boolean) {
  const [d, setD] = useState<StepDetail[] | null>(null);
  const key = ids.join(',');
  useEffect(() => {
    if (!on || d || !paneId) return;
    let live = true;
    api()
      .steps(paneId, ids)
      .then((r) => live && setD(r || []))
      .catch(() => live && setD([]));
    return () => {
      live = false;
    };
  }, [on, key, paneId]);
  return d;
}

function Diff({ text }: { text: string }) {
  return (
    <pre className="turn-pre diff">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('@@') ? 'hunk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : undefined}>
          {l || ' '}
        </span>
      ))}
    </pre>
  );
}

function Loading() {
  return <div className="turn-note">Loading…</div>;
}

export function FileRow({ f, paneId }: { f: Turn['files'][number]; paneId: string | null }) {
  const [open, setOpen] = useState(false);
  const d = useDetail(paneId, f.ids, open);
  const dir = f.path.slice(0, Math.max(0, f.path.length - f.name.length)).replace(/\/$/, '');
  return (
    <>
      <button type="button" className="turn-row" aria-expanded={open} title={f.path} onClick={() => setOpen(!open)}>
        <span className="turn-say mono">{f.name}</span>
        {dir && <span className="turn-dir">{dir.split('/').slice(-2).join('/')}</span>}
        <span className="turn-count">
          {f.created ? 'new · ' : ''}+{f.add} −{f.del}
        </span>
      </button>
      {open && (d ? d.some((x) => x.diff) ? d.map((x) => x.diff && <Diff key={x.id} text={x.diff} />) : <div className="turn-note">The change is no longer in the log.</div> : <Loading />)}
    </>
  );
}

export function LinkRow({ say, link, kind }: { say: string; link?: string; kind?: string }) {
  if (!link)
    return (
      <div className="turn-row still">
        <span className="turn-say">{say}</span>
        {kind && <span className="turn-kind">{kind}</span>}
      </div>
    );
  return (
    <button type="button" className="turn-row" title={link} onClick={() => api().openUrl(link)}>
      <span className="turn-say">{say}</span>
      {kind && <span className="turn-kind">{kind}</span>}
      <Out />
    </button>
  );
}

// A step, an agent or a background command: its words, and on a click what
// it printed, changed or reported, read from the log then.
function StepRow({ s, paneId, small = true, kind }: { s: { id: string; say: string; missed?: boolean; running?: boolean }; paneId: string | null; small?: boolean; kind?: string }) {
  const [open, setOpen] = useState(false);
  const d = useDetail(paneId, [s.id], open);
  const x = d && d[0];
  const label = s.running ? 'running' : s.missed ? "didn't work" : kind;
  return (
    <>
      <button type="button" className={'turn-row' + (small ? ' small' : '')} aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="turn-say">{s.say}</span>
        {label && <span className="turn-kind">{label}</span>}
      </button>
      {open &&
        (!d ? (
          <Loading />
        ) : x && x.running ? (
          <div className="turn-note">Still running.</div>
        ) : x && x.md && x.out ? (
          <div className="turn-md">
            <Markdown text={x.out} fold={false} />
          </div>
        ) : x && (x.out || x.diff) ? (
          x.diff ? (
            <Diff text={x.diff} />
          ) : (
            <pre className="turn-pre">{(x.cut ? `… ${x.cut} lines above\n` : '') + x.out}</pre>
          )
        ) : (
          <div className="turn-note">Nothing printed.</div>
        ))}
    </>
  );
}

function FailRow({ f, paneId, onAsk, canAsk }: { f: Turn['failed'][number]; paneId: string | null; onAsk: (text: string) => void; canAsk: boolean }) {
  const [all, setAll] = useState(false);
  const [asked, setAsked] = useState(false);
  const d = useDetail(paneId, [f.id], all);
  const x = d && d[0];
  return (
    <div className="turn-fail">
      <div className="turn-fail-top">
        <button type="button" className="turn-row bad" aria-expanded={all} title="Show all it printed" onClick={() => setAll(!all)}>
          <span className="turn-dot" aria-hidden="true" />
          <span className="turn-say">{f.say}</span>
        </button>
        <button
          type="button"
          className="wcard-btn turn-ask"
          disabled={!canAsk || asked}
          onClick={() => {
            setAsked(true);
            onAsk(`This failed: "${f.say}". Please fix it.`);
          }}
        >
          {asked ? 'Asked' : 'Ask it to fix'}
        </button>
      </div>
      {all && x?.cmd && <pre className="turn-pre cmd">{x.cmd}</pre>}
      {all ? (
        !d ? (
          <Loading />
        ) : x?.out ? (
          <pre className="turn-pre">{(x.cut ? `… ${x.cut} lines above\n` : '') + x.out}</pre>
        ) : (
          <div className="turn-note">Nothing more in the log.</div>
        )
      ) : (
        f.tail.length > 0 && <pre className="turn-pre">{f.tail.join('\n')}</pre>
      )}
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="turn-sec">
      <div className="turn-h">{title}</div>
      {children}
    </div>
  );
}

// The line of facts under a turn's last reply; a click opens what the turn
// did, by kind, so nothing is out of reach.
export function TurnCard({ item, paneId, onAsk, canAsk }: { item: Item; paneId: string | null; onAsk: (text: string) => void; canAsk: boolean }) {
  const [open, setOpen] = useState(false);
  const [rest, setRest] = useState(false);
  // Cmd+F on a place in this card opens it.
  const found = useContext(Unfolded) === item.id;
  useEffect(() => {
    if (!found) return;
    setOpen(true);
    setRest(true);
  }, [found]);
  const t = item.turn!;
  const writes = (w: string) => (w === 'draft' ? 'draft' : w === 'sent' ? 'sent' : undefined);
  return (
    <Card
      className="turn"
      done
      bare
      open={open}
      onOpen={setOpen}
      icon={<Icon name="steps" />}
      title={<Facts text={item.t} />}
      state={open ? took(t.ms) : undefined}
      hint={open ? undefined : 'What it did'}
    >
      {t.files.length > 0 && (
        <Section title="Files">
          {t.files.map((f) => (
            <FileRow key={f.path} f={f} paneId={paneId} />
          ))}
        </Section>
      )}
      {t.outside.length > 0 && (
        <Section title="Outside">
          {t.outside.map((o, i) => (
            <LinkRow key={o.id + i} say={o.say} link={o.link} kind={writes(o.write)} />
          ))}
        </Section>
      )}
      {t.git.length > 0 && (
        <Section title="Git">
          {t.git.map((g, i) => (
            <LinkRow key={g.id + i} say={g.say} link={g.link} />
          ))}
        </Section>
      )}
      {t.failed.length > 0 && (
        <Section title="Failed">
          {t.failed.map((f) => (
            <FailRow key={f.id} f={f} paneId={paneId} onAsk={onAsk} canAsk={canAsk} />
          ))}
        </Section>
      )}
      {!!t.agents?.length && (
        <Section title="Agents">
          {t.agents.map((a) => (
            <StepRow key={a.id} s={a} paneId={paneId} small={false} />
          ))}
        </Section>
      )}
      {!!t.background?.length && (
        <Section title="In the background">
          {t.background.map((b) => (
            <StepRow key={b.id} s={b} paneId={paneId} small={false} kind={b.kind === 'watch' ? 'watch' : undefined} />
          ))}
        </Section>
      )}
      {t.other.length > 0 && (
        <div className="turn-sec">
          <button type="button" className="turn-row turn-rest" aria-expanded={rest} onClick={() => setRest(!rest)}>
            <span className="turn-say">
              {t.other.length} other {t.other.length === 1 ? 'step' : 'steps'}
            </span>
            <Icon name="right" className={'wcard-fold' + (rest ? ' open' : '')} />
          </button>
          {rest && t.other.map((s) => <StepRow key={s.id} s={s} paneId={paneId} />)}
        </div>
      )}
    </Card>
  );
}

// "2m", "1h 5m": how long the turn has run.
function running(since: number | null) {
  if (!since) return '';
  const m = Math.floor((Date.now() - since) / 60000);
  if (m < 1) return '';
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// What the box does right now, in plain words, quiet grey with a soft pulse,
// and how long the turn has run ("Running the tests · 2m").
export function NowLine({ text, since }: { text: string; since?: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => tick((x) => x + 1), 15000);
    return () => clearInterval(t);
  }, [since]);
  const time = running(since ?? null);
  return (
    <div className="now rise" role="status" aria-live="polite">
      <span className="now-pulse" aria-hidden="true" />
      <span className="now-t">{text}</span>
      {time && <span className="now-time">· {time}</span>}
    </div>
  );
}

// A step that failed in the turn that runs: one red line, at once.
export function NowFailed({ now }: { now: TurnNow }) {
  return (
    <>
      {now.failed.map((f) => (
        <div key={f.id} className="now-failed rise" role="alert">
          <span className="turn-dot" aria-hidden="true" />
          Failed: {f.say}
        </div>
      ))}
    </>
  );
}

// The words of the line while it works: the newest step, else thinking.
export function nowText(now: TurnNow | null | undefined) {
  if (now?.say) return now.say;
  return now ? 'Thinking' : 'Working';
}

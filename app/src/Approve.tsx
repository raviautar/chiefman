import type { Menu } from './api';
import { Card, type CardButton } from './Card';
import { Markdown, More, useFold } from './Markdown';
import { PlanIcon, ShieldIcon } from './icons';
import './turn.css';
import './live.css';

// The options of Claude Code's permission question, by what they do. Yes
// allows once; "don't ask again" (or "allow all … this session") allows
// always; No denies. "Switch to auto mode" has no button here.
export function permOptions(menu: Menu) {
  const always = menu.options.find((o) => /don'?t ask again|allow all|always/i.test(o.label));
  const yes = menu.options.find((o) => /^yes\b/i.test(o.label) && o !== always && !/switch to|auto mode|bypass/i.test(o.label));
  const no = menu.options.find((o) => /^no\b/i.test(o.label));
  return { yes, always, no };
}

// Long text shows its first lines; Show all opens the rest.
function Folded({ text, mono, diff }: { text: string; mono?: boolean; diff?: boolean }) {
  const f = useFold();
  const lines = text.split('\n');
  const long = lines.length > 8 || text.length > 600;
  const body = diff ? (
    <pre className="turn-pre diff">
      {lines.map((l, i) => (
        <span key={i} className={l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : undefined}>
          {l || ' '}
        </span>
      ))}
    </pre>
  ) : mono ? (
    <pre className="turn-pre cmd">{text}</pre>
  ) : (
    <div className="ask-text">{text}</div>
  );
  return (
    <>
      <div ref={f.ref} className={'ask-fold' + (long && !f.open ? ' cut' : '')}>
        {body}
      </div>
      {long && <More open={f.open} onClick={f.toggle} />}
    </>
  );
}

// Claude Code's "Do you want to …?" as a card: what it asks to do in plain
// words, the command or the change, then Allow, Always allow and Deny.
// Enter allows and Esc denies while the message field is empty.
export function PermCard({ menu, busy, onPick, onDeny }: { menu: Menu; busy: boolean; onPick: (n: number) => void; onDeny: () => void }) {
  const p = menu.perm!;
  const { yes, always, no } = permOptions(menu);
  const buttons: CardButton[] = [
    { label: 'Deny', title: 'Esc', disabled: busy, onClick: () => (no ? onPick(no.n) : onDeny()) },
    ...(always ? [{ label: 'Always allow', title: always.label, disabled: busy, onClick: () => onPick(always.n) }] : []),
    ...(yes ? [{ label: 'Allow', main: true, title: 'Enter', disabled: busy, onClick: () => onPick(yes.n) }] : []),
  ];
  const file = !!p.body && !!p.diff;
  return (
    <Card className="ask-card rise" icon={<ShieldIcon />} title={p.say} state="asks you" tone="asks" buttons={buttons} fixed>
      {(p.note || p.what || p.body) && (
        <>
          {p.note && <div className="ask-note">{p.note}</div>}
          {p.what && (file ? <div className="ask-file">{p.what}</div> : <Folded text={p.what} mono />)}
          {p.body && <Folded text={p.body} diff={p.diff} mono />}
        </>
      )}
    </Card>
  );
}

// Claude Code's approval of a plan: the plan folded, Approve, and Keep
// planning. His words in the message field go back as what to change.
export function PlanCard({ menu, busy, onPick, onKeep }: { menu: Menu; busy: boolean; onPick: (n: number) => void; onKeep: () => void }) {
  const approve = menu.options.find((o) => /^yes\b/i.test(o.label)) || menu.options[0];
  const all = menu.plan || '';
  const lines = all.split('\n');
  const at = lines.findIndex((l) => l.trim());
  // Its first line, a heading or "Plan: …", is the card's title, not its body.
  const first = at < 0 ? '' : lines[at].trim();
  const titled = /^#+\s+/.test(first) || /^plan:\s*/i.test(first);
  const head = titled ? first.replace(/^#+\s*/, '').replace(/^plan:\s*/i, '') : '';
  const plan = titled ? lines.slice(at + 1).join('\n').trim() : all;
  const buttons: CardButton[] = [
    { label: 'Keep planning', title: 'Esc', disabled: busy, onClick: onKeep },
    ...(approve ? [{ label: 'Approve', main: true, title: approve.label, disabled: busy, onClick: () => onPick(approve.n) }] : []),
  ];
  return (
    <Card className="ask-card plan-card rise" icon={<PlanIcon />} title={head ? `Plan: ${head}` : 'Its plan'} state="asks you" tone="asks" buttons={buttons} fixed>
      {plan ? <PlanText text={plan} /> : <div className="ask-note">The plan shows in Terminal.</div>}
    </Card>
  );
}

function PlanText({ text }: { text: string }) {
  const f = useFold();
  const long = text.split('\n').length > 10;
  return (
    <>
      <div ref={f.ref} className={'plan-text' + (long && !f.open ? ' cut' : '')}>
        <Markdown text={text} fold={false} />
      </div>
      {long && <More open={f.open} onClick={f.toggle} />}
    </>
  );
}

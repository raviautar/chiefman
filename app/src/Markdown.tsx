import { Fragment, ReactNode } from 'react';
import { api } from './api';

const INLINE = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>]+)/g;

function link(href: string, text: ReactNode, key: number) {
  return (
    <a key={key} onClick={() => api().openUrl(href)} title={href}>
      {text}
    </a>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(s.slice(last, i));
    const t = m[0];
    if (t.startsWith('**')) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      out.push(link(mm[2], mm[1], k++));
    } else out.push(link(t, t, k++));
    last = i + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

function lines(ls: string[]) {
  return ls.map((l, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {inline(l)}
    </Fragment>
  ));
}

function block(par: string, key: number): ReactNode {
  const ls = par.split('\n');
  if (ls.every((l) => /^\s*[-*•]\s+/.test(l)))
    return (
      <ul key={key}>
        {ls.map((l, i) => (
          <li key={i}>{inline(l.replace(/^\s*[-*•]\s+/, ''))}</li>
        ))}
      </ul>
    );
  const num = /^\s*(\d+)[.)]\s+/;
  if (ls.every((l) => num.test(l) || /^\s{2,}\S/.test(l)) && num.test(ls[0])) {
    const items: string[] = [];
    for (const l of ls) {
      if (num.test(l)) items.push(l.replace(num, ''));
      else items[items.length - 1] += ' ' + l.trim();
    }
    return (
      <ol key={key} start={Number(num.exec(ls[0])![1])}>
        {items.map((l, i) => (
          <li key={i}>{inline(l)}</li>
        ))}
      </ol>
    );
  }
  if (ls.every((l) => /^\s*\|/.test(l))) return <pre key={key}>{par}</pre>;
  if (/^#{1,6}\s/.test(ls[0]))
    return (
      <Fragment key={key}>
        <h4>{inline(ls[0].replace(/^#+\s*/, ''))}</h4>
        {ls.length > 1 && <p>{lines(ls.slice(1))}</p>}
      </Fragment>
    );
  return <p key={key}>{lines(ls)}</p>;
}

export function Markdown({ text }: { text: string }) {
  const parts = text.split(/```[^\n]*\n?/);
  const out: ReactNode[] = [];
  let k = 0;
  parts.forEach((p, i) => {
    if (i % 2 === 1) {
      out.push(<pre key={k++}>{p.replace(/\n$/, '')}</pre>);
      return;
    }
    for (const par of p.split(/\n\s*\n/)) if (par.trim()) out.push(block(par.replace(/^\n+|\n+$/g, ''), k++));
  });
  return <>{out}</>;
}

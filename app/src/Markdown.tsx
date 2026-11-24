import { Fragment, ReactNode } from 'react';
import { api } from './api';

// Bold, code, links, then italics: a star or underscore pair that hugs its
// words, never one inside a word (snake_case, 2*3*4).
const INLINE =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s)<>]+|(?<![\w*])\*(?![\s*])(?:[^*\n]*[^\s*])?\*(?![\w*])|(?<![\w_])_(?![\s_])(?:[^_\n]*[^\s_])?_(?![\w_]))/g;

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
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k++}>{inline(t.slice(2, -2))}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      out.push(link(mm[2], mm[1], k++));
    } else if (t.startsWith('*') || t.startsWith('_')) out.push(<em key={k++}>{inline(t.slice(1, -1))}</em>);
    else out.push(link(t, t, k++));
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

const BULLET = /^(\s*)[-*•+]\s+/;
const NUM = /^(\s*)(\d+)[.)]\s+/;
const HEAD = /^#{1,6}\s/;
const ROW = /^\s*\|/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A line of three or more dashes, stars or underscores alone: a thin rule.
const RULER = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

// A list, nested by how far its lines are indented.
interface List {
  ordered: boolean;
  start: number;
  indent: number;
  items: { text: string; kids: List | null }[];
}

function listOf(ls: string[]): List {
  const stack: List[] = [];
  for (const l of ls) {
    const b = BULLET.exec(l);
    const n = b ? null : NUM.exec(l);
    const m = b || n;
    if (!m) {
      // A wrapped line belongs to the item above it.
      const top = stack[stack.length - 1];
      const li = top?.items[top.items.length - 1];
      if (li) li.text += ' ' + l.trim();
      continue;
    }
    const indent = m[1].length;
    while (stack.length > 1 && indent < stack[stack.length - 1].indent) stack.pop();
    let top = stack[stack.length - 1];
    const fresh = (): List => ({ ordered: !b, start: n ? Number(n[2]) : 1, indent, items: [] });
    if (!top) stack.push((top = fresh()));
    else if (indent > top.indent && top.items.length) {
      const parent = top.items[top.items.length - 1];
      if (!parent.kids) parent.kids = fresh();
      stack.push((top = parent.kids));
    }
    top.items.push({ text: l.slice(m[0].length), kids: null });
  }
  return stack[0];
}

function list(l: List, key: number | string): ReactNode {
  const items = l.items.map((it, i) => (
    <li key={i}>
      {inline(it.text)}
      {it.kids && list(it.kids, 'k')}
    </li>
  ));
  return l.ordered ? (
    <ol key={key} start={l.start}>
      {items}
    </ol>
  ) : (
    <ul key={key}>{items}</ul>
  );
}

// A table row's cells. A pipe inside code or after a backslash is text.
function cells(row: string) {
  let s = row.trim().replace(/^\|/, '');
  if (/[^\\]\|$/.test(s)) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let code = false;
  for (const c of s) {
    if (c === '`') code = !code;
    if (c === '|' && !code && !cur.endsWith('\\')) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(ls: string[], key: string): ReactNode {
  const align = cells(ls[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : undefined));
  const head = cells(ls[0]);
  const body = ls.slice(2).map(cells);
  return (
    <div key={key} className="md-table">
      <table>
        <thead>
          <tr>
            {head.map((c, i) => (
              <th key={i} style={{ textAlign: align[i] }}>
                {inline(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, j) => (
            <tr key={j}>
              {head.map((_h, i) => (
                <td key={i} style={{ textAlign: align[i] }}>
                  {inline(r[i] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// A paragraph can hold a sentence, then a list or a table right under it:
// each run of lines renders as what it is.
function block(par: string, key: number): ReactNode[] {
  const runs: { k: 'p' | 'list' | 'table' | 'h' | 'hr'; ls: string[] }[] = [];
  for (const l of par.split('\n')) {
    const last = runs[runs.length - 1];
    const k = HEAD.test(l)
      ? 'h'
      : RULER.test(l)
        ? 'hr'
        : ROW.test(l)
        ? 'table'
        : BULLET.test(l) || NUM.test(l) || (last?.k === 'list' && /^\s{2,}\S/.test(l))
          ? 'list'
          : 'p';
    if (last && last.k === k && k !== 'h' && k !== 'hr') last.ls.push(l);
    else runs.push({ k, ls: [l] });
  }
  return runs.map((r, i) => {
    const k = `${key}.${i}`;
    if (r.k === 'h') return <h4 key={k}>{inline(r.ls[0].replace(/^#+\s*/, ''))}</h4>;
    if (r.k === 'hr') return <hr key={k} />;
    if (r.k === 'list') return list(listOf(r.ls), k);
    if (r.k === 'table') return r.ls.length > 1 && RULE.test(r.ls[1]) ? table(r.ls, k) : <pre key={k}>{r.ls.join('\n')}</pre>;
    return <p key={k}>{lines(r.ls)}</p>;
  });
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
    for (const par of p.split(/\n\s*\n/)) if (par.trim()) out.push(...block(par.replace(/^\n+|\n+$/g, ''), k++));
  });
  return <>{out}</>;
}

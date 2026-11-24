import { createContext, Fragment, ReactNode, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Check } from './icons';
import './blocks.css';

// Where a picture named in a reply opens large: the chat's lightbox. With
// none, it opens in the Mac's default app.
export const PictureOpen = createContext<((url: string) => void) | null>(null);

// A picture on this Mac, served by the app (only from his home folder and
// the temporary folders).
export const picUrl = (p: string) => 'cm-att://p/' + encodeURIComponent(p);
const PIC = /\.(png|jpe?g|gif|webp)$/i;

// A full local file path: a home or system folder, then at least one more
// part, and maybe a line number.
const PATH_SRC = String.raw`(?:~|\/(?:Users|home|private|tmp|var|opt|Volumes|Applications|Library|usr|etc|root|mnt|srv))(?:\/[\w.@%+-]+)+\/?(?::\d+(?::\d+)?)?`;
const PATH = new RegExp('^' + PATH_SRC + '$');
const URL_ONLY = /^https?:\/\/\S+$/;

// Bold, struck, code, links, bare links and local paths, then italics: a
// star or underscore pair that hugs its words, never one inside a word
// (snake_case, 2*3*4).
const INLINE = new RegExp(
  [
    String.raw`\*\*(?=\S)(?:[^*\n]|\*(?!\*))+?\*\*`,
    String.raw`__(?=\S)[^_\n]+?__`,
    String.raw`~~(?=\S)[^~\n]+?~~`,
    '`[^`\\n]+`',
    String.raw`\[[^\]\n]+\]\([^)\s]+\)`,
    String.raw`https?:\/\/[^\s<>)]+`,
    String.raw`(?<![\w/.~:-])` + PATH_SRC,
    String.raw`(?<![\w*])\*(?![\s*])(?:[^*\n]*[^\s*])?\*(?![\w*])`,
    String.raw`(?<![\w_])_(?![\s_])(?:[^_\n]*[^\s_])?_(?![\w_])`,
  ].join('|'),
  'g',
);

// Check marks and arrows come from the system font, so they sit on the line
// as the letters around them do. A ticket key never breaks at its dash.
const SYM = /^[✓✔✗✘✕→←↳]$/;
const SPLIT = /([✓✔✗✘✕→←↳]|\b[A-Z][A-Z0-9]{1,9}-\d+\b)/;

function text(s: string, key: number): ReactNode {
  if (!SPLIT.test(s)) return s;
  return (
    <Fragment key={key}>
      {s.split(SPLIT).map((p, i) =>
        i % 2 ? (
          <span key={i} className={SYM.test(p) ? 'sym' : 'nowrap'}>
            {p}
          </span>
        ) : (
          p
        ),
      )}
    </Fragment>
  );
}

// A site's own name where it has one, else its address without "www.".
function siteOf(u: URL) {
  const h = u.host.replace(/^www\./, '');
  if (h === 'github.com') return 'GitHub';
  if (h === 'gitlab.com') return 'GitLab';
  if (h.endsWith('.atlassian.net')) return u.pathname.startsWith('/wiki') ? 'Confluence' : 'Jira';
  if (h === 'notion.so' || h.endsWith('.notion.site')) return 'Notion';
  if (h === 'slack.com' || h.endsWith('.slack.com')) return 'Slack';
  if (h === 'linear.app') return 'Linear';
  if (h === 'docs.google.com') return 'Google Docs';
  if (h === 'drive.google.com') return 'Google Drive';
  if (h === 'figma.com') return 'Figma';
  return h;
}

const KEY = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/;
// Long ids say nothing to him.
const ID = /^(?:[0-9a-f]{20,}|[0-9a-f-]{32,}|[A-Za-z0-9_-]{28,})$/i;
const ACTION = /^(edit|view|index\.html?|overview|preview|show|latest)$/i;

// A path part as a page name: "watering-guide" reads "watering guide", a
// Notion page drops its id, a file keeps its name.
function pageName(seg: string) {
  let s = seg;
  try {
    s = decodeURIComponent(seg.replace(/\+/g, ' '));
  } catch {}
  s = s.replace(/[-_ ]?[0-9a-f]{32}$/i, '');
  if (!/\.\w{1,5}$/.test(s)) s = s.replace(/[-_+]+/g, ' ');
  return s.trim();
}

// The most telling part of an address: a ticket key, "PR 1548",
// "run 19876543210", a file name or the page name.
function tellingPart(u: URL, site: string) {
  const segs = u.pathname.split('/').filter(Boolean);
  if (site === 'GitHub' || site === 'GitLab') {
    const s = segs.filter((x) => x !== '-');
    const [owner, repo, kind, a, b] = s;
    if ((kind === 'pull' || kind === 'merge_requests') && a) return 'PR ' + a;
    if (kind === 'issues' && a) return 'issue ' + a;
    if (kind === 'actions' && a === 'runs' && b) return 'run ' + b;
    if (kind === 'pipelines' && a) return 'pipeline ' + a;
    if (kind === 'jobs' && a) return 'job ' + a;
    if (kind === 'commit' && a) return 'commit ' + a.slice(0, 7);
    if ((kind === 'blob' || kind === 'tree') && s.length > 4) {
      const line = /^#L(\d+)/.exec(u.hash);
      return s[s.length - 1] + (line ? ':' + line[1] : '');
    }
    if (kind === 'releases' && s.length > 3) return 'release ' + s[s.length - 1];
    if (repo && !kind) return repo;
    if (owner && !repo) return owner;
  }
  const key = KEY.exec(u.pathname + u.search + u.hash);
  if (key) return key[1];
  if (site === 'Slack') return segs[0] === 'archives' ? (segs[2] ? 'message' : 'channel') : '';
  if (site === 'Google Docs') return ({ document: 'document', spreadsheets: 'sheet', presentation: 'slides', forms: 'form' } as Record<string, string>)[segs[0]] || '';
  for (let i = segs.length - 1; i >= 0; i--) {
    const s = pageName(segs[i]);
    if (!s || ID.test(segs[i]) || ACTION.test(s)) continue;
    return s;
  }
  return '';
}

// A bare address as its site and its most telling part, never the whole
// address; the whole one shows on hover.
export function shortUrl(href: string) {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return href;
  }
  const site = siteOf(u);
  let part = tellingPart(u, site);
  if (part.length > 42) part = part.slice(0, 40).trimEnd() + '…';
  return part ? `${site} · ${part}` : site;
}

// A local path as its file name, with its line number.
export function fileName(p: string) {
  const m = /^(.*?)(:\d+(?::\d+)?)?$/.exec(p)!;
  const dir = m[1].endsWith('/');
  const body = m[1].replace(/\/+$/, '');
  return body.slice(body.lastIndexOf('/') + 1) + (dir ? '/' : '') + (m[2] || '');
}

function link(href: string, label: ReactNode, key: number, short = false) {
  return (
    <a key={key} className={short ? 'short' : undefined} onClick={() => api().openUrl(href)} title={href}>
      {label}
    </a>
  );
}

// A local path: a picture shows as itself and opens large; any other file
// shows its name and opens in the Mac's default app.
function LocalFile({ p }: { p: string }) {
  const show = useContext(PictureOpen);
  const [bad, setBad] = useState(false);
  const bare = p.replace(/(?::\d+){1,2}$/, '');
  if (PIC.test(bare) && !bad)
    return (
      <button type="button" className="md-pic" title={p} onClick={() => (show ? show(picUrl(bare)) : api().openPath(bare))}>
        <img src={picUrl(bare)} alt={fileName(p)} onError={() => setBad(true)} />
      </button>
    );
  return (
    <code
      className="md-file open"
      title={p}
      role="button"
      tabIndex={0}
      onClick={() => api().openPath(bare)}
      onKeyDown={(e) => e.key === 'Enter' && api().openPath(bare)}
    >
      {fileName(p)}
    </code>
  );
}

function file(p: string, key: number) {
  return <LocalFile key={key} p={p} />;
}

// A PR, ticket or CI run: its site and its telling part, else null.
function kindOf(href: string) {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const site = siteOf(u);
  const part = tellingPart(u, site);
  return /^(PR|issue|run|pipeline|job) \S+$/.test(part) || /^[A-Z][A-Z0-9]{1,9}-\d+$/.test(part) ? { site, part } : null;
}

// A line that is only such a link, bare or with its own words.
const CARD_LINE = /^\s*(?:\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|<?(https?:\/\/[^\s<>`]+?)>?|`(https?:\/\/[^`\s]+)`)\s*$/;
function cardOf(line: string) {
  const m = CARD_LINE.exec(line);
  if (!m) return null;
  const href = m[2] || m[3] || m[4];
  const k = kindOf(href);
  return k ? { href, label: m[1] && m[1] !== href ? m[1] : '', ...k } : null;
}

// A small card for that link: the telling part, the words around it, the site.
function LinkCard({ href, site, part, title }: { href: string; site: string; part: string; title: string }) {
  return (
    <a className="md-card" title={href} onClick={() => api().openUrl(href)}>
      <span className="md-card-part">{part}</span>
      {title && <span className="md-card-title">{inline(title, true)}</span>}
      <span className="md-card-site">{site}</span>
    </a>
  );
}

// A line that ends with a picture's path ("The new page: ~/shot.png").
const PIC_LINE = new RegExp('^(.*?)\\s*`?((?<![\\w/.~:-])' + PATH_SRC + ')`?\\s*$');

// A paragraph's lines, with a link card for each line that is only a PR,
// ticket or run link, and a picture under a line that ends with its path. A
// line just before a card that only leads to it ("The pull request:")
// becomes the card's words.
function para(ls: string[], key: number) {
  const out: ReactNode[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length) out.push(<p key={out.length}>{lines(run)}</p>);
    run = [];
  };
  for (const l of ls) {
    const c = cardOf(l);
    const pic = c ? null : PIC_LINE.exec(l);
    if (!c && !(pic && PIC.test(pic[2].replace(/(?::\d+){1,2}$/, '')))) {
      run.push(l);
      continue;
    }
    if (pic) {
      if (pic[1].trim()) run.push(pic[1]);
      flush();
      out.push(
        <div key={out.length} className="md-pics">
          <LocalFile p={pic[2]} />
        </div>,
      );
      continue;
    }
    let title = c!.label;
    const prev = run[run.length - 1];
    if (!title && prev && /:\s*$/.test(prev) && prev.length <= 90 && !/https?:|\//.test(prev)) {
      title = prev.replace(/:\s*$/, '').trim();
      run.pop();
    }
    flush();
    out.push(<LinkCard key={out.length} href={c!.href} site={c!.site} part={c!.part} title={title} />);
  }
  flush();
  return <Fragment key={key}>{out}</Fragment>;
}

// noLinks: inside a link's own text, where a second link cannot go.
function inline(s: string, noLinks = false): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of s.matchAll(INLINE)) {
    const i = m.index ?? 0;
    let t = m[0];
    const bare = /^(https?:|~|\/)/.test(t);
    // A sentence's full stop or comma after a bare link or path is text.
    if (bare) t = t.replace(/[.,;:!?'"]+$/, '');
    if (bare && noLinks) continue;
    if (i > last) out.push(text(s.slice(last, i), k++));
    if (t.startsWith('**') || t.startsWith('__')) out.push(<strong key={k++}>{inline(t.slice(2, -2), noLinks)}</strong>);
    else if (t.startsWith('~~')) out.push(<del key={k++}>{inline(t.slice(2, -2), noLinks)}</del>);
    else if (t.startsWith('`')) {
      const c = t.slice(1, -1).trim();
      if (!noLinks && URL_ONLY.test(c)) out.push(link(c, shortUrl(c), k++, true));
      else if (PATH.test(c)) out.push(file(c, k++));
      else out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    } else if (t.startsWith('[')) {
      const mm = /^\[([^\]]+)\]\((.+)\)$/.exec(t)!;
      const [, label, href] = mm;
      // An anchor or another kind of address: its words only.
      if (noLinks || (/^(#|[a-z][\w+.-]*:)/i.test(href) && !/^https?:\/\//.test(href))) out.push(<Fragment key={k++}>{inline(label, true)}</Fragment>);
      else if (/^https?:\/\//.test(href)) out.push(label === href ? link(href, shortUrl(href), k++, true) : link(href, inline(label, true), k++));
      // A link to a file in the project: its own words, the path on hover;
      // a file name in the code style.
      else
        out.push(
          /\s/.test(label) ? (
            <span key={k++} title={href}>
              {inline(label, true)}
            </span>
          ) : (
            <code key={k++} className="md-file" title={href}>
              {label}
            </code>
          ),
        );
    } else if (t.startsWith('*') || t.startsWith('_')) out.push(<em key={k++}>{inline(t.slice(1, -1), noLinks)}</em>);
    else if (t.startsWith('http')) out.push(link(t, shortUrl(t), k++, true));
    else out.push(file(t, k++));
    last = i + t.length;
  }
  if (last < s.length) out.push(text(s.slice(last), k++));
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
const HEAD = /^(#{1,6})\s/;
const ROW = /^\s*\|/;
const RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A line of three or more dashes, stars or underscores alone: a thin rule.
const RULER = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)/;
const QUOTE = /^\s{0,3}>/;
// A line that starts with a check mark or an arrow.
const MARK = /^\s*([✓✔✗✘✕→↳›])\s+/;
const TASK = /^\[([ xX])\]\s+/;

// A list, nested by how far its lines are indented. An item can hold more:
// an indented paragraph or code block after an empty line.
interface List {
  ordered: boolean;
  start: number;
  indent: number;
  items: { text: string; kids: List | null; more: Block[] }[];
}

type Block =
  | { k: 'p'; ls: string[] }
  | { k: 'h'; n: number; t: string }
  | { k: 'hr' }
  | { k: 'list'; l: List }
  | { k: 'table'; ls: string[] }
  | { k: 'code'; lang: string; t: string }
  | { k: 'quote'; bs: Block[]; ls: string[] }
  | { k: 'marks'; ls: string[] };

function listOf(ls: string[]): List {
  const stack: List[] = [];
  for (const l of ls) {
    const b = BULLET.exec(l);
    const n = b ? null : NUM.exec(l);
    const m = b || n;
    if (!m) {
      // A wrapped line belongs to the item above it; a PR, ticket or run
      // link on its own line under it is its card.
      const top = stack[stack.length - 1];
      const li = top?.items[top.items.length - 1];
      if (li && cardOf(l)) li.more.push({ k: 'p', ls: [l.trim()] });
      else if (li) li.text += ' ' + l.trim();
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
    top.items.push({ text: l.slice(m[0].length), kids: null, more: [] });
  }
  return stack[0];
}

// A run of lines with no empty line in it: a sentence, then a list or a
// table right under it, each renders as what it is.
function runs(par: string[]): Block[] {
  const rs: { k: 'p' | 'list' | 'table' | 'h' | 'hr' | 'marks'; ls: string[] }[] = [];
  for (const l of par) {
    const last = rs[rs.length - 1];
    const k = HEAD.test(l)
      ? 'h'
      : RULER.test(l)
        ? 'hr'
        : ROW.test(l)
          ? 'table'
          : BULLET.test(l) || NUM.test(l) || (last?.k === 'list' && /^\s{2,}\S/.test(l))
            ? 'list'
            : MARK.test(l) || (last?.k === 'marks' && /^\s{2,}\S/.test(l))
              ? 'marks'
              : 'p';
    if (last && last.k === k && k !== 'h' && k !== 'hr') last.ls.push(l);
    else rs.push({ k, ls: [l] });
  }
  return rs.map((r): Block => {
    if (r.k === 'h') return { k: 'h', n: HEAD.exec(r.ls[0])![1].length, t: r.ls[0].replace(/^#+\s*/, '').replace(/\s+#+\s*$/, '') };
    if (r.k === 'hr') return { k: 'hr' };
    if (r.k === 'list') return { k: 'list', l: listOf(r.ls) };
    if (r.k === 'table' && r.ls.length > 1 && RULE.test(r.ls[1])) return { k: 'table', ls: r.ls };
    if (r.k === 'table') return { k: 'code', lang: '', t: r.ls.join('\n') };
    if (r.k === 'marks') {
      // A wrapped line belongs to the mark line above it.
      const ls: string[] = [];
      for (const l of r.ls) MARK.test(l) || !ls.length ? ls.push(l.trim()) : (ls[ls.length - 1] += ' ' + l.trim());
      return { k: 'marks', ls };
    }
    return { k: 'p', ls: r.ls };
  });
}

// The blocks of a text, line by line: code blocks, quotes (with lists and
// paragraphs inside), and runs of text between empty lines.
function parse(src: string): Block[] {
  const ls = src.replace(/\r\n?/g, '\n').split('\n');
  const out: Block[] = [];
  const lastList = () => {
    const b = out[out.length - 1];
    return b && b.k === 'list' ? b.l.items[b.l.items.length - 1] : null;
  };
  let i = 0;
  while (i < ls.length) {
    const l = ls[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const f = FENCE.exec(l);
    if (f) {
      const close = new RegExp(`^\\s*${f[2][0]}{${f[2].length},}\\s*$`);
      const cut = new RegExp(`^ {0,${f[1].length}}`);
      const body: string[] = [];
      for (i++; i < ls.length && !close.test(ls[i]); i++) body.push(ls[i].replace(cut, ''));
      i++;
      const code: Block = { k: 'code', lang: f[3].toLowerCase(), t: body.join('\n') };
      // Indented under a list item after an empty line: part of that item.
      const li = f[1].length >= 2 ? lastList() : null;
      if (li) li.more.push(code);
      else out.push(code);
      continue;
    }
    if (QUOTE.test(l)) {
      const inner: string[] = [];
      while (i < ls.length) {
        if (QUOTE.test(ls[i])) {
          inner.push(ls[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
          continue;
        }
        // An empty line between two quoted lines keeps them one quote.
        let j = i;
        while (j < ls.length && !ls[j].trim()) j++;
        if (j > i && j < ls.length && QUOTE.test(ls[j])) {
          inner.push('');
          i = j;
          continue;
        }
        break;
      }
      out.push({ k: 'quote', bs: parse(inner.join('\n')), ls: inner });
      continue;
    }
    const par: string[] = [];
    while (i < ls.length && ls[i].trim() && !FENCE.test(ls[i]) && !QUOTE.test(ls[i])) par.push(ls[i++]);
    // Indented after an empty line, under a list: more of its last item.
    const li = /^\s{2,}\S/.test(par[0]) ? lastList() : null;
    if (li) li.more.push(...runs(par));
    else
      for (const b of runs(par)) {
        // A list that goes on after an empty line stays one list.
        const prev = out[out.length - 1];
        if (b.k === 'list' && prev?.k === 'list' && prev.l.ordered === b.l.ordered && (!b.l.ordered || b.l.start === prev.l.start + prev.l.items.length))
          prev.l.items.push(...b.l.items);
        else out.push(b);
      }
  }
  return out;
}

// About how many lines a text takes at the bubble's reading width.
const WIDTH = 66;
const height = (ls: string[]) => ls.reduce((n, l) => n + (l.trim() ? Math.ceil(l.length / WIDTH) : 0), 0);

// Long parts open on a click and close again. The chat holds still: it does
// not jump to its end when a part opens below where he reads.
export function useFold() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  useLayoutEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    const el = ref.current;
    const chat = el?.closest('.chat');
    if (!el || !chat) return;
    const top = el.getBoundingClientRect().top - chat.getBoundingClientRect().top;
    if (!open && top < 0) chat.scrollTop += top - 12;
    chat.dispatchEvent(new Event('scroll'));
  }, [open]);
  return {
    open,
    ref,
    toggle: () => {
      moved.current = true;
      setOpen((o) => !o);
    },
  };
}

export function More({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button className="md-more" onClick={onClick} aria-expanded={open}>
      {open ? 'Show less' : 'Show all'}
    </button>
  );
}

// A code block: monospace on a quiet ground, scrolls sideways, a Copy button
// on hover. A long one shows its start. A questions block never folds.
function Code({ lang, t, fold }: { lang: string; t: string; fold: boolean }) {
  const f = useFold();
  const [copied, setCopied] = useState(false);
  const ls = t.split('\n');
  const long = fold && lang !== 'questions' && ls.length > 15;
  const cut = long && !f.open;
  return (
    <div className={'md-code' + (cut ? ' cut' : '')} ref={f.ref}>
      <pre>{cut ? ls.slice(0, 10).join('\n') : t}</pre>
      <button
        className="md-copy"
        onClick={() => {
          api().copy(t);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {long && <More open={f.open} onClick={f.toggle} />}
    </div>
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

// A table scrolls sideways inside the bubble; a long one shows its first rows.
function Table({ ls, fold }: { ls: string[]; fold: boolean }) {
  const f = useFold();
  const align = cells(ls[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : undefined));
  const head = cells(ls[0]);
  const all = ls.slice(2).map(cells);
  const long = fold && all.length > 12;
  const body = long && !f.open ? all.slice(0, 8) : all;
  return (
    <div className="md-table-wrap" ref={f.ref}>
      <div className="md-table">
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
                  // A long cell keeps a readable width; the table scrolls instead.
                  <td key={i} style={{ textAlign: align[i], minWidth: (r[i] ?? '').length > 28 ? '14em' : undefined }}>
                    {inline(r[i] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {long && <More open={f.open} onClick={f.toggle} />}
    </div>
  );
}

// A quote: one block with a thin rule at its left, the same type. A long one
// shows its start.
function Quote({ bs, ls, fold }: { bs: Block[]; ls: string[]; fold: boolean }) {
  const f = useFold();
  const long = fold && height(ls) > 10;
  return (
    <div className="md-quote-wrap" ref={f.ref}>
      <blockquote className={long && !f.open ? 'cut' : undefined}>{bs.map((b, i) => block(b, i, fold))}</blockquote>
      {long && <More open={f.open} onClick={f.toggle} />}
    </div>
  );
}

function ListView({ l, fold }: { l: List; fold: boolean }) {
  const items = l.items.map((it, i) => {
    const card = cardOf(it.text);
    if (card)
      return (
        <li key={i}>
          <LinkCard href={card.href} site={card.site} part={card.part} title={card.label} />
          {it.kids && <ListView l={it.kids} fold={fold} />}
          {it.more.map((b, j) => block(b, j, fold))}
        </li>
      );
    const t = TASK.exec(it.text);
    const done = !!t && t[1] !== ' ';
    return (
      <li key={i} className={t ? 'task' + (done ? ' done' : '') : undefined}>
        {t && (
          <span className="task-box" role="img" aria-label={done ? 'Done' : 'To do'}>
            {done && <Check size={11} />}
          </span>
        )}
        {t ? <span className="task-t">{inline(it.text.slice(t[0].length))}</span> : inline(it.text)}
        {it.kids && <ListView l={it.kids} fold={fold} />}
        {it.more.map((b, j) => block(b, j, fold))}
      </li>
    );
  });
  return l.ordered ? <ol start={l.start}>{items}</ol> : <ul>{items}</ul>;
}

function block(b: Block, key: number, fold: boolean): ReactNode {
  switch (b.k) {
    case 'h':
      return (
        <div key={key} role="heading" aria-level={b.n} className={'md-h md-h' + Math.min(b.n, 3)}>
          {inline(b.t)}
        </div>
      );
    case 'hr':
      return <hr key={key} />;
    case 'list':
      return <ListView key={key} l={b.l} fold={fold} />;
    case 'table':
      return <Table key={key} ls={b.ls} fold={fold} />;
    case 'code':
      return <Code key={key} lang={b.lang} t={b.t} fold={fold} />;
    case 'quote':
      return <Quote key={key} bs={b.bs} ls={b.ls} fold={fold} />;
    case 'marks':
      return (
        <div key={key} className="md-marks">
          {b.ls.map((l, i) => {
            const m = MARK.exec(l)!;
            return (
              <div key={i} className="md-mark-row">
                <span className="md-mark">{m[1]}</span>
                <span>{inline(l.slice(m[0].length))}</span>
              </div>
            );
          })}
        </div>
      );
    default:
      return para(b.ls, key);
  }
}

// fold: long parts show their start with Show all, and a reply of over about
// 40 lines shows its start and its last paragraph, which may ask something.
// Inside a folded reply the parts do not fold again: one Show all opens all.
export function Markdown({ text, fold = true }: { text: string; fold?: boolean }) {
  const blocks = useMemo(() => parse(text), [text]);
  const f = useFold();
  const long = fold && blocks.length > 1 && height(text.split('\n')) > 40;
  if (!long) return <div className="md">{blocks.map((b, i) => block(b, i, fold))}</div>;
  return (
    <div className="md">
      <div className={'md-body' + (f.open ? '' : ' cut')} ref={f.ref}>
        {blocks.slice(0, -1).map((b, i) => block(b, i, false))}
      </div>
      <More open={f.open} onClick={f.toggle} />
      {block(blocks[blocks.length - 1], blocks.length - 1, fold)}
    </div>
  );
}

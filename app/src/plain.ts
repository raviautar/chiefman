import { shortUrl } from './Markdown';

// Markdown as the plain words a reader sees: no marks, no code ticks, a
// link as its words (a bare address as its short form), on one line.
export function plainText(s: string) {
  return s
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_m, u) => shortUrl(u))
    .replace(/(^|[\s(])(https?:\/\/[^\s)]+)/g, (_m, pre, u) => pre + shortUrl(u))
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|\[[ xX]\]\s+|[-*+]\s+|\d{1,3}[.)]\s+)/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?=$|[^\w*])/g, '$1$2')
    .replace(/(^|[^\w_])_([^_\n]+)_(?=$|[^\w_])/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// "Waiting · the CI run"; words that start with their own wait verb keep it
// once: "Wait for CI" reads "Waiting for CI". past: "Waited …".
export function waitingOn(on: string, past = false) {
  const verb = past ? 'Waited' : 'Waiting';
  const m = /^\s*(?:wait(?:ing|ed|s)?|watch(?:ing|es)?|poll(?:ing|s)?)\s+(for|on|until|till)\s+(\S[\s\S]*)$/i.exec(on);
  if (m) return `${verb} ${m[1].toLowerCase()} ${m[2]}`;
  return `${verb} · ${on.replace(/^\s*(?:wait(?:ing|ed|s)?)\s+/i, '')}`;
}

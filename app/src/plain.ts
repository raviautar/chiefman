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

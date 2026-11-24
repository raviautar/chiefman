// Every message the app sends carries one short mark, so the box knows it
// came from chiefman. A hook in the user's Claude settings sees the mark and
// gives the box chiefman's rules for its reply. The app strips the mark
// again before it shows the message.

const MARK = '[sent from chiefman]';

// The skill buttons take the mark as their arguments; any other slash
// command, and a "!" shell line, goes as typed.
const SKILL_CMD = /^\/(?:[\w.-]+:)?(plain-english|drill-down)$/;

function markText(text) {
  const t = String(text);
  if (t.startsWith('!')) return t;
  if (t.startsWith('/')) return SKILL_CMD.test(t) ? `${t} ${MARK}` : t;
  return `${t}\n${MARK}`;
}

// The text without its marks, and whether it had one.
function unmark(text) {
  const t = String(text);
  if (!t.includes(MARK)) return { text: t, app: false };
  const out = t
    .replace(/[ \t]*\[sent from chiefman\][ \t]*/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+$/, '');
  return { text: out, app: true };
}

// What the box reads with a marked message. Short and plain: the reply
// shape, and what the app cannot show.
const RULES = `This message was sent from the chiefman app. "${MARK}" is the app's mark, not his words: never quote it or pass it on.

How chiefman shows your reply:
- Only your text shows, as simple Markdown: paragraphs, lists, bold, inline code, code blocks, links. Tables show as plain text. Tool calls and file changes do not show, so say in words what you did.
- When he must settle something, end the reply with one block in this shape, one line per question, and ask nothing outside it:

\`\`\`questions
1. Merge the fix now? [yes/no]
2. Which environment first? [one: dev | stage]
3. Which checks should run? [any: api | ui | load]
\`\`\`

- [yes/no] shows a check mark. [one: ...] shows choices; he picks one. [any: ...] shows check boxes; he picks several. Options are a few words each, 2 to 6 of them.
- Number the questions 1, 2, 3. In a drill-down list, a line keeps its own number.
- He answers in one message, by number: "1. yes", "3. api, ui". He can always answer in his own words instead.
- A reply that asks nothing has no block.
- A message without the mark was typed in the terminal: answer it as you normally would, with no block.`;

module.exports = { MARK, markText, unmark, RULES };

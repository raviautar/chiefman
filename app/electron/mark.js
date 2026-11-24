// Every message the app sends carries one short mark, so the box knows it
// came from chiefman. A hook in the user's Claude settings sees the mark and
// gives the box chiefman's rules for its reply. The app strips the mark
// again before it shows the message.

const MARK = '[sent from chiefman]';

// The skill buttons take the mark as their arguments; any other slash
// command, and a "!" shell line, goes as typed.
const SKILL_CMD = /^\/(?:[\w.-]+:)?(plain-english|explain|drill-down)$/;

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

// What the box reads with its first marked message in a session, and again
// after a compact: the reply shape and every block the app turns into a
// card (blocks.js reads them). Short and plain.
const F = '```';
const RULES = `This message came from the chiefman app. "${MARK}" is its mark, not his words: never quote it. A message without it comes from the terminal: no blocks there. These rules hold all session.

chiefman shows only your text, as Markdown: tables, quotes, task lists and code too. Tool calls and file changes do not show, so say what you did. A PR, ticket or CI run link alone on its line shows as a card, a picture's full path as the picture.

End a reply with the blocks that fit; each becomes a card. Keep each line's shape: an unreadable block shows as plain text.

${F}questions
1. Merge the fix now? [yes/no]
2. Which environment first? [one: dev* | stage]
3. Which checks should run? [any: api | ui | load]
4. What should the report be called? [text]
5. Which plan? [one]
   - small*
     done today
   - full
${F}
* marks your recommended choice; a line indented under a choice is its note. 2 to 6 short choices. A drill-down line keeps its number. He answers "1. yes", "3. api, ui" or in his words. Ask nothing outside the block.

${F}actions
Post it
Hold
${F}
Up to four buttons, the main one first; a click sends its words. Use it instead of 'Reply "X" to ...'.

${F}draft slack
The text he posts himself.
${F}
After "draft": where it goes (slack, ticket, pr, email).

${F}your turn
Sign in to the console | https://example.com/login
Approve the deploy
${F}
Steps only he can do. He answers "done" or "done, not 2".

${F}result
passed 41
failed 2
login | times out after 30s
export | the file is empty
https://example.com/runs/123
${F}

${F}waiting
the CI run on the fix | https://example.com/runs/124
then merge it
${F}
What you wait on, then what you do next.

Only your first reply in a session ends with a title, two or three lower-case words for the work:
${F}title
weather-radar-notes
${F}`;

// What every later marked message carries.
const SHORT = `Sent from the chiefman app: reply by the chiefman rules given earlier in this session. Never quote "${MARK}".`;

// The rules' version, one up whenever RULES, SHORT or the hook's script
// change: every copy of the app shares one hook file, and only a copy with
// newer rules rewrites it.
const RULES_VERSION = 35;

module.exports = { MARK, markText, unmark, RULES, SHORT, RULES_VERSION };

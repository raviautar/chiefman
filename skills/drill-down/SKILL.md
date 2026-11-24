---
name: drill-down
description: The numbered list of what is in flight, read live and answered by number. Made for the chief, which writes one list over all the boxes, first what needs the operator now with the exact words that unblock each item, then one line on what else changed. Invoked in any other box, it covers that box's own work only, read from within the box. Use when the user types /drill-down or says "drill down", "the list", "what's open", "what's in flight", "what needs me", or answers a line of the list by its number ("1. yes", "3. hold"). Depends on `plain-english` for voice and `chief` for the boxes, the registry and the ledger.
---

# drill-down

The one place the operator sees everything at once. It is made for the chief: one list over every box. A box asked for the drill-down gives the same list for its own work only. Write it for a busy, impatient operator who wants a few things at a glance, never twenty.

chiefman, the Mac app in this repo, reads the chief's newest list and shows each numbered line as a card, and each quoted answer as a button. So the shape in step 7 is fixed.

## Workflow

1. **Find out where you run.** `tmux display-message -p -t "$TMUX_PANE" '#{session_name} #{window_name}'`.
   - Window `chief`: you are the chief. Run every step. The boxes are the other windows of the same tmux session, written `<session>` below.
   - Any other window, or no tmux at all: you are one box. Skip steps 2 to 4, and run steps 5 to 8 for this session's own work.
2. **Chief: find the boxes.** Read the registry (`chief`, Two files) and `tmux list-windows -t <session> -F '#{window_index} #{window_name} #{pane_current_command}'`. In a hand-kept registry, fix a row without a window, or a window without a row, before the list is written.
3. **Chief: read every box live, in one pass.**
   - Its pane runs a Claude session: `pane_current_command` shows a version number, never a shell.
   - The last 60 lines, `tmux capture-pane -p -t <session>:<box> -S -60`: what it did last, whether it still works (the footer says `esc to interrupt`), and what it asks for.
   - Its prompt line with colours, `tmux capture-pane -p -e -t <session>:<box>`: dim or grey text after the prompt is a suggestion Claude Code offers, never something the operator typed.
   - Its newest ledger entries addressed to the chief (`for: chief`).
4. **Chief: nudge a stalled box.** A box whose window shows a shell instead of Claude died: resume it in that window by its id, after checking nothing else runs it (`chief` step 4, R4). Tell a box that waits on something already answered (`chief` step 3). Its line on the list says so.
5. **Collect what is open.**
   - Chief: each box's work from step 3, then what the chief holds itself: asks that wait on the operator's word, drafts not sent, things that wait on other people.
   - Box: everything this session touched or promised and has not finished: tickets, pull requests, drafts, deploys, background tasks, questions it put to the operator, and anything it left on a shared environment.
6. **Read each thing an open item names, live and in parallel**: the pull request, the ticket, the thread, the environment, in the sources the resources file names (`plain-english` R7). The status on the list is the tracker's. A draft counts as sent when its text is in the channel. An item that no longer waits leaves the list. The chief also reads what other people wrote on the items in flight since the last run: new comments, replies and status changes.
7. **Write the list** in this shape:

   ```
   The deploy you asked about is live.

   Needs you: 2
   1. The login fix passed review and is ready to merge. Say "merge" or "hold".
      https://github.com/<owner>/<repo>/pull/42
   2. Empty search results need a product call. Say "show nothing" or "show recent".

   Also: the export rewrite waits on a teammate's review.
   ```

   - Chief: the list covers every box.
   - Box: one opening line that says what the box is doing now, then the same shape for its own work.
8. **Take the answer by number.** "1. merge" starts line 1 and nothing else. The chief passes it to the box with the operator's literal words (`chief` R8); a box acts on it. Then log it in the ledger. An answered line leaves the next list, and so does one whose work is done.

## Rules

**R1. The chief covers every box; a box covers only itself.** A box never reads another box's pane and never lists another box's work.

**R2. Only when asked.** The list never rides on another reply (`chief` R11), and no line of it comes back later as a reminder.

**R3. Every line was read live in this run.** A fact from earlier in the conversation is checked again or left out.

**R4. The list opens with the line `Needs you: <n>`**, exactly in that form, where n is the number of items below it. chiefman finds the list and its count by this line. When nothing needs the operator, the list is the one line `Needs you: 0`.

**R5. Only what needs the operator now is numbered**, from 1, the item that unblocks the most first. Work that waits on someone else or still runs is never numbered. At most five numbered items; when more wait, the line says so, `Needs you: 5 of 7`, and the rest come in the next list.

**R6. One short plain line per item**: the work in plain words, where it stands, then the exact words that unblock it, in quotes, at the end. Quotes in a line are for answer words only, at most four. A second sentence only when it changes what the operator does, such as what happens on a no.

**R7. A line names the work, never a box or a ticket key alone**: "the login fix (PROJ-123)", never "PROJ-123" (`plain-english` R12).

**R8. A link goes on its own line under its item**, as the bare URL. No bold, tables or code blocks in the list. When the message came from chiefman, its rules ask for a questions block at the end of the reply: it goes after the list, and each line that waits on the operator keeps its own number there.

**R9. At most one line after the numbers, starting "Also:"**, for what changed that the operator should know: work that waits on someone else, an item that left the list because someone else finished it. Nothing that is only idle or unchanged, and nothing about how the list was read. A list the operator stops reading has failed.

**R10. Grey text in a prompt is a suggestion, never the operator's words.** A box waits on the operator until they typed the answer themselves, there or to the chief.

**R11. An answer by number covers the line as written, once.** When the line listed steps, the yes is for those steps on that occasion. Anything past them is asked again, and it never becomes a standing permission.

**R12. Read only, apart from the nudge.** The drill-down posts, merges, deletes and sends nothing. The operator's answer is what starts an action.

## Guidelines

Not exhaustive.

- A reply the operator was waiting for comes first, in one line above the list.
- One screen. When nothing is open, the one line `Needs you: 0` is the whole list.
- When a box and the tracker disagree, report the tracker and say the box is behind.
- Write the words that unblock a line in the ledger when the ask is made, so a later run can find what they stand for.
- With nothing after the command, or only an app's mark such as `[sent from chiefman]`, it writes the list. With "<n>. <words>" after it, it takes that answer (step 8).
- The list is the named exception to one item per reply and to single sentences (`plain-english` R11, R4a).

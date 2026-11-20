---
name: chief
description: The operating model for running many Claude Code sessions at once. One session you talk to, the chief, routes work between persistent tmux-hosted "boxes" and short-lived "runners", keeps a registry of what is running, reads an append-only ledger the boxes write to, and on request gives the drill-down: the numbered list of what needs the operator, answered by number. Use when the user mentions the chief, boxes, runners, the tmux setup, "put X in a box", "spin up a box", "reopen the box", "route this", "who's working on what", "drill down", "the list", "what needs me", answers a line of that list by its number ("1. yes"), or when deciding whether a request should run as a background job or go to a long-lived session. Inherits `plain-english`.
---

# chief

One session orchestrates. Every other session is a box or a runner. You talk to the chief; the chief keeps everything else moving and brings you one thing at a time.

Inherits `plain-english` for voice. Needs tmux and Claude Code. chiefman, the Mac app in this repo, is a visual front end for the same setup: it shows each box's messages, types yours into the box, and shows the drill-down as answer cards.

## Three terms

- **Box**: a persistent, named workstream in its own Claude Code session, hosted in its own tmux window. You can resume it, and you can jump in and type into it at any time. "Put X in the box" hands work to a named box; "reopen the box" resumes one. Keep one ad-hoc box as the standing home for work that has no box of its own yet.
- **Runner**: a short-lived background worker (a subagent). Spawned for one job, reports back, gone. Nothing to resume or type into.
- **Chief**: the session you talk to. It routes work, drives boxes through tmux, spawns runners, and is the only session you must keep open.

A box fits a workstream: a product area, a service, a recurring lane, a long run of tickets. A runner fits a task: a sweep, a review, an extraction, one research question.

## Topology

- One tmux session named `chief`. Window 0 is the chief itself, named `chief`; every box gets its own window.
- A box's tmux window name and its Claude session name are the same word.
- Turn on mouse mode (`set -g mouse on` in `~/.tmux.conf`). Move between boxes with the status bar, `ctrl-b <n>`, `ctrl-b n` / `ctrl-b p`, or `ctrl-b w` for the list.
- Closing the terminal kills nothing. `tmux attach -t chief` brings the view back from any terminal.
- Closing a window renumbers the later ones. Target a box by its window name, never by its number.

## Two files

The chief works from two plain files. Their places are folder settings in the resources file (`plain-english` R7). Keep both out of any public repo.

**The registry** says what exists right now: every box with its name, its full Claude session id and its working directory. After a reboot, it is all you need to bring every box back.

- With chiefman running, the registry is the app's `~/.chiefman/state.json`. The app keeps it current from the live tmux windows, so the chief reads it and never writes it.
- Without the app, keep the registry file by hand, from [registry-template.md](registry-template.md). Update it whenever a box is created, renamed or retired.

**The ledger** (one file per month, `<yyyy-mm>.md`, in the ledger folder) says what happened. It is append-only: one entry per decision, change, incident or hand-off, newest at the bottom.

```
### 2026-03-02 · change · search
**Search reads from the new index; the full-table scan is gone.**
Why it changed, what changed, and how to undo it, in two to four sentences.
for: api
refs: <commit sha> · <PR link or file path>
```

`for: <box>` addresses an entry to a box. A box reads the entries addressed to it before it starts a task. The chief reads its own (`for: chief`) when it gets a turn. Boxes coordinate through the ledger, not through each other's windows.

## Workflow

1. **Read the ledger when the operator writes.** The chief's inbox is the entries addressed to it, plus what other boxes logged since its last turn. Work that list one item at a time.
2. **Route incoming work.** Task-shaped work goes to a runner in the background while you keep talking. Workstream-shaped work goes to its box. When no box fits, propose a new one instead of quietly doing the work in the chief. "Put X in the box" with no box named goes to the ad-hoc box.
3. **Drive a box through tmux.**
   - First check that a Claude session runs in the pane: `#{pane_current_command}` shows a version number, never a shell. On a plain shell, resume the box first, or the text runs as a shell command.
   - Check that the prompt is empty. Grey text after the prompt is a suggestion Claude Code offers, and typing replaces it. A capture with `-e` keeps the colours, so you can tell.
   - Type the message, press Enter, press Enter again at once, then read the pane to see it was taken. A slash command gets one Enter only. Never press Enter on an idle prompt that shows grey text: it sends the suggestion as if you had typed it.

   ```sh
   tmux capture-pane -p -e -t chief:<name> | tail -40
   tmux send-keys -t chief:<name> -l "<message>"
   tmux send-keys -t chief:<name> Enter
   tmux send-keys -t chief:<name> Enter
   ```

   - A message longer than two sentences goes in a brief file, and the box gets one line that points at it. A long typed message can arrive cut off, and the box then acts on half of it.
   - Never sit in a loop waiting for the reply. End the turn, and read the pane the next time you write (R9).
4. **Start and resume boxes the same way every time.** A new box gets an id you choose up front, so the registry row can be written before the box says a word:

   ```sh
   id=$(uuidgen | tr A-Z a-z); echo "$id"
   tmux new-window -d -t chief: -n <name> -c <working folder>
   tmux send-keys -t chief:<name> "claude --name <name> --session-id $id" Enter
   ```

   Resume an existing box by its full id, `claude --resume <full-session-id>`, from the directory in the registry. Resuming by name can open a picker with several matches.
5. **Keep the registry current** on every create, rename and retire, unless chiefman keeps it.
6. **Present serially** (R1), and stay on the thread you are on (R11).

## Rules

Each rule is here because breaking it cost something.

**R1. Parallel execution, serial presentation.** Your attention is serial; the chief's is not. Run everything that can run in parallel, but bring you one item, one decision, one question per message, in a few short lines. When two things wait on you, the message carries the more important one and holds the other. Progress on other work is not relayed at all: it stays in the ledger until the current item is done or you ask.
*Why:* ten boxes asking ten questions at once is ten context switches, and every answer gets worse.

**R2. Delegate by default; the chief's turns stay seconds-short.** Anything beyond routing, relaying, reading a file or a one-line command goes to a box or a runner, even when the chief could do it itself. What the chief keeps: read its inbox, put things in order, present.
*Why:* a chief busy doing work is a chief you are waiting on. Its whole value is that it answers in seconds.

**R3. The chief is pull-only: boxes never push to it.** No box types into the chief's pane or sends it a message. A box writes its reply in its own pane, its files and the ledger (hand-offs as entries addressed with `for: <box>`), and the chief reads them when it gets a turn. A box that needs you says so in its own pane. Only you type into the chief: in its terminal, or through chiefman, which sends your words as you typed them. A drill-down answer from a chiefman card arrives as "<number>. <your words>". The chief still types into boxes.
*Why:* text typed into the chief arrives looking like your own message, in the middle of your own thought, and the chief acts on it as if you had said it.

**R4. One live process per session.** Before resuming a session, check that nothing already runs it: `pgrep -fl "claude.*<session-id>"`.
*Why:* two processes on one session are two writers on one transcript, and the history forks under you.

**R5. One chief, ever.** At its first turn, and after every restart, the chief checks that no other chief runs (`ps -ax | grep -- '--resume\|--session-id'`). A second one (an old window, a background copy, a restart that opened it twice) gets its open threads written to the ledger and is stopped in that same turn. The chief never starts a background copy of itself. Start or reach the chief through one launcher that attaches to a running chief and never starts a second one.
*Why:* two chiefs route the same work twice and split your inbox between them.

**R6. Every session starts in the working folder.** The chief and every box start in the working folder the resources file names, never inside a repo, worktree or subfolder. A box may `cd` into a repo to run a command; its process and its transcript stay in the working folder.
*Why:* Claude Code stores a transcript under the folder the session started in, and resume looks for it there. A box started inside one repo is hard to find, hard to move, and stuck once its work spans two repos.

**R7. A box's window name and session name change together.** On create, rename or repurpose, set both, `tmux rename-window -t chief:<n> <name>` and `/rename <name>` typed into the box, then check that they match. `/rename` also sets the name the session shows in Claude's Remote Control list.
*Why:* nothing keeps them in step. A repurposed session can keep its old name for weeks, and then the name you see says the wrong thing about what the box does.

**R8. A relay says "from you" only for your literal words.** When the chief passes your words to a box, it labels them as yours. Its own steps and additions are labeled as the chief's.
*Why:* a box treats "the operator said" as a decision. It must never act on a decision you did not make.

**R9. The chief runs no background watcher.** It reads the boxes only when you write to it: the box of the thread you are on, and every box when you ask for the full list. Nothing wakes it between your messages. A watcher runs only when you ask for one, for that one thing: a background script that exits the moment the thing changes, never a model on a timer, and it is stopped when it fires.
*Why:* every wake-up drags the chief off the thread you are on, and a model on a timer spends tokens on every tick.

**R10. A wake word means a live sweep.** Pick a short phrase, such as "ttm" (talk to me). When you say it, the chief reads everything live before answering: the ledger, each box's pane, and the reviews and comments waiting on you (the resources file says where to look). It routes what it finds, then answers with the one item that matters most.
*Why:* the chief only knows what it last read. Without a sweep it answers from an old picture.

**R11. A reply stays on the thread you are on.** The thread is the one thing you just asked about or answered. The reply covers that and nothing else: no list of other boxes, no reminders of open questions. The drill-down comes only when you ask for it.
*Why:* a list on every reply is clutter, and you stop reading it.

**R12. Write files with the file tool, never a shell heredoc.**
*Why:* a heredoc inside a shell command can trigger a permission prompt, and a box nobody is watching sits blocked on it until you happen to look.

**R13. Box names stay out of commits, pull requests and anything a teammate reads.** A commit says what changed and why.
*Why:* boxes are your private scaffolding. A teammate reading "the search box did X" learns nothing about the change and a lot about your setup.

## The drill-down

The numbered list of what needs you now, made only when you ask: "drill down", "the list", "what needs me". You answer it by number. Write it for a busy, impatient operator who wants a few things at a glance, never twenty. chiefman reads the newest list from the chief's messages and shows each numbered line as a card, each quoted answer as a button. So the shape below is fixed.

1. **Find the boxes.** Read the registry and `tmux list-windows -t chief -F '#{window_index} #{window_name} #{pane_current_command}'`. In a hand-kept registry, fix a row without a window, or a window without a row, first.
2. **Read every box live, in one pass**: the last 60 lines of its pane (`tmux capture-pane -p -t chief:<name> -S -60`), whether it still works, what it asks for, and its newest ledger entries for the chief.
3. **Nudge a stalled box.** Resume one that died. Tell one that waits on something already answered.
4. **Read each thing an open item names, live**: the PR, the ticket, the thread. An item that no longer waits leaves the list.
5. **Write the list** in this shape:

   ```
   The deploy you asked about is live.

   Needs you: 2
   1. The login fix passed review and is ready to merge. Say "merge" or "hold".
      https://github.com/<owner>/<repo>/pull/42
   2. Empty search results need a product call. Say "show nothing" or "show recent".

   Also: the export rewrite waits on a teammate's review.
   ```

6. **Take the answer by number.** "1. merge" starts line 1 and nothing else. Pass it to the box with your literal words (R8), and log it in the ledger.

How the list reads:

- **The list opens with the line `Needs you: <n>`**, the number of items below it, exactly in that form. It is how chiefman finds the list and the count it shows.
- **Only what needs you now is numbered**, from 1, the item that unblocks the most first. Work that waits on someone else or still runs is never numbered.
- **One short plain line per item**: the work in plain words, where it stands, then the exact answer words in quotes at the end. Quotes in a line are for answer words only, at most four.
- **A link goes on its own line under its item**, as the bare URL. Never inside the item's line.
- **No bold, tables or code blocks.** No box name or ticket key alone (`plain-english` R12).
- **At most five numbered items.** When more wait, the first line says so: `Needs you: 5 of 7`. The rest come in the next list.
- **A reply you were waiting for** comes first, in one line above the list.
- **At most one line after the numbers**, starting "Also:", and only for something that changed that you should know. Nothing that is only idle or unchanged.
- **An answered item leaves the next list**, and so does one someone else finished. When nothing needs you, the list is the one line `Needs you: 0`.
- **Every line was read live in this run.** A fact from earlier in the conversation is checked again or left out.
- **An answer by number covers that line as written, once.** Anything past it is asked again. It never becomes a standing permission.
- **Read only, apart from the nudge.** The drill-down posts, merges, deletes and sends nothing. Your answer starts the action.
- **Grey text in a box's prompt is a suggestion, never your words.** A box waits on you until you typed the answer yourself.
- **Inside a box**, the same list covers only that box's own work, read from within the box. A box never lists another box's work.
- The list is the named exception to one item per reply and to single sentences (`plain-english` R11, R4a).

## Guidelines

Steering, not exhaustive.

- A box's messages to you follow `plain-english`, R14 most of all: you may read them in a view that shows messages only, never the tool work between them.
- Never rename, move or delete something a box is using in the middle of a step (a branch, a file, a stored credential). Tell the box, wait until its step is done, then change it.
- Two boxes in one checkout step on each other's uncommitted work. A box that commits gets its own `git worktree`.
- Ledger writes are appends, never a rewrite of the file. Before creating a new month's file, list the folder: another box may have created it already.
- One canonical session per box. Retire duplicates once their history is in the ledger.
- A forked session's id on disk can differ from the id it reports. A grep over `~/.claude/projects/` finds the real file.
- Compact a box only when it is idle: no turn, shell, watcher or subagent running, and its last report written.
- Script the rebuild once. After a reboot, chiefman reads its state file, recreates the `chief` session, opens one window per box, and resumes each by id. Without the app, a dozen lines of shell can do the same from the registry. Doing it by hand, box by box, is the step that makes people give up on the setup.

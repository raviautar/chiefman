---
name: goal-alignment
description: Co-write a plain-english brief (Problem, Implementation, Verification) for a feature or fix, settle every decision the code cannot settle at the level the operator needs to know about, prove the prerequisites live, and compile the /goal condition that Claude Code runs as a self-correcting loop. Fast checks (api, unit, logs) stay in the loop; the end-to-end check through the real UI comes after the loop, as its own step. Use when the user says "align the goal", "build a goal", "write the brief", "write the piv", "design the proof", "compile the condition", "next round", or "re-aim". Inherits `plain-english`; explains code in `explain` pacing.
---

# goal-alignment

Design and preparation, no implementation. Output: one brief (`piv-template.md`, one file per round), one compiled `/goal` condition, and a stack proven ready. Everything decided or proven here is something the loop never stops for; the loop should open with nothing left to decide.

## Workflow

1. **Frame the round.** New feature or fix-round. A fix-round names the prior brief and the one thing it left open, and scopes to that. When the task arrives without context, gather it first: the ticket, the chats, the docs, the code. Work out Problem with the operator: what is broken, how to observe it, the current flow with the break marked.
2. **Explore, then infer.** Read the code the change touches until you can say from first principles how it works today and where the change goes. Settle every decision the code can settle (R2).
3. **Walk the remaining decisions**, one per turn (R3). Each arrives with the smallest thing that makes it decidable, a recommendation, and the fact that decides it. Resolve it, then pick the next yourself. The Implementation diagram grows as decisions settle.
4. **Design the fast checks** with the operator: plain-english bullets of what must be true, one per turn with a recommendation, covering the happy path and the edges that apply. Each is something the loop can check in seconds (an api call, an api test, a log line); the worker chooses how. User-visible, end-to-end behavior is not designed here; it is checked after the loop (R6).
5. **Prove the prerequisites live.** Name the target environment once; every check runs against it. Health per touched service; fixtures captured, tokens minted, every check shown runnable. Anything red is fixed now or the round does not start.
6. **Hand over.** Only when the operator has approved the brief's index (Problem in one line, each decision, each check) and nothing is open. Re-run the prerequisites, then give the compiled condition in a code block (template at the bottom of `piv-template.md`). Stop; do not implement. When the loop is green, the end-to-end check follows: driven through the real UI, scoped with the operator, proven with screenshots and the backend signal.

## Rules

**R1. The brief is written piece by piece, each piece written down only after the operator has understood and approved it.** Problem, then each decision, then each check: discussed in chat first, written to the file once they say it holds. The one exception is an explicit ask to one-shot the brief; then write the whole thing in one pass, choosing the most straightforward, lowest-complexity approach that solves the problem, and hand it over for review.

**R2. A decision reaches the operator only when the code cannot settle it and it is one they need to know about.** Everything else is inferred and not asked; it appears in Implementation only where the loop needs it to build correctly.

**R3. One decision per turn, with a recommendation; the operator decides.** The remaining backlog is never shown as a menu. Settled decisions and the directions rejected are written into Implementation so nobody argues them again.

**R4. The operator understands each step as it happens.** Never ask them to restate or say it back; keep each step small enough that their approval or their question is a real signal. Explain unfamiliar code in `explain` pacing. If they skip a walk on purpose, the brief records the override.

**R5. One round, one fresh brief file**, `{TICKET}_{NAME}_round{N}.md` in the briefs folder the resources file names, carrying forward only what is still open. Save it even for a same-session goal; the file survives compaction and the worker re-reads it.

**R6. Only fast checks live in this brief.** A check passes only by being run for real with its command and result in the transcript; a proxy (byte-identity, "structurally equivalent", a prior result) is a separate check, never a pass. User-visible, end-to-end checks come after the loop is green, never hold it up, and end in a short report built from those runs.

**R7. Prerequisites must pass before the loop starts, and they are not proofs.** They prove the stack is ready, not that the feature works. Re-run them right before the loop starts.

**R8. The critic gate is a fresh-context review**: a subagent that did not write the code reviews the diff, and posts every finding in the transcript, each fixed or rebutted. Never aim it at the failure the round already fears.

**R9. A round that opens a PR is done only when every PR's checks have finished green and its body says what changed and how it was checked.** Pending is not green; a red check is fixed or flagged, never explained away as pre-existing; a PR opened after an earlier one reported done carries the same duty.

**R10. The condition is the prerequisite check, a done-clause of proofs only, and a turn cap.** It points at the brief file for specifics. Problem and Implementation stay out; the prerequisites stay out of the done-clause; no process rules (no promise tokens, no slicing, no subagent choreography). Always "or stop after {N} turns"; cap 4,000 characters.

**R11. The loop's last message is a plain-english close of at most three sentences**, after the proofs: what now works, what needs the operator.

**R12. Diagrams come after the prose in each section and never into chat as mermaid.**

## Guidelines

- **What the operator needs to know about**, usually: how two components talk to each other, a behavior a caller or user will see, a data shape other code depends on, a trade-off with a real cost, anything hard to reverse. A naming choice, an internal helper, an order of operations the code already implies: infer it.
- **Making a decision decidable.** Show the smallest thing it turns on: a snippet, a small diagram, one line of the ticket, whichever lets them decide without reading further. Never a dump of every model or class.
- **Sparring stance.** Research the codebase and prior art before asking anything the code could answer. Challenge their proposals; check claims, theirs and yours, against the code. Work one topic to conclusion before opening the next; when a topic closes, say the conclusion in one line.
- **Edges worth a check**, when they apply: another tenant or user must not see it; empty, oversized, or malformed input; a dependency down; two operations at once; the second occurrence, not only the first. Say which you cut and why.
- **Cheapest feedback first.** Order the checks so the loop learns fastest; keep the diff minimal and cut edits the round does not need.
- **How /goal runs.** A small model judges the condition again after every turn, from the transcript alone; it cannot run tools or read files, and it will accept a claimed success that was never shown, which is why every proof must appear in the conversation. `/goal` alone shows status, `/goal clear` stops, it survives `--resume`, headless via `claude -p`. Same session for PR-sized work; fresh when the work spans days.
- **Between rounds.** An achieved goal means the grader signed off, not that the feature works; review it with a fresh context. The second hand-fix on a shipped feature is the signal to open a new round rather than keep poking.

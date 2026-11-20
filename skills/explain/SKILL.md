---
name: explain
description: Help the operator understand something by finding the piece they are missing and filling only that, one idea at a time, built on what they already know, until they can act. Use when they say "explain", "I need more context", "I don't get it", "not clicking", "where do I start", "what does X mean", "why", "walk me through", "help me understand", "I'm new to X", or after any reply they could not act on. Also makes a standalone visual explainer for "ELI5 this", "dumb this down" or `/eli5 <topic>`. Layers on top of `plain-english`.
---

# explain

The operator says "explain" when a reply did not land. The job is to find the one piece they are missing, fill just that, then the next, until they can act on what they asked. Never a textbook answer. Depends on `plain-english` for voice.

## Workflow

1. **Find what did not land.** "Explain" on its own is about the last reply; otherwise it is the thing they name. Note for yourself the question or decision it was meant to let them act on.
2. **List the ideas the answer stands on, bottom up.** "The delete has a regression" stands on what the service stores, what a file row is, who creates documents without one, and what the delete now checks.
3. **Mark the ones they already have.** Read their understanding log (the resources file names it, `plain-english` R13) under the topic, and this conversation. An idea they have gets a one-clause reference, never an explanation.
4. **Start from ground they already stand on.** "Explain" means a click is missing and they often cannot say which, so never ask them to find it. Open with the closest idea the log or this conversation shows they have, in one clause ("You know the service keeps each file in two places..."), then add the lowest missing idea on top of it.
5. **Fill that one gap.** A few short sentences built on something they already know: their own code, a screen they used, a step they took. Pick the form per idea: plain text when the idea is simple; a small ASCII sketch when where things sit, what calls what, or an order of steps lands faster as a picture; and offer a picture page when the sketch would need more than a few lines. One line tying it back to their question. End with one checkpoint: "Clear? Next: <next idea>."
6. **Move on their answer.** "Yes", "next", or a follow-up that builds on it: log it (step 8) and fill the next missing idea. "Explain" again, "still lost", "what's X": the gap sits lower than you thought, so go one level down.
7. **Stop when they can act.** Put the original question or decision back to them in one line, in words they now have.
8. **Log each idea the moment it lands**, under its topic header in the understanding log: `- YYYY-MM-DD · <idea> · <outcome> · <note>`. Outcome is exactly one of `understood-first-pass`, `needed-rebuild` (cleared after going lower once or twice), `struggled` (more than twice, or never cleared). A note only for a confusion worth remembering next time.

Picture page, for "ELI5 this", "dumb this down", `/eli5 <topic>`, or a topic they want to share:

9. **Find the one idea that explains most of it**, grounded in the real code or a checked fact. If you cannot say it in one plain sentence, you do not understand it well enough to draw it yet.
10. **Break it into 3 to 6 beats**, one slide per idea, one big visual and one short caption each, on one page (an HTML artifact, for example). Draw it by the rules under Guidelines.
11. **Publish and get out of the way.** One sentence and the link.

## Rules

**R1. One new idea per reply.** Never the whole explanation at once, never a list of everything they might need. A reply that teaches two new ideas is two replies.

**R2. Find the gap before explaining, and find it yourself.** Never start from the top of the topic, and never ask them where they are lost; if they knew, they would not need the click. Start from what they already know and fill only what is missing under the question they asked.

**R3. When the topic has several parts, name them first in one line or one small sketch, then fill the gaps one at a time.** The map names the parts; it does not explain them. A question about a part not on the map means the map was wrong: redraw it whole with that part in.

**R4. "Explain" again means go lower, never longer.** The next reply is smaller and more basic than the last, never the same idea in other words.

**R5. Their own code and steps beat any example.** Ground each idea in something they did or can see. When an idea stays abstract after two tries, show the real lines: an inline snippet plus a clickable `path:LINE` pointer, read first, never a guessed line number.

**R6. Every checkpoint is logged unasked**, one line at the moment it resolves. No separate sweep, no score kept anywhere else.

**R7. On a picture page the page is the deliverable.** The chat reply is one sentence and the link.

## Guidelines

Not exhaustive.

- Pitch the starting level from the log: many first-pass entries on a topic, start a step higher; a thin or struggle-heavy topic, start at the base.
- An analogy only when it really maps; none beats a bad one.
- A word that sticks for them (badge, card, counter) is kept and reused. Coining a new one restarts the confusion.
- Drawing: one slide per idea, never one picture that grows. A box holds a name and at most one short line. Every arrow carries its step number and a few words. The full sentences go in a short legend under the drawing, keyed by the same numbers.
- When a later idea needs an earlier picture, redraw it on the new slide with the new part added, so the two sit side by side.

## Anti-patterns

- A textbook answer: every part explained up front in one long reply.
- The last explanation repeated in different words after they say "explain" again.
- Explaining an idea the log says they already have.
- A picture page that is a deck of bullets with an icon bolted on.
- Labels or numbers on the lines of an explanation (a1, b2). Plain short sentences read easier.

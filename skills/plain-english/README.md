# plain-english

**The voice.** The foundation skill the others build on: how the agent talks to you.

One idea: you read everything the agent sends, so every reply is written at high-school level, in short sentences with one fact each, and a sentence stays only if cutting it would change what you do. Around that sit the rules that make an agent easy to trust: be honest about what was not checked, bring one thing per reply, keep code out of chat unless you ask and link it when shown, read the files before asking, and treat "less text" as a change that holds for the rest of the session.

It also keeps private details out of the skills. Hosts, trackers, page ids and customer names live in your own `.agents/resources.mdc`; start from [resources-template.mdc](resources-template.mdc).

`explain`, `goal-alignment`, `chief` and `drill-down` inherit this skill. See [SKILL.md](SKILL.md).

# agenda

A Claude Code mod: one pane with a context gauge and handoff-and-clear, a live list of subagents with
collapsible one-sentence task summaries, open questions pulled from each reply, items left undone (with
"do it" buttons), and a scratch pad of notes kept across sessions and injected into the system prompt.

## Install

```
/plugin install agenda --marketplace djbrandl/claude-mods
```

Answer `y` to add the marketplace, pick the user scope. Then `/agenda` opens the pane, `/note <text>` adds a
note, `/handoff` writes a handoff and clears.

Config: `extractorModel` (default `haiku`) is the model that scans replies and summarises subagent work.

## Develop

```
claude --plugin-dir <this folder>
claude plugin validate .
claude plugin test .
```

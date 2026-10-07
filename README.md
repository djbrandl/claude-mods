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

## The one setting

The installer asks for a **Summary model**. The pane runs a small background Claude call after each reply to
pull out open questions and unfinished work, and to write the one-line subagent summaries. This setting picks
which Claude does that chore. `haiku` (the default) is cheap, fast and enough; it has no effect on which model
answers you in the main chat. Change it with `/plugin configure agenda` only if the one-liners read badly.

## Develop

```
claude --plugin-dir <this folder>
claude plugin validate .
claude plugin test .
```

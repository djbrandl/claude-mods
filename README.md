# agenda

A Claude Code mod: one pane with a context gauge and handoff-and-clear, a live list of subagents with
collapsible one-sentence task summaries, open questions pulled from each reply (this session only; a question clears itself once you answer it, through ✎ or in your own words), items left undone (with
"do it" buttons), and a scratch pad of notes. Undone items and notes belong to the project directory and are kept
across sessions and injected into the system prompt. The status line shows the counts only while the pane is off screen.

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

## Styling

The first run writes `~/.claude/agenda.theme.json` with the defaults. Edit it (colours as hex or terminal colour
names, any text for glyphs and labels, the two context-gauge thresholds), then run `/agenda` to reload. Plugin
updates replace the plugin, never that file, so your styling survives every update. Leave a key out to keep its
default; delete the file to start over. The path is a plugin setting (`themeFile`) if you want it elsewhere.

## Develop

```
claude --plugin-dir <this folder>
claude plugin validate .
claude plugin test .
```

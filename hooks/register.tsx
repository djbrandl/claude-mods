import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgendaItem, AgentRow, ContextGauge, Handoff } from '../types'

const PANE = 'agenda'
const TITLE = 'Agenda'
const LEGACY_STORE_KEY = 'agenda:v1'
const STORE_PREFIX = 'agenda:v2:'
const MAX_PER_LIST = 60
const MAX_DONE_AGENTS = 4
const MAX_TASKS_PER_AGENT = 10
const SUMMARIZE_AFTER_TOOLS = 4

// Deep Space palette, taken from ~/.wezterm.lua (Tokyo Night Moon derived).
const C = {
  bg: '#0a0d1a',
  text: '#c8d3f5',
  dim: '#545c7e',
  muted: '#828bb8',
  blue: '#82aaff',
  cyan: '#86e1fc',
  purple: '#c099ff',
  yellow: '#ffc777',
  red: '#ff757f',
  green: '#c3e88d',
} as const

const questions = atom({ plugin: 'agenda', key: 'questions' } as const, [])
const undone = atom({ plugin: 'agenda', key: 'undone' } as const, [])
const notes = atom({ plugin: 'agenda', key: 'notes' } as const, [])
const agents = atom({ plugin: 'agenda', key: 'agents' } as const, [])
const expandedAgents = atom({ plugin: 'agenda', key: 'expandedAgents' } as const, [])
const context = atom({ plugin: 'agenda', key: 'context' } as const, null)
const handoff = atom({ plugin: 'agenda', key: 'handoff' } as const, null)
const scanning = atom({ plugin: 'agenda', key: 'scanning' } as const, false)
const handingOff = atom({ plugin: 'agenda', key: 'handingOff' } as const, false)

// Questions are the session's alone and live in $.state only. Undone, notes and the pending handoff
// belong to the project directory and are stored under its path.
type Stored = { undone: AgendaItem[]; notes: AgendaItem[]; handoff: Handoff | null }
type ListName = 'questions' | 'undone' | 'notes'

const EXTRACT_SYSTEM = `You read one reply from a coding assistant to its user and extract two lists.

"questions": every question or decision the assistant is asking the USER to answer or decide, that the user still needs to respond to. Include requests for a choice, confirmation, missing information or a go/no-go. Exclude rhetorical questions, questions the assistant answered itself, and questions directed at nobody.

"undone": every piece of work the assistant says it did NOT do, left out, skipped, deferred, could not verify, will do later, suggests as a follow-up, or leaves for the user to do. Include failing tests it did not fix, steps it said were blocked, and "next steps" it names. Exclude work it reports as complete.

Write each item as one short self-contained sentence (max 160 characters) that makes sense without the reply. Do not invent items. Reply with JSON only, no prose, no code fence:
{"questions":["..."],"undone":["..."]}
Empty lists are fine.`

const TASK_SYSTEM = `You watch a coding subagent work. You are given its assignment, the task sentences already recorded for it, and its latest activity (what it said and which tools it used, with the key argument of each). Write ONE sentence, max 110 characters, plain language, past tense, saying what it just did and, if it is clear, why. Describe the work at the level a manager wants ("Read the three recipe files that reference the removed LoRA"), never tool names or paths unless they are the point. Do not repeat a sentence already recorded. Reply with the sentence only.`

const HANDOFF_PROMPT = `Write a handoff for a fresh session that will continue this work with none of this conversation. Plain Markdown, under 60 lines, no preamble. Sections, in this order:
# Handoff
## Goal
What the user is trying to achieve, in their words where possible.
## State
What is done and verified, what is built but unverified, what is broken.
## Decisions
Choices the user made or confirmed, each with the reason, so they are not re-litigated.
## Open questions
Questions the user has not answered yet.
## Left undone
Work named but not finished, one line each.
## Next step
The single next action to take.
## Files
Paths touched or that the next session must read first.`

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function merge(list: AgendaItem[], texts: string[], at: string): AgendaItem[] {
  const seen = new Set(list.map(one => norm(one.text)))
  const added: AgendaItem[] = []
  for (const text of texts) {
    const clean = text.trim()
    if (!clean || seen.has(norm(clean))) continue
    seen.add(norm(clean))
    added.push({ id: newId(), text: clean, at })
  }
  return [...list, ...added].slice(-MAX_PER_LIST)
}

function parseExtract(text: string): { questions: string[]; undone: string[] } {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return { questions: [], undone: [] }
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Record<'questions' | 'undone', unknown>>
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
    return { questions: strings(parsed.questions), undone: strings(parsed.undone) }
  } catch {
    return { questions: [], undone: [] }
  }
}

function asList(value: unknown): AgendaItem[] {
  return Array.isArray(value)
    ? value.filter(
        (one): one is AgendaItem =>
          typeof one === 'object' && one !== null && typeof (one as AgendaItem).text === 'string',
      )
    : []
}

let projectKey = ''

async function projectStoreKey($: EngineInterface): Promise<string> {
  if (!projectKey) {
    const cwd = (await $.session.cwd()).replace(/[\/]+$/, '').toLowerCase()
    projectKey = STORE_PREFIX + cwd
  }
  return projectKey
}

async function load($: EngineInterface): Promise<void> {
  const key = await projectStoreKey($)
  let raw = (await $.store.get(key)) as Partial<Stored> | undefined
  if (!raw) {
    // One-time migration of the pre-project store: its items were made in this project.
    const legacy = (await $.store.get(LEGACY_STORE_KEY)) as Partial<Stored> | undefined
    if (legacy) {
      raw = legacy
      await $.store.set(key, { undone: asList(legacy.undone), notes: asList(legacy.notes), handoff: legacy.handoff ?? null })
      await $.store.delete(LEGACY_STORE_KEY)
    }
  }
  await update($, questions, () => [])
  await update($, undone, () => asList(raw?.undone))
  await update($, notes, () => asList(raw?.notes))
  const h = raw?.handoff
  await update($, handoff, () => (h && typeof h.text === 'string' ? { text: h.text, at: String(h.at ?? '') } : null))
}

async function persist($: EngineInterface): Promise<void> {
  const stored: Stored = {
    undone: await read($, undone),
    notes: await read($, notes),
    handoff: await read($, handoff),
  }
  await $.store.set(await projectStoreKey($), stored)
  await refreshStatus($)
}

// The status line carries the counts only while the pane is not on screen.
async function refreshStatus($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  const mine = panes.find(one => one.id === PANE)
  if (mine && mine.isPlaced && mine.isShown) {
    $.ui.status(undefined)
    return
  }
  const q = (await read($, questions)).length
  const u = (await read($, undone)).length
  $.ui.status(q + u === 0 ? undefined : `agenda: ${q} open question${q === 1 ? '' : 's'} · ${u} undone`)
}

async function setList($: EngineInterface, which: ListName, fn: (list: AgendaItem[]) => AgendaItem[]): Promise<void> {
  if (which === 'questions') await update($, questions, fn)
  else if (which === 'undone') await update($, undone, fn)
  else await update($, notes, fn)
  await persist($)
}

async function refreshContext($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  const tokens = usage.context.tokens ?? 0
  const window = usage.context.window
  const gauge: ContextGauge = {
    tokens,
    window,
    percent: usage.context.percent ?? (window ? Math.round((tokens / window) * 100) : 0),
    usd: usage.cost?.usd ?? 0,
  }
  await update($, context, () => gauge)
}

async function refreshAgents($: EngineInterface): Promise<void> {
  const live = await $.agent.list()
  const now = Date.now()
  await update($, agents, list => {
    const byId = new Map(list.map(one => [one.id, one]))
    for (const info of live) {
      const prev = byId.get(info.id)
      const isOver = info.status === 'completed' || info.status === 'failed' || info.status === 'killed'
      byId.set(info.id, {
        id: info.id,
        description: info.description || prev?.description || info.type,
        type: info.type,
        status: info.status,
        startedAt: prev?.startedAt ?? now,
        endedAt: isOver ? (prev?.endedAt ?? now) : undefined,
        tasks: prev?.tasks ?? [],
      })
    }
    const rows = [...byId.values()]
    const active = rows.filter(one => one.endedAt === undefined)
    const done = rows
      .filter(one => one.endedAt !== undefined)
      .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
      .slice(0, MAX_DONE_AGENTS)
    return [...active, ...done]
  })
}

async function scanAnswer($: EngineInterface, answer: string, model: string): Promise<void> {
  await update($, scanning, () => true)
  try {
    const reply = await $.model.complete({
      model,
      system: EXTRACT_SYSTEM,
      prompt: answer.slice(0, 24000),
      effort: 'low',
      maxTokens: 800,
      timeoutMs: 30000,
    })
    if (!reply.isAnswered) return
    const found = parseExtract(reply.text)
    if (found.questions.length === 0 && found.undone.length === 0) return
    const at = new Date().toISOString()
    await update($, questions, list => merge(list, found.questions, at))
    await update($, undone, list => merge(list, found.undone, at))
    await persist($)
    const parts: string[] = []
    if (found.questions.length) parts.push(`${found.questions.length} open question${found.questions.length === 1 ? '' : 's'}`)
    if (found.undone.length) parts.push(`${found.undone.length} undone item${found.undone.length === 1 ? '' : 's'}`)
    $.ui.toast(`Agenda: ${parts.join(', ')} captured`)
  } finally {
    await update($, scanning, () => false)
  }
}

type Activity = { lines: string[]; tools: number; inFlight: Promise<void> | null }
const activity = new Map<string, Activity>()

function keyArg(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const o = input as Record<string, unknown>
  for (const k of ['description', 'file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt', 'skill']) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').slice(0, 120)
  }
  return ''
}

function noteActivity(agentId: string, blocks: readonly { type: string; [field: string]: unknown }[]): { isDue: boolean } {
  const buf = activity.get(agentId) ?? { lines: [], tools: 0, inFlight: null }
  activity.set(agentId, buf)
  let hasNarration = false
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const text = block.text.replace(/\s+/g, ' ').trim()
      if (text.length >= 20) {
        buf.lines.push(`said: ${text.slice(0, 300)}`)
        if (text.length >= 60) hasNarration = true
      }
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      const arg = keyArg(block.input)
      buf.lines.push(arg ? `${block.name}: ${arg}` : block.name)
      buf.tools += 1
    }
  }
  return { isDue: hasNarration || buf.tools >= SUMMARIZE_AFTER_TOOLS }
}

async function summarizeActivity($: EngineInterface, agentId: string, model: string): Promise<void> {
  const buf = activity.get(agentId)
  if (!buf || buf.lines.length === 0 || buf.inFlight) return
  const lines = buf.lines.splice(0, buf.lines.length)
  buf.tools = 0
  const run = (async () => {
    const row = (await read($, agents)).find(one => one.id === agentId)
    const prompt = [
      `Assignment: ${row?.description ?? agentId}`,
      row?.tasks.length ? `Recorded so far:\n${row.tasks.map(one => `- ${one}`).join('\n')}` : 'Recorded so far: nothing',
      `Latest activity:\n${lines.map(one => `- ${one}`).join('\n')}`,
    ].join('\n\n')
    const reply = await $.model.complete({ model, system: TASK_SYSTEM, prompt: prompt.slice(0, 12000), effort: 'low', maxTokens: 120, timeoutMs: 20000 })
    if (!reply.isAnswered) return
    const sentence = reply.text.replace(/\s+/g, ' ').trim().replace(/^["'‘“-]+|["'’”]+$/g, '')
    if (!sentence) return
    await update($, agents, list =>
      list.map(one =>
        one.id === agentId && !one.tasks.some(t => norm(t) === norm(sentence))
          ? { ...one, tasks: [...one.tasks, sentence].slice(-MAX_TASKS_PER_AGENT) }
          : one,
      ),
    )
  })()
  buf.inFlight = run
  try {
    await run
  } finally {
    buf.inFlight = null
  }
}

async function writeHandoff($: EngineInterface): Promise<Handoff | null> {
  await update($, handingOff, () => true)
  try {
    const qs = await read($, questions)
    const us = await read($, undone)
    const extra = [
      qs.length ? `The agenda pane also holds these unanswered questions; include them under Open questions:\n${qs.map(one => `- ${one.text}`).join('\n')}` : '',
      us.length ? `And these undone items; include them under Left undone:\n${us.map(one => `- ${one.text}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const reply = await $.model.fork({ prompt: extra ? `${HANDOFF_PROMPT}\n\n${extra}` : HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      $.ui.toast(`Agenda: handoff failed (${reply.reason})`)
      return null
    }
    const written: Handoff = { text: reply.text.trim(), at: new Date().toISOString() }
    await update($, handoff, () => written)
    await persist($)
    const cwd = await $.session.cwd()
    const path = `${cwd.replace(/[\\/]+$/, '')}/.claude/handoff.md`
    try {
      await $.fs.write(path, `${written.text}\n`)
    } catch {
      // The store copy is what the next session reads; the file is a courtesy.
    }
    return written
  } finally {
    await update($, handingOff, () => false)
  }
}

function bar(percent: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

function gaugeColor(percent: number): string {
  if (percent >= 75) return C.red
  if (percent >= 50) return C.yellow
  return C.purple
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function elapsed(row: AgentRow, now: number): string {
  const s = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

function agentGlyph(status: AgentRow['status']): { glyph: string; color: string } {
  switch (status) {
    case 'running':
      return { glyph: '●', color: C.blue }
    case 'pending':
      return { glyph: '○', color: C.muted }
    case 'waiting':
    case 'idle':
      return { glyph: '◐', color: C.yellow }
    case 'completed':
      return { glyph: '✓', color: C.green }
    case 'failed':
    case 'killed':
      return { glyph: '✗', color: C.red }
  }
}

export const register: Register = (on, options) => {
  const extractorModel = String(options.extractorModel ?? 'haiku')

  let hasOpenedOnPrompt = false

  on('session.start', async ($, e, next) => {
    await load($)
    await persist($)
    await $.command.register({ name: 'agenda', description: 'Open the Agenda pane (agents, context, questions, undone, notes)' })
    await $.command.register({ name: 'note', description: 'Add a note to the Agenda scratch pad: /note <text>' })
    await $.command.register({ name: 'handoff', description: 'Write a handoff for the next session, then /clear' })
    // Unasked, the engine seats a pane only on a terminal 144 columns or wider; narrower, it waits
    // undrawn, and the first prompt.submit below opens it as the person's own ask, at any width.
    void $.ui.open({ id: PANE, title: TITLE })
    try {
      await refreshContext($)
    } catch {
      // No usage yet; the gauge reads "no turn yet" until the first reply.
    }
    $.clock.every(3000, async () => {
      const rows = await read($, agents)
    const expanded = await read($, expandedAgents)
      if (rows.some(one => one.endedAt === undefined)) await refreshAgents($)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!hasOpenedOnPrompt) {
      hasOpenedOnPrompt = true
      const panes = await $.ui.panes()
      const mine = panes.find(one => one.id === PANE)
      if (!mine || !mine.isPlaced) void $.ui.open({ id: PANE, title: TITLE })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await update($, questions, () => [])
    return next(e)
  })

  on('ui.open', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    void refreshStatus($)
    return result
  }).catch(($, e, next) => next(e))

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const result = await next(e)
    void refreshStatus($)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agenda' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE, focus: true })
    return { text: opened.isPlaced ? 'Agenda pane opened.' : 'Agenda pane could not be placed; widen the terminal.' }
  })

  on('command.run', { command: 'note' }, async ($, e) => {
    const text = (e.args ?? '').trim()
    if (!text) return { text: 'Usage: /note <text>' }
    await setList($, 'notes', list => merge(list, [text], new Date().toISOString()))
    return { text: `Noted: ${text}` }
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const written = await writeHandoff($)
    if (!written) return { text: 'Handoff not written; nothing to hand off yet or the model did not answer.' }
    void $.command.run({ command: 'clear' })
    return { text: 'Handoff written to .claude/handoff.md and kept for the next session. Clearing.' }
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    await refreshAgents($)
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'response' }, ($, e, next) => {
    if (e.agentId && e.message.role === 'assistant') {
      const { isDue } = noteActivity(e.agentId, e.message.content)
      if (isDue) void summarizeActivity($, e.agentId, extractorModel)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refreshAgents($)
    if (e.agentId) {
      void summarizeActivity($, e.agentId, extractorModel)
      return result
    }
    void refreshContext($)
    // The first main-loop answer after a handoff was loaded has consumed it.
    const pending = await read($, handoff)
    if (pending && e.reason === 'answer') {
      await update($, handoff, () => null)
      await persist($)
    }
    if (e.reason === 'answer' && e.answer.trim().length >= 20) void scanAnswer($, e.answer, extractorModel)
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections]
    const list = await read($, notes)
    if (list.length > 0) {
      sections.push({
        id: 'agenda:notes',
        scope: 'session',
        text: [
          '# Agenda scratch pad',
          'Standing notes the user keeps for this project directory, across sessions, through the agenda pane. Treat them as context that must not be lost; honour any to-do or constraint listed here when it is relevant to the current work.',
          ...list.map(one => `- ${one.text}`),
        ].join('\n'),
      })
    }
    const pending = await read($, handoff)
    if (pending) {
      sections.push({
        id: 'agenda:handoff',
        scope: 'session',
        text: [
          '# Handoff from the previous session',
          `Written ${pending.at}. The previous session ended on purpose and this one continues it. Read this before acting, then pick up at "Next step". Do not re-ask the questions it lists as decided.`,
          '',
          pending.text,
        ].join('\n'),
      })
    }
    return { sections }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const qs = await read($, questions)
    const us = await read($, undone)
    const ns = await read($, notes)
    const rows = await read($, agents)
    const expanded = await read($, expandedAgents)
    const gauge = await read($, context)
    const pending = await read($, handoff)
    const busy = await read($, scanning)
    const isHandingOff = await read($, handingOff)
    const width = Math.max(24, e.props.bodyColumns)
    const inner = width - 2
    const now = Date.now()

    const askAnswer = (item: AgendaItem) => async () => {
      await $.prompt.fill({ text: `Answering your earlier question "${item.text}": `, mode: 'replace' })
    }
    const dismiss = (which: ListName, item: AgendaItem) => () =>
      void setList($, which, list => list.filter(one => one.id !== item.id))
    const doUndone = (item: AgendaItem) => async () => {
      await setList($, 'undone', list => list.filter(one => one.id !== item.id))
      void $.prompt.submit({ text: `Do this item you left undone earlier, then verify it: ${item.text}` })
    }
    const doAllUndone = async () => {
      const items = us.map(one => `- ${one.text}`)
      await setList($, 'undone', () => [])
      void $.prompt.submit({ text: `Do every item you left undone earlier, then verify each:\n${items.join('\n')}` })
    }
    const addNote = (value: string) => {
      const text = value.trim()
      if (!text) return
      void setList($, 'notes', list => merge(list, [text], new Date().toISOString()))
    }
    const handoffAndClear = async () => {
      const written = await writeHandoff($)
      if (!written) return
      $.ui.toast('Agenda: handoff written, clearing session')
      void $.command.run({ command: 'clear' })
    }
    const toggleAgent = (id: string) => () =>
      void update($, expandedAgents, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
    const dropHandoff = () => {
      void (async () => {
        await update($, handoff, () => null)
        await persist($)
      })()
    }

    const heading = (label: string, color: string, count: number, trailing?: JSX.Element) => (
      <Box justifyContent="space-between" marginTop={1}>
        <Box gap={1}>
          <Text color={color} bold>
            {label}
          </Text>
          <Text color={C.dim}>{count}</Text>
        </Box>
        {trailing}
      </Box>
    )

    const item = (one: AgendaItem, color: string, buttons: JSX.Element) => (
      <Box key={one.id} paddingLeft={1} gap={1}>
        <Text color={color}>▎</Text>
        <Box flexGrow={1}>
          <Text color={C.text} wrap="wrap">
            {one.text}
          </Text>
        </Box>
        <Box gap={1} flexShrink={0}>
          {buttons}
        </Box>
      </Box>
    )

    const empty = (text: string) => (
      <Box paddingLeft={2}>
        <Text color={C.dim} italic>
          {text}
        </Text>
      </Box>
    )

    const barWidth = Math.max(8, inner - 8)

    return (
      <Box flexDirection="column" width={width} backgroundColor={C.bg} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={C.purple} bold>
            CONTEXT
          </Text>
          {gauge && (
            <Text color={C.muted}>
              {kTokens(gauge.tokens)} / {kTokens(gauge.window)} · API-equiv ${gauge.usd.toFixed(2)}
            </Text>
          )}
        </Box>
        {gauge ? (
          <Box gap={1}>
            <Text color={gaugeColor(gauge.percent)}>{bar(gauge.percent, barWidth)}</Text>
            <Text color={gaugeColor(gauge.percent)} bold>
              {gauge.percent}%
            </Text>
          </Box>
        ) : (
          empty('no turn yet')
        )}
        <Box gap={1} marginTop={1}>
          <Button
            key="handoff"
            label={isHandingOff ? 'writing handoff…' : 'handoff + clear'}
            variant="primary"
            hotkey="h"
            onPress={handoffAndClear}
          />
          {pending && <Button key="drop-handoff" label="drop pending handoff" onPress={dropHandoff} />}
        </Box>
        {pending && (
          <Box paddingLeft={2}>
            <Text color={C.green}>handoff loaded, consumed on the next reply</Text>
          </Box>
        )}

        {heading('AGENTS', C.blue, rows.filter(one => one.endedAt === undefined).length)}
        {rows.length === 0 && empty('no subagents')}
        {rows.map(row => {
          const { glyph, color } = agentGlyph(row.status)
          const isDone = row.endedAt !== undefined
          const isOpen = expanded.includes(row.id)
          const latest = row.tasks[row.tasks.length - 1]
          return (
            <Box key={row.id} flexDirection="column" paddingLeft={1}>
              <Box gap={1}>
                <Text color={color}>{glyph}</Text>
                <Button key={`ag-${row.id}`} plain label={isOpen ? '▾' : '▸'} onPress={toggleAgent(row.id)} />
                <Box width={inner - 14}>
                  <Text color={isDone ? C.dim : C.text} bold={!isDone} wrap="truncate-end">
                    {row.description}
                  </Text>
                </Box>
                <Text color={C.dim}>{elapsed(row, now)}</Text>
              </Box>
              {!isOpen && latest && (
                <Box paddingLeft={4} width={inner - 4}>
                  <Text color={C.muted} wrap="truncate-end">
                    {latest}
                  </Text>
                </Box>
              )}
              {isOpen && row.tasks.length === 0 && (
                <Box paddingLeft={4}>
                  <Text color={C.dim} italic>
                    no tasks summarised yet
                  </Text>
                </Box>
              )}
              {isOpen &&
                row.tasks.map((task, i) => (
                  <Box key={`${row.id}-${i}`} paddingLeft={4} width={inner - 4}>
                    <Text color={i === row.tasks.length - 1 ? C.text : C.muted} wrap="wrap">
                      {i + 1}. {task}
                    </Text>
                  </Box>
                ))}
            </Box>
          )
        })}

        {heading('QUESTIONS', C.yellow, qs.length, busy ? <Text color={C.dim}>scanning…</Text> : undefined)}
        {qs.length === 0 && empty('none pending')}
        {qs.map(one =>
          item(
            one,
            C.yellow,
            <>
              <Button key={`qa-${one.id}`} plain label="✎" variant="primary" onPress={askAnswer(one)} />
              <Button key={`qx-${one.id}`} plain label="✕" dimColor onPress={dismiss('questions', one)} />
            </>,
          ),
        )}

        {heading('UNDONE', C.red, us.length, us.length > 1 ? <Button key="do-all" plain label="▶▶ all" onPress={doAllUndone} /> : undefined)}
        {us.length === 0 && empty('nothing left undone')}
        {us.map(one =>
          item(
            one,
            C.red,
            <>
              <Button key={`ud-${one.id}`} plain label="▶" variant="primary" onPress={doUndone(one)} />
              <Button key={`ux-${one.id}`} plain label="✕" dimColor onPress={dismiss('undone', one)} />
            </>,
          ),
        )}

        {heading('NOTES', C.cyan, ns.length)}
        {ns.map(one => item(one, C.cyan, <Button key={`nx-${one.id}`} plain label="✕" dimColor onPress={dismiss('notes', one)} />))}
        <Box paddingLeft={1}>
          {Input ? (
            <Input key="new-note" placeholder="add a project note, kept across sessions" submitLabel="add" onSubmit={addNote} />
          ) : (
            <Text color={C.dim}>add notes with /note from a terminal or desktop</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text color={C.dim}>✎ answer · ▶ do · ✕ dismiss · ▸ expand</Text>
        </Box>
      </Box>
    )
  })
}

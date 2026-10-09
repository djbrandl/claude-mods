import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgendaItem, AgentRow, ContextGauge, Handoff, PlanStep, Theme } from '../types'
import { DEFAULT_THEME, THEME_DOC, legend, mergeTheme } from './theme'

const PANE = 'agenda'
const TITLE = 'Agenda'
const LEGACY_STORE_KEY = 'agenda:v1'
const STORE_PREFIX = 'agenda:v2:'
const MAX_PER_LIST = 60
const MAX_DONE_AGENTS = 4
const MAX_PLAN_STEPS = 8
const SUMMARIZE_AFTER_TOOLS = 4

// Looks come from the theme file (see hooks/theme.ts); T mirrors the state atom for the helpers.
let T: Theme = DEFAULT_THEME

const questions = atom({ plugin: 'agenda', key: 'questions' } as const, [])
const undone = atom({ plugin: 'agenda', key: 'undone' } as const, [])
const notes = atom({ plugin: 'agenda', key: 'notes' } as const, [])
const agents = atom({ plugin: 'agenda', key: 'agents' } as const, [])
// Agents whose row the person flipped from its default: running rows open, finished rows folded.
const toggledAgents = atom({ plugin: 'agenda', key: 'toggledAgents' } as const, [])
const context = atom({ plugin: 'agenda', key: 'context' } as const, null)
const handoff = atom({ plugin: 'agenda', key: 'handoff' } as const, null)
const scanning = atom({ plugin: 'agenda', key: 'scanning' } as const, false)
const handingOff = atom({ plugin: 'agenda', key: 'handingOff' } as const, false)
const theme = atom({ plugin: 'agenda', key: 'theme' } as const, DEFAULT_THEME)

// Questions are the session's alone and live in $.state only. Undone, notes and the pending handoff
// belong to the project directory and are stored under its path.
type Stored = { undone: AgendaItem[]; notes: AgendaItem[]; handoff: Handoff | null }
type ListName = 'questions' | 'undone' | 'notes'

const EXTRACT_SYSTEM = `You read one reply from a coding assistant to its user, together with the user's request it answers, the open questions already recorded, and the list of unfinished items already recorded. You answer with four lists.

"questions": every NEW question or decision the assistant is asking the USER to answer or decide, that the user still needs to respond to. Include requests for a choice, confirmation, missing information or a go/no-go. Exclude rhetorical questions, questions the assistant answered itself, questions directed at nobody, and anything already in the recorded open questions.

"answered": the ids from the recorded open questions that the user's request answers or decides, or that this reply shows are settled, withdrawn, or no longer relevant. A user who tells the assistant what to do about a question has answered it even without using the word.

"undone": ONLY work the user asked for that the assistant explicitly did not finish. A part of the request it dropped or skipped, a step it said it would do next but did not, a failing check it left broken. Most replies have ZERO undone items. Exclude all of these: caveats about what it could not verify from where it sits ("not verified live", "needs a real run", "tell me what you see"); optional suggestions, ideas, offers or follow-ups; work that waits on the user's decision (that is a question); explanations of how something works; anything that is already in the recorded list.

"resolved": the ids from the recorded list that this reply shows are now finished, superseded, or no longer apply.

Write each new item as one short self-contained sentence (max 160 characters) that makes sense without the reply. Do not invent items. Reply with JSON only, no prose, no code fence:
{"questions":["..."],"answered":["id"],"undone":["..."],"resolved":["id"]}
Empty lists are fine and usual.`

const PLAN_SYSTEM = `You are given the assignment a coding subagent was just handed. List the macro steps it will have to carry out to finish: the outcomes a manager would track, not individual file reads or commands. Between 2 and 6 steps, in the order they will likely happen, each a short phrase of at most 60 characters in plain language, no tool names or paths unless they are the point. Reply with JSON only, no prose, no code fence:
{"steps":["..."]}`

const PROGRESS_SYSTEM = `You watch a coding subagent work against a numbered plan. You are given its assignment, the plan (number, state, step), and its latest activity (what it said and which tools it used, with the key argument of each). Decide what the activity shows: which steps are now finished, and which single step it is working on now. Add a new step ONLY if the agent is clearly doing substantial work that no planned step covers; phrase it like the others, max 60 characters. Reply with JSON only, no prose, no code fence:
{"done":[1],"doing":2,"added":["..."]}
"doing" is a step number or null; a step number may be from the plan or count on from the end for an added step.`

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

type Extracted = { questions: string[]; answered: string[]; undone: string[]; resolved: string[] }

function parseExtract(text: string): Extracted {
  const none: Extracted = { questions: [], answered: [], undone: [], resolved: [] }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return none
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as Partial<Record<keyof Extracted, unknown>>
    const strings = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
    return {
      questions: strings(parsed.questions),
      answered: strings(parsed.answered),
      undone: strings(parsed.undone),
      resolved: strings(parsed.resolved),
    }
  } catch {
    return none
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
        plan: isOver && prev ? finishPlan(prev.plan, info.status === 'completed') : (prev?.plan ?? []),
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

let lastPrompt = ''

// The question the ✎ button put into the prompt box; cleared from the list when that prompt is sent.
const ANSWER_PREFIX = 'Answering your earlier question '
let pendingAnswer: AgendaItem | null = null

// The pane's own estimate of its tree's height at the last draw, and how far the engine's count differed.
let lastEstimate = 0
let rowCorrection = 0

async function scanAnswer($: EngineInterface, answer: string, model: string): Promise<void> {
  await update($, scanning, () => true)
  try {
    const recorded = await read($, undone)
    const open = await read($, questions)
    const prompt = [
      `User's request:\n${lastPrompt.trim().slice(0, 4000) || '(not captured)'}`,
      open.length
        ? `Recorded open questions (id: text):\n${open.map(one => `${one.id}: ${one.text}`).join('\n')}`
        : 'Recorded open questions: none',
      recorded.length
        ? `Recorded unfinished items (id: text):\n${recorded.map(one => `${one.id}: ${one.text}`).join('\n')}`
        : 'Recorded unfinished items: none',
      `Assistant's reply:\n${answer.slice(0, 20000)}`,
    ].join('\n\n')
    const reply = await $.model.complete({ model, system: EXTRACT_SYSTEM, prompt, effort: 'low', maxTokens: 800, timeoutMs: 30000 })
    if (!reply.isAnswered) return
    const found = parseExtract(reply.text)
    const answered = new Set(found.answered.filter(id => open.some(one => one.id === id)))
    const resolved = new Set(found.resolved.filter(id => recorded.some(one => one.id === id)))
    if (found.questions.length === 0 && found.undone.length === 0 && answered.size === 0 && resolved.size === 0) return
    const at = new Date().toISOString()
    await update($, questions, list => merge(list.filter(one => !answered.has(one.id)), found.questions, at))
    await update($, undone, list => merge(list.filter(one => !resolved.has(one.id)), found.undone, at))
    await persist($)
    const parts: string[] = []
    if (found.questions.length) parts.push(`${found.questions.length} open question${found.questions.length === 1 ? '' : 's'}`)
    if (answered.size) parts.push(`${answered.size} answered`)
    if (found.undone.length) parts.push(`${found.undone.length} undone`)
    if (resolved.size) parts.push(`${resolved.size} resolved`)
    $.ui.toast(`Agenda: ${parts.join(', ')}`)
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

function parseJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function stepTexts(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((one): one is string => typeof one === 'string')
        .map(one => one.replace(/\s+/g, ' ').trim().replace(/^[-*\d.)\s]+/, ''))
        .filter(one => one.length > 0)
        .map(one => one.slice(0, 80))
    : []
}

// The agent is over: whatever it was on is done when it completed, otherwise left where it stood.
function finishPlan(plan: PlanStep[], isCompleted: boolean): PlanStep[] {
  if (!isCompleted) return plan
  return plan.map(step => (step.state === 'doing' ? { ...step, state: 'done' } : step))
}

// Called once per spawn with the assignment the subagent was handed.
async function planAgent($: EngineInterface, agentId: string, description: string, assignment: string, model: string): Promise<void> {
  const reply = await $.model.complete({
    model,
    system: PLAN_SYSTEM,
    prompt: `Description: ${description}\n\nAssignment:\n${assignment.slice(0, 12000)}`,
    effort: 'low',
    maxTokens: 300,
    timeoutMs: 20000,
  })
  if (!reply.isAnswered) return
  const steps = stepTexts(parseJson(reply.text)?.steps).slice(0, MAX_PLAN_STEPS)
  if (steps.length === 0) return
  await update($, agents, list =>
    list.map(one => {
      if (one.id !== agentId) return one
      // Progress may already have added steps; the plan goes in front of them.
      const known = new Set(steps.map(norm))
      const extra = one.plan.filter(step => !known.has(norm(step.text)))
      const planned: PlanStep[] = steps.map(text => ({ text, state: one.plan.find(step => norm(step.text) === norm(text))?.state ?? 'todo' }))
      return { ...one, plan: [...planned, ...extra].slice(0, MAX_PLAN_STEPS) }
    }),
  )
}

async function summarizeActivity($: EngineInterface, agentId: string, model: string): Promise<void> {
  const buf = activity.get(agentId)
  if (!buf || buf.lines.length === 0 || buf.inFlight) return
  const lines = buf.lines.splice(0, buf.lines.length)
  buf.tools = 0
  const run = (async () => {
    const row = (await read($, agents)).find(one => one.id === agentId)
    const plan = row?.plan ?? []
    const prompt = [
      `Assignment: ${row?.description ?? agentId}`,
      plan.length ? `Plan:\n${plan.map((step, i) => `${i + 1}. [${step.state}] ${step.text}`).join('\n')}` : 'Plan: none yet',
      `Latest activity:\n${lines.map(one => `- ${one}`).join('\n')}`,
    ].join('\n\n')
    const reply = await $.model.complete({ model, system: PROGRESS_SYSTEM, prompt: prompt.slice(0, 12000), effort: 'low', maxTokens: 200, timeoutMs: 20000 })
    if (!reply.isAnswered) return
    const parsed = parseJson(reply.text)
    if (!parsed) return
    const done = new Set(Array.isArray(parsed.done) ? parsed.done.filter((one): one is number => Number.isInteger(one)) : [])
    const doing = Number.isInteger(parsed.doing) ? (parsed.doing as number) : null
    const added = stepTexts(parsed.added)
    await update($, agents, list =>
      list.map(one => {
        if (one.id !== agentId) return one
        const have = new Set(one.plan.map(step => norm(step.text)))
        const extra: PlanStep[] = added.filter(text => !have.has(norm(text))).map(text => ({ text, state: 'todo' }))
        const next = [...one.plan, ...extra].slice(0, MAX_PLAN_STEPS).map((step, i) => {
          const n = i + 1
          if (done.has(n)) return { ...step, state: 'done' as const }
          if (n === doing) return { ...step, state: 'doing' as const }
          // Moving on to a later step finishes the one it was on.
          if (step.state === 'doing' && doing !== null && doing > n) return { ...step, state: 'done' as const }
          return step
        })
        return { ...one, plan: next }
      }),
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
  return T.gauge.filled.repeat(filled) + T.gauge.empty.repeat(Math.max(0, width - filled))
}

function gaugeColor(percent: number): string {
  if (percent >= T.gauge.dangerAt) return T.gauge.danger
  if (percent >= T.gauge.warnAt) return T.gauge.warn
  return T.gauge.ok
}

/** Rows a word-wrapped Text takes at `width` cells, as the terminal wraps it. */
function wrapRows(text: string, width: number): number {
  const w = Math.max(1, width)
  let rows = 0
  for (const line of text.split('\n')) {
    let used = 0
    let lineRows = 1
    for (const word of line.split(' ')) {
      const len = [...word].length
      if (used === 0) {
        lineRows += Math.max(0, Math.ceil(len / w) - 1)
        used = len % w || (len ? w : 0)
      } else if (used + 1 + len <= w) {
        used += 1 + len
      } else {
        lineRows += Math.ceil(Math.max(1, len) / w)
        used = len % w || w
      }
    }
    rows += lineRows
  }
  return rows
}

/** The thumb's first row and length on a track of `rows` rows over a tree of `content` rows. */
function thumb(offset: number, rows: number, content: number): { start: number; size: number } {
  const size = Math.max(1, Math.min(rows, Math.round((rows * rows) / content)))
  const travel = Math.max(1, content - rows)
  const start = Math.round((Math.min(Math.max(0, offset), travel) / travel) * (rows - size))
  return { start, size }
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function elapsed(row: AgentRow, now: number): string {
  const s = Math.max(0, Math.round(((row.endedAt ?? now) - row.startedAt) / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`
}

function agentGlyph(status: AgentRow['status']): { glyph: string; color: string } {
  return T.status[status]
}

async function expandHome($: EngineInterface, path: string): Promise<string> {
  if (!path.startsWith('~')) return path
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  return home.replace(/[\/]+$/, '') + path.slice(1)
}

/**
 * Reads the theme file. A missing file is written with the defaults so there is something to edit;
 * an unreadable or malformed one yields the defaults and a note of why.
 */
async function loadTheme($: EngineInterface, themeFile: string): Promise<{ theme: Theme; path: string; problem?: string; isNew?: boolean }> {
  const path = await expandHome($, themeFile)
  let exists = false
  try {
    exists = await $.fs.exists(path)
  } catch {
    return { theme: DEFAULT_THEME, path, problem: 'could not check the theme file' }
  }
  if (!exists) {
    try {
      await $.fs.write(path, JSON.stringify({ $doc: THEME_DOC, ...DEFAULT_THEME }, null, 2) + '\n')
      return { theme: DEFAULT_THEME, path, isNew: true }
    } catch {
      return { theme: DEFAULT_THEME, path, problem: 'could not write the starter theme file' }
    }
  }
  try {
    const text = await $.fs.read(path)
    return { theme: mergeTheme(JSON.parse(text)), path }
  } catch {
    return { theme: DEFAULT_THEME, path, problem: 'theme file is not valid JSON; using defaults' }
  }
}

async function applyTheme($: EngineInterface, themeFile: string, isReload: boolean): Promise<void> {
  const loaded = await loadTheme($, themeFile)
  T = loaded.theme
  await update($, theme, () => loaded.theme)
  if (loaded.isNew) $.ui.toast(`Agenda: starter theme written to ${loaded.path}; edit it and run /agenda to reload`)
  else if (loaded.problem) $.ui.toast(`Agenda: ${loaded.problem} (${loaded.path})`)
  else if (isReload) $.ui.toast('Agenda: theme reloaded')
}

export const register: Register = (on, options) => {
  const extractorModel = String(options.extractorModel ?? 'haiku')
  const themeFile = String(options.themeFile ?? '~/.claude/agenda.theme.json')

  let hasOpenedOnPrompt = false

  on('session.start', async ($, e, next) => {
    await applyTheme($, themeFile, false)
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
      if (rows.some(one => one.endedAt === undefined)) await refreshAgents($)
    })
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin?.kind !== 'plugin') {
      lastPrompt = e.text
      const answering = pendingAnswer
      if (answering && e.text.startsWith(ANSWER_PREFIX)) {
        pendingAnswer = null
        await setList($, 'questions', list => list.filter(one => one.id !== answering.id))
      }
    }
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
    await applyTheme($, themeFile, true)
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
    if (!result.deny && result.agentId) {
      void planAgent($, result.agentId, e.description || e.subagentType, e.prompt, extractorModel)
    }
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

  // The engine scrolls the pane body but draws no scrollbar, and the render hook is not told the tree's
  // height. The pane estimates it; each scroll reports the true height, which calibrates the estimate.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, ($, e, next) => {
    if (lastEstimate > 0) rowCorrection = e.contentRows - lastEstimate
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? null : $.ui.resolve(e).Input
    const qs = await read($, questions)
    const us = await read($, undone)
    const ns = await read($, notes)
    const rows = await read($, agents)
    const toggled = await read($, toggledAgents)
    const gauge = await read($, context)
    const pending = await read($, handoff)
    const busy = await read($, scanning)
    const isHandingOff = await read($, handingOff)
    const t = await read($, theme)
    T = t
    const width = Math.max(24, e.props.bodyColumns)
    const inner = width - 2
    const now = Date.now()

    const askAnswer = (item: AgendaItem) => async () => {
      pendingAnswer = item
      await $.prompt.fill({ text: `${ANSWER_PREFIX}"${item.text}": `, mode: 'replace' })
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
      void update($, toggledAgents, list => (list.includes(id) ? list.filter(one => one !== id) : [...list, id]))
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
          <Text color={t.colors.dim}>{count}</Text>
        </Box>
        {trailing}
      </Box>
    )

    const item = (one: AgendaItem, color: string, buttons: JSX.Element) => (
      <Box key={one.id} paddingLeft={1} gap={1}>
        <Text color={color}>{t.glyphs.bullet}</Text>
        <Box flexGrow={1}>
          <Text color={t.colors.text} wrap="wrap">
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
        <Text color={t.colors.dim} italic>
          {text}
        </Text>
      </Box>
    )

    const barWidth = Math.max(8, inner - 8)

    // Height estimate mirroring the layout below, row for row; see the ui.scroll hook.
    const cells = (text: string) => [...text].length
    const itemRows = (one: AgendaItem, buttonCells: number) => wrapRows(one.text, inner - 4 - cells(t.glyphs.bullet) - buttonCells)
    let estimate = 4 + (pending ? 1 : 0)
    estimate += 2 + (rows.length === 0 ? 1 : 0)
    for (const row of rows) {
      const isDone = row.endedAt !== undefined
      const isOpen = toggled.includes(row.id) ? isDone : !isDone
      estimate += isOpen ? wrapRows(row.description, inner - 12) : 1
      if (!isOpen) estimate += row.plan.length > 0 && (isDone || row.plan.some(step => step.state !== 'done')) ? 1 : 0
      else if (row.plan.length === 0) estimate += 1
      else for (const step of row.plan) estimate += wrapRows(step.text, inner - 6)
    }
    const pairCells = (a: string, b: string) => cells(a) + 1 + cells(b)
    estimate += 2 + (qs.length === 0 ? 1 : 0) + qs.reduce((n, one) => n + itemRows(one, pairCells(t.glyphs.answer, t.glyphs.dismiss)), 0)
    estimate += 2 + (us.length === 0 ? 1 : 0) + us.reduce((n, one) => n + itemRows(one, pairCells(t.glyphs.do, t.glyphs.dismiss)), 0)
    estimate += 2 + ns.reduce((n, one) => n + itemRows(one, cells(t.glyphs.dismiss)), 0)
    estimate += 1 + 1 + wrapRows(legend(t), inner)
    lastEstimate = estimate
    const contentRows = Math.max(1, estimate + rowCorrection)
    const view = e.props.scroll
    const overflows = contentRows > view.bodyRows && view.bodyRows > 1
    const track = overflows ? thumb(view.offset, view.bodyRows, contentRows) : null

    return (
      <Box flexDirection="column" width={width} backgroundColor={t.colors.background} paddingX={1}>
        <Box justifyContent="space-between">
          <Text color={t.sections.context} bold>
            {t.labels.context}
          </Text>
          {gauge && (
            <Text color={t.colors.muted}>
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
            label={isHandingOff ? 'writing handoff…' : t.labels.handoff}
            variant="primary"
            hotkey="h"
            onPress={handoffAndClear}
          />
          {pending && <Button key="drop-handoff" label={t.labels.dropHandoff} onPress={dropHandoff} />}
        </Box>
        {pending && (
          <Box paddingLeft={2}>
            <Text color={t.colors.success}>handoff loaded, consumed on the next reply</Text>
          </Box>
        )}

        {heading(t.labels.agents, t.sections.agents, rows.filter(one => one.endedAt === undefined).length)}
        {rows.length === 0 && empty('no subagents')}
        {rows.map(row => {
          const { glyph, color } = agentGlyph(row.status)
          const isDone = row.endedAt !== undefined
          // Running rows open by default so the plan is in view; finished rows fold to one line.
          const isOpen = toggled.includes(row.id) ? isDone : !isDone
          const doneCount = row.plan.filter(step => step.state === 'done').length
          const current = row.plan.find(step => step.state === 'doing') ?? row.plan.find(step => step.state === 'todo')
          const folded = row.plan.length === 0 ? '' : isDone ? `${doneCount}/${row.plan.length} steps` : current ? `${doneCount}/${row.plan.length} · ${current.text}` : ''
          return (
            <Box key={row.id} flexDirection="column" paddingLeft={1}>
              <Box gap={1}>
                <Text color={color}>{glyph}</Text>
                <Button key={`ag-${row.id}`} plain label={isOpen ? t.glyphs.collapse : t.glyphs.expand} onPress={toggleAgent(row.id)} />
                <Box width={inner - 12}>
                  <Text color={isDone ? t.colors.dim : t.colors.text} bold={!isDone} wrap={isOpen ? 'wrap' : 'truncate-end'}>
                    {row.description}
                  </Text>
                </Box>
                <Text color={t.colors.dim}>{elapsed(row, now)}</Text>
              </Box>
              {!isOpen && folded && (
                <Box paddingLeft={4} width={inner - 4}>
                  <Text color={t.colors.muted} wrap="truncate-end">
                    {folded}
                  </Text>
                </Box>
              )}
              {isOpen && row.plan.length === 0 && (
                <Box paddingLeft={4}>
                  <Text color={t.colors.dim} italic>
                    {isDone ? 'no plan recorded' : 'reading its assignment…'}
                  </Text>
                </Box>
              )}
              {isOpen &&
                row.plan.map((step, i) => (
                  <Box key={`${row.id}-${i}`} paddingLeft={4} width={inner - 4} gap={1}>
                    <Text color={step.state === 'done' ? t.colors.success : step.state === 'doing' ? t.colors.text : t.colors.dim}>
                      {step.state === 'done' ? t.glyphs.stepDone : step.state === 'doing' ? t.glyphs.stepDoing : t.glyphs.stepTodo}
                    </Text>
                    <Box width={inner - 6}>
                      <Text color={step.state === 'doing' ? t.colors.text : step.state === 'done' ? t.colors.muted : t.colors.dim} bold={step.state === 'doing'} wrap="wrap">
                        {step.text}
                      </Text>
                    </Box>
                  </Box>
                ))}
            </Box>
          )
        })}

        {heading(t.labels.questions, t.sections.questions, qs.length, busy ? <Text color={t.colors.dim}>scanning…</Text> : undefined)}
        {qs.length === 0 && empty('none pending')}
        {qs.map(one =>
          item(
            one,
            t.sections.questions,
            <>
              <Button key={`qa-${one.id}`} plain label={t.glyphs.answer} variant="primary" onPress={askAnswer(one)} />
              <Button key={`qx-${one.id}`} plain label={t.glyphs.dismiss} dimColor onPress={dismiss('questions', one)} />
            </>,
          ),
        )}

        {heading(t.labels.undone, t.sections.undone, us.length, us.length > 1 ? (
            <Box gap={1}>
              <Button key="do-all" plain label={t.glyphs.doAll} onPress={doAllUndone} />
              <Button key="dismiss-all" plain label={t.glyphs.dismissAll} dimColor onPress={() => void setList($, 'undone', () => [])} />
            </Box>
          ) : undefined)}
        {us.length === 0 && empty('nothing left undone')}
        {us.map(one =>
          item(
            one,
            t.sections.undone,
            <>
              <Button key={`ud-${one.id}`} plain label={t.glyphs.do} variant="primary" onPress={doUndone(one)} />
              <Button key={`ux-${one.id}`} plain label={t.glyphs.dismiss} dimColor onPress={dismiss('undone', one)} />
            </>,
          ),
        )}

        {heading(t.labels.notes, t.sections.notes, ns.length)}
        {ns.map(one => item(one, t.sections.notes, <Button key={`nx-${one.id}`} plain label={t.glyphs.dismiss} dimColor onPress={dismiss('notes', one)} />))}
        <Box paddingLeft={1}>
          {Input ? (
            <Input key="new-note" placeholder="add a project note, kept across sessions" submitLabel="add" onSubmit={addNote} />
          ) : (
            <Text color={t.colors.dim}>add notes with /note from a terminal or desktop</Text>
          )}
        </Box>
        <Box marginTop={1}>
          <Text color={t.colors.dim}>{legend(t)}</Text>
        </Box>
        {track && (
          // Painted over the right padding column, pinned to the rows the window shows.
          <Box key="scrollbar" position="absolute" top={Math.max(0, Math.min(view.offset, contentRows - view.bodyRows))} right={0} width={1} flexDirection="column">
            {Array.from({ length: view.bodyRows }, (_, i) => {
              const isThumb = i >= track.start && i < track.start + track.size
              return (
                <Text key={`sb-${i}`} color={isThumb ? t.scrollbar.thumbColor : t.scrollbar.trackColor}>
                  {isThumb ? t.scrollbar.thumb : t.scrollbar.track}
                </Text>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })
}

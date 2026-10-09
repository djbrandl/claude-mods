import { expect, mock, test } from 'claude-code/testing'

const PANE_PROPS = {
  title: 'Agenda',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
} as const

const HANDOFF_TEXT = ['# Handoff', '## Next step', 'Finish the pane.'].join(String.fromCharCode(10))
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Files = Record<string, string>

function bottom(on: Parameters<Parameters<typeof test>[1] extends infer B ? (B extends (...a: infer A) => unknown ? A[1] : never) : never>[0], extract: string | ((prompt: string) => string), store?: Record<string, unknown>, files: Files = {}) {
  const submitted: string[] = []
  const filled: string[] = []
  const ran: string[] = []
  const opened: string[] = []
  const statuses: (string | undefined)[] = []
  const panes: unknown[] = []
  const agentRows: unknown[] = []
  const prompts: string[] = []
  if (store) {
    on('store.get', (_$, e) => ({ value: store[e.key] }) as never)
    on('store.set', (_$, e) => { store[e.key] = e.value; return { value: undefined } as never })
    on('store.delete', (_$, e) => { delete store[e.key]; return { value: undefined } as never })
    on('store.keys', () => ({ value: Object.keys(store) }) as never)
  } else {
    mock.store(on)
  }
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('ui.open', () => { opened.push('agenda'); return { value: { isPlaced: true } } as never })
  on('ui.panes', () => ({ value: panes }) as never)
  on('ui.status', (_$, e) => { statuses.push(e.text); return { value: undefined } as never })
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120000, window: 200000, percent: 60 }, rateLimits: [], cost: { usd: 1.25 } } }) as never)
  on('agent.list', () => ({ value: agentRows }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: HANDOFF_TEXT, usage: USAGE } }) as never)
  on('session.cwd', () => ({ value: 'C:/tmp/proj' }) as never)
  const norm = (path: string) => path.split(String.fromCharCode(92)).join('/')
  on('fs.write', (_$, e) => { files[norm(e.path)] = e.text; return { value: undefined } as never })
  on('fs.exists', (_$, e) => ({ value: norm(e.path) in files }) as never)
  on('fs.read', (_$, e) => ({ value: files[norm(e.path)] ?? '' }) as never)
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? 'C:/Users/me' : undefined }) as never)
  on('command.run', (_$, e) => { ran.push(e.command); return { text: '' } as never })
  on('model.complete', (_$, e) => { const prompt = String(e.prompt); prompts.push(prompt); return { value: { isAnswered: true, text: typeof extract === 'string' ? extract : extract(prompt), usage: USAGE } } as never })
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  return { submitted, filled, ran, agentRows, opened, statuses, panes, files, prompts }
}

const EXTRACT = '{"questions":["Should the undone list survive /clear?"],"undone":["Dashboard regen was left for next session."]}'

test('a reply with a question and an undone item lands both in the pane', async ($, on) => {
  const { submitted, filled } = bottom(on, EXTRACT)
  await $.turn.complete({
    answer: 'I did the patch. Dashboard regen is left for next session. Should the undone list survive /clear?',
    durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer',
  } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agenda', surface, component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
    expect((await ui.find({ type: 'Text', text: /survive/ }))).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /Dashboard regen/ }))).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  const answer = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === '✎')
  expect(answer?.key).toBeDefined()
  await ui.press({ key: answer!.key! })
  expect(filled[0]).toMatch(/Answering your earlier question/)
  const doIt = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === '▶')
  await ui.press({ key: doIt!.key! })
  expect(submitted[0]).toMatch(/Dashboard regen/)
  expect((await ui.find({ type: 'Text', text: /Dashboard regen/ }))).toBeUndefined()
  await ui.unmount()
})

test('notes are added from the pane, kept in the store and injected into the system prompt', async ($, on) => {
  bottom(on, '{"questions":[],"undone":[]}')
  on('prompt.compose', () => ({ sections: [] }) as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  await ui.input({ key: 'new-note', text: 'Never pitch Wan as a Seedance substitute' })
  expect((await ui.find({ type: 'Text', text: /Seedance substitute/ }))).toBeDefined()
  await ui.unmount()
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  const section = composed.sections.find(s => s.id === 'agenda:notes')
  expect(section?.text).toMatch(/Seedance/)
})

test('subagent turns and duplicate items are ignored', async ($, on) => {
  bottom(on, EXTRACT)
  const base = { answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer' }
  await $.turn.complete({ ...base, turnId: 'a', agentId: 'agent-1' } as never)
  await $.turn.complete({ ...base, turnId: 'b' } as never)
  await $.turn.complete({ ...base, turnId: 'c' } as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect((await ui.find({ type: 'Text', text: /survive/ }))).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /Dashboard regen/ }))).toBeDefined()
  await ui.unmount()
})

test('running subagents are listed by their one-line description and the context gauge is drawn', async ($, on) => {
  const { agentRows } = bottom(on, '{"questions":[],"undone":[]}')
  agentRows.push({ id: 'ag1', description: 'Audit recipe schema', type: 'general-purpose', status: 'running' })
  agentRows.push({ id: 'ag2', description: 'Scan LoRA folder', type: 'Explore', status: 'completed' })
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Audit recipe schema/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Scan LoRA folder/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /60%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /120k \/ 200k/ })).toBeDefined()
  await ui.unmount()
})

test('handoff + clear forks a handoff, keeps it for the next session and runs /clear', async ($, on) => {
  const { ran } = bottom(on, '{"questions":[],"undone":[]}')
  on('prompt.compose', () => ({ sections: [] }) as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  await ui.press({ key: 'handoff' })
  expect(ran).toContain('clear')
  expect(await ui.find({ type: 'Text', text: /handoff loaded/ })).toBeDefined()
  await ui.unmount()
  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(composed.sections.find(s => s.id === 'agenda:handoff')?.text).toMatch(/Finish the pane/)
  await $.turn.complete({ answer: 'Picked up the handoff and finished the pane.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  const after = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] } as never)
  expect(after.sections.find(s => s.id === 'agenda:handoff')).toBeUndefined()
})

test('a subagent shows its macro-step plan from its assignment, ticked off by its activity, folded once it finishes', async ($, on) => {
  const { agentRows, prompts } = bottom(on, prompt =>
    prompt.startsWith('Description:')
      ? '{"steps":["Find every recipe that references the removed LoRA","Rewrite those recipes to the replacement","Run the recipe validator"]}'
      : '{"done":[1],"doing":2,"added":[]}',
  )
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag9' }) as never)
  agentRows.push({ id: 'ag9', description: 'Audit recipe schema', type: 'general-purpose', status: 'running' })
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'Find every recipe referencing the removed LoRA, rewrite them to the replacement, then run the validator.',
    description: 'Audit recipe schema', subagentType: 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false,
  } as never)
  // The plan is written in the background; a main-loop turn settles it, as in a live session.
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(prompts[0]).toMatch(/Assignment:\nFind every recipe/)
  // Open by default while running: every step is readable, none ticked yet.
  expect(await ui.find({ type: 'Text', text: /Find every recipe that references/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run the recipe validator/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeUndefined()
  await ui.unmount()
  const blocks = [
    { type: 'text', text: 'Found four recipes that reference the LoRA; now rewriting each one to point at the replacement file.' },
    { type: 'tool_use', name: 'Edit', input: { file_path: 'recipes/a.json' } },
  ]
  // The test kit keeps no transcript beneath the plugins, so the store rejects; the plugin's bookkeeping runs first.
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: blocks }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'u1', agentId: 'ag9' } as never).catch(() => undefined)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(prompts[prompts.length - 1]).toMatch(/Plan:\n1\. \[todo\] Find every recipe/)
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^◉$/ })).toBeDefined()
  await ui.unmount()
  // Finished: the row folds to a progress line and the step it was on counts as done; ▸ reopens it.
  agentRows[0] = { ...(agentRows[0] as object), status: 'completed' }
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'ta', agentId: 'ag9' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /2\/3 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Run the recipe validator/ })).toBeUndefined()
  await ui.press({ key: 'ag-ag9' })
  expect(await ui.find({ type: 'Text', text: /Run the recipe validator/ })).toBeDefined()
  await ui.unmount()
})

test('the pane is opened as the person\'s own ask on the first prompt of the session', async ($, on) => {
  const { opened } = bottom(on, '{"questions":[],"undone":[]}')
  await $.prompt.submit({ text: 'hello' } as never)
  await $.prompt.submit({ text: 'again' } as never)
  expect(opened).toHaveLength(1)
})

test('the status line carries counts only while the pane is off screen', async ($, on) => {
  const { statuses, panes } = bottom(on, EXTRACT)
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  // Mounting settles the background scan the turn started.
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  await ui.unmount()
  expect(statuses[statuses.length - 1]).toMatch(/1 open question · 1 undone/)
  panes.push({ id: 'agenda', title: 'Agenda', isShown: true, isFocused: false, isPlaced: true })
  await $.command.run({ command: 'agenda', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  await ui.unmount()
  expect(statuses[statuses.length - 1]).toBeUndefined()
})

test('questions stay in the session; undone and notes are stored per project directory', async ($, on) => {
  const store: Record<string, unknown> = { 'agenda:v1': { notes: [{ id: 'n1', text: 'legacy note', at: '' }], undone: [], questions: [{ id: 'q0', text: 'old question', at: '' }] } }
  bottom(on, EXTRACT, store)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/tmp/proj', surface: 'terminal', isInteractive: true } as never)
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /legacy note/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old question/ })).toBeUndefined()
  await ui.unmount()
  const stored = store['agenda:v2:c:/tmp/proj'] as Record<string, unknown>
  expect(stored).toBeDefined()
  expect(stored.questions).toBeUndefined()
  expect(Array.isArray(stored.undone) && stored.undone.length).toBe(1)
  expect(store['agenda:v1']).toBeUndefined()
})

test('a missing theme file is written with the defaults; an edited one restyles the pane and survives as a separate file', async ($, on) => {
  const files: Files = {}
  const { statuses } = bottom(on, '{"questions":[],"undone":[]}', undefined, files)
  on('session.start', (_$, e) => ({ cwd: e.cwd }) as never)
  on('clock.every', () => ({ value: undefined }) as never)
  await $.session.start({ cwd: 'C:/tmp/proj', surface: 'terminal', isInteractive: true } as never)
  const path = 'C:/Users/me/.claude/agenda.theme.json'
  expect(files[path]).toBeDefined()
  expect(JSON.parse(files[path]!).glyphs.answer).toBe('✎')
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /^QUESTIONS$/ })).toBeDefined()
  await ui.unmount()
  files[path] = JSON.stringify({ labels: { questions: 'ASKS' }, glyphs: { answer: 'A' }, gauge: { warnAt: 10 } })
  await $.command.run({ command: 'agenda', args: '', origin: { kind: 'composer' }, presentation: 'inline' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /^ASKS$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /A answer · ▶ do/ })).toBeDefined()
  await ui.unmount()
  expect(statuses.length).toBeGreaterThanOrEqual(0)
})

test('a question answered through the ✎ button leaves the pane when that prompt is sent', async ($, on) => {
  const { filled } = bottom(on, EXTRACT)
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  const answer = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === '✎')
  await ui.press({ key: answer!.key! })
  await ui.unmount()
  expect(filled[0]).toMatch(/survive/)
  await $.prompt.submit({ text: `${filled[0]}yes, keep it`, origin: { kind: 'composer' } } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /survive/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Dashboard regen/ })).toBeDefined()
  await ui.unmount()
})

test('a question the user answers in their own words is dropped by the next scan', async ($, on) => {
  const { prompts } = bottom(on, prompt => {
    const m = /Recorded open questions \(id: text\):\n([a-z0-9-]+): Should the undone list survive/.exec(prompt)
    return m ? `{"questions":[],"answered":["${m[1]}"],"undone":[],"resolved":[]}` : EXTRACT
  })
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /survive/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'Yes, it should survive /clear.', origin: { kind: 'composer' } } as never)
  await $.turn.complete({ answer: 'Understood, the undone list now survives /clear.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /survive/ })).toBeUndefined()
  await ui.unmount()
  expect(prompts[1]).toMatch(/Recorded open questions \(id: text\):\n[a-z0-9-]+: Should the undone list survive/)
})

test('an undone item is dropped once a later reply resolves it, and the scan sees the request and the recorded list', async ($, on) => {
  const { prompts } = bottom(on, prompt => {
    const m = /Recorded unfinished items \(id: text\):\n([a-z0-9-]+): Dashboard regen/.exec(prompt)
    return m ? `{"questions":[],"undone":[],"resolved":["${m[1]}"]}` : EXTRACT
  })
  await $.prompt.submit({ text: 'Regenerate the dashboard please', origin: { kind: 'composer' } } as never)
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as never)
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Dashboard regen/ })).toBeDefined()
  await ui.unmount()
  expect(prompts[0]).toMatch(/User's request:\nRegenerate the dashboard/)
  await $.turn.complete({ answer: 'Dashboard regenerated and verified.', durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Dashboard regen/ })).toBeUndefined()
  await ui.unmount()
})

test('a pane taller than its window draws a scrollbar whose thumb follows the scroll; a short one draws none', async ($, on) => {
  const items = Array.from({ length: 30 }, (_, i) => `"Undone item number ${i} needs a follow-up pass"`)
  bottom(on, `{"questions":[],"undone":[${items.join(',')}]}`)
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  // Track cells in tree order, top row first; the indexes of the thumb's cells.
  const thumbRows = async (ui: { findAll: (q: { type: 'Text'; text: RegExp }) => Promise<readonly { text?: string }[]> }) =>
    (await ui.findAll({ type: 'Text', text: /^[┃│]$/ })).flatMap((one, i) => (one.text === '┃' ? [i] : []))
  for (const surface of ['terminal', 'desktop'] as const) {
    const top = await $.ui.mount({ plugin: 'agenda', surface, component: 'Pane', props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 20 } }, requestId: 'agenda' })
    const atTop = await thumbRows(top)
    expect(atTop.length).toBeGreaterThan(0)
    expect(atTop[0]).toBe(0)
    expect((await top.findAll({ type: 'Text', text: /^[┃│]$/ })).length).toBe(20)
    await top.unmount()
    const end = await $.ui.mount({ plugin: 'agenda', surface, component: 'Pane', props: { ...PANE_PROPS, scroll: { offset: 999, bodyRows: 20 } }, requestId: 'agenda' })
    const atEnd = await thumbRows(end)
    expect(atEnd[atEnd.length - 1]).toBe(19)
    await end.unmount()
    const tall = await $.ui.mount({ plugin: 'agenda', surface, component: 'Pane', props: { ...PANE_PROPS, scroll: { offset: 0, bodyRows: 200 } }, requestId: 'agenda' })
    expect((await tall.findAll({ type: 'Text', text: /^[┃│]$/ })).length).toBe(0)
    await tall.unmount()
  }
})

test('idle subagents count as finished, and clearing finished rows keeps them gone across refreshes', async ($, on) => {
  const { agentRows } = bottom(on, '{"questions":[],"undone":[]}')
  agentRows.push({ id: 'a1', description: 'Audit recipe schema', type: 'general-purpose', status: 'running' })
  agentRows.push({ id: 'a2', description: 'Scan LoRA folder', type: 'Explore', status: 'idle' })
  agentRows.push({ id: 'a3', description: 'Hash the checkpoints', type: 'general-purpose', status: 'completed' })
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  let ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  // Only the running agent counts as active.
  expect(await ui.find({ type: 'Text', text: /^1$/ })).toBeDefined()
  await ui.press({ key: 'clear-agents' })
  expect(await ui.find({ type: 'Text', text: /Scan LoRA folder/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Hash the checkpoints/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Audit recipe schema/ })).toBeDefined()
  await ui.unmount()
  // The engine still lists them; a refresh must not bring them back.
  await $.turn.complete({ answer: 'y'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Hash the checkpoints/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'clear-agents' } as never)).toBeUndefined()
  await ui.unmount()
  // A cleared agent that is messaged awake shows again.
  agentRows[1] = { ...(agentRows[1] as object), status: 'running' }
  await $.turn.complete({ answer: 'z'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't3' } as never)
  ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Scan LoRA folder/ })).toBeDefined()
  await ui.unmount()
})

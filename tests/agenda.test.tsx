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

function bottom(on: Parameters<Parameters<typeof test>[1] extends infer B ? (B extends (...a: infer A) => unknown ? A[1] : never) : never>[0], extract: string) {
  const submitted: string[] = []
  const filled: string[] = []
  const ran: string[] = []
  const agentRows: unknown[] = []
  mock.store(on)
  on('command.register', () => ({ value: { isRegistered: true } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  on('turn.complete', (_$, e) => ({ text: e.answer }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 120000, window: 200000, percent: 60 }, rateLimits: [], cost: { usd: 1.25 } } }) as never)
  on('agent.list', () => ({ value: agentRows }) as never)
  on('model.fork', () => ({ value: { isAnswered: true, text: HANDOFF_TEXT, usage: USAGE } }) as never)
  on('session.cwd', () => ({ value: 'C:/tmp/proj' }) as never)
  on('fs.write', () => ({ value: undefined }) as never)
  on('command.run', (_$, e) => { ran.push(e.command); return { text: '' } as never })
  on('model.complete', () => ({ value: { isAnswered: true, text: extract, usage: USAGE } }) as never)
  on('prompt.submit', (_$, e) => {
    submitted.push(e.text)
    return { text: e.text } as never
  })
  on('prompt.fill', (_$, e) => {
    filled.push(e.text)
    return { isFilled: true } as never
  })
  return { submitted, filled, ran, agentRows }
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
  const answer = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === 'answer')
  expect(answer?.key).toBeDefined()
  await ui.press({ key: answer!.key! })
  expect(filled[0]).toMatch(/Answering your earlier question/)
  const doIt = (await ui.findAll({ type: 'Button' })).find(b => b.props.label === 'do it')
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

test('a subagent gets one-sentence task summaries from its activity, collapsed by default', async ($, on) => {
  const { agentRows } = bottom(on, 'Read the three recipe files that reference the removed LoRA.')
  agentRows.push({ id: 'ag9', description: 'Audit recipe schema', type: 'general-purpose', status: 'running' })
  await $.turn.complete({ answer: 'x'.repeat(40), durationMs: 1, isAborted: false, reason: 'answer', turnId: 't' } as never)
  const blocks = [
    { type: 'text', text: 'I will start by reading every recipe that references the LoRA so I know the blast radius.' },
    { type: 'tool_use', name: 'Read', input: { file_path: 'recipes/a.json' } },
  ]
  // The test kit keeps no transcript beneath the plugins, so the store rejects; the plugin's bookkeeping runs first.
  await $.session.append({ message: { type: 'assistant', role: 'assistant', content: blocks }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'u1', agentId: 'ag9' } as never).catch(() => undefined)
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'ta', agentId: 'ag9' } as never)
  const ui = await $.ui.mount({ plugin: 'agenda', surface: 'terminal', component: 'Pane', props: PANE_PROPS, requestId: 'agenda' })
  expect(await ui.find({ type: 'Text', text: /Read the three recipe files/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\. Read the three/ })).toBeUndefined()
  await ui.press({ key: 'ag-ag9' })
  expect(await ui.find({ type: 'Text', text: /1\. Read the three recipe files/ })).toBeDefined()
  await ui.unmount()
})

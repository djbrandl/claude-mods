export type AgendaItem = {
  id: string
  text: string
  /** ISO date the item was captured. */
  at: string
}

export type AgentRow = {
  id: string
  /** The Agent call's own few-word description of the task. */
  description: string
  type: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  startedAt: number
  endedAt?: number
  /** The macro steps its assignment asks for, in order, each ticked off as its activity shows progress. */
  plan: PlanStep[]
}

export type PlanStep = {
  text: string
  state: 'todo' | 'doing' | 'done'
}

export type ContextGauge = {
  tokens: number
  window: number
  percent: number
  /** API list-price equivalent of the session so far; the user is on a subscription, shown for comparison. */
  usd: number
}

export type Handoff = {
  text: string
  /** ISO date the handoff was written. */
  at: string
}

declare module 'claude-code' {
  interface PluginState {
    agenda: {
      questions: AgendaItem[]
      undone: AgendaItem[]
      notes: AgendaItem[]
      agents: AgentRow[]
      toggledAgents: string[]
      context: ContextGauge | null
      handoff: Handoff | null
      scanning: boolean
      handingOff: boolean
      theme: Theme
    }
  }
}

export type StatusLook = { glyph: string; color: string }

/** Everything a person may restyle; read from the theme file, defaults filled in. */
export type Theme = {
  colors: { background: string; text: string; dim: string; muted: string; success: string }
  sections: { context: string; agents: string; questions: string; undone: string; notes: string }
  gauge: { ok: string; warn: string; danger: string; warnAt: number; dangerAt: number; filled: string; empty: string }
  status: {
    pending: StatusLook
    running: StatusLook
    waiting: StatusLook
    idle: StatusLook
    completed: StatusLook
    failed: StatusLook
    killed: StatusLook
  }
  glyphs: {
    answer: string
    do: string
    doAll: string
    dismiss: string
    dismissAll: string
    expand: string
    collapse: string
    bullet: string
    stepTodo: string
    stepDoing: string
    stepDone: string
  }
  labels: { context: string; agents: string; questions: string; undone: string; notes: string; handoff: string; dropHandoff: string }
  scrollbar: { thumb: string; track: string; thumbColor: string; trackColor: string }
}

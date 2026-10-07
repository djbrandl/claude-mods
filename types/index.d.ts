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
  /** One-sentence summaries of the work it has done so far, oldest first. */
  tasks: string[]
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
      expandedAgents: string[]
      context: ContextGauge | null
      handoff: Handoff | null
      scanning: boolean
      handingOff: boolean
    }
  }
}

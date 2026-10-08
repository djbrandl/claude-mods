import type { Theme } from '../types'

export const THEME_DOC =
  'Styling for the Claude Code agenda pane. Edit any value, then run /agenda to reload. Colours are hex or terminal names; glyphs are any text. Plugin updates never touch this file. Delete it to get the defaults back.'

// Deep Space palette (Tokyo Night Moon derived), matching the author's WezTerm background.
export const DEFAULT_THEME: Theme = {
  colors: { background: '#0a0d1a', text: '#c8d3f5', dim: '#545c7e', muted: '#828bb8', success: '#c3e88d' },
  sections: { context: '#c099ff', agents: '#82aaff', questions: '#ffc777', undone: '#ff757f', notes: '#86e1fc' },
  gauge: { ok: '#c099ff', warn: '#ffc777', danger: '#ff757f', warnAt: 50, dangerAt: 75, filled: '█', empty: '░' },
  status: {
    pending: { glyph: '○', color: '#828bb8' },
    running: { glyph: '●', color: '#82aaff' },
    waiting: { glyph: '◐', color: '#ffc777' },
    idle: { glyph: '◐', color: '#ffc777' },
    completed: { glyph: '✓', color: '#c3e88d' },
    failed: { glyph: '✗', color: '#ff757f' },
    killed: { glyph: '✗', color: '#ff757f' },
  },
  glyphs: {
    answer: '✎',
    do: '▶',
    doAll: '▶▶ all',
    dismiss: '✕',
    dismissAll: '✕ all',
    expand: '▸',
    collapse: '▾',
    bullet: '▎',
    stepTodo: '○',
    stepDoing: '◉',
    stepDone: '✓',
  },
  labels: {
    context: 'CONTEXT',
    agents: 'AGENTS',
    questions: 'QUESTIONS',
    undone: 'UNDONE',
    notes: 'NOTES',
    handoff: 'handoff + clear',
    dropHandoff: 'drop pending handoff',
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Fills a partial theme in over the defaults, keeping only values of the right type. */
function fill<T>(base: T, raw: unknown): T {
  if (!isRecord(raw) || !isRecord(base)) return base
  const out: Record<string, unknown> = { ...base }
  for (const key of Object.keys(base)) {
    const want = (base as Record<string, unknown>)[key]
    const got = raw[key]
    if (got === undefined) continue
    if (isRecord(want)) out[key] = fill(want, got)
    else if (typeof want === typeof got && (typeof got !== 'string' || got.length > 0)) out[key] = got
  }
  return out as T
}

export function mergeTheme(raw: unknown): Theme {
  const theme = fill(DEFAULT_THEME, raw)
  theme.gauge.warnAt = Math.max(0, Math.min(100, theme.gauge.warnAt))
  theme.gauge.dangerAt = Math.max(theme.gauge.warnAt, Math.min(100, theme.gauge.dangerAt))
  return theme
}

export function legend(theme: Theme): string {
  const g = theme.glyphs
  return `${g.answer} answer · ${g.do} do · ${g.dismiss} dismiss · ${g.expand} expand`
}

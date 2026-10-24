export type Mode = 'on' | 'off'

/** A reasoning effort level, lowest first. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** The judge's difficulty labels, easiest first. */
export type Label = 'trivial' | 'routine' | 'involved' | 'open'

/** The four token counts as the API spells them. */
export type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

/** The options in plugin.json's userConfig, parsed with defaults filled in. */
export type Config = {
  enabled: boolean
  /** The effort for each label. */
  efforts: Record<Label, Effort>
  /** Full model id of the judge. */
  judgeModel: string
  /** How long a turn waits for the judge, in milliseconds. */
  timeoutMs: number
  /** Subagent requests above this level are lowered to it; null leaves subagents alone. */
  subagentCap: Effort | null
  /** Directory for the per-session logs; null means ~/.claude/auto-effort. */
  logDir: string | null
}

/**
 * Where a turn's effort came from.
 * judge: the judge's label. inherit: a skipped prompt reusing the last judged effort.
 * ultrathink: the keyword. pin: /auto-effort pin. fallback: the judge failed.
 * off: the mod is off. env: CLAUDE_CODE_EFFORT_LEVEL is set, so the mod defers.
 */
export type Source = 'judge' | 'inherit' | 'ultrathink' | 'pin' | 'fallback' | 'off' | 'env'

/** The decision for one main-loop turn. */
export type Decision = {
  turnId: string
  source: Source
  label: Label | null
  /** The effort chosen before clamping; null leaves the session's effort. */
  effort: Effort | null
  /** Why a skip or a fallback happened (`ack`, `timeout`, `api-error`, ...). */
  reason: string | null
  judgeMs: number | null
  judgeUsage: Usage | null
  /** Filled at the turn's first step: the step's model, the session's effort, and what was sent. */
  model: string | null
  sessionEffort: string | number | null
  sentEffort: string | number | null
  steps: number
}

/** What the mod keeps for the session. Lives in $.state, so it survives a hot reload. */
export type Session = {
  /** A /auto-effort on|off override for this session; null follows the `enabled` option. */
  mode: Mode | null
  /** A /auto-effort pin level; null judges. */
  pin: Effort | null
  /** The current (or last) main turn's decision. */
  decision: Decision | null
  /** The effort of the last judged turn, which skipped prompts reuse. */
  lastJudged: Effort | null
  /** A log write failed this session and was reported. */
  logFailed: boolean
}

/** One line of the decision log. No prompt text. */
export type LogRecord = {
  ts: string
  turnId: string
  source: Source
  label: Label | null
  reason: string | null
  effort: Effort | null
  model: string | null
  sessionEffort: string | number | null
  sentEffort: string | number | null
  steps: number
  judgeMs: number | null
  judgeUsage: Usage | null
  usage: Usage | null
  durationMs: number
  outcome: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-effort': { session: Shaped<Session> }
  }
}

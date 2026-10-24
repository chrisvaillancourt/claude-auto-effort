import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  INITIAL,
  JUDGE_SYSTEM,
  USAGE,
  configFrom,
  isActive,
  judgePrompt,
  judgedDecision,
  logRecord,
  parseArgs,
  parseLabel,
  parseLog,
  planTurn,
  statsText,
  statusLine,
  statusText,
  stepEffort,
} from './policy'
import type { JudgeOutcome } from './policy'
import type { Config, Decision, Label, LogRecord, Session, Usage } from '../types'

const NAME = 'auto-effort'

// Change the shape tag when Session's fields change: a value an older version
// stored (it outlives a hot reload) then reads as INITIAL instead of breaking.
const sessionAtom = atom({ plugin: 'auto-effort', key: 'session' } as const, INITIAL, { shape: 'session-2' })

// Module variables reset on a hot reload; register runs again then.
// Anything that must persist goes in $.state.
let config: Config = configFrom({}).config
let problems: string[] = []

/** Best effort: reporting must never throw out of a hook. */
function log($: EngineInterface, text: string) {
  try {
    $.ui.log(`${NAME}: ${text}`)
  } catch {
    // nothing to do
  }
}

function showStatus($: EngineInterface, s: Session) {
  try {
    $.ui.status(statusLine(isActive(config, s), s.decision))
  } catch {
    // best effort
  }
}

function usageOf(u: Usage | null | undefined): Usage | null {
  if (!u) return null
  const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = u
  return { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
}

/** One judge call, bounded by `timeoutMs`; never throws. */
async function judge($: EngineInterface, text: string, signal: AbortSignal): Promise<JudgeOutcome> {
  const started = Date.now()
  try {
    const r = await $.model.complete(
      { model: config.judgeModel, system: JUDGE_SYSTEM, prompt: judgePrompt(text), effort: 'low', maxTokens: 16, timeoutMs: config.timeoutMs },
      { signal },
    )
    const ms = Date.now() - started
    const usage = usageOf(r.usage)
    if (!r.isAnswered) {
      const failure = r.reason === 'aborted' ? (signal.aborted ? 'interrupted' : 'timeout') : r.reason
      return { failure, ms, usage }
    }
    const label: Label | undefined = parseLabel(r.text)
    return label ? { label, ms, usage } : { failure: 'bad-label', ms, usage }
  } catch {
    // The engine refused to send it (a blocked model, say).
    return { failure: 'refused', ms: Date.now() - started, usage: null }
  }
}

async function logDir($: EngineInterface): Promise<string | null> {
  if (config.logDir) return config.logDir
  const home = await $.env.get('HOME')
  return home ? `${home}/.claude/auto-effort` : null
}

async function readLog($: EngineInterface, path: string): Promise<string> {
  return (await $.fs.exists(path)) ? await $.fs.read(path) : ''
}

/** Appends one record to this session's log; reports the first failure and never throws. */
async function writeLog($: EngineInterface, record: LogRecord) {
  try {
    const dir = await logDir($)
    if (!dir) throw new Error('HOME is not set and logDir is empty')
    const path = `${dir}/${await $.session.id()}.jsonl`
    await $.fs.write(path, `${await readLog($, path)}${JSON.stringify(record)}\n`)
  } catch (err) {
    try {
      const s = await read($, sessionAtom)
      if (s.logFailed) return
      await update($, sessionAtom, s => ({ ...s, logFailed: true }))
      log($, `could not write the decision log (${err instanceof Error ? err.message : String(err)}); decisions still apply`)
    } catch {
      // nothing more to do
    }
  }
}

async function stats($: EngineInterface): Promise<string> {
  const dir = await logDir($)
  if (!dir) return 'No log directory: HOME is not set and logDir is empty.'
  const mine = `${await $.session.id()}.jsonl`
  let session: LogRecord[] = []
  const all: LogRecord[] = []
  const entries = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.jsonl')) continue
    const records = parseLog(await readLog($, `${dir}/${entry.name}`))
    all.push(...records)
    if (entry.name === mine) session = records
  }
  return `${statsText(session, all)}\nLog: ${dir}`
}

export const register: Register = (on, options) => {
  ;({ config, problems } = configFrom(options))

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'auto-effort',
      description: 'Show or set how auto-effort picks the reasoning effort for this session',
      argumentHint: '[status|on|off|pin <level>|unpin|stats]',
    })
    for (const p of problems) log($, p)
    showStatus($, await read($, sessionAtom))
    return result
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, sessionAtom, s => ({ ...s, decision: null, lastJudged: null }))
      showStatus($, await read($, sessionAtom))
    }
    return next(e)
  })

  // Decide once per main turn. The turn waits for the judge at most timeoutMs;
  // any failure leaves the session's effort (fail open).
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const envEffort = await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')
    const planned = planTurn({ turnId: e.turnId, text: e.text, config, session: await read($, sessionAtom), envEffort })
    const decision: Decision = planned === 'judge' ? judgedDecision(e.turnId, config, await judge($, e.text, next.signal)) : planned
    await update($, sessionAtom, s => ({
      ...s,
      decision,
      lastJudged: decision.source === 'judge' ? decision.effort : s.lastJudged,
    }))
    showStatus($, await read($, sessionAtom))
    return next(e)
  })

  // Apply the turn's decision to every request; facts (off, pin, model) are read now.
  on('turn.step', async function* ($, e, next) {
    const s = await read($, sessionAtom)
    const effort = stepEffort(config, s, e, await $.env.get('CLAUDE_CODE_EFFORT_LEVEL'))
    if (e.agentId === undefined && s.decision?.turnId === e.turnId) {
      await update($, sessionAtom, cur => {
        const d = cur.decision
        if (!d || d.turnId !== e.turnId) return cur
        const first = d.steps === 0
        return {
          ...cur,
          decision: {
            ...d,
            steps: d.steps + 1,
            model: first ? e.model : d.model,
            sessionEffort: first ? e.effort ?? null : d.sessionEffort,
            sentEffort: first ? effort ?? e.effort ?? null : d.sentEffort,
          },
        }
      })
    }
    return yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort })
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const d = (await read($, sessionAtom)).decision
    if (d && d.turnId === e.turnId) {
      await writeLog($, logRecord(d, { ts: new Date().toISOString(), usage: usageOf(e.usage), durationMs: e.durationMs, outcome: e.reason }))
    }
    return next(e)
  })

  on('command.run', { command: 'auto-effort' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    if (cmd.kind === 'help') return { text: cmd.error ? `${cmd.error}\n${USAGE}` : USAGE }
    if (cmd.kind === 'stats') return { text: await stats($) }
    if (cmd.kind === 'set') await update($, sessionAtom, s => ({ ...s, mode: cmd.mode }))
    if (cmd.kind === 'pin') await update($, sessionAtom, s => ({ ...s, pin: cmd.effort }))
    if (cmd.kind === 'unpin') await update($, sessionAtom, s => ({ ...s, pin: null }))
    const s = await read($, sessionAtom)
    if (cmd.kind === 'pin' && isActive(config, s)) $.ui.status(`effort ${cmd.effort} · pinned`)
    else showStatus($, s)
    return { text: statusText(config, s, await $.env.get('CLAUDE_CODE_EFFORT_LEVEL')) }
  })
}

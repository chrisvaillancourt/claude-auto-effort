import { describe, expect, test } from 'claude-code/testing'

import {
  INITIAL,
  JUDGE_MAX_CHARS,
  clampEffort,
  configFrom,
  hasUltrathink,
  isActive,
  judgePrompt,
  judgedDecision,
  logRecord,
  parseArgs,
  parseLabel,
  parseLog,
  planTurn,
  skipReason,
  statsText,
  statusLine,
  stepEffort,
  supportedEfforts,
} from './policy'
import type { Decision, Session } from '../types'

const config = configFrom({}).config
const OPUS = 'claude-opus-5-5'

function decided(d: Partial<Decision>): Decision {
  return {
    turnId: 't1', source: 'judge', label: null, effort: null, reason: null, judgeMs: null, judgeUsage: null,
    model: null, sessionEffort: null, sentEffort: null, steps: 0, ...d,
  }
}

describe('options', () => {
  test('defaults', async () => {
    const { config: c, problems } = configFrom({})
    expect(problems).toEqual([])
    expect(c).toEqual({
      enabled: true,
      efforts: { trivial: 'low', routine: 'medium', involved: 'high', open: 'xhigh' },
      judgeModel: 'claude-haiku-5-5',
      timeoutMs: 4000,
      subagentCap: null,
      logDir: null,
    })
  })

  test('efforts, cap and logDir are read; bad values fall back with a problem', async () => {
    const ok = configFrom({ efforts: ' low, low ,medium,HIGH', subagentCap: 'medium', logDir: '/x/logs', timeoutMs: 2500 })
    expect(ok.config.efforts).toEqual({ trivial: 'low', routine: 'low', involved: 'medium', open: 'high' })
    expect(ok.config.subagentCap).toBe('medium')
    expect(ok.config.logDir).toBe('/x/logs')
    expect(ok.config.timeoutMs).toBe(2500)

    const bad = configFrom({ efforts: 'low,medium', subagentCap: 'huge', timeoutMs: -1, judgeModel: '' })
    expect(bad.config.efforts).toEqual(config.efforts)
    expect(bad.config.subagentCap).toBe(null)
    expect(bad.config.timeoutMs).toBe(4000)
    expect(bad.config.judgeModel).toBe('claude-haiku-5-5')
    expect(bad.problems.length).toBe(3)
    expect(configFrom({ subagentCap: 'off' }).problems).toEqual([])
  })

  test('a session override beats the enabled option', async () => {
    expect(isActive(config, INITIAL)).toBe(true)
    expect(isActive(configFrom({ enabled: false }).config, INITIAL)).toBe(false)
    expect(isActive(configFrom({ enabled: false }).config, { ...INITIAL, mode: 'on' })).toBe(true)
    expect(isActive(config, { ...INITIAL, mode: 'off' })).toBe(false)
  })
})

describe('prompt rules', () => {
  test('empty, slash commands and bare acknowledgements are skipped; short real prompts are not', async () => {
    expect(skipReason('')).toBe('empty')
    expect(skipReason('   \n')).toBe('empty')
    expect(skipReason('/review 12')).toBe('slash')
    expect(skipReason('Yes.')).toBe('ack')
    expect(skipReason('  go ahead!! ')).toBe('ack')
    expect(skipReason('LGTM')).toBe('ack')
    expect(skipReason('thank you')).toBe('ack')
    expect(skipReason('Yes, go ahead.')).toBe('ack')
    expect(skipReason('ok thanks')).toBe('ack')
    expect(skipReason('fix race')).toBe(null)
    expect(skipReason('yes, but rename it too')).toBe(null)
    expect(skipReason('/tmp/x is missing, why?')).toBe(null)
  })

  test('ultrathink is a whole word, any case', async () => {
    expect(hasUltrathink('please ultrathink about this')).toBe(true)
    expect(hasUltrathink('ULTRATHINK: the bug')).toBe(true)
    expect(hasUltrathink('ultrathinking')).toBe(false)
  })

  test('the judge prompt wraps and caps the request', async () => {
    expect(judgePrompt('rename foo')).toBe('<request>\nrename foo\n</request>')
    expect(judgePrompt('x'.repeat(JUDGE_MAX_CHARS + 500)).length).toBeLessThan(JUDGE_MAX_CHARS + 100)
  })

  test('parseLabel takes exactly one label word', async () => {
    expect(parseLabel('trivial')).toBe('trivial')
    expect(parseLabel(' Open.\n')).toBe('open')
    expect(parseLabel('`involved`')).toBe('involved')
    expect(parseLabel('routine or involved')).toBe(undefined)
    expect(parseLabel('hard')).toBe(undefined)
    expect(parseLabel('')).toBe(undefined)
  })
})

describe('models and clamping', () => {
  test('supportedEfforts knows current families and refuses unknown ids', async () => {
    const all = ['low', 'medium', 'high', 'xhigh', 'max']
    expect(supportedEfforts('claude-opus-5-5')).toEqual(all)
    expect(supportedEfforts('claude-haiku-5-5')).toEqual(all)
    expect(supportedEfforts('claude-sonnet-5-5[1m]')).toEqual(all)
    expect(supportedEfforts('claude-fable-5-1')).toEqual(all)
    expect(supportedEfforts('claude-opus-4-7')).toEqual(all)
    expect(supportedEfforts('claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max'])
    expect(supportedEfforts('us.anthropic.claude-sonnet-4-6-v1:0')).toEqual(['low', 'medium', 'high', 'max'])
    expect(supportedEfforts('claude-sonnet-4-5')).toBe(null)
    expect(supportedEfforts('gpt-6')).toBe(null)
  })

  test('clampEffort takes the highest supported level at or below, else the lowest', async () => {
    const four = ['low', 'medium', 'high', 'max'] as const
    expect(clampEffort('xhigh', four)).toBe('high')
    expect(clampEffort('max', four)).toBe('max')
    expect(clampEffort('low', ['medium', 'high'])).toBe('medium')
  })
})

describe('turn decisions', () => {
  const plan = (text: string, session: Session = INITIAL, envEffort?: string, c = config) =>
    planTurn({ turnId: 't1', text, config: c, session, envEffort })

  test('a real prompt goes to the judge', async () => {
    expect(plan('why does the cache miss after reload?')).toBe('judge')
  })

  test('off, env, pin and ultrathink decide without the judge, in that order', async () => {
    expect(plan('x', { ...INITIAL, mode: 'off', pin: 'low' }, 'high')).toMatchObject({ source: 'off', effort: null })
    expect(plan('x', { ...INITIAL, pin: 'low' }, 'high')).toMatchObject({ source: 'env', effort: null })
    expect(plan('ultrathink x', { ...INITIAL, pin: 'low' })).toMatchObject({ source: 'pin', effort: 'low' })
    expect(plan('ultrathink x')).toMatchObject({ source: 'ultrathink', effort: 'max' })
    expect(plan('x', INITIAL, '')).toBe('judge')
  })

  test('a skipped prompt inherits the last judged effort, else the session effort', async () => {
    expect(plan('yes', { ...INITIAL, lastJudged: 'xhigh' })).toMatchObject({ source: 'inherit', effort: 'xhigh', reason: 'ack' })
    expect(plan('', INITIAL)).toMatchObject({ source: 'inherit', effort: null, reason: 'empty' })
  })

  test('judgedDecision maps a label through efforts and keeps failures at the session effort', async () => {
    const usage = { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    expect(judgedDecision('t1', config, { label: 'open', ms: 600, usage })).toMatchObject({
      source: 'judge', label: 'open', effort: 'xhigh', judgeMs: 600, judgeUsage: usage,
    })
    expect(judgedDecision('t1', config, { failure: 'timeout', ms: 4000, usage: null })).toMatchObject({
      source: 'fallback', effort: null, reason: 'timeout', judgeMs: 4000,
    })
  })
})

describe('step effort', () => {
  const step = (over: Partial<{ turnId: string; model: string; effort: string | number | undefined; agentId: string }> = {}) => ({
    turnId: 't1', model: OPUS, effort: 'high' as string | number | undefined, ...over,
  })
  const withDecision = (d: Partial<Decision>, s: Partial<Session> = {}): Session => ({ ...INITIAL, decision: decided(d), ...s })

  test('applies the turn decision clamped to the step model', async () => {
    const s = withDecision({ effort: 'xhigh' })
    expect(stepEffort(config, s, step())).toBe('xhigh')
    expect(stepEffort(config, s, step({ model: 'claude-opus-4-6' }))).toBe('high')
  })

  test('leaves the request alone for another turn, a fallback, an unknown model or no effort', async () => {
    const s = withDecision({ effort: 'low' })
    expect(stepEffort(config, s, step({ turnId: 't0' }))).toBe(undefined)
    expect(stepEffort(config, withDecision({ source: 'fallback' }), step())).toBe(undefined)
    expect(stepEffort(config, s, step({ model: 'some-proxy-model' }))).toBe(undefined)
    expect(stepEffort(config, s, step({ effort: undefined }))).toBe(undefined)
    expect(stepEffort(config, s, step({ effort: 2048 }))).toBe(undefined)
  })

  test('off and pin are read at step time; the env override never rewrites', async () => {
    expect(stepEffort(config, withDecision({ effort: 'low' }, { mode: 'off' }), step())).toBe(undefined)
    expect(stepEffort(config, withDecision({ effort: 'low' }, { pin: 'max' }), step())).toBe('max')
    expect(stepEffort(config, withDecision({ source: 'env', effort: null }, { pin: 'max' }), step(), 'high')).toBe(undefined)
  })

  test('CLAUDE_CODE_EFFORT_LEVEL set: no rewrite for any step, whatever the turn decision or cap', async () => {
    const capped = { ...config, subagentCap: 'low' as const }
    expect(stepEffort(capped, withDecision({ effort: 'low' }), step({ agentId: 'a1', effort: 'high' }), 'high')).toBe(undefined)
    expect(stepEffort(config, withDecision({ source: 'off' }, { pin: 'low' }), step(), 'high')).toBe(undefined)
    expect(stepEffort(config, withDecision({ effort: 'low' }), step(), 'high')).toBe(undefined)
    expect(stepEffort(config, withDecision({ effort: 'low' }), step(), '')).toBe('low')
  })

  test('subagents are left alone unless a cap lowers them', async () => {
    const s = withDecision({ effort: 'low' })
    expect(stepEffort(config, s, step({ agentId: 'a1', effort: 'xhigh' }))).toBe(undefined)
    const capped = { ...config, subagentCap: 'medium' as const }
    expect(stepEffort(capped, s, step({ agentId: 'a1', effort: 'xhigh' }))).toBe('medium')
    expect(stepEffort(capped, s, step({ agentId: 'a1', effort: 'low' }))).toBe(undefined)
    expect(stepEffort(capped, { ...s, mode: 'off' }, step({ agentId: 'a1', effort: 'max' }))).toBe(undefined)
  })
})

describe('commands and text', () => {
  test('parseArgs', async () => {
    expect(parseArgs('')).toEqual({ kind: 'status' })
    expect(parseArgs(' ON ')).toEqual({ kind: 'set', mode: 'on' })
    expect(parseArgs('off')).toEqual({ kind: 'set', mode: 'off' })
    expect(parseArgs('pin XHigh')).toEqual({ kind: 'pin', effort: 'xhigh' })
    expect(parseArgs('pin')).toMatchObject({ kind: 'help', error: expect.stringContaining('level') })
    expect(parseArgs('unpin')).toEqual({ kind: 'unpin' })
    expect(parseArgs('stats')).toEqual({ kind: 'stats' })
    expect(parseArgs('bogus')).toEqual({ kind: 'help', error: 'Unknown argument: bogus' })
  })

  test('statusLine says the effort and why', async () => {
    expect(statusLine(true, decided({ label: 'trivial', effort: 'low' }))).toBe('effort low · trivial')
    expect(statusLine(true, decided({ source: 'fallback', reason: 'timeout' }))).toBe('effort: session · judge timeout')
    expect(statusLine(true, decided({ source: 'inherit', effort: 'high', reason: 'ack' }))).toBe('effort high · kept')
    expect(statusLine(true, decided({ source: 'pin', effort: 'max' }))).toBe('effort max · pinned')
    expect(statusLine(true, decided({ source: 'env' }))).toBe('effort: CLAUDE_CODE_EFFORT_LEVEL')
    expect(statusLine(false, null)).toBe(undefined)
  })
})

describe('log and stats', () => {
  const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 }
  const rec = (d: Partial<Decision>, outcome = 'answer') =>
    logRecord(decided(d), { ts: '2026-10-23T00:00:00.000Z', usage, durationMs: 1200, outcome })

  test('a record carries the decision and the turn, with no prompt text', async () => {
    const r = rec({ label: 'routine', effort: 'medium', sentEffort: 'medium', judgeMs: 500 })
    expect(r).toMatchObject({ turnId: 't1', source: 'judge', label: 'routine', sentEffort: 'medium', judgeMs: 500, usage, durationMs: 1200 })
    expect(Object.keys(r)).not.toContain('text')
  })

  test('parseLog skips lines that are not records', async () => {
    const lines = `${JSON.stringify(rec({}))}\nnot json\n\n{"x":1}\n`
    expect(parseLog(lines).length).toBe(1)
  })

  test('statsText summarizes sources, efforts, latency, failures and tokens', async () => {
    const mine = [
      rec({ label: 'trivial', effort: 'low', sentEffort: 'low', judgeMs: 400, judgeUsage: usage }),
      rec({ label: 'open', effort: 'xhigh', sentEffort: 'xhigh', judgeMs: 800, judgeUsage: usage }),
      rec({ source: 'fallback', reason: 'timeout', judgeMs: 4000, sentEffort: 'high' }),
      rec({ source: 'inherit', reason: 'ack', effort: 'xhigh', sentEffort: 'xhigh' }),
    ]
    const text = statsText(mine, [...mine, ...mine])
    expect(text).toContain('This session: 4 turns')
    expect(text).toContain('judge 2, fallback 1, inherit 1')
    expect(text).toContain('low 1, high 1, xhigh 2')
    expect(text).toContain('timeout 1')
    expect(text).toContain('median 800 ms')
    expect(text).toContain('All logged sessions: 8 turns')
    expect(statsText([], [])).toContain('No turns logged yet')
  })
})

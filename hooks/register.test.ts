import { describe, expect, mock, test } from 'claude-code/testing'
import type { ModelCompleteResult, ModelUsage, On } from 'claude-code'

const OPUS = 'claude-opus-5-5'
const HOME = '/home/test'
const LOG_DIR = `${HOME}/.claude/auto-effort`
const SESSION = 'sess-1'
const USAGE: ModelUsage = { input_tokens: 300, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

type Reply = ModelCompleteResult | 'throw'

/** The engine beneath the plugin. */
const world = (on: On, env: Record<string, string> = {}) => {
  mock.env(on, { HOME, ...env })
  const files = new Map<string, string>()
  let failWrites = false
  on('fs.exists', ($, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(`${e.path}/`)) }))
  on('fs.read', ($, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`missing ${e.path}`)
    return { value: text }
  })
  on('fs.write', ($, e) => {
    if (failWrites) throw new Error('disk full')
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', ($, e) => {
    const dir = `${e.path}/`
    const names = [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length))
    return { value: names.map(name => ({ name, kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', () => ({ sessionId: SESSION }))
  on('session.id', () => ({ value: SESSION }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })

  const judged: { model: string; system?: unknown; prompt: unknown; effort?: string; maxTokens?: number; timeoutMs?: number }[] = []
  let reply: Reply = { isAnswered: true, text: 'open', usage: USAGE }
  on('model.complete', ($, e) => {
    judged.push({ model: e.model, system: e.system, prompt: e.prompt, effort: e.effort, maxTokens: e.maxTokens, timeoutMs: e.timeoutMs })
    if (reply === 'throw') throw new Error('blocked model')
    return { value: reply }
  })

  /** What each request was sent with, in order. */
  const sent: { turnId: string; effort: unknown; agentId?: string }[] = []
  on('turn.step', async function* ($, e) {
    sent.push({ turnId: e.turnId, effort: e.effort, ...(e.agentId ? { agentId: e.agentId } : {}) })
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: { ...USAGE, model: e.model } }
  })

  const logLines = () => (files.get(`${LOG_DIR}/${SESSION}.jsonl`) ?? '').split('\n').filter(Boolean).map(l => JSON.parse(l))
  return {
    files, statuses, logs, judged, sent, logLines,
    reply: (r: Reply) => (reply = r),
    failWrites: () => (failWrites = true),
  }
}

const start = ($: any) => $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
const command = ($: any, args: string) => $.command.run({ command: 'auto-effort', args, ...COMMAND })

let turnNo = 0
/** One main turn: start with `text`, `steps` requests, then complete. Returns the turn id. */
const turn = async ($: any, text: string, steps = 2, extra: Record<string, unknown> = {}) => {
  const turnId = `t${++turnNo}`
  await $.turn.start({ text, turnId, ...extra })
  for (let index = 0; index < steps; index++) {
    const s = $.turn.step({ turnId, index, model: OPUS, effort: 'high', messageCount: 2 + index, ...extra })
    for await (const _ of s);
  }
  await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId, reason: 'answer', usage: { ...USAGE, model: OPUS }, ...extra })
  return turnId
}

const effortsOf = (w: ReturnType<typeof world>, turnId: string) => w.sent.filter(s => s.turnId === turnId).map(s => s.effort)

describe('auto-effort', () => {
  test('judges a main prompt once and sends every request of the turn at the mapped effort', async ($, on) => {
    const w = world(on)
    await start($)
    const t = await turn($, 'our two services deadlock intermittently; find the cause', 3)

    expect(w.judged.length).toBe(1)
    expect(w.judged[0]).toMatchObject({ model: 'claude-haiku-5-5', effort: 'low', maxTokens: 16, timeoutMs: 4000 })
    expect(String(w.judged[0]?.system)).toContain('open-ended')
    expect(String(w.judged[0]?.prompt)).toContain('deadlock intermittently')
    expect(effortsOf(w, t)).toEqual(['xhigh', 'xhigh', 'xhigh'])
    expect(w.statuses.at(-1)).toBe('effort xhigh · open')
  })

  test('the efforts option remaps labels', { options: { efforts: 'medium,medium,medium,low' } }, async ($, on) => {
    const w = world(on)
    await start($)
    const t = await turn($, 'find the race')
    expect(effortsOf(w, t)).toEqual(['low', 'low'])
  })

  for (const [name, reply, reason] of [
    ['an api error', { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }, 'api-error'],
    ['a timeout', { isAnswered: false, reason: 'aborted', usage: USAGE }, 'timeout'],
    ['a reply that is no label', { isAnswered: true, text: 'This looks hard to me.', usage: USAGE }, 'bad-label'],
    ['a refused call', 'throw', 'refused'],
  ] as const) {
    test(`${name} leaves the turn at the session effort`, async ($, on) => {
      const w = world(on)
      await start($)
      w.reply(reply as Reply)
      const t = await turn($, 'design the retry policy')
      expect(effortsOf(w, t)).toEqual(['high', 'high'])
      expect(w.statuses.at(-1)).toBe(`effort: session · judge ${reason}`)
      expect(w.logLines().at(-1)).toMatchObject({ source: 'fallback', reason, sentEfforts: ['high', 'high'] })
    })
  }

  test('an acknowledgement keeps the last judged effort without a judge call', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'find the race')
    const t = await turn($, 'yes, go ahead.')
    expect(w.judged.length).toBe(1)
    expect(effortsOf(w, t)).toEqual(['xhigh', 'xhigh'])
    const empty = await turn($, '')
    expect(effortsOf(w, empty)).toEqual(['xhigh', 'xhigh'])
    expect(w.judged.length).toBe(1)
  })

  test('ultrathink sends max for that turn only', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply({ isAnswered: true, text: 'trivial', usage: USAGE })
    const t1 = await turn($, 'ultrathink: why is this flaky')
    const t2 = await turn($, 'rename foo')
    const t3 = await turn($, 'ok')
    expect(w.judged.length).toBe(1)
    expect(effortsOf(w, t1)).toEqual(['max', 'max'])
    expect(effortsOf(w, t2)).toEqual(['low', 'low'])
    expect(effortsOf(w, t3)).toEqual(['low', 'low'])
  })

  test('subagent turns are not judged and their requests keep their effort', async ($, on) => {
    const w = world(on)
    await start($)
    const main = `t${turnNo + 1}`
    await $.turn.start({ text: 'find the race', turnId: main })
    const sub = await turn($, 'search the repo', 2, { agentId: 'a1' })
    expect(w.judged.length).toBe(1)
    expect(effortsOf(w, sub)).toEqual(['high', 'high'])
    // A subagent step carrying the main turn's id still is not the main loop.
    const s = $.turn.step({ turnId: main, index: 0, model: OPUS, effort: 'high', messageCount: 1, agentId: 'a2' })
    for await (const _ of s);
    expect(w.sent.at(-1)).toEqual({ turnId: main, effort: 'high', agentId: 'a2' })
  })

  test('subagentCap lowers subagent requests above it', { options: { subagentCap: 'medium' } }, async ($, on) => {
    const w = world(on)
    await start($)
    const sub = await turn($, 'search', 1, { agentId: 'a1' })
    expect(effortsOf(w, sub)).toEqual(['medium'])
  })

  test('a step of a turn the mod did not decide is left alone', async ($, on) => {
    const w = world(on)
    await start($)
    const s = $.turn.step({ turnId: 'before-load', index: 0, model: OPUS, effort: 'high', messageCount: 1 })
    for await (const _ of s);
    expect(w.sent).toEqual([{ turnId: 'before-load', effort: 'high' }])
  })

  test('off takes effect on the next request; on, pin and unpin', async ($, on) => {
    const w = world(on)
    await start($)
    const turnId = `t${++turnNo}`
    await $.turn.start({ text: 'find the race', turnId })
    const stepOnce = async (index: number) => {
      const s = $.turn.step({ turnId, index, model: OPUS, effort: 'high', messageCount: 1 })
      for await (const _ of s);
    }
    await stepOnce(0)
    expect((await command($, 'off')).text).toContain('off (set for this session)')
    expect(w.statuses.at(-1)).toBe(undefined)
    await stepOnce(1)
    expect((await command($, 'pin low')).text).toContain('Pinned at low')
    await command($, 'on')
    await stepOnce(2)
    await command($, 'unpin')
    await stepOnce(3)
    expect(effortsOf(w, turnId)).toEqual(['xhigh', 'high', 'low', 'xhigh'])

    await command($, 'pin medium')
    const pinned = await turn($, 'design the retry policy')
    expect(effortsOf(w, pinned)).toEqual(['medium', 'medium'])
    expect(w.judged.length).toBe(1)
  })

  for (const [name, model, effort, sent, status] of [
    ['clamped to the model', 'claude-opus-4-6', 'high', 'high', 'effort high (xhigh clamped) · pinned'],
    ['left alone on an unknown model', 'proxy-custom-model', 'high', 'high', 'effort: unchanged (unknown model)'],
    ['left alone on a model without effort', OPUS, undefined, undefined, 'effort: unchanged (model takes no effort)'],
  ] as const) {
    test(`the status line says what was sent: ${name}`, async ($, on) => {
      const w = world(on)
      await start($)
      await command($, 'pin xhigh')
      const turnId = `t${++turnNo}`
      await $.turn.start({ text: 'explain the race', turnId })
      const s = $.turn.step({ turnId, index: 0, model, effort, messageCount: 1 })
      for await (const _ of s);
      expect(effortsOf(w, turnId)).toEqual([sent])
      expect(w.statuses.at(-1)).toBe(status)
    })
  }

  test('the enabled option off judges nothing until /auto-effort on', { options: { enabled: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    const t1 = await turn($, 'find the race')
    expect(w.judged.length).toBe(0)
    expect(effortsOf(w, t1)).toEqual(['high', 'high'])
    await command($, 'on')
    const t2 = await turn($, 'find the race')
    expect(effortsOf(w, t2)).toEqual(['xhigh', 'xhigh'])
  })

  test('CLAUDE_CODE_EFFORT_LEVEL set: no judge and no rewrite, even when pinned', async ($, on) => {
    const w = world(on, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })
    await start($)
    await command($, 'pin low')
    const t = await turn($, 'find the race')
    expect(w.judged.length).toBe(0)
    expect(effortsOf(w, t)).toEqual(['high', 'high'])
    expect((await command($, 'status')).text).toContain('CLAUDE_CODE_EFFORT_LEVEL=high is set')
  })

  test('CLAUDE_CODE_EFFORT_LEVEL set: a subagent cap does not rewrite', { options: { subagentCap: 'low' } }, async ($, on) => {
    const w = world(on, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })
    await start($)
    const sub = await turn($, 'search', 1, { agentId: 'a1' })
    expect(effortsOf(w, sub)).toEqual(['high'])
  })

  test('CLAUDE_CODE_EFFORT_LEVEL set: on and pin mid-turn do not rewrite', { options: { enabled: false } }, async ($, on) => {
    const w = world(on, { CLAUDE_CODE_EFFORT_LEVEL: 'high' })
    await start($)
    const turnId = `t${++turnNo}`
    await $.turn.start({ text: 'explain the race', turnId })
    await command($, 'pin low')
    await command($, 'on')
    const s = $.turn.step({ turnId, index: 0, model: OPUS, effort: 'high', messageCount: 1 })
    for await (const _ of s);
    expect(effortsOf(w, turnId)).toEqual(['high'])
  })

  test('each main turn logs one line without prompt text, and stats summarizes it', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'find the secret race in billing')
    await turn($, 'yes')
    await turn($, 'search', 1, { agentId: 'a1' })
    const lines = w.logLines()
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatchObject({
      source: 'judge', label: 'open', effort: 'xhigh', model: OPUS, sessionEffort: 'high', sentEfforts: ['xhigh', 'xhigh'], steps: 2,
      judgeUsage: USAGE, durationMs: 900, outcome: 'answer',
    })
    expect(typeof lines[0].judgeMs).toBe('number')
    expect(lines[1]).toMatchObject({ source: 'inherit', reason: 'ack', sentEfforts: ['xhigh', 'xhigh'] })
    expect(JSON.stringify(lines)).not.toContain('billing')

    w.files.set(`${LOG_DIR}/other.jsonl`, `${JSON.stringify(lines[0])}\n`)
    const stats = (await command($, 'stats')).text
    expect(stats).toContain('This session: 2 turns')
    expect(stats).toContain('All logged sessions: 3 turns')
  })

  test('a turn whose requests went at different efforts is logged and counted as mixed', async ($, on) => {
    const w = world(on)
    await start($)
    w.reply({ isAnswered: true, text: 'trivial', usage: USAGE })
    const turnId = `t${++turnNo}`
    await $.turn.start({ text: 'rename foo to bar', turnId })
    const stepOnce = async (index: number) => {
      const s = $.turn.step({ turnId, index, model: OPUS, effort: 'high', messageCount: 1 })
      for await (const _ of s);
    }
    await stepOnce(0)
    await command($, 'pin max')
    await stepOnce(1)
    await $.turn.complete({ answer: 'done', durationMs: 900, isAborted: false, turnId, reason: 'answer', usage: { ...USAGE, model: OPUS } })
    expect(effortsOf(w, turnId)).toEqual(['low', 'max'])
    expect(w.logLines().at(-1)).toMatchObject({ sentEfforts: ['low', 'max'], steps: 2 })
    const stats = (await command($, 'stats')).text
    expect(stats).toContain('effort sent: mixed 1')
    expect(stats).not.toContain('low 1')
  })

  test('the logDir option moves the log', { options: { logDir: '/logs/ae/' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'rename foo')
    expect(w.files.has(`/logs/ae/${SESSION}.jsonl`)).toBe(true)
  })

  test('a failed log write never breaks the turn and is reported once', async ($, on) => {
    const w = world(on)
    await start($)
    w.failWrites()
    const t1 = await turn($, 'find the race')
    await turn($, 'find the race')
    expect(effortsOf(w, t1)).toEqual(['xhigh', 'xhigh'])
    expect(w.logs.filter(l => l.includes('could not write')).length).toBe(1)
  })

  test('/clear forgets the inherited effort', async ($, on) => {
    const w = world(on)
    await start($)
    await turn($, 'find the race')
    await $.session.end({ reason: 'clear', sessionId: SESSION, resume: { id: SESSION } })
    const t = await turn($, 'yes')
    expect(effortsOf(w, t)).toEqual(['high', 'high'])
  })

  test('bad options are reported at session start', { options: { efforts: 'fast' } }, async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.logs.some(l => l.includes('efforts "fast"'))).toBe(true)
  })

  test('an unknown argument answers with usage', async ($, on) => {
    world(on)
    await start($)
    expect((await command($, 'bogus')).text).toContain('Usage: /auto-effort')
  })
})

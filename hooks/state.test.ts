import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

/**
 * State held under explicit shape tags, as a hot reload finds what an earlier
 * version stored: the person's controls under the current controls shape, the
 * per-turn decision data under an older decision shape.
 */
const world = (on: On, stored: Record<string, { shape: string; value: unknown }>) => {
  mock.env(on, {})
  const state = new Map(Object.entries(stored).map(([k, v]) => [k, { stored: v as unknown, version: 1 }]))
  on('state.get', ($, e) => {
    const s = state.get(e.key)
    return { value: s ? { value: s.stored, version: s.version } : { value: undefined, version: 0 } }
  })
  on('state.set', ($, e) => {
    const s = state.get(e.key) ?? { stored: undefined, version: 0 }
    if (e.ifVersion !== undefined && e.ifVersion !== s.version) return { value: { isSet: false as const, value: s.stored, version: s.version } }
    state.set(e.key, { stored: e.value, version: s.version + 1 })
    return { value: { isSet: true as const, version: s.version + 1 } }
  })
  let judgeCalls = 0
  const sent: unknown[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('model.complete', () => {
    judgeCalls++
    return { value: { isAnswered: true, text: 'open', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.step', async function* ($, e) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { sent, judgeCalls: () => judgeCalls }
}

const run = async ($: any) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
  await $.turn.start({ turnId: 'after-reload', text: 'Diagnose the intermittent deadlock' })
  for await (const _ of $.turn.step({ turnId: 'after-reload', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 }));
}

/** Decision data as an older version stored it, under a shape this version no longer reads. */
const OLD_DECISIONS = { shape: 'session-0', value: { decision: null, lastJudged: 'max', logFailed: false } }

describe('controls survive a decision-shape change', () => {
  test('off stays off: no judge call, the request keeps its effort', async ($, on) => {
    const w = world(on, { controls: { shape: 'controls-1', value: { mode: 'off', pin: null } }, session: OLD_DECISIONS })
    await run($)
    expect(w.judgeCalls()).toBe(0)
    expect(w.sent).toEqual(['high'])
  })

  test('a pin stays pinned: the request goes at the pin', async ($, on) => {
    const w = world(on, { controls: { shape: 'controls-1', value: { mode: null, pin: 'low' } }, session: OLD_DECISIONS })
    await run($)
    expect(w.judgeCalls()).toBe(0)
    expect(w.sent).toEqual(['low'])
  })
})

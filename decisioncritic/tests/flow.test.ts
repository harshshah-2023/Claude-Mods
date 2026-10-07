import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PLUGIN = 'decisioncritic'
const PANE = { component: 'Pane', requestId: 'decisioncritic', props: { title: 'DecisionCritic', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} } } as const

const MESSAGES = [
  { role: 'user', text: 'Add caching to the price lookup', toolUses: [] },
  {
    role: 'assistant',
    text: 'I will store prices as float values in the cache to keep it simple.',
    toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: 'src/cache.py', old_string: 'x', new_string: 'price = float(row.price)' } }],
  },
]

const REVIEW = {
  criticisms: [
    {
      category: 'technical',
      severity: 'high',
      confidence: 0.9,
      decision: 'Store prices as floats',
      concern: 'Floats lose precision',
      consequence: 'Totals drift',
      correction: 'Use Decimal for prices',
      evidence: [{ quote: 'store prices as float values in the cache', locator: '#1 assistant' }],
    },
  ],
}

const DIFF = 'diff --git a/src/cache.py b/src/cache.py\n--- a/src/cache.py\n+++ b/src/cache.py\n@@ -1 +1 @@\n-price = float(row.price)\n+price = Decimal(row.price)\n'

const cmd = (args: string) => ({ command: PLUGIN, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

type Script = { challenge: object; verdicts: object[] }

function engine(on: On, script: Script) {
  mock.store(on)
  const clock = mock.clock(on, { now: 1_000_000 })
  const spawned: string[] = []
  const verdicts = [...script.verdicts]
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.id', () => ({ value: 's1' }))
  on('session.root', () => ({ value: '/proj' }))
  on('session.messages', () => ({ value: MESSAGES }) as never)
  // a hook-answered spawn has no agentId (core sets it), so the list carries the writers
  const agents: { id: string; description: string; type: string; status: 'running' }[] = []
  on('agent.list', () => ({ value: agents }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('command.register', () => ({ value: {} }) as never)
  on('agent.register', () => ({ value: { agent: 'decisioncritic:writer' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('env.get', () => ({ value: undefined }))
  on('agent.spawn', ($, e) => {
    spawned.push(e.prompt)
    agents.push({ id: `w${spawned.length}`, description: e.description, type: e.subagentType, status: 'running' })
    return { model: 'm' }
  })
  on('process.run', ($, e) => {
    const [, sub, flag] = e.argv
    const stdout = sub === 'stash' ? 'base123\n' : sub === 'rev-parse' ? 'head\n' : sub === 'diff' && flag === '--stat' ? ' src/cache.py | 2 +-\n' : sub === 'diff' ? DIFF : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    const body = e.prompt.includes('Review the agent')
      ? REVIEW
      : e.prompt.includes('challenge the proposed correction')
        ? script.challenge
        : (verdicts.shift() ?? { passed: false })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: { isAnswered: true, text: JSON.stringify(body), usage } } as never
  })
  const settle = async () => {
    for (let i = 0; i < 40; i++) await clock.advance(1)
  }
  return { spawned, settle }
}

const JUSTIFIED = {
  verdict: 'justified',
  reasoning: 'Floats are inexact for money.',
  counterexamples: [{ scenario: '0.1 + 0.2', breaksCorrection: false, note: 'Decimal is exact' }],
  requirementsChecked: [],
  scopeChange: false,
  revisedCorrection: null,
  plan: ['Swap float for Decimal'],
  acceptanceCriteria: ['Prices are Decimal'],
}
const FAIL = { passed: false, checks: [{ criterion: 'Prices are Decimal', passed: false, evidence: 'still float' }], feedback: 'Still a float on line 3.' }
const PASS = { passed: true, checks: [{ criterion: 'Prices are Decimal', passed: true, evidence: '+price = Decimal(row.price)' }], feedback: 'Done.' }

test('review → card → accept → challenge → two rounds → verified, writer never run twice', async ($, on) => {
  const { spawned, settle } = engine(on, { challenge: JUSTIFIED, verdicts: [FAIL, PASS] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
  await $.command.run(cmd('review'))
  await settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect(await ui.find({ key: 'accept:C1' })).toBeDefined()
    expect(await ui.find({ text: /Use Decimal for prices/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'accept:C1' })
  await settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('APPROVED CORRECTION')

  await $.turn.complete({ answer: 'changed it', durationMs: 1, isAborted: false, turnId: 'tw1', agentId: 'w1', reason: 'answer' })
  await settle()
  expect(spawned.length).toBe(2)
  expect(spawned[1]).toContain('ROUND 2 OF 3')

  await $.turn.complete({ answer: 'fixed line 3', durationMs: 1, isAborted: false, turnId: 'tw2', agentId: 'w2', reason: 'answer' })
  await settle()
  // a duplicate completion changes nothing
  await $.turn.complete({ answer: 'again', durationMs: 1, isAborted: false, turnId: 'tw2', agentId: 'w2', reason: 'answer' })
  await settle()
  expect(spawned.length).toBe(2)

  const history = await $.command.run(cmd('history'))
  expect(history.text).toContain('C1 [done]')
  expect(history.text).toContain('2 round(s)')

  await ui.press({ key: 'tab:history' })
  await ui.press({ key: 'hdetails:C1' })
  expect(await ui.find({ text: /verified in round 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Code' })).toBeDefined()
  await ui.unmount()
})

test('an unjustified criticism is explained and nothing is written', async ($, on) => {
  const challenge = { verdict: 'unjustified', reasoning: 'These are display ratios, not money.', counterexamples: [], requirementsChecked: [], scopeChange: false, revisedCorrection: null, plan: [], acceptanceCriteria: [] }
  const { spawned, settle } = engine(on, { challenge, verdicts: [] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
  await $.command.run(cmd('review'))
  await settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'accept:C1' })
  await settle()
  expect(spawned.length).toBe(0)
  await ui.press({ key: 'tab:history' })
  await ui.press({ key: 'hdetails:C1' })
  expect(await ui.find({ text: /display ratios/ })).toBeDefined()
  await ui.unmount()
})

test('a scope-changing revision waits for approval before any writer runs', async ($, on) => {
  const challenge = { ...JUSTIFIED, verdict: 'revised', scopeChange: true, revisedCorrection: 'Use Decimal and migrate the stored column' }
  const { spawned, settle } = engine(on, { challenge, verdicts: [PASS] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
  await $.command.run(cmd('review'))
  await settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'accept:C1' })
  await settle()
  expect(spawned.length).toBe(0)
  await ui.press({ key: 'tab:queue' })
  expect(await ui.find({ text: /needs your approval/ })).toBeDefined()
  await ui.press({ key: 'approve:J2' })
  await settle()
  expect(spawned.length).toBe(1)
  expect(spawned[0]).toContain('migrate the stored column')
  await ui.unmount()
})

test('off stops automatic review and pauses the queue', async ($, on) => {
  const { spawned, settle } = engine(on, { challenge: JUSTIFIED, verdicts: [PASS] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
  const off = await $.command.run(cmd('off'))
  expect(off.text).toContain('off')
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  expect(await ui.find({ key: 'accept:C1' })).toBeUndefined()
  // a manual review still works while off, but accepting only queues
  await $.command.run(cmd('review'))
  await settle()
  await ui.press({ key: 'accept:C1' })
  await settle()
  expect(spawned.length).toBe(0)
  await $.command.run(cmd('on'))
  await settle()
  expect(spawned.length).toBe(1)
  await ui.unmount()
})

test('three failed rounds end the job: no fourth writer, the diff is kept for review', async ($, on) => {
  const { spawned, settle } = engine(on, { challenge: JUSTIFIED, verdicts: [FAIL, FAIL, FAIL, PASS] })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: false })
  await $.command.run(cmd('review'))
  await settle()
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', ...PANE })
  await ui.press({ key: 'accept:C1' })
  await settle()
  for (const n of [1, 2, 3]) {
    await $.turn.complete({ answer: `round ${n}`, durationMs: 1, isAborted: false, turnId: `tw${n}`, agentId: `w${n}`, reason: 'answer' })
    await settle()
  }
  expect(spawned.length).toBe(3)
  const history = await $.command.run(cmd('history'))
  expect(history.text).toContain('C1 [failed]')
  await ui.press({ key: 'tab:history' })
  await ui.press({ key: 'hdetails:C1' })
  expect(await ui.find({ text: /Not verified after 3 rounds/ })).toBeDefined()
  expect(await ui.find({ key: 'retry:C1' })).toBeDefined()
  await ui.unmount()
})

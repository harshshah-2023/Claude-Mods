import { expect, test } from 'claude-code/testing'

import type { Challenge, Db } from '../types'
import {
  ACTIVE,
  accept,
  addCards,
  afterChallenge,
  buildTranscript,
  dismiss,
  emptyDb,
  nextJob,
  parseChallenge,
  parseCriticisms,
  parseVerification,
  putJob,
  recover,
} from '../hooks/core'

const TRANSCRIPT = `[#1 ASSISTANT]
I will store prices as float values in the cache to keep it simple.
  tool Edit
    file_path: src/cache.py`

const REVIEW = JSON.stringify({
  criticisms: [
    {
      category: 'technical',
      severity: 'high',
      confidence: 0.9,
      decision: 'Store prices as floats',
      concern: 'Floats lose precision',
      consequence: 'Totals drift',
      correction: 'Use Decimal',
      evidence: [{ quote: 'store prices as FLOAT   values in the cache', locator: '#1 assistant' }],
    },
    {
      category: 'product',
      decision: 'Invented decision',
      concern: 'x',
      correction: 'y',
      evidence: [{ quote: 'this text never appears anywhere at all', locator: '#0' }],
    },
  ],
})

function withCard(): Db {
  const { drafts } = parseCriticisms(REVIEW, TRANSCRIPT, '')
  return addCards(emptyDb(), drafts, 's1', 1).db
}

test('keeps only criticisms whose quotes are found in the transcript', () => {
  const { drafts, dropped } = parseCriticisms('```json\n' + REVIEW + '\n```', TRANSCRIPT, '')
  expect(drafts.length).toBe(1)
  expect(dropped).toBe(1)
  expect(drafts[0]?.category).toBe('technical')
  expect(drafts[0]?.evidence[0]?.source).toBe('transcript')
})

test('a criticism backed only by requirement quotes is dropped', () => {
  const reply = JSON.stringify({
    criticisms: [{ decision: 'd', concern: 'c', correction: 'x', evidence: [{ quote: 'No floats for quantities', locator: 'CLAUDE.md' }] }],
  })
  expect(parseCriticisms(reply, TRANSCRIPT, 'Rule: No floats for quantities.').drafts.length).toBe(0)
})

test('the same criticism is never carded twice', () => {
  const db = withCard()
  const { drafts } = parseCriticisms(REVIEW, TRANSCRIPT, '')
  const again = addCards(db, drafts, 's2', 2)
  expect(again.added.length).toBe(0)
  expect(again.db.cards.length).toBe(1)
})

test('accepting is idempotent: one card, one job', () => {
  const db = withCard()
  const first = accept(db, 'C1', 's1', 5)
  expect(first.job?.status).toBe('queued')
  const second = accept(first.db, 'C1', 's1', 6)
  expect(second.job).toBeUndefined()
  expect(second.db.jobs.length).toBe(1)
  expect(second.reason).toContain('already')
})

test('dismissing an open card keeps it in history and blocks accept', () => {
  const db = dismiss(withCard(), 'C1', 9)
  expect(db.cards[0]?.status).toBe('dismissed')
  expect(accept(db, 'C1', 's1', 10).job).toBeUndefined()
})

test('only one job runs at a time', () => {
  let db = withCard()
  db = addCards(db, [{ ...db.cards[0]!, fingerprint: 'other', decision: 'Another decision' }], 's1', 2).db
  db = accept(db, 'C1', 's1', 3).db
  db = accept(db, 'C2', 's1', 4).db
  const first = nextJob(db)
  expect(first?.cardId).toBe('C1')
  db = putJob(db, { ...first!, status: 'implementing' })
  expect(nextJob(db)).toBeUndefined()
  expect(db.cards.find(c => c.id === 'C1')?.status).toBe('implementing')
})

test('a revision is a scope change unless the critic says it is not', () => {
  const revised = parseChallenge(JSON.stringify({ verdict: 'revised', reasoning: 'r', revisedCorrection: 'Use Decimal and migrate the column' }))!
  expect(revised.scopeChange).toBe(true)
  expect(afterChallenge(revised, 'Use Decimal').status).toBe('awaiting-approval')
  const tight = parseChallenge(JSON.stringify({ verdict: 'revised', reasoning: 'r', scopeChange: false, revisedCorrection: 'Use Decimal(str(x))' }))!
  expect(afterChallenge(tight, 'Use Decimal')).toEqual({ status: 'implementing', correction: 'Use Decimal(str(x))' })
})

test('an unjustified criticism is rejected and an unusable challenge is no verdict', () => {
  const c = parseChallenge('{"verdict":"unjustified","reasoning":"The value is a display ratio, not a quantity"}') as Challenge
  expect(afterChallenge(c, 'x').status).toBe('rejected')
  expect(parseChallenge('no json here')).toBeUndefined()
  expect(parseChallenge('{"verdict":"maybe"}')).toBeUndefined()
})

test('verification passes only with a verdict, every check, a clean command and a diff', () => {
  const ok = JSON.stringify({ passed: true, checks: [{ criterion: 'a', passed: true, evidence: 'e' }], feedback: 'ok' })
  const cmd = { argv: 'pytest', exitCode: 0, output: '' }
  expect(parseVerification(ok, cmd, 'diff --git a b').passed).toBe(true)
  expect(parseVerification(ok, { ...cmd, exitCode: 1 }, 'diff --git a b').passed).toBe(false)
  expect(parseVerification(ok, cmd, '').passed).toBe(false)
  expect(parseVerification(undefined, cmd, 'diff').passed).toBe(false)
  const oneFails = JSON.stringify({ passed: true, checks: [{ criterion: 'a', passed: false, evidence: 'e' }] })
  expect(parseVerification(oneFails, cmd, 'diff').passed).toBe(false)
})

test('a restart marks another session’s running job interrupted, never re-runs it', () => {
  let db = accept(withCard(), 'C1', 'old', 3).db
  db = putJob(db, { ...db.jobs[0]!, status: 'implementing' })
  const after = recover(db, 'new', 100)
  expect(after.jobs[0]?.status).toBe('interrupted')
  expect(after.cards[0]?.status).toBe('interrupted')
  expect(ACTIVE.includes(after.jobs[0]!.status)).toBe(false)
  // the same session (a hot reload) is left for the module to resume
  expect(recover(db, 'old', 100).jobs[0]?.status).toBe('implementing')
  // and retry is an explicit, new job
  const retry = accept(after, 'C1', 'new', 101)
  expect(retry.job?.id).not.toBe(db.jobs[0]?.id)
})

test('the transcript leaves out what DecisionCritic itself caused', () => {
  const t = buildTranscript(
    [
      { role: 'user', text: 'Fix the import', toolUses: [] },
      { role: 'user', text: '/decisioncritic review', toolUses: [] },
      { role: 'assistant', text: 'Background task [decisioncritic] C1 round 1 finished', toolUses: [] },
      { role: 'assistant', text: 'Done.', toolUses: [{ tool: 'Bash', input: { command: 'uv run pytest' } }] },
    ],
    0,
  )
  expect(t.text).toContain('Fix the import')
  expect(t.text).toContain('uv run pytest')
  expect(t.text).not.toContain('/decisioncritic')
  expect(t.text).not.toContain('round 1 finished')
})

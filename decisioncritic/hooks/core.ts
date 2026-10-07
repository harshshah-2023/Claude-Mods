// Pure logic of DecisionCritic: no `$`, no clock, no I/O. Everything the hooks
// module decides about cards, jobs and model answers is decided here, so the
// tests can hold it exactly.
import type {
  Card,
  Category,
  Challenge,
  Db,
  Evidence,
  Job,
  JobStatus,
  JobStep,
  Severity,
  StepState,
  Verification,
} from '../types'

export const MAX_ROUNDS = 3
export const MARKER = '[decisioncritic]'

const CATEGORIES: readonly Category[] = [
  'business',
  'product',
  'technical',
  'architecture',
  'development',
  'testing',
  'security',
  'process',
]
const SEVERITIES: readonly Severity[] = ['high', 'medium', 'low']

/** job states in which work is under way and no second job may start */
export const ACTIVE: readonly JobStatus[] = ['challenging', 'implementing', 'verifying']
/** job states that are finished for good */
export const FINAL: readonly JobStatus[] = ['done', 'rejected', 'failed', 'interrupted']

export function emptyDb(): Db {
  return { version: 1, enabled: true, seq: 0, cards: [], jobs: [], cursors: {} }
}

export function normalizeDb(raw: unknown): Db {
  const db = emptyDb()
  if (raw === null || typeof raw !== 'object') return db
  const r = raw as Partial<Db>
  return {
    version: 1,
    enabled: typeof r.enabled === 'boolean' ? r.enabled : true,
    seq: typeof r.seq === 'number' ? r.seq : 0,
    cards: Array.isArray(r.cards) ? r.cards : [],
    jobs: Array.isArray(r.jobs) ? r.jobs : [],
    cursors: r.cursors !== undefined && typeof r.cursors === 'object' ? r.cursors : {},
    lastReviewAt: r.lastReviewAt,
    lastReviewNote: r.lastReviewNote,
  }
}

// ---------------------------------------------------------------- text utils

export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n… (${text.length - max} more characters)`
}

/** FNV-1a, 32 bit, as 8 hex digits: a stable fingerprint, not a secret. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** The first JSON object in a model reply: a ```json fence, or the outermost braces. */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidates = [fence?.[1], text]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start < 0 || end <= start) continue
    try {
      return JSON.parse(candidate.slice(start, end + 1))
    } catch {
      // try the next candidate
    }
  }
  return undefined
}

function str(value: unknown, max = 2000): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function strList(value: unknown, max = 12): string[] {
  return Array.isArray(value)
    ? value.map(v => str(v, 600)).filter(v => v.length > 0).slice(0, max)
    : []
}

// ---------------------------------------------------------------- transcript

export type TranscriptMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses: readonly { tool: string; input: Record<string, unknown>; text?: string; isError?: true }[]
}

export type Transcript = { text: string; from: number; to: number }

const TOOL_FIELDS = ['file_path', 'command', 'pattern', 'path', 'description', 'old_string', 'new_string', 'content', 'prompt', 'url']

function describeToolUse(use: TranscriptMessage['toolUses'][number]): string {
  const parts: string[] = []
  for (const field of TOOL_FIELDS) {
    const value = use.input[field]
    if (typeof value === 'string' && value.length > 0) {
      parts.push(`${field}: ${clip(value, field === 'content' || field.endsWith('_string') ? 1200 : 400)}`)
    }
  }
  const outcome = use.isError === true ? ' (failed)' : ''
  return `  tool ${use.tool}${outcome}\n${parts.map(p => `    ${p.replace(/\n/g, '\n    ')}`).join('\n')}`
}

/** Messages that DecisionCritic itself caused never go to the critic. */
export function isOwnMessage(message: TranscriptMessage): boolean {
  if (message.text.includes(MARKER) || /decisioncritic:writer/i.test(message.text)) return true
  // the /decisioncritic command and its output rows
  return message.role === 'user' && /(^|\s|>)\/decisioncritic\b|^\s*DecisionCritic( is|:)/i.test(message.text)
}

/**
 * Renders the main-thread messages from `from` on as the critic reads them, the
 * newest kept when the budget is short.
 */
export function buildTranscript(
  messages: readonly TranscriptMessage[],
  from: number,
  budget = 60_000,
): Transcript {
  const blocks: string[] = []
  let used = 0
  for (let i = messages.length - 1; i >= from; i--) {
    const message = messages[i]
    if (message === undefined || isOwnMessage(message)) continue
    const head = `[#${i} ${message.role.toUpperCase()}]`
    const body = [message.text.trim() === '' ? '' : clip(message.text.trim(), 6000), ...message.toolUses.map(describeToolUse)]
      .filter(p => p !== '')
      .join('\n')
    if (body === '') continue
    const block = `${head}\n${body}`
    if (used + block.length > budget && blocks.length > 0) break
    blocks.unshift(block)
    used += block.length
  }
  return { text: blocks.join('\n\n'), from, to: messages.length }
}

// ---------------------------------------------------------------- criticisms

export type CardDraft = Omit<Card, 'id' | 'createdAt' | 'sessionId' | 'status'>

/** Checks a quote against what the critic was shown; whitespace and case do not count. */
export function quoteFound(quote: string, haystack: string): boolean {
  const q = squash(quote).replace(/^["'`…]+|["'`…]+$/g, '').replace(/\.\.\.$/, '')
  return q.length >= 8 && squash(haystack).includes(q)
}

/**
 * Turns the critic's review reply into card drafts. A criticism is kept only
 * when its fields are present and at least one quote is found verbatim in the
 * transcript: evidence the critic invented is dropped with its card.
 */
export function parseCriticisms(
  reply: string,
  transcript: string,
  requirements: string,
): { drafts: CardDraft[]; dropped: number } {
  const json = extractJson(reply) as { criticisms?: unknown } | undefined
  const list = Array.isArray(json?.criticisms) ? json.criticisms : []
  const drafts: CardDraft[] = []
  let dropped = 0
  for (const item of list.slice(0, 6)) {
    const c = (item ?? {}) as Record<string, unknown>
    const decision = str(c.decision, 600)
    const concern = str(c.concern, 1200)
    const consequence = str(c.consequence, 1200)
    const correction = str(c.correction, 1500)
    const evidence: Evidence[] = []
    for (const ev of Array.isArray(c.evidence) ? c.evidence.slice(0, 6) : []) {
      const e = (ev ?? {}) as Record<string, unknown>
      const quote = str(e.quote, 500)
      const locator = str(e.locator, 120) || 'transcript'
      if (quoteFound(quote, transcript)) {
        evidence.push({ source: /tool/i.test(locator) ? 'tool' : 'transcript', quote, locator })
      } else if (quoteFound(quote, requirements)) {
        evidence.push({ source: 'requirement', quote, locator })
      }
    }
    const grounded = evidence.some(e => e.source !== 'requirement')
    if (decision === '' || concern === '' || correction === '' || !grounded) {
      dropped++
      continue
    }
    const category = CATEGORIES.find(k => k === str(c.category).toLowerCase()) ?? 'technical'
    const severity = SEVERITIES.find(k => k === str(c.severity).toLowerCase()) ?? 'medium'
    const confidence = typeof c.confidence === 'number' ? Math.min(1, Math.max(0, c.confidence)) : 0.5
    drafts.push({
      fingerprint: fingerprint(`${squash(decision)}|${squash(correction)}`),
      category,
      severity,
      confidence,
      decision,
      concern,
      consequence: consequence || 'Not stated.',
      correction,
      evidence,
      requirements: strList(c.requirements, 6),
    })
  }
  return { drafts, dropped }
}

/** Adds drafts as open cards, skipping any whose fingerprint or decision is already known. */
export function addCards(db: Db, drafts: readonly CardDraft[], sessionId: string, now: number): { db: Db; added: Card[] } {
  const known = new Set(db.cards.map(c => c.fingerprint))
  const knownDecisions = new Set(db.cards.map(c => squash(c.decision)))
  let seq = db.seq
  const added: Card[] = []
  for (const draft of drafts) {
    if (known.has(draft.fingerprint) || knownDecisions.has(squash(draft.decision))) continue
    known.add(draft.fingerprint)
    knownDecisions.add(squash(draft.decision))
    seq += 1
    added.push({ ...draft, id: `C${seq}`, createdAt: now, sessionId, status: 'open' })
  }
  return { db: { ...db, seq, cards: [...db.cards, ...added] }, added }
}

// ---------------------------------------------------------------- challenge / verify

export function parseChallenge(reply: string): Challenge | undefined {
  const json = extractJson(reply) as Record<string, unknown> | undefined
  if (json === undefined) return undefined
  const verdictRaw = str(json.verdict).toLowerCase()
  const verdict = verdictRaw === 'justified' || verdictRaw === 'unjustified' || verdictRaw === 'revised' ? verdictRaw : undefined
  if (verdict === undefined) return undefined
  const counterexamples = (Array.isArray(json.counterexamples) ? json.counterexamples : []).slice(0, 8).map(raw => {
    const c = (raw ?? {}) as Record<string, unknown>
    return { scenario: str(c.scenario, 500), breaksCorrection: c.breaksCorrection === true, note: str(c.note, 500) }
  }).filter(c => c.scenario !== '')
  const requirementsChecked = (Array.isArray(json.requirementsChecked) ? json.requirementsChecked : []).slice(0, 10).map(raw => {
    const r = (raw ?? {}) as Record<string, unknown>
    return { requirement: str(r.requirement, 400), satisfied: r.satisfied === true, note: str(r.note, 400) }
  }).filter(r => r.requirement !== '')
  const revisedCorrection = str(json.revisedCorrection, 1500) || null
  // A revision is a scope change unless the critic says otherwise; a revision with no text is no revision.
  const scopeChange = verdict === 'revised' ? json.scopeChange !== false : false
  return {
    verdict: verdict === 'revised' && revisedCorrection === null ? 'justified' : verdict,
    reasoning: str(json.reasoning, 2500),
    counterexamples,
    requirementsChecked,
    scopeChange: revisedCorrection === null ? false : scopeChange,
    revisedCorrection,
    plan: strList(json.plan, 10),
    acceptanceCriteria: strList(json.acceptanceCriteria, 10),
  }
}

/** What happens after a challenge: the correction to implement and the job's next status. */
export function afterChallenge(challenge: Challenge, original: string): { status: JobStatus; correction: string } {
  if (challenge.verdict === 'unjustified') return { status: 'rejected', correction: original }
  if (challenge.verdict === 'revised' && challenge.revisedCorrection !== null) {
    return challenge.scopeChange
      ? { status: 'awaiting-approval', correction: challenge.revisedCorrection }
      : { status: 'implementing', correction: challenge.revisedCorrection }
  }
  return { status: 'implementing', correction: original }
}

export function parseVerification(
  reply: string | undefined,
  command: Verification['command'],
  diff: string,
): Verification {
  const json = reply === undefined ? undefined : (extractJson(reply) as Record<string, unknown> | undefined)
  const checks = (Array.isArray(json?.checks) ? json.checks : []).slice(0, 12).map(raw => {
    const c = (raw ?? {}) as Record<string, unknown>
    return { criterion: str(c.criterion, 400), passed: c.passed === true, evidence: str(c.evidence, 600) }
  }).filter(c => c.criterion !== '')
  const criticAnswered = json !== undefined && typeof json.passed === 'boolean'
  const feedbackParts = [str(json?.feedback, 2000)]
  const commandFailed = command !== undefined && command.exitCode !== 0
  const emptyDiff = diff.trim() === ''
  if (!criticAnswered) feedbackParts.push('The critic gave no usable verification verdict.')
  if (commandFailed) feedbackParts.push(`Verification command exited ${command.exitCode}.`)
  if (emptyDiff) feedbackParts.push('The round produced no change to the working tree.')
  const passed = criticAnswered && json?.passed === true && checks.every(c => c.passed) && !commandFailed && !emptyDiff
  return {
    passed,
    checks,
    feedback: feedbackParts.filter(p => p !== '').join(' '),
    command,
    criticAnswered,
  }
}

// ---------------------------------------------------------------- jobs

export function setStep(job: Job, key: string, label: string, state: StepState, at: number, note?: string): Job {
  const steps: JobStep[] = job.steps.some(s => s.key === key)
    ? job.steps.map(s => (s.key === key ? { ...s, label, state, at, note: note ?? s.note } : s))
    : [...job.steps, { key, label, state, at, note }]
  return { ...job, steps }
}

const CARD_OF_JOB: Record<JobStatus, Card['status']> = {
  queued: 'queued',
  challenging: 'challenging',
  'awaiting-approval': 'awaiting-approval',
  implementing: 'implementing',
  verifying: 'verifying',
  done: 'done',
  rejected: 'rejected',
  failed: 'failed',
  interrupted: 'interrupted',
}

/** Replaces a job and keeps its card's status in step with it. */
export function putJob(db: Db, job: Job): Db {
  const jobs = db.jobs.some(j => j.id === job.id) ? db.jobs.map(j => (j.id === job.id ? job : j)) : [...db.jobs, job]
  const cards = db.cards.map(c => (c.id === job.cardId ? { ...c, status: CARD_OF_JOB[job.status], jobId: job.id } : c))
  return { ...db, jobs, cards }
}

export type AcceptResult = { db: Db; job?: Job; reason?: string }

/**
 * Accepting is idempotent: a card already queued or under way keeps its one
 * job, so a double press or a second session never runs a correction twice.
 * Retry is an explicit accept of a card whose job failed or was interrupted.
 */
export function accept(db: Db, cardId: string, sessionId: string, now: number): AcceptResult {
  const card = db.cards.find(c => c.id === cardId)
  if (card === undefined) return { db, reason: `No card ${cardId}.` }
  const retryable = card.status === 'failed' || card.status === 'interrupted'
  if (card.status !== 'open' && !retryable) {
    return { db, reason: `${card.id} is already ${card.status}.` }
  }
  const seq = db.seq + 1
  const job: Job = {
    id: `J${seq}`,
    cardId,
    sessionId,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    correction: card.correction,
    rounds: [],
    steps: [{ key: 'queued', label: retryable ? 'Queued again (retry)' : 'Queued', state: 'done', at: now }],
  }
  return { db: putJob({ ...db, seq }, job), job }
}

export function dismiss(db: Db, cardId: string, now: number): Db {
  return {
    ...db,
    cards: db.cards.map(c => (c.id === cardId && c.status === 'open' ? { ...c, status: 'dismissed', dismissedAt: now } : c)),
  }
}

/** The next job to start, only when no job is under way: one code writer at a time. */
export function nextJob(db: Db): Job | undefined {
  if (db.jobs.some(j => ACTIVE.includes(j.status))) return undefined
  return db.jobs.filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt)[0]
}

/**
 * On a session start: work that belonged to another process cannot be
 * resumed, so it is marked interrupted (never re-run by itself, which could
 * apply a correction twice). Work of this same session (a hot reload) is left
 * for the hooks module to resume.
 */
export function recover(db: Db, sessionId: string, now: number): Db {
  let next = db
  for (const job of db.jobs) {
    if (!ACTIVE.includes(job.status) || job.sessionId === sessionId) continue
    let j = setStep(job, 'interrupted', 'Interrupted by a restart', 'failed', now, 'Check the working tree, then Retry if wanted.')
    j = { ...j, status: 'interrupted', updatedAt: now, outcome: 'Interrupted: the session that ran it ended.' }
    next = putJob(next, j)
  }
  return next
}

/** Keeps the store under its 4 MiB: the newest cards and their jobs, long texts cut. */
export function trimDb(db: Db, maxCards = 150): Db {
  const cards = db.cards.slice(-maxCards)
  const keep = new Set(cards.map(c => c.id))
  const jobs = db.jobs.filter(j => keep.has(j.cardId) || ACTIVE.includes(j.status)).map(j => ({
    ...j,
    rounds: j.rounds.map(r => ({
      ...r,
      diff: r.diff === undefined ? undefined : clip(r.diff, 30_000),
      writerReport: r.writerReport === undefined ? undefined : clip(r.writerReport, 6_000),
    })),
  }))
  const sessions = Object.entries(db.cursors).slice(-30)
  return { ...db, cards, jobs, cursors: Object.fromEntries(sessions) }
}

export function counts(db: Db): { open: number; queued: number; active: number; done: number } {
  return {
    open: db.cards.filter(c => c.status === 'open').length,
    queued: db.jobs.filter(j => j.status === 'queued' || j.status === 'awaiting-approval').length,
    active: db.jobs.filter(j => ACTIVE.includes(j.status)).length,
    done: db.jobs.filter(j => j.status === 'done').length,
  }
}

export function historyText(db: Db, limit = 20): string {
  const lines = db.cards
    .slice(-limit)
    .reverse()
    .map(c => {
      const job = c.jobId === undefined ? undefined : db.jobs.find(j => j.id === c.jobId)
      const rounds = job === undefined || job.rounds.length === 0 ? '' : `, ${job.rounds.length} round(s)`
      return `- ${c.id} [${c.status}] ${c.category}/${c.severity}: ${c.decision.slice(0, 90)}${rounds}`
    })
  return lines.length === 0 ? 'DecisionCritic has no history yet.' : `DecisionCritic history (newest first):\n${lines.join('\n')}`
}

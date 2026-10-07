export type Category =
  | 'business'
  | 'product'
  | 'technical'
  | 'architecture'
  | 'development'
  | 'testing'
  | 'security'
  | 'process'

export type Severity = 'high' | 'medium' | 'low'

export type Evidence = {
  source: 'transcript' | 'tool' | 'requirement'
  quote: string
  /** where the quote was found, e.g. "assistant message 3" or "Edit apps/api/x.py" */
  locator: string
}

export type CardStatus =
  | 'open'
  | 'dismissed'
  | 'queued'
  | 'challenging'
  | 'awaiting-approval'
  | 'implementing'
  | 'verifying'
  | 'done'
  | 'rejected'
  | 'failed'
  | 'interrupted'

export type Card = {
  id: string
  fingerprint: string
  createdAt: number
  sessionId: string
  category: Category
  severity: Severity
  confidence: number
  decision: string
  concern: string
  consequence: string
  correction: string
  evidence: Evidence[]
  requirements: string[]
  status: CardStatus
  jobId?: string
  dismissedAt?: number
}

export type StepState = 'pending' | 'active' | 'done' | 'failed' | 'skipped'

export type JobStep = {
  key: string
  label: string
  state: StepState
  at?: number
  note?: string
}

export type Counterexample = { scenario: string; breaksCorrection: boolean; note: string }
export type RequirementCheck = { requirement: string; satisfied: boolean; note: string }

export type Challenge = {
  verdict: 'justified' | 'unjustified' | 'revised'
  reasoning: string
  counterexamples: Counterexample[]
  requirementsChecked: RequirementCheck[]
  scopeChange: boolean
  revisedCorrection: string | null
  plan: string[]
  acceptanceCriteria: string[]
}

export type VerifyCheck = { criterion: string; passed: boolean; evidence: string }

export type Verification = {
  passed: boolean
  checks: VerifyCheck[]
  feedback: string
  command?: { argv: string; exitCode: number; output: string }
  criticAnswered: boolean
}

export type Round = {
  n: number
  startedAt: number
  finishedAt?: number
  writerAgentId?: string
  writerReport?: string
  diff?: string
  diffStat?: string
  verification?: Verification
}

export type JobStatus =
  | 'queued'
  | 'challenging'
  | 'awaiting-approval'
  | 'implementing'
  | 'verifying'
  | 'done'
  | 'rejected'
  | 'failed'
  | 'interrupted'

export type Job = {
  id: string
  cardId: string
  sessionId: string
  status: JobStatus
  createdAt: number
  updatedAt: number
  /** the correction the writer implements: the card's, or an approved revision */
  correction: string
  challenge?: Challenge
  approvedRevision?: boolean
  baseRef?: string
  untrackedBefore?: string[]
  rounds: Round[]
  steps: JobStep[]
  outcome?: string
}

export type Db = {
  version: 1
  enabled: boolean
  seq: number
  cards: Card[]
  jobs: Job[]
  /** per session: how many main-thread messages were already reviewed */
  cursors: Record<string, number>
  lastReviewAt?: number
  lastReviewNote?: string
}

export type View = 'cards' | 'queue' | 'history' | 'details'

export type UiState = {
  view: View
  selected?: string
  page: number
  /** card ids whose Details are expanded inline */
  reviewing: boolean
}

declare module 'claude-code' {
  interface PluginState {
    decisioncritic: { db: Db; ui: UiState }
  }
}

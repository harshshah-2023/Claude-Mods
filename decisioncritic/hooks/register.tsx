import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type { Card, Db, Job, JobStep, Round, UiState, Verification } from '../types'
import {
  ACTIVE,
  FINAL,
  MARKER,
  MAX_ROUNDS,
  accept,
  addCards,
  afterChallenge,
  buildTranscript,
  clip,
  counts,
  dismiss,
  emptyDb,
  historyText,
  nextJob,
  normalizeDb,
  parseChallenge,
  parseCriticisms,
  parseVerification,
  putJob,
  recover,
  setStep,
  trimDb,
} from './core'
import { CRITIC_SYSTEM, WRITER_SYSTEM, challengePrompt, reviewPrompt, verifyPrompt, writerPrompt } from './prompts'

type Engine = EngineInterface

const PANE = 'decisioncritic'
const WRITER = 'decisioncritic:writer'
const dbAtom = atom({ plugin: 'decisioncritic', key: 'db' } as const, emptyDb())
const uiAtom = atom({ plugin: 'decisioncritic', key: 'ui' } as const, { view: 'cards', page: 0, reviewing: false } as UiState)

export const register: Register = (on, options) => {
  const criticModel = String(options.criticModel ?? 'sonnet') || 'sonnet'
  const writerModel = String(options.writerModel ?? 'inherit') || 'inherit'
  const autoReview = options.autoReview !== false
  const verifyCommand = String(options.verifyCommand ?? '').trim()
  const requirementFiles = String(options.requirementsFiles ?? 'CLAUDE.md')
    .split(',')
    .map(s => s.trim())
    .filter(s => s !== '')

  // The session's own `$`, held for work that outlives one dispatch (reviews,
  // jobs). Module variables reset on a reload; the durable truth is in state.
  let sessionId = ''
  let root = ''
  let storeKey = 'db'
  let reviewing = false
  let pumping = false
  const ownTurns = new Set<string>()
  const earlyAnswers = new Map<string, { answer: string; isAborted: boolean }>()


  type Api = {
    onTurnComplete: (t: { agentId?: string; answer: string; isAborted: boolean; turnId: string }) => void
    command: (arg: string) => Promise<string>
    startReview: (manual: boolean) => void
    pump: () => void
    doAccept: (cardId: string) => Promise<string>
    doDismiss: (cardId: string) => Promise<void>
    doApprove: (jobId: string, approve: boolean) => Promise<void>
    show: (view: UiState['view'], selected?: string) => Promise<void>
    setUi: (change: (ui: UiState) => UiState) => Promise<void>
    toggle: () => Promise<void>
  }
  let api: Api | undefined

  // Long-lived work runs on the session's own `$`: every helper below is a
  // closure inside session.start, and other hooks reach them through `api`.
  on('session.start', async ($, e, next) => {
    // ------------------------------------------------------------ persistence

    async function mutate(change: (db: Db) => Db): Promise<Db> {
      const written = await update($, dbAtom, db => trimDb(change(normalizeDb(db))))
      await $.store.set(storeKey, written)
      refreshStatus(written)
      return written
    }

    async function setUi(change: (ui: UiState) => UiState): Promise<void> {
      await update($, uiAtom, change)
    }

    function refreshStatus(db: Db): void {
      const c = counts(db)
      const active = db.jobs.find(j => ACTIVE.includes(j.status))
      const job = active === undefined ? '' : ` · ${active.id} ${phaseLabel(active)}`
      $.ui.status(db.enabled || c.open + c.active > 0 ? `◆ critic ${db.enabled ? 'on' : 'off'} · ${c.open} open${job}` : undefined)
    }

    async function git(args: string[]): Promise<{ ok: boolean; out: string }> {
      try {
        const r = await $.process.run(['git', ...args], { cwd: root, timeoutMs: 60_000 })
        return { ok: r.exitCode === 0, out: r.stdout }
      } catch {
        return { ok: false, out: '' }
      }
    }

    async function requirements(): Promise<string> {
      const parts: string[] = []
      for (const file of requirementFiles.slice(0, 5)) {
        try {
          parts.push(`=== ${file} ===\n${clip(await $.fs.read(`${root}/${file}`), 16_000)}`)
        } catch {
          // a missing document is simply not a requirement here
        }
      }
      return parts.join('\n\n')
    }

    async function critic(prompt: string, maxTokens: number): Promise<string | undefined> {
      for (let attempt = 0; attempt < 2; attempt++) {
        const r = await $.model.complete({
          model: criticModel,
          system: [{ text: CRITIC_SYSTEM, cache: true }],
          prompt,
          maxTokens,
        })
        if (r.isAnswered) return r.text
      }
      return undefined
    }

    // ------------------------------------------------------------ review

    async function review(manual: boolean): Promise<string> {
      if (reviewing) return 'A review is already running.'
      reviewing = true
      await setUi(ui => ({ ...ui, reviewing: true }))
      try {
        const messages = await $.session.messages()
        const db = await read($, dbAtom)
        let from = db.cursors[sessionId] ?? 0
        if (from > messages.length) from = 0
        if (manual && from >= messages.length) from = Math.max(0, messages.length - 12)
        const transcript = buildTranscript(messages, from)
        const to = messages.length
        if (transcript.text === '') {
          await mutate(d => ({ ...d, cursors: { ...d.cursors, [sessionId]: to } }))
          return 'Nothing new to review.'
        }
        const reqs = await requirements()
        const reply = await critic(reviewPrompt(transcript.text, reqs), 4000)
        const now = await $.clock.now()
        if (reply === undefined) {
          await mutate(d => ({ ...d, lastReviewAt: now, lastReviewNote: 'The critic model did not answer; nothing was marked reviewed.' }))
          return 'The critic model did not answer. Try /decisioncritic review again.'
        }
        const { drafts, dropped } = parseCriticisms(reply, transcript.text, reqs)
        let added: Card[] = []
        await mutate(d => {
          const result = addCards(d, drafts, sessionId, now)
          added = result.added
          const note = `Reviewed messages ${from}–${to - 1}: ${result.added.length} new card(s)` + (dropped > 0 ? `, ${dropped} dropped for unverified evidence` : '')
          return { ...result.db, cursors: { ...result.db.cursors, [sessionId]: to }, lastReviewAt: now, lastReviewNote: note }
        })
        if (added.length > 0) {
          $.ui.toast(`DecisionCritic: ${added.length} new criticism${added.length === 1 ? '' : 's'}`)
          void $.ui.open({ id: PANE, title: 'DecisionCritic' })
        }
        return added.length === 0
          ? `Reviewed messages ${from}–${to - 1}: no criticism with verifiable evidence.`
          : `Reviewed messages ${from}–${to - 1}: ${added.length} new card(s): ${added.map(c => c.id).join(', ')}.`
      } finally {
        reviewing = false
        await setUi(ui => ({ ...ui, reviewing: false }))
      }
    }

    function startReview(manual: boolean): void {
      $.clock.after(0, () => {
        void review(manual).catch(err => $.ui.log(`DecisionCritic review failed: ${String(err)}`))
      })
    }

    // ------------------------------------------------------------ jobs

    async function jobOf(id: string): Promise<Job | undefined> {
      return (await read($, dbAtom)).jobs.find(j => j.id === id)
    }

    async function cardOf(id: string): Promise<Card | undefined> {
      return (await read($, dbAtom)).cards.find(c => c.id === id)
    }

    async function saveJob(id: string, change: (job: Job, now: number) => Job): Promise<Job | undefined> {
      const now = await $.clock.now()
      let out: Job | undefined
      await mutate(db => {
        const job = db.jobs.find(j => j.id === id)
        if (job === undefined) return db
        out = { ...change(job, now), updatedAt: now }
        return putJob(db, out)
      })
      return out
    }

    function pump(): void {
      if (pumping) return
      pumping = true
      $.clock.after(0, () => {
        void (async () => {
          try {
            for (;;) {
              const db = await read($, dbAtom)
              if (!db.enabled) break
              const job = nextJob(db)
              if (job === undefined) break
              if (job.challenge !== undefined && job.approvedRevision === true) await startRound(job.id, 1)
              else await runChallenge(job.id)
              // a job that did not move on would spin here: stop and let the next event pump again
              if ((await jobOf(job.id))?.status === 'queued') break
            }
          } catch (err) {
            $.ui.log(`DecisionCritic job runner failed: ${String(err)}`)
          } finally {
            pumping = false
          }
        })()
      })
    }

    async function runChallenge(jobId: string): Promise<void> {
      const job = await saveJob(jobId, (j, now) => setStep({ ...j, status: 'challenging' }, 'challenge', 'Double-checking whether the fix is really needed', 'active', now))
      const card = job === undefined ? undefined : await cardOf(job.cardId)
      if (job === undefined || card === undefined) return
      const [status, head, stat] = await Promise.all([
        git(['status', '--short']),
        git(['log', '-1', '--oneline']),
        git(['diff', '--stat']),
      ])
      const repoState = `HEAD: ${head.out.trim() || '(unknown)'}\nstatus:\n${clip(status.out, 3000) || '(clean)'}\ndiff --stat:\n${clip(stat.out, 2000) || '(none)'}`
      const reply = await critic(challengePrompt(card, await requirements(), repoState), 4000)
      const challenge = reply === undefined ? undefined : parseChallenge(reply)
      if (challenge === undefined) {
        await saveJob(jobId, (j, now) => ({
          ...setStep(j, 'challenge', 'Challenge failed', 'failed', now, 'The critic gave no usable challenge.'),
          status: 'failed',
          outcome: 'The critic could not challenge the correction; nothing was changed.',
        }))
        return
      }
      const outcome = afterChallenge(challenge, card.correction)
      const verdictNote = `${challenge.verdict}${challenge.scopeChange ? ' (scope change)' : ''}`
      const saved = await saveJob(jobId, (j, now) => {
        let out = setStep({ ...j, challenge, correction: outcome.correction, status: outcome.status }, 'challenge', 'Double-checked', 'done', now, verdictNote)
        if (outcome.status === 'rejected') out = { ...out, outcome: `Criticism rejected after challenge: ${challenge.reasoning}` }
        if (outcome.status === 'awaiting-approval') out = setStep(out, 'approval', 'Revised proposal needs your approval', 'active', now)
        return out
      })
      if (saved === undefined) return
      if (outcome.status === 'rejected') $.ui.toast(`DecisionCritic: ${card.id} turned out not to need a fix — see Details`)
      if (outcome.status === 'awaiting-approval') {
        $.ui.toast(`DecisionCritic: ${card.id} needs approval of a revised proposal`)
        void $.ui.open({ id: PANE, title: 'DecisionCritic' })
      }
      if (outcome.status === 'implementing') await startRound(jobId, 1)
    }

    async function startRound(jobId: string, n: number): Promise<void> {
      // Claim the round first: a round that exists is never spawned again.
      let claimed = false
      let baseline: { baseRef?: string; untracked?: string[] } = {}
      if (n === 1) {
        const stash = await git(['stash', 'create'])
        const headRef = await git(['rev-parse', 'HEAD'])
        const untracked = await git(['ls-files', '--others', '--exclude-standard'])
        baseline = {
          baseRef: stash.out.trim() || headRef.out.trim() || undefined,
          untracked: untracked.out.split('\n').map(s => s.trim()).filter(s => s !== ''),
        }
      }
      const job = await saveJob(jobId, (j, now) => {
        if (j.rounds.some(r => r.n === n) || FINAL.includes(j.status)) return j
        claimed = true
        const based = n === 1 ? { ...j, baseRef: baseline.baseRef, untrackedBefore: baseline.untracked } : j
        return setStep({ ...based, status: 'implementing', rounds: [...j.rounds, { n, startedAt: now }] }, `round-${n}`, `Round ${n}/${MAX_ROUNDS}: making the fix`, 'active', now)
      })
      if (!claimed || job === undefined) return
      const card = await cardOf(job.cardId)
      if (card === undefined) return
      const previous = job.rounds.find(r => r.n === n - 1)
      const description = `${MARKER} ${card.id} round ${n}`
      const spawned = await $.agent.spawn({ subagentType: WRITER, description, prompt: writerPrompt(card, job, previous) })
      // core sets agentId; where it does not (a spawn a hook answered), the
      // round's unique description finds the writer in the agent list
      const agentId =
        spawned.agentId ??
        (spawned.deny === undefined ? (await $.agent.list().catch(() => [])).find(a => a.description === description)?.id : undefined)
      if (spawned.deny !== undefined || agentId === undefined) {
        const why = spawned.deny ?? 'the subagent started without an id to follow it by'
        await saveJob(jobId, (j, now) => ({
          ...setStep(j, `round-${n}`, `Round ${n}: writer could not start`, 'failed', now, why),
          status: 'failed',
          outcome: `The writer could not start: ${why}`,
        }))
        return
      }
      await saveJob(jobId, j => ({ ...j, rounds: j.rounds.map(r => (r.n === n ? { ...r, writerAgentId: agentId } : r)) }))
      const early = earlyAnswers.get(agentId)
      if (early !== undefined) {
        earlyAnswers.delete(agentId)
        await onWriterDone(agentId, early.answer, early.isAborted)
      }
    }

    async function onWriterDone(agentId: string, answer: string, isAborted: boolean): Promise<void> {
      const db = await read($, dbAtom)
      const job = db.jobs.find(j => j.status === 'implementing' && j.rounds.some(r => r.writerAgentId === agentId))
      if (job === undefined) {
        // maybe the writer finished before its spawn resolved; other agents' answers age out
        earlyAnswers.set(agentId, { answer, isAborted })
        for (const key of [...earlyAnswers.keys()].slice(0, Math.max(0, earlyAnswers.size - 20))) earlyAnswers.delete(key)
        return
      }
      const round = job.rounds.find(r => r.writerAgentId === agentId)
      if (round === undefined || round.writerReport !== undefined) return
      if (isAborted) {
        await saveJob(job.id, (j, now) => ({
          ...setStep(j, `round-${round.n}`, `Round ${round.n}: writer was stopped`, 'failed', now),
          status: 'interrupted',
          rounds: j.rounds.map(r => (r.n === round.n ? { ...r, writerReport: answer || '(aborted)', finishedAt: now } : r)),
          outcome: 'The writer was interrupted. Check the working tree, then Retry if wanted.',
        }))
        return
      }
      await saveJob(job.id, (j, now) => {
        const out = { ...j, status: 'verifying' as const, rounds: j.rounds.map(r => (r.n === round.n ? { ...r, writerReport: answer } : r)) }
        return setStep(setStep(out, `round-${round.n}`, `Round ${round.n}/${MAX_ROUNDS}: fix made`, 'done', now), `verify-${round.n}`, `Round ${round.n}: checking the fix`, 'active', now)
      })
      await runVerify(job.id)
    }

    async function diffOf(job: Job): Promise<{ diff: string; stat: string }> {
      if (job.baseRef === undefined) return { diff: '(not a git repository: no diff available)', stat: '' }
      const [diff, stat, untracked] = await Promise.all([
        git(['diff', job.baseRef]),
        git(['diff', '--stat', job.baseRef]),
        git(['ls-files', '--others', '--exclude-standard']),
      ])
      const before = new Set(job.untrackedBefore ?? [])
      const fresh = untracked.out.split('\n').map(s => s.trim()).filter(s => s !== '' && !before.has(s)).slice(0, 15)
      const added: string[] = []
      for (const file of fresh) {
        try {
          const lines = (await $.fs.read(`${root}/${file}`)).split('\n')
          const shown = lines.slice(0, 300)
          added.push(`diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${shown.length} @@\n${shown.map(l => `+${l}`).join('\n')}`)
        } catch {
          added.push(`# new file ${file} (not readable as text)`)
        }
      }
      const statText = [stat.out.trim(), ...fresh.map(f => ` ${f} (new)`)].filter(s => s !== '').join('\n')
      return { diff: [diff.out.trimEnd(), ...added].filter(s => s !== '').join('\n'), stat: statText }
    }

    async function runCommand(): Promise<Verification['command']> {
      if (verifyCommand === '') return undefined
      const isWindows = (await $.env.get('ComSpec')) !== undefined
      const argv = isWindows ? ['cmd', '/d', '/s', '/c', verifyCommand] : ['sh', '-c', verifyCommand]
      try {
        const r = await $.process.run(argv, { cwd: root, timeoutMs: 600_000 })
        return { argv: verifyCommand, exitCode: r.exitCode, output: clip(`${r.stdout}\n${r.stderr}`.trim(), 8000) }
      } catch (err) {
        return { argv: verifyCommand, exitCode: -1, output: String(err) }
      }
    }

    async function runVerify(jobId: string): Promise<void> {
      const job = await jobOf(jobId)
      const card = job === undefined ? undefined : await cardOf(job.cardId)
      const round = job?.rounds[job.rounds.length - 1]
      if (job === undefined || card === undefined || round === undefined || job.status !== 'verifying') return
      const { diff, stat } = await diffOf(job)
      const command = await runCommand()
      const commandText = command === undefined ? '(none configured)' : `\`${command.argv}\` exited ${command.exitCode}:\n${command.output}`
      const withDiff: Round = { ...round, diff, diffStat: stat }
      const reply = await critic(verifyPrompt(card, job, withDiff, commandText), 3000)
      const verification = parseVerification(reply, command, diff)
      const n = round.n
      const saved = await saveJob(jobId, (j, now) => {
        const rounds = j.rounds.map(r => (r.n === n ? { ...withDiff, writerReport: r.writerReport, writerAgentId: r.writerAgentId, verification, finishedAt: now } : r))
        const base = { ...j, rounds }
        if (verification.passed) {
          return { ...setStep(base, `verify-${n}`, `Round ${n}: verified`, 'done', now), status: 'done', outcome: `Implemented and verified in round ${n}.` }
        }
        const failed = setStep(base, `verify-${n}`, `Round ${n}: verification failed`, 'failed', now, clip(verification.feedback, 300))
        if (n >= MAX_ROUNDS) {
          return { ...failed, status: 'failed', outcome: `Not verified after ${MAX_ROUNDS} rounds. The working tree keeps round ${n}'s changes; review the diff before keeping them.` }
        }
        return { ...failed, status: 'implementing' }
      })
      if (saved === undefined) return
      if (saved.status === 'done') $.ui.toast(`DecisionCritic: ${card.id} corrected and verified`)
      else if (saved.status === 'failed') $.ui.toast(`DecisionCritic: ${card.id} could not be verified in ${MAX_ROUNDS} rounds`)
      else await startRound(jobId, n + 1)
      pump()
    }

    /** After a hot reload in the same session: pick up what the previous copy left. */
    async function resume(): Promise<void> {
      const db = await read($, dbAtom)
      const agents = await $.agent.list().catch(() => [])
      for (const job of db.jobs) {
        if (job.sessionId !== sessionId) continue
        if (job.status === 'challenging') {
          await saveJob(job.id, j => ({ ...j, status: 'queued' }))
        } else if (job.status === 'verifying') {
          await runVerify(job.id)
        } else if (job.status === 'implementing') {
          const round = job.rounds[job.rounds.length - 1]
          const agent = agents.find(a => a.id === round?.writerAgentId)
          const alive = agent !== undefined && (agent.status === 'running' || agent.status === 'pending' || agent.status === 'waiting')
          if (!alive) {
            await saveJob(job.id, (j, now) => ({
              ...setStep(j, 'interrupted', 'Writer lost during a reload', 'failed', now),
              status: 'interrupted',
              outcome: 'The writer was lost during a reload. Check the working tree, then Retry if wanted.',
            }))
          }
        }
      }
      pump()
    }

    // ------------------------------------------------------------ actions

    async function doAccept(cardId: string): Promise<string> {
      const now = await $.clock.now()
      let reason: string | undefined
      let job: Job | undefined
      await mutate(db => {
        const r = accept(db, cardId, sessionId, now)
        reason = r.reason
        job = r.job
        return r.db
      })
      if (job === undefined) return reason ?? 'Nothing to do.'
      pump()
      return `${cardId} queued as ${(job as Job).id}.`
    }

    async function doApprove(jobId: string, approve: boolean): Promise<void> {
      await saveJob(jobId, (j, now) => {
        if (j.status !== 'awaiting-approval') return j
        if (!approve) {
          return { ...setStep(j, 'approval', 'Revised proposal declined', 'failed', now), status: 'rejected', outcome: 'You declined the revised proposal; nothing was changed.' }
        }
        return { ...setStep(j, 'approval', 'Revised proposal approved', 'done', now), status: 'queued', approvedRevision: true }
      })
      if (approve) pump()
    }

    async function show(view: UiState['view'], selected?: string): Promise<void> {
      await setUi(ui => ({ ...ui, view, selected: selected ?? ui.selected, page: view === ui.view ? ui.page : 0 }))
    }


    function onTurnComplete(t: { agentId?: string; answer: string; isAborted: boolean; turnId: string }): void {
      $.clock.after(0, () => {
        void (async () => {
          if (t.agentId !== undefined) return onWriterDone(t.agentId, t.answer, t.isAborted)
          if (ownTurns.has(t.turnId)) {
            // A turn the mod itself caused is never reviewed: no review of reviews.
            ownTurns.delete(t.turnId)
            const length = (await $.session.messages()).length
            await mutate(d => ({ ...d, cursors: { ...d.cursors, [sessionId]: length } }))
            return
          }
          const db = await read($, dbAtom)
          if (db.enabled && autoReview && !t.isAborted) startReview(false)
        })().catch(err => $.ui.log(`DecisionCritic: ${String(err)}`))
      })
    }

    async function command(arg: string): Promise<string> {
      if (arg === 'on') {
        await mutate(d => ({ ...d, enabled: true }))
        pump()
        return `DecisionCritic is on. ${autoReview ? 'Each completed turn is reviewed by a separate critic model.' : 'Automatic review is disabled in its options; use /decisioncritic review.'}`
      }
      if (arg === 'off') {
        const db = await mutate(d => ({ ...d, enabled: false }))
        const running = db.jobs.find(j => ACTIVE.includes(j.status))
        return `DecisionCritic is off: no automatic reviews, and queued corrections wait.${running === undefined ? '' : ` ${running.id} is already running and will finish.`}`
      }
      if (arg === 'review') {
        await show('cards')
        startReview(true)
        return 'DecisionCritic is reviewing the recent decisions; cards appear in its pane.'
      }
      if (arg === 'history') {
        await show('history')
        return historyText(await read($, dbAtom))
      }
      const db = await read($, dbAtom)
      const c = counts(db)
      return `DecisionCritic is ${db.enabled ? 'on' : 'off'}: ${c.open} open, ${c.queued} waiting, ${c.active} running, ${c.done} fixed.\nUsage: /decisioncritic on | off | review | history`
    }

    async function doDismiss(cardId: string): Promise<void> {
      const now = await $.clock.now()
      await mutate(db => dismiss(db, cardId, now))
    }

    async function toggle(): Promise<void> {
      await mutate(d => ({ ...d, enabled: !d.enabled }))
      pump()
    }

    sessionId = await $.session.id()
    root = (await $.session.root().catch(() => '')) || e.cwd
    storeKey = `db:${root.replace(/\\/g, '/').toLowerCase()}`
    const now = await $.clock.now()
    const held = await $.state.get({ plugin: 'decisioncritic', key: 'db' } as const)
    const base = held.version > 0 && held.value !== undefined ? normalizeDb(held.value) : normalizeDb(await $.store.get(storeKey))
    await mutate(() => recover(base, sessionId, now))
    api = { onTurnComplete, command, startReview, pump, doAccept, doDismiss, doApprove, show, setUi, toggle }

    await $.command.register({
      name: 'decisioncritic',
      description: 'DecisionCritic: on | off | review | history',
      argumentHint: 'on|off|review|history',
    })
    await $.agent
      .register({
        name: 'writer',
        description: 'DecisionCritic code writer. Spawned only by the DecisionCritic mod to implement an approved correction.',
        prompt: WRITER_SYSTEM,
        model: writerModel,
        disallowedTools: ['Agent', 'Task'],
      })
      .catch(err => $.ui.log(`DecisionCritic: writer agent not registered: ${String(err)}`))

    const db = await read($, dbAtom)
    if (db.enabled && e.isInteractive) void $.ui.open({ id: PANE, title: 'DecisionCritic' })
    $.clock.after(0, () => void resume().catch(err => $.ui.log(`DecisionCritic resume failed: ${String(err)}`)))
    return next(e)
  })

  // The writer is the mod's own: the main model never delegates to it.
  on('agent.offer', { agent: WRITER }, () => ({ isOffered: false }))

  on('turn.start', ($, e, next) => {
    if (e.text.includes(MARKER)) ownTurns.add(e.turnId)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    api?.onTurnComplete({ agentId: e.agentId, answer: e.answer, isAborted: e.isAborted, turnId: e.turnId })
    return result
  })

  on('command.run', { command: 'decisioncritic' }, async ($, e) => {
    const arg = (e.args.trim().toLowerCase().split(/\s+/)[0] ?? '').replace(/^-+/, '')
    await $.ui.open({ id: PANE, title: 'DecisionCritic' })
    if (api === undefined) return { text: 'DecisionCritic is still starting; try again in a moment.' }
    return { text: await api.command(arg) }
  })

  // Press handlers in the pane reach the session's work through these.
  const act = {
    show: (view: UiState['view'], selected?: string) => void api?.show(view, selected),
    page: (change: (page: number) => number) => void api?.setUi(u => ({ ...u, page: change(u.page) })),
    review: () => api?.startReview(true),
    toggle: () => void api?.toggle(),
    accept: (cardId: string) => void api?.doAccept(cardId),
    dismiss: (cardId: string) => void api?.doDismiss(cardId),
    approve: (jobId: string, ok: boolean) => void api?.doApprove(jobId, ok),
  }

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const db = normalizeDb(await read($, dbAtom))
    const ui = await read($, uiAtom)
    const now = await $.clock.now()
    const width = Math.max(30, e.props.bodyColumns)
    const rows = e.viewport?.rows ?? 40
    const el: El = $.ui.resolve(e)
    return renderPane(el, { db, ui, now, width, rows, reviewing: ui.reviewing })
  })

  type PaneData = { db: Db; ui: UiState; now: number; width: number; rows: number; reviewing: boolean }
  type El = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Code'>

  function renderPane(el: El, s: PaneData): RenderElement {
    const { Box, Text, Button } = el
    const { db, ui } = s
    const c = counts(db)
    const active = db.jobs.find(j => ACTIVE.includes(j.status))
    const history = db.cards.filter(card => card.status !== 'open').length
    const tab = (view: UiState['view'], label: string, hotkey: string) => (
      <Button key={`tab:${view}`} label={label} hotkey={hotkey} variant={ui.view === view ? 'primary' : undefined} onPress={() => act.show(view)} />
    )
    return (
      <Box flexDirection="column" width={s.width}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold color="claude">◆ DecisionCritic</Text>
          <Text color={db.enabled ? 'success' : 'inactive'} bold>{db.enabled ? '● ON' : '○ OFF'}</Text>
        </Box>
        <Text dimColor>
          {c.open} open · {c.queued} waiting · {c.active} running · {c.done} fixed
        </Text>
        {s.reviewing && <Text color="suggestion">⟳ Critic is reviewing recent decisions…</Text>}
        {active !== undefined && (
          <Text color="warning">● {active.id} · {active.cardId} · {phaseLabel(active)}</Text>
        )}
        {!s.reviewing && active === undefined && db.lastReviewNote !== undefined && (
          <Text dimColor wrap="truncate-end">Last review {ago(s.now, db.lastReviewAt)}: {db.lastReviewNote}</Text>
        )}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {tab('cards', `Cards ${c.open}`, '1')}
          {tab('queue', `Queue ${c.queued + c.active}`, '2')}
          {tab('history', `History ${history}`, '3')}
          <Button key="review" label={s.reviewing ? 'Reviewing…' : 'Review now'} hotkey="r" onPress={() => act.review()} />
          <Button
            key="toggle"
            label={db.enabled ? 'Turn off' : 'Turn on'}
            onPress={() => act.toggle()}
          />
        </Box>
        <Text dimColor>{'─'.repeat(Math.max(10, s.width - 1))}</Text>
        {ui.view === 'cards' && renderCards(el, s)}
        {ui.view === 'queue' && renderQueue(el, s)}
        {ui.view === 'history' && renderHistory(el, s)}
        {ui.view === 'details' && renderDetails(el, s)}
      </Box>
    )
  }

  function pager(el: El, page: number, pages: number): RenderElement | false {
    const { Box, Text, Button } = el
    if (pages <= 1) return false
    return (
      <Box flexDirection="row" columnGap={1} marginTop={1}>
        <Button key="prev" label="‹ Prev" dimColor={page === 0} onPress={() => act.page(p => Math.max(0, p - 1))} />
        <Text dimColor>
          page {page + 1} of {pages}
        </Text>
        <Button key="next" label="Next ›" dimColor={page >= pages - 1} onPress={() => act.page(p => Math.min(pages - 1, p + 1))} />
      </Box>
    )
  }

  function renderCards(el: El, s: PaneData): RenderElement {
    const { Box, Text, Button } = el
    const open = s.db.cards.filter(card => card.status === 'open').reverse()
    if (open.length === 0) {
      return (
        <Box flexDirection="column" paddingY={1}>
          <Text color="success">✓ No open criticisms.</Text>
          <Text dimColor>
            {s.db.enabled ? 'Each completed turn is reviewed by a separate critic model.' : 'Automatic review is off. Press Review now or run /decisioncritic on.'}
          </Text>
        </Box>
      )
    }
    const per = Math.max(1, Math.floor((s.rows - 9) / 13))
    const pages = Math.ceil(open.length / per)
    const page = Math.min(s.ui.page, pages - 1)
    const shown = open.slice(page * per, page * per + per)
    return (
      <Box flexDirection="column" rowGap={1}>
        {shown.map((card, i) => {
          const first = i === 0
          const ev = card.evidence[0]
          return (
            <Box key={`card:${card.id}`} flexDirection="column" borderStyle="round" borderColor={severityColor(card.severity)} paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text>
                  <Text bold color={severityColor(card.severity)}>{card.severity.toUpperCase()}</Text>
                  <Text dimColor> · {card.category} · {card.id}</Text>
                </Text>
                <Text dimColor>{Math.round(card.confidence * 100)}% · {ago(s.now, card.createdAt)}</Text>
              </Box>
              {field(el, "What Claude decided", card.decision)}
              {field(el, "Why it is a problem", card.concern)}
              {field(el, "What could go wrong", card.consequence)}
              {field(el, "Suggested fix", card.correction, "success")}
              {ev !== undefined && (
                <Text dimColor italic wrap="truncate-end">
                  “{ev.quote}” — {ev.locator}{card.evidence.length > 1 ? ` (+${card.evidence.length - 1})` : ''}
                </Text>
              )}
              <Box flexDirection="row" columnGap={1} marginTop={1}>
                <Button key={`accept:${card.id}`} label="Accept" variant="primary" hotkey={first ? 'a' : undefined} onPress={() => act.accept(card.id)} />
                <Button key={`dismiss:${card.id}`} label="Dismiss" hotkey={first ? 'd' : undefined} onPress={() => act.dismiss(card.id)} />
                <Button key={`details:${card.id}`} label="Details" hotkey={first ? 'i' : undefined} onPress={() => act.show('details', card.id)} />
              </Box>
            </Box>
          )
        })}
        {pager(el, page, pages)}
      </Box>
    )
  }

  function renderQueue(el: El, s: PaneData): RenderElement {
    const { Box, Text, Button } = el
    const jobs = s.db.jobs.filter(j => !FINAL.includes(j.status)).sort((a, b) => a.createdAt - b.createdAt)
    if (jobs.length === 0) return <Text dimColor>No corrections queued. Accept a card to queue its correction.</Text>
    return (
      <Box flexDirection="column" rowGap={1}>
        {!s.db.enabled && <Text color="warning">Paused: DecisionCritic is off, queued corrections wait.</Text>}
        {jobs.map(job => {
          const card = s.db.cards.find(c => c.id === job.cardId)
          return (
            <Box key={`job:${job.id}`} flexDirection="column" borderStyle="round" borderColor={jobColor(job)} paddingX={1}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>{job.id} → {job.cardId}</Text>
                <Text color={jobColor(job)}>{phaseLabel(job)}</Text>
              </Box>
              <Text wrap="truncate-end">{card?.decision ?? ''}</Text>
              {roundsBar(el, job)}
              {steps(el, job.steps, s.now)}
              <Box flexDirection="row" columnGap={1} marginTop={1}>
                <Button key={`jobdetails:${job.id}`} label="Details" onPress={() => act.show('details', job.cardId)} />
                {job.status === 'awaiting-approval' && (
                  <Button key={`approve:${job.id}`} label="Approve revised" variant="primary" onPress={() => act.approve(job.id, true)} />
                )}
                {job.status === 'awaiting-approval' && <Button key={`decline:${job.id}`} label="Decline" onPress={() => act.approve(job.id, false)} />}
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  }

  function renderHistory(el: El, s: PaneData): RenderElement {
    const { Box, Text, Button } = el
    const past = s.db.cards.filter(c => c.status !== 'open').reverse()
    if (past.length === 0) return <Text dimColor>No history yet. Accepted and dismissed cards are kept here across restarts.</Text>
    const per = Math.max(3, s.rows - 10)
    const pages = Math.ceil(past.length / per)
    const page = Math.min(s.ui.page, pages - 1)
    return (
      <Box flexDirection="column">
        {past.slice(page * per, page * per + per).map(card => (
          <Box key={`hist:${card.id}`} flexDirection="row" columnGap={1}>
            <Text color={statusColor(card.status)}>{statusIcon(card.status)}</Text>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text bold>{card.id}</Text> <Text dimColor>{card.status}</Text> {card.decision}
              </Text>
            </Box>
            <Button key={`hdetails:${card.id}`} label="›" plain onPress={() => act.show('details', card.id)} />
          </Box>
        ))}
        {pager(el, page, pages)}
      </Box>
    )
  }

  function renderDetails(el: El, s: PaneData): RenderElement {
    const { Box, Text, Button, Code } = el
    const card = s.db.cards.find(c => c.id === s.ui.selected)
    const back = <Button key="back" label="‹ Back" hotkey="b" onPress={() => act.show(card !== undefined && card.status === 'open' ? 'cards' : card?.jobId !== undefined && !FINAL.includes(jobStatus(s.db, card.jobId)) ? 'queue' : 'history')} />
    if (card === undefined) return <Box flexDirection="column">{back}<Text dimColor>That card is no longer kept.</Text></Box>
    const job = card.jobId === undefined ? undefined : s.db.jobs.find(j => j.id === card.jobId)
    const ch = job?.challenge
    const last = job?.rounds[job.rounds.length - 1]
    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {back}
          {card.status === 'open' && <Button key={`daccept:${card.id}`} label="Accept" variant="primary" hotkey="a" onPress={() => act.accept(card.id)} />}
          {card.status === 'open' && (
            <Button key={`ddismiss:${card.id}`} label="Dismiss" onPress={() => act.dismiss(card.id)} />
          )}
          {(card.status === 'failed' || card.status === 'interrupted') && (
            <Button key={`retry:${card.id}`} label="Retry" variant="primary" onPress={() => act.accept(card.id)} />
          )}
          {job?.status === 'awaiting-approval' && <Button key={`dapprove:${job.id}`} label="Approve revised" variant="primary" onPress={() => act.approve(job.id, true)} />}
          {job?.status === 'awaiting-approval' && <Button key={`ddecline:${job.id}`} label="Decline" onPress={() => act.approve(job.id, false)} />}
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={severityColor(card.severity)} paddingX={1}>
          <Text>
            <Text bold color={severityColor(card.severity)}>{card.severity.toUpperCase()}</Text>
            <Text dimColor> · {card.category} · {card.id} · {Math.round(card.confidence * 100)}% confidence · </Text>
            <Text color={statusColor(card.status)}>{card.status}</Text>
          </Text>
          {field(el, "What Claude decided", card.decision)}
          {field(el, "Why it is a problem", card.concern)}
          {field(el, "What could go wrong", card.consequence)}
          {field(el, "Suggested fix", card.correction, "success")}
        </Box>
        <Box flexDirection="column">
          <Text bold>Proof from the conversation</Text>
          {card.evidence.map((ev, i) => (
            <Text>
              <Text dimColor>{ev.source === 'requirement' ? '§' : '›'} {ev.locator}: </Text>
              <Text italic>“{ev.quote}”</Text>
            </Text>
          ))}
          {card.requirements.map((r, i) => (
            <Text color="permission">§ {r}</Text>
          ))}
        </Box>
        {job !== undefined && (
          <Box flexDirection="column">
            <Box flexDirection="row" justifyContent="space-between">
              <Text bold>Correction job {job.id}</Text>
              <Text color={jobColor(job)}>{phaseLabel(job)}</Text>
            </Box>
            {roundsBar(el, job)}
            {steps(el, job.steps, s.now)}
            {job.outcome !== undefined && <Text color={jobColor(job)}>{job.outcome}</Text>}
          </Box>
        )}
        {ch !== undefined && (
          <Box flexDirection="column">
            <Text bold>
              Second opinion: <Text color={ch.verdict === 'unjustified' ? 'error' : ch.verdict === 'revised' ? 'warning' : 'success'}>{ch.verdict === 'unjustified' ? 'the criticism was wrong, no fix needed' : ch.verdict === 'revised' ? 'right problem, but the fix needed changing' : 'the criticism holds, fix it as suggested'}</Text>
              {ch.scopeChange ? <Text color="warning"> · scope change</Text> : ''}
            </Text>
            <Text>{ch.reasoning}</Text>
            {ch.revisedCorrection !== null && (
              <Box flexDirection="column" borderStyle="single" borderColor="warning" paddingX={1}>
                <Text bold color="warning">Changed suggestion (needs your OK)</Text>
                <Text>{ch.revisedCorrection}</Text>
              </Box>
            )}
            {ch.counterexamples.map((cx, i) => (
              <Text>
                <Text color={cx.breaksCorrection ? 'error' : 'success'}>{cx.breaksCorrection ? '✗' : '✓'}</Text> {cx.scenario}
                <Text dimColor>{cx.note === '' ? '' : ` — ${cx.note}`}</Text>
              </Text>
            ))}
            {ch.requirementsChecked.map((r, i) => (
              <Text>
                <Text color={r.satisfied ? 'success' : 'error'}>{r.satisfied ? '§✓' : '§✗'}</Text> {r.requirement}
                <Text dimColor>{r.note === '' ? '' : ` — ${r.note}`}</Text>
              </Text>
            ))}
            {ch.acceptanceCriteria.length > 0 && <Text bold>How we will know it worked</Text>}
            {ch.acceptanceCriteria.map((a, i) => (
              <Text>• {a}</Text>
            ))}
          </Box>
        )}
        {job?.rounds.map(round => (
          <Box key={`round:${round.n}`} flexDirection="column">
            <Text bold>
              Round {round.n}/{MAX_ROUNDS}{' '}
              {round.verification === undefined ? (
                <Text color="warning">{round.writerReport === undefined ? 'making the fix…' : 'checking…'}</Text>
              ) : (
                <Text color={round.verification.passed ? 'success' : 'error'}>{round.verification.passed ? '✓ verified' : '✗ not verified'}</Text>
              )}
            </Text>
            {round.verification?.checks.map((chk, i) => (
              <Text>
                <Text color={chk.passed ? 'success' : 'error'}>{chk.passed ? '✓' : '✗'}</Text> {chk.criterion}
                <Text dimColor>{chk.evidence === '' ? '' : ` — ${chk.evidence}`}</Text>
              </Text>
            ))}
            {round.verification?.command !== undefined && (
              <Text>
                <Text color={round.verification.command.exitCode === 0 ? 'success' : 'error'}>$ {round.verification.command.argv} → exit {round.verification.command.exitCode}</Text>
              </Text>
            )}
            {round.verification?.feedback !== undefined && round.verification.feedback !== '' && <Text dimColor>{round.verification.feedback}</Text>}
            {round.diffStat !== undefined && round.diffStat !== '' && <Text dimColor>{round.diffStat}</Text>}
          </Box>
        ))}
        {last?.verification?.command !== undefined && last.verification.command.output !== '' && (
          <Box flexDirection="column">
            <Text bold>Check results (round {last.n})</Text>
            <Code source={clip(last.verification.command.output, 4000)} wrap="wrap" />
          </Box>
        )}
        {last?.diff !== undefined && last.diff !== '' && (
          <Box flexDirection="column">
            <Text bold>What changed in the files (round {last.n})</Text>
            <Code source={clip(last.diff, 20_000)} format={last.diff.startsWith('diff --git') ? 'diff' : undefined} />
          </Box>
        )}
        {last?.writerReport !== undefined && (
          <Box flexDirection="column">
            <Text bold>What the fixer said (round {last.n})</Text>
            <Text dimColor>{clip(last.writerReport, 3000)}</Text>
          </Box>
        )}
      </Box>
    )
  }

  function field(el: El, label: string, text: string, color?: 'success'): RenderElement {
    const { Text } = el
    return (
      <Text>
        <Text bold color={color}>{label}: </Text>
        {text}
      </Text>
    )
  }

  function steps(el: El, list: readonly JobStep[], now: number): RenderElement {
    const { Box, Text } = el
    return (
      <Box flexDirection="column">
        {list.map(step => (
          <Text wrap="truncate-end">
            <Text color={stepColor(step.state)}>{stepIcon(step.state)}</Text> {step.label}
            <Text dimColor>
              {step.at === undefined ? '' : ` · ${ago(now, step.at)}`}
              {step.note === undefined ? '' : ` · ${step.note}`}
            </Text>
          </Text>
        ))}
      </Box>
    )
  }

  function roundsBar(el: El, job: Job): RenderElement {
    const { Text } = el
    const done = job.rounds.length
    const cells = Array.from({ length: MAX_ROUNDS }, (_, i) => {
      const round = job.rounds[i]
      if (round === undefined) return { glyph: '□', color: 'inactive' as const }
      if (round.verification === undefined) return { glyph: '■', color: 'warning' as const }
      return { glyph: '■', color: round.verification.passed ? ('success' as const) : ('error' as const) }
    })
    return (
      <Text>
        <Text dimColor>Rounds </Text>
        {cells.map((cell, i) => (
          <Text color={cell.color}>{cell.glyph}</Text>
        ))}
        <Text dimColor> {done}/{MAX_ROUNDS}</Text>
      </Text>
    )
  }
}

// ---------------------------------------------------------------- display helpers

function jobStatus(db: Db, jobId: string): Job['status'] {
  return db.jobs.find(j => j.id === jobId)?.status ?? 'done'
}

function phaseLabel(job: Job): string {
  const n = job.rounds.length
  switch (job.status) {
    case 'queued':
      return job.approvedRevision === true ? 'approved, waiting to start' : 'queued'
    case 'challenging':
      return 'double-checking the fix…'
    case 'awaiting-approval':
      return 'needs your approval'
    case 'implementing':
      return `round ${n}/${MAX_ROUNDS} · making the fix…`
    case 'verifying':
      return `round ${n}/${MAX_ROUNDS} · checking the fix…`
    case 'done':
      return `verified in round ${n}`
    case 'rejected':
      return 'turned out fine — no fix needed'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
  }
}

type Tone = 'error' | 'warning' | 'success' | 'inactive' | 'suggestion' | 'subtle' | 'permission'

function severityColor(severity: Card['severity']): Tone {
  return severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'suggestion'
}

function jobColor(job: Job): Tone {
  if (job.status === 'done') return 'success'
  if (job.status === 'failed' || job.status === 'interrupted') return 'error'
  if (job.status === 'rejected') return 'inactive'
  if (job.status === 'awaiting-approval') return 'permission'
  return 'warning'
}

function statusColor(status: Card['status']): Tone {
  if (status === 'done') return 'success'
  if (status === 'failed' || status === 'interrupted') return 'error'
  if (status === 'dismissed' || status === 'rejected') return 'inactive'
  if (status === 'awaiting-approval') return 'permission'
  return 'warning'
}

function statusIcon(status: Card['status']): string {
  if (status === 'done') return '✓'
  if (status === 'failed' || status === 'interrupted') return '✗'
  if (status === 'dismissed') return '–'
  if (status === 'rejected') return '⊘'
  if (status === 'awaiting-approval') return '?'
  return '●'
}

function stepIcon(state: JobStep['state']): string {
  return state === 'done' ? '✓' : state === 'active' ? '●' : state === 'failed' ? '✗' : state === 'skipped' ? '–' : '○'
}

function stepColor(state: JobStep['state']): Tone {
  return state === 'done' ? 'success' : state === 'active' ? 'warning' : state === 'failed' ? 'error' : 'inactive'
}

function ago(now: number, at: number | undefined): string {
  if (at === undefined) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86_400)}d ago`
}

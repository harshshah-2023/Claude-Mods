// The texts the critic and the writer read. Each critic call is a separate,
// history-free `$.model.complete`; the writer is the mod's one subagent type.
import type { Card, Challenge, Job, Round } from '../types'

import { MARKER, clip } from './core'

// Everything the critic writes for the person (not the quotes, which stay
// verbatim) is in plain language a non-programmer can follow.
export const PLAIN_LANGUAGE = `WRITE FOR A NON-EXPERT. The person reading your explanations may not be a programmer.
- Use everyday words and short sentences (aim for under 20 words each). Explain like you would to a smart friend outside the field.
- Avoid jargon. If a technical term is unavoidable (a file name, a tool, a command), keep it but add a few plain words saying what it is, e.g. "the test suite (the automatic checks)".
- Say what happens in real life, not in code terms: "prices could come out slightly wrong", not "floating-point precision loss".
- Be concrete and calm. No acronyms without spelling them out, no hedging filler, no lecturing.
- This applies to every explanation you write: decision, concern, consequence, correction, reasoning, notes, feedback and acceptance criteria.
- It does NOT apply to evidence quotes: those must still be copied exactly, word for word.`

export const CRITIC_SYSTEM =`You are DecisionCritic, an independent senior reviewer. You did not write the work you review and you owe it no loyalty.
You judge the observable decisions an AI coding agent made: business, product, technical, architectural, development-process, testing and security decisions.
You are rigorous, specific and fair. You never invent facts: every claim you make about what the agent did must be backed by a verbatim quote from the material you were given.
You answer with one JSON object and nothing else.

${PLAIN_LANGUAGE}`

export function reviewPrompt(transcript: string, requirements: string): string {
  return `Review the agent's decisions in the transcript below.

REQUIREMENTS (the project's own rules; they win over the agent's preferences):
<requirements>
${requirements || '(none provided)'}
</requirements>

TRANSCRIPT (main thread; [#n ROLE] marks message n; tool calls are listed under the message that made them):
<transcript>
${transcript}
</transcript>

Find at most 4 decisions that are materially wrong, risky, or that contradict the requirements. A decision is something the agent chose: a design, a scope cut, a tool or library, a data shape, an assumption, skipping a test, a command it ran, a claim it reported as done.
Do NOT report: style nits, decisions that are fine, things outside the transcript, speculative concerns without evidence, or anything about DecisionCritic itself. Reporting nothing is a good answer when nothing is wrong.

For each criticism give:
- category: business | product | technical | architecture | development | testing | security | process
- severity: high | medium | low
- confidence: 0..1 that the criticism is correct
- decision: what the agent decided, one plain sentence
- concern: why it is a problem, in plain words
- consequence: what could actually go wrong for the people using it, in plain words
- correction: the specific fix, said plainly (name the file if needed), small enough to make and check
- evidence: 1-4 items {"quote": "<verbatim text copied exactly from the transcript or requirements, 8-300 chars>", "locator": "<e.g. #12 assistant, #12 tool Edit path/x.py, CLAUDE.md>"}
- requirements: the requirement lines it violates, if any

Quotes are checked mechanically; a criticism whose quotes are not found verbatim is discarded.

Answer: {"criticisms": [ ... ]}`
}

export function challengePrompt(card: Card, requirements: string, repoState: string): string {
  return `A reviewer criticised a decision and the user accepted the criticism. Before anything is changed, challenge the proposed correction rigorously. You are allowed, and expected, to conclude the criticism is wrong.

REQUIREMENTS:
<requirements>
${requirements || '(none provided)'}
</requirements>

REPOSITORY STATE:
<repo>
${repoState}
</repo>

CRITICISM ${card.id} (${card.category}, ${card.severity}):
- Decision: ${card.decision}
- Concern: ${card.concern}
- Consequence: ${card.consequence}
- Proposed correction: ${card.correction}
- Evidence:
${card.evidence.map(e => `  - [${e.locator}] "${e.quote}"`).join('\n')}

Do this:
1. Check the correction against every relevant requirement.
2. Construct at least 3 concrete counterexamples: situations where the original decision was right, or where the correction breaks something, conflicts with a requirement, or is incomplete.
3. Decide:
   - "justified": the criticism holds and the correction as stated is right.
   - "unjustified": the criticism is wrong (explain exactly why, citing the requirement or fact that defeats it).
   - "revised": the criticism holds but the correction must change. Give revisedCorrection. Set scopeChange true when the revision touches more files, behaviour or requirements than the original correction would, adds new work, or changes product behaviour the user did not accept; false only for a tighter equivalent of the same change.
4. Give a short implementation plan and testable acceptance criteria.

Answer exactly:
{"verdict": "justified|unjustified|revised", "reasoning": "...", "counterexamples": [{"scenario": "...", "breaksCorrection": true|false, "note": "..."}], "requirementsChecked": [{"requirement": "...", "satisfied": true|false, "note": "..."}], "scopeChange": true|false, "revisedCorrection": "..." or null, "plan": ["..."], "acceptanceCriteria": ["..."]}`
}

export const WRITER_SYSTEM = `You are the DecisionCritic code writer: the single agent that implements an approved correction in this repository.
Rules:
- Implement exactly the approved correction and nothing else. Keep the diff minimal and in the style of the surrounding code.
- Read and follow the repository's CLAUDE.md and the documents it names before editing.
- Work test-first where the repository asks for it; run the relevant tests, linters and type checks for what you changed.
- Never commit, push, merge, change branches, or edit git history. Never touch files the repository marks private.
- Never start other agents.
- If the correction turns out to be wrong or impossible, change nothing and say so.
Finish with a report in this exact form as the last thing you write:
\`\`\`json
{"summary": "...", "filesChanged": ["..."], "commandsRun": [{"command": "...", "exitCode": 0, "result": "..."}], "openConcerns": ["..."]}
\`\`\``

export function writerPrompt(card: Card, job: Job, previous: Round | undefined): string {
  const challenge = job.challenge
  const criteria = challenge?.acceptanceCriteria ?? []
  const plan = challenge?.plan ?? []
  const retry =
    previous === undefined
      ? ''
      : `

THIS IS ROUND ${previous.n + 1} OF 3. Round ${previous.n} did not pass verification.
Verifier feedback: ${previous.verification?.feedback ?? '(none)'}
Failed checks:
${(previous.verification?.checks ?? []).filter(c => !c.passed).map(c => `- ${c.criterion}: ${c.evidence}`).join('\n') || '- (none listed)'}
${previous.verification?.command === undefined ? '' : `Verification command \`${previous.verification.command.argv}\` exited ${previous.verification.command.exitCode}:\n${clip(previous.verification.command.output, 3000)}`}
The working tree already holds round ${previous.n}'s changes. Fix what failed; do not start over unless needed.`
  return `${MARKER} Implement correction for ${card.id} (job ${job.id}).

Decision being corrected: ${card.decision}
Why: ${card.concern}

APPROVED CORRECTION:
${job.correction}

PLAN:
${plan.map(p => `- ${p}`).join('\n') || '- (use your judgement)'}

ACCEPTANCE CRITERIA (an independent verifier checks each one against your diff):
${criteria.map(c => `- ${c}`).join('\n') || '- The correction above is implemented and tested.'}${retry}`
}

export function verifyPrompt(card: Card, job: Job, round: Round, commandText: string): string {
  const challenge: Challenge | undefined = job.challenge
  return `Verify one round of a code correction. Be strict: pass it only when the diff really implements the approved correction, meets every acceptance criterion, and introduces no regression you can see. Do not trust the writer's report over the diff.

APPROVED CORRECTION for ${card.id}:
${job.correction}

ACCEPTANCE CRITERIA:
${(challenge?.acceptanceCriteria ?? ['The correction is implemented.']).map(c => `- ${c}`).join('\n')}

DIFF (round ${round.n}, against the tree as it was before the job started):
<diff>
${clip(round.diff ?? '', 40_000) || '(empty)'}
</diff>

WRITER REPORT:
<report>
${clip(round.writerReport ?? '(none)', 6000)}
</report>

VERIFICATION COMMAND:
${commandText}

Answer exactly:
{"passed": true|false, "checks": [{"criterion": "<each acceptance criterion>", "passed": true|false, "evidence": "<diff lines or output that show it>"}], "feedback": "<what the writer must fix next round, or why it passed>"}`
}

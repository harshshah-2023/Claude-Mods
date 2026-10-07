# DecisionCritic

A Claude Code mod that reviews the decisions Claude visibly makes in a session (business, product, technical, architectural, development, testing, security, process). It shows each criticism as a card in a side pane, and when you accept one it challenges, implements and verifies the fix.

## Commands

| Command | What it does |
|---|---|
| `/decisioncritic on` | Turn on: each finished main-thread turn gets reviewed, and the queue runs |
| `/decisioncritic off` | Stop automatic reviews and pause the queue. A correction that is already running finishes |
| `/decisioncritic review` | Review the recent decisions now. This works even when the mod is off |
| `/decisioncritic history` | Print the history and open the History tab |

Pane keys: `1` Cards, `2` Queue, `3` History, `r` Review now. On the top card: `a` Accept, `d` Dismiss, `i` Details. In Details: `b` Back.

## How a card is made

1. Each review is a separate `$.model.complete` call to the critic model. It has no shared history and gets only the new main-thread messages and your requirement documents (`CLAUDE.md` by default).
2. The critic has to quote evidence word for word. The mod checks every quote against the transcript, ignoring whitespace and case. A criticism with no quote found in the transcript is thrown away.
3. Duplicate criticisms are skipped (matched by fingerprint and by decision text).

## What Accept does

1. **Queue.** Accepting a card is idempotent: one card gets one job, and only one job runs at a time.
2. **Challenge.** A separate critic call checks the correction against the requirements and at least three counterexamples. It ends in one of three verdicts:
   - *unjustified*: the card is marked rejected and the reasoning is shown. Nothing is changed.
   - *revised* with a scope change: the job waits for you to approve or decline the revised proposal.
   - *justified*, or a tighter revision: the job goes on to implementation.
3. **Implement.** The one code writer (the `decisioncritic:writer` subagent, hidden from the main model) makes the change. It never commits or pushes.
4. **Verify.** The mod takes a diff of the working tree against a `git stash create` snapshot taken before round 1, plus any new files. It runs your optional `verifyCommand`, then a critic call checks every acceptance criterion against the diff. A round passes only if the verdict is pass, every check passes, the command exits 0 and the diff is not empty.
5. If a round fails, the critic's feedback goes into the next round. There are **at most 3 rounds**. After that the job is marked failed and the changes stay in the tree for you to review. The mod never reverts anything.

## Safety

- **No review of its own work.** Writer turns, the mod's own command rows and turns started by its marker are never reviewed.
- **Restarts never re-run anything.** A job that was running in a session that ended is marked *interrupted*, and Retry starts it again only when you press it. After a hot reload in the same session, the mod resumes side-effect-free steps and watches a writer that is still alive.
- **History persists** in the plugin store, one entry per project root, trimmed to stay within the 4 MiB store limit.

## Options (`/config` → plugin options)

`criticModel` (default `sonnet`), `writerModel` (default `inherit`), `autoReview` (default on), `verifyCommand` (for example `uv run pytest -q`), `requirementsFiles` (default `CLAUDE.md`, comma-separated).

## Develop

```
claude plugin validate <this folder>
claude plugin test <this folder>
```

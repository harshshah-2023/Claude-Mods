# Claude Code Mods

Two Claude Code mods, packaged as plugins and published as one plugin marketplace, `claude-code-mods`.

> These are independent, community-built mods. They are not made, endorsed or supported by Anthropic. "Claude" and "Claude Code" are Anthropic's trademarks and are used here only to say what the mods work with.

| Mod | Command | What it does |
|---|---|---|
| [WorkTrace](worktrace/README.md) | `/worktrace` | A persistent file tree and timeline of the files Claude reads, searches and changes, with summaries and exact diffs |
| [DecisionCritic](decisioncritic/README.md) | `/decisioncritic` | Reviews Claude's visible decisions with a separate critic model and shows evidence-backed criticism cards you can accept, challenge, implement and verify |

## Install

In a Claude Code session:

```
/plugin marketplace add harshshah-2023/Claude-Mods
/plugin install worktrace@claude-code-mods
/plugin install decisioncritic@claude-code-mods
```

From your shell, the same steps are `claude plugin marketplace add harshshah-2023/Claude-Mods` and `claude plugin install <name>@claude-code-mods`. You can install either mod by itself.

## WorkTrace

WorkTrace keeps a browsable record, per project, of the files Claude reads, searches and changes. It shows that record in a side pane with tabs for Tree, Timeline, History and Graph.

![WorkTrace pane screenshot](docs/worktrace.png) <!-- placeholder: add a screenshot -->

- It records Read, Glob, Grep, Edit, Write and NotebookEdit calls as they happen. It reads the file directly before each edit, so changes that were already uncommitted are never attributed to Claude.
- After each Bash or PowerShell command it checks `git status` and blob hashes. It records the files that changed as "Detected change—attribution uncertain".
- It writes two-sentence file summaries through the session's own sign-in (no API key needed). If the model is unavailable, it falls back to a factual summary.
- History is stored under `~/.claude/worktrace/` and kept across sessions. Nothing is deleted until you run `/worktrace delete` and confirm.

Commands: `/worktrace on`, `off`, `history`, `graph`, `task <name>` and `delete`. See [worktrace/README.md](worktrace/README.md) for pane keys, options and known limitations.

## DecisionCritic

After each turn, DecisionCritic has a separate critic model review the decisions Claude visibly made (business, product, technical, architectural, development, testing, security, process). Each criticism appears as a card in a side pane.

![DecisionCritic pane screenshot](docs/decisioncritic.png) <!-- placeholder: add a screenshot -->

- Each criticism must quote the transcript word for word. A criticism whose quote can't be found in the transcript is discarded.
- When you **Accept** a card, the critic first challenges the proposed correction. If it holds up, one writer subagent implements it and the critic verifies the diff, along with your optional `verifyCommand`. This repeats for at most 3 rounds.
- It never commits, pushes or reverts. It never reviews its own work, and after a restart it never re-runs a job automatically.

Commands: `/decisioncritic on`, `off`, `review` and `history`. See [decisioncritic/README.md](decisioncritic/README.md) for the full accept flow, safety rules and options.

## Requirements

- Claude Code with mod (function-hook) plugin support. These mods were built and tested on Claude Code 2.1.292.
- `git` on `PATH`:
  - WorkTrace uses it to find changes made by shell commands. Without git, or outside a repository, that part is skipped.
  - DecisionCritic uses it to snapshot and diff the working tree when verifying corrections.
- Both mods call models through the session's own sign-in, so no API key is needed. Each critic or summary call uses your normal Claude usage.

## Run the tests

From the repository root:

```
claude plugin validate .
claude plugin test ./worktrace
claude plugin test ./decisioncritic
```

The tests are mocked: they run against an in-memory host, or against the engine's test host with a mocked file system, clock and store. At the time of release, worktrace has 20 tests and decisioncritic has 16, and all of them pass.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace catalog (name: claude-code-mods)
worktrace/                        WorkTrace plugin (hooks/, tests/, types/)
decisioncritic/                   DecisionCritic plugin (hooks/, tests/, types/)
```

Each plugin's `tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. Claude Code generates that file locally, and git ignores it.

## License

License: TBD. Add a LICENSE file before others reuse the code.

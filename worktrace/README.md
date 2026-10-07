# WorkTrace

A Claude Code mod (built for Claude Code 2.1.292) that keeps a persistent, browsable record of the files Claude reads, searches and changes: a file tree, a timeline, two-sentence summaries and exact diffs.

## Install

From the [claude-code-mods marketplace](../README.md):

```
/plugin marketplace add harshshah-2023/Claude-Mods
/plugin install worktrace@claude-code-mods
```

Or, from a local clone, for one session: `claude --plugin-dir ./worktrace`.

## Use

| Command | Effect |
|---|---|
| `/worktrace on` | Start recording for this project and open the pane. Stays on for this project in later sessions until turned off. |
| `/worktrace off` | Stop recording future activity and close the pane. History is kept. |
| `/worktrace history` | Open the pane on the History tab (no recording needed). |
| `/worktrace graph` | Open the pane on the Graph tab: one card per file, linked by arrows in the order Claude touched them. |
| `/worktrace task <name>` | Start a new task group. Follow-up prompts stay in the current task until you do this (or press `n`). |
| `/worktrace delete` | Choose a task, a session or the whole project's history to delete, with a confirmation. Nothing is ever deleted silently. |

Keys while the pane has focus (click it, or ctrl+x tab): `1` Tree, `2` Timeline, `3` History, `4` Graph, `j`/`k` next/previous, `o` fold the folder, `f` follow-live, `n` new task, `m` show search hits, `h` operation history, `c` diff, `d` this operation vs whole task, `r` refresh summary, `x` delete (History tab), `l` back to live. Every row is clickable in the fullscreen terminal.

Options (in `/config`, or `pluginConfigs.worktrace` in settings): `summaries` (`on-select` | `off`), `summaryModel` (default `haiku`), `storeSensitive` (default off), `icons` (`emoji` | `ascii`).

## What it records and how

- **Read, Glob, Grep, Edit, Write, NotebookEdit**: observed with the `tool.call` hook. The hook passes the call through unchanged and returns the tool's own result. Attempts are recorded first (`running`), then marked completed, failed, denied or interrupted.
- **Exact baselines**: before an edit the file is read directly, so uncommitted changes already present are part of the *before* state and never attributed to Claude. The tool's own `originalFile` is cross-checked; a difference (the file changed while a permission prompt waited) is recorded as a separate “Detected change—attribution uncertain”. So is any change between two of Claude's operations on a file.
- **Search vs read**: Glob/Grep are recorded on the searched folder; matching files are discoveries, shown only with “Search hits” on, and never counted as reads.
- **Bash / PowerShell**: `git status` and blob hashes before and after the command; changed, created, deleted and renamed files are recorded as “Detected change—attribution uncertain”, with exact diffs when the pre-command content was captured (HEAD for clean files, a snapshot for dirty ones).
- **Summaries**: generated in the background through `$.model.complete`, i.e. the session's own sign-in (no API key); cached on disk by an evidence hash; labelled AI / pending / stale / factual. If the model fails, a factual two-sentence summary from the record is shown and recording continues.

Storage: `~/.claude/worktrace/v1/<project>-<hash of root>/sessions/<session>/ev-<writer>-NNNN.json` (each process writes only its own files), content-addressed snapshots under `blobs/`, summaries under `summaries/`. Separate worktrees have separate roots, so separate histories.

## Limitations (this build)

- Files a shell command only *reads* (`cat`, `grep`, scripts) are not observable and are not shown. Shell changes to git-ignored files, and changes outside a git repository, are not reconciled; the command still appears in the timeline saying so.
- A background shell command (`run_in_background`) is reconciled only up to the moment it returns.
- Changes made by other tools (MCP servers, subagent-unrelated processes) between Claude's operations are only noticed when Claude next touches that file.
- Snapshots are capped at 512 KB per file (hash and size kept above that, up to 4 MiB); binary files are not diffed; files that look like credentials keep only hashes unless `storeSensitive` is on.
- `$.fs` has no delete, so explicit deletion runs `cmd /c rmdir` / `rm -rf`, restricted to the WorkTrace storage folder.
- The summary model sees at most ~160 lines of the file and ~160 diff lines; it is told to use only that evidence, but a model can still be wrong. Summaries never claim to know Claude's reasoning.
- Graph tab: arrows mean *touched next*, not *imports*. Files first touched within 2.5 s of each other (parallel reads) share a column, at most 3 per column. A green bar and ✓ mean changed, ● means working now, a blue border and • mean selected. Card text is the AI summary already held in memory, or otherwise the factual sentence from the record: drawing the graph never calls the model or reads the disk. Only the newest rows that fit are drawn; earlier files stay in Files and Activity.

## Tests

`claude plugin test ./worktrace`: 20 tests across 3 files, against an in-memory host, pure functions, or the engine's own test host with mocked fs/clock/store. They are mocked, not run against a live session.

// Observes tool calls and records what they did to files. It never changes a call:
// the hook hands `next` the event it received and returns what `next` resolved to.

import { boundHunks, diffText, hunkStats, type Hunk } from './diff'
import type { CommandEvent, FileOp, OpEvent, Outcome, Snap, TaskEvent, TraceEvent, TurnEvent } from './model'
import { latestTaskEvents } from './model'
import { type Blobs, Journal, loadSession, type Io } from './store'
import { byteLength, excerpt, isBinaryText, isSensitivePath, isUnder, lineCount, pathKey, randomId, redact, resolvePath, sha256 } from './util'

export type RunResult = { exitCode: number; stdout: string; stderr: string }

export type Host = {
  io: Io
  /** The file's text; rejects when missing or unreadable. */
  readFile: (path: string) => Promise<string>
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number } | null>
  run: (argv: readonly string[], cwd: string, stdin?: string) => Promise<RunResult>
  now: () => Promise<number>
}

export type RecorderOptions = {
  storeSensitive: boolean
  /** Largest file whose content is stored (bytes). */
  maxSnapshot: number
  /** Largest file read at all for hashing (the host's own read limit). */
  maxRead: number
  /** Most dirty files whose content is kept before a shell command. */
  maxShellCapture: number
}

export const DEFAULTS: RecorderOptions = {
  storeSensitive: false,
  maxSnapshot: 512 * 1024,
  maxRead: 4 * 1024 * 1024,
  maxShellCapture: 60,
}

export const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'Glob', 'Grep'])
export const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])

type ToolEvent = { tool: string; tool_use_id?: string; agentId?: string; [arg: string]: unknown }
type ToolResult = { deny?: string; isError?: boolean; result?: unknown; text?: string }

type GitFile = { rel: string; path: string; xy: string; hash?: string }
type GitState = { top: string; files: Map<string, GitFile>; snaps: Map<string, Snap> }

const PATCH_LINES = 400
const READ_EXCERPT = 32 * 1024

export class Recorder {
  events: TraceEvent[] = []
  private byId = new Map<string, number>()
  journal: Journal
  tracking = false
  taskId = ''
  turn = 0
  private lastAfter = new Map<string, Snap>()
  private directEditAt = new Map<string, number>()
  private gitTop = new Map<string, string | null>()
  private gitHashSnap = new Map<string, Snap>()
  loaded = false
  loadProblems: string[] = []

  constructor(
    private host: Host,
    readonly blobs: Blobs,
    readonly project: string,
    readonly root: string,
    public cwd: string,
    readonly sessionId: string,
    readonly writer: string,
    private opts: RecorderOptions,
    private changed: () => void,
    readonly exclude: string[] = [],
  ) {
    this.journal = new Journal(host.io, project, root, sessionId, writer)
  }

  /** Reads back what was recorded for this session (a reload, a resume, another process on it). */
  async load() {
    const { events, problems } = await loadSession(this.host.io, this.project, this.sessionId)
    this.loadProblems = problems
    this.journal.adopt(events)
    for (const e of events) this.index(e)
    for (const e of events) {
      if ((e.kind === 'op' || e.kind === 'command') && e.status === 'active' && e.writer === this.writer) {
        this.put({ ...e, status: 'interrupted', error: 'Recording stopped (reload or exit) before this finished.', rev: e.rev + 1 })
      }
      if (e.kind === 'op' && e.status === 'completed' && e.after) this.lastAfter.set(pathKey(e.path), e.after)
      if (e.kind === 'turn') this.turn = Math.max(this.turn, e.turn)
    }
    const tasks = latestTaskEvents(this.events)
    this.taskId = tasks[tasks.length - 1]?.taskId ?? ''
    this.loaded = true
    this.changed()
  }

  private index(e: TraceEvent) {
    const at = this.byId.get(e.id)
    if (at === undefined) {
      this.byId.set(e.id, this.events.length)
      this.events.push(e)
    } else this.events[at] = e
  }

  private put(e: TraceEvent) {
    this.index(e)
    this.journal.put(e)
    this.changed()
  }

  private async base() {
    return {
      id: randomId(12),
      seq: this.journal.nextSeq(),
      writer: this.writer,
      sessionId: this.sessionId,
      taskId: this.taskId,
      turn: this.turn,
      ts: await this.host.now(),
      rev: 0,
    }
  }

  // ------------------------------------------------------------ tasks and turns

  async startTask(title: string | undefined): Promise<TaskEvent> {
    const n = latestTaskEvents(this.events).length + 1
    const b = await this.base()
    const taskId = randomId(8)
    this.taskId = taskId
    const ev: TaskEvent = { ...b, taskId, kind: 'task', title: title?.trim() || `Task ${n}`, titleFromPrompt: !title?.trim() }
    this.put(ev)
    return ev
  }

  async ensureTask() {
    if (!this.taskId) await this.startTask(undefined)
  }

  async turnStarted(prompt: string, origin: string) {
    if (!this.tracking) return
    await this.ensureTask()
    this.turn++
    const text = excerpt(redact(prompt), 120)
    this.put({ ...(await this.base()), kind: 'turn', prompt: text, origin } satisfies TurnEvent)
    const task = latestTaskEvents(this.events).find(t => t.taskId === this.taskId)
    if (task?.titleFromPrompt && text) {
      this.put({ ...task, title: `${task.title} · ${excerpt(text, 48)}`, titleFromPrompt: false, rev: task.rev + 1 })
    }
  }

  async renameTask(taskId: string, title: string) {
    const task = latestTaskEvents(this.events).find(t => t.taskId === taskId)
    if (task) this.put({ ...task, title, titleFromPrompt: false, rev: task.rev + 1 })
  }

  /** Forgets everything recorded for this session (after an explicit delete). */
  clearAll() {
    this.events = []
    this.byId.clear()
    this.journal = new Journal(this.host.io, this.project, this.root, this.sessionId, this.writer)
    this.taskId = ''
    this.lastAfter.clear()
    this.changed()
  }

  dropTask(taskId: string) {
    const gone = (e: TraceEvent) => e.taskId === taskId
    this.events = this.events.filter(e => !gone(e))
    this.byId = new Map(this.events.map((e, i) => [e.id, i]))
    this.journal.drop(gone)
    if (this.taskId === taskId) this.taskId = ''
    this.changed()
  }

  // ------------------------------------------------------------ snapshots

  async fromText(path: string, text: string, source: Snap['source']): Promise<Snap> {
    const hash = await sha256(text)
    const nhash = text.includes('\r') ? await sha256(text.replace(/\r\n/g, '\n')) : undefined
    const size = byteLength(text)
    if (isBinaryText(text)) return { exists: true, hash, size, reason: 'binary', source }
    const lines = lineCount(text)
    if (size > this.opts.maxSnapshot) return { exists: true, hash, nhash, size, lines, reason: 'oversized', source }
    if (!this.opts.storeSensitive && isSensitivePath(path)) return { exists: true, hash, nhash, size, lines, reason: 'sensitive', source }
    try {
      const blob = await this.blobs.put(text, hash)
      return { exists: true, hash, nhash, size, lines, blob, source }
    } catch {
      return { exists: true, hash, nhash, size, lines, reason: 'unreadable', source }
    }
  }

  async snapshot(path: string): Promise<Snap> {
    let st: Awaited<ReturnType<Host['stat']>>
    try {
      st = await this.host.stat(path)
    } catch {
      st = null
    }
    if (!st) return { exists: false, source: 'fs' }
    if (st.kind !== 'file') return { exists: true, size: st.size, reason: 'unreadable', source: 'fs' }
    if (st.size > this.opts.maxRead) return { exists: true, size: st.size, reason: 'oversized', source: 'fs' }
    try {
      return await this.fromText(path, await this.host.readFile(path), 'fs')
    } catch {
      return { exists: true, size: st.size, reason: 'unreadable', source: 'fs' }
    }
  }

  private excluded(path: string) {
    return this.exclude.some(x => isUnder(x, path)) || /(^|\/)\.git(\/|$)/.test(path)
  }

  // ------------------------------------------------------------ tool calls

  async onToolCall<R extends ToolResult>(e: ToolEvent, next: (e: ToolEvent) => Promise<R>): Promise<R> {
    if (!this.tracking || !(FILE_TOOLS.has(e.tool) || SHELL_TOOLS.has(e.tool))) return next(e)
    let pre: Pending | undefined
    try {
      pre = await this.pre(e)
    } catch {
      pre = undefined
    }
    let ran: R
    try {
      ran = await next(e)
    } catch (err) {
      if (pre) await this.post(pre, undefined, err).catch(() => undefined)
      throw err
    }
    if (pre) await this.post(pre, ran).catch(() => undefined)
    return ran
  }

  private async pre(e: ToolEvent): Promise<Pending | undefined> {
    await this.ensureTask()
    const meta = { tool: e.tool, toolUseId: e.tool_use_id, agentId: e.agentId }
    const str = (k: string) => (typeof e[k] === 'string' ? (e[k] as string) : undefined)
    if (e.tool === 'Read') {
      const path = resolvePath(this.cwd, str('file_path') ?? '')
      if (this.excluded(path)) return undefined
      const off = typeof e.offset === 'number' ? e.offset : undefined
      const lim = typeof e.limit === 'number' ? e.limit : undefined
      const detail = off !== undefined || lim !== undefined ? `lines ${off ?? 1}–${(off ?? 1) + (lim ?? 2000) - 1} requested` : undefined
      return this.open('read', path, 'file', meta, { detail })
    }
    if (e.tool === 'Glob' || e.tool === 'Grep') {
      const path = resolvePath(this.cwd, str('path') ?? this.cwd)
      if (this.excluded(path)) return undefined
      const st = await this.host.stat(path).catch(() => null)
      const pattern = str('pattern') ?? ''
      const filter = [str('glob') && `in ${str('glob')}`, str('type') && `type ${str('type')}`].filter(Boolean).join(' ')
      const detail = `${e.tool === 'Glob' ? 'glob' : 'grep'} “${excerpt(redact(pattern), 60)}”${filter ? ' ' + filter : ''}`
      return this.open('search', path, st?.kind === 'file' ? 'file' : 'dir', meta, { detail })
    }
    if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'NotebookEdit') {
      const path = resolvePath(this.cwd, str(e.tool === 'NotebookEdit' ? 'notebook_path' : 'file_path') ?? '')
      if (this.excluded(path)) return undefined
      const before = await this.snapshot(path)
      await this.checkIntervening(path, before, e.tool)
      const op: FileOp = before.exists ? 'modify' : 'create'
      return this.open(op, path, 'file', meta, { before })
    }
    // Bash / PowerShell
    const command = excerpt(redact(str('command') ?? ''), 200)
    const git = await this.gitState(this.cwd).catch(() => undefined)
    const ev: CommandEvent = {
      ...(await this.base()),
      kind: 'command',
      ...meta,
      command,
      status: 'active',
      reconcile: git === undefined ? 'unavailable' : git === null ? 'not-repo' : 'git',
      changed: 0,
    }
    this.put(ev)
    return { kind: 'shell', ev, git: git ?? undefined, startedAt: ev.ts, background: e.run_in_background === true }
  }

  private async open(op: FileOp, path: string, target: 'file' | 'dir', meta: Pick<OpEvent, 'tool' | 'toolUseId' | 'agentId'>, extra: Partial<OpEvent>): Promise<Pending> {
    const ev: OpEvent = { ...(await this.base()), kind: 'op', op, status: 'active', attribution: 'claude', ...meta, path, target, ...extra }
    this.put(ev)
    return { kind: 'op', ev }
  }

  /** A file that changed since Claude's last recorded state of it changed outside Claude's operations. */
  private async checkIntervening(path: string, now: Snap, tool: string) {
    const last = this.lastAfter.get(pathKey(path))
    if (!last || last.hash === undefined || now.hash === undefined || last.hash === now.hash) {
      if (last && last.exists !== now.exists) await this.detected(path, last, now, `before ${tool}`)
      return
    }
    await this.detected(path, last, now, `before ${tool}`)
  }

  private async detected(path: string, before: Snap, after: Snap, when: string) {
    const op: FileOp = !before.exists ? 'create' : !after.exists ? 'delete' : 'modify'
    const stats = await this.stats(before, after)
    this.put({
      ...(await this.base()),
      kind: 'op',
      op,
      status: 'completed',
      attribution: 'uncertain',
      tool: 'external',
      path,
      target: 'file',
      before,
      after,
      ...stats,
      note: `Detected change—attribution uncertain (found ${when}; not made by a recorded Claude operation).`,
    })
    this.lastAfter.set(pathKey(path), after)
  }

  private async stats(before: Snap | undefined, after: Snap | undefined, patch?: Hunk[]) {
    if (before?.blob && after?.blob) {
      const [a, b] = await Promise.all([this.blobs.get(before.blob), this.blobs.get(after.blob)])
      if (a !== undefined && b !== undefined) {
        const d = diffText(a, b)
        if (d.kind === 'ok') return { added: d.added, removed: d.removed }
        if (d.kind === 'identical') return { added: 0, removed: 0 }
      }
    }
    if (before?.blob && after && !after.exists) return { added: 0, removed: before.lines ?? 0 }
    if (after?.blob && before && !before.exists) return { added: after.lines ?? 0, removed: 0 }
    if (patch) return hunkStats(patch)
    return {}
  }

  private async post(pre: Pending, ran: ToolResult | undefined, err?: unknown) {
    const end = await this.host.now()
    const outcome = outcomeOf(ran, err)
    if (pre.kind === 'shell') return this.postShell(pre, ran, outcome, end)
    const ev = pre.ev
    let next: OpEvent = { ...ev, status: outcome.status, error: outcome.error, endTs: end, rev: ev.rev + 1 }
    const r = (ran?.result ?? {}) as Record<string, unknown>
    if (outcome.status === 'completed') {
      if (ev.op === 'read') next = await this.postRead(next, r)
      else if (ev.op === 'search') next = this.postSearch(next, r)
      else next = await this.postEdit(next, r)
    }
    this.put(next)
  }

  private async postRead(ev: OpEvent, r: Record<string, unknown>): Promise<OpEvent> {
    const type = r.type
    const file = (r.file ?? {}) as Record<string, unknown>
    if (type === 'text' && typeof file.content === 'string') {
      const start = Number(file.startLine ?? 1)
      const num = Number(file.numLines ?? lineCount(file.content))
      const total = Number(file.totalLines ?? num)
      const detail = num >= total && start <= 1 ? `all ${total} line${total === 1 ? '' : 's'}` : `lines ${start}–${start + Math.max(0, num - 1)} of ${total}`
      const seen = await this.fromText(ev.path, file.content.slice(0, READ_EXCERPT), 'tool')
      return { ...ev, detail, seen }
    }
    return { ...ev, detail: typeof type === 'string' ? `${type} content` : ev.detail }
  }

  private postSearch(ev: OpEvent, r: Record<string, unknown>): OpEvent {
    const names = Array.isArray(r.filenames) ? (r.filenames as unknown[]).filter((f): f is string => typeof f === 'string') : []
    const matches = names
      .map(f => resolvePath(this.cwd, f))
      .filter(p => !this.excluded(p))
      .slice(0, 50)
    const count = typeof r.numFiles === 'number' ? r.numFiles : names.length
    return { ...ev, matches, matchCount: count, detail: `${ev.detail ?? ev.tool} · ${count} ${count === 1 ? 'match' : 'matches'}` }
  }

  private async postEdit(ev: OpEvent, r: Record<string, unknown>): Promise<OpEvent> {
    let before = ev.before
    const original = typeof r.originalFile === 'string' ? r.originalFile : typeof r.original_file === 'string' ? r.original_file : undefined
    let note: string | undefined
    if (original !== undefined) {
      const fromTool = await this.fromText(ev.path, original, 'tool')
      const same = before?.hash !== undefined && (before.hash === fromTool.hash || (before.nhash ?? before.hash) === (fromTool.nhash ?? fromTool.hash))
      if (before?.exists && before.hash !== undefined && !same) {
        // Someone changed the file while the call waited (permission prompt): that change is not Claude's.
        await this.detected(ev.path, before, fromTool, `while ${ev.tool} waited to run`)
        before = fromTool
      } else if (!before?.blob && fromTool.blob) before = fromTool
    }
    const after = await this.snapshot(ev.path)
    const raw = Array.isArray(r.structuredPatch) ? (r.structuredPatch as Hunk[]) : undefined
    const bounded = raw ? boundHunks(raw, PATCH_LINES) : undefined
    const op: FileOp = r.type === 'create' || (before && !before.exists) ? 'create' : 'modify'
    if (!before?.blob && !bounded?.hunks.length) note = 'No exact baseline was captured for this edit.'
    const stats = await this.stats(before, after, bounded?.hunks)
    const key = pathKey(ev.path)
    this.lastAfter.set(key, after)
    this.directEditAt.set(key, await this.host.now())
    return { ...ev, op, before, after, toolPatch: bounded?.hunks, toolPatchCut: bounded?.cut || undefined, ...stats, note }
  }

  // ------------------------------------------------------------ shell reconciliation

  private async postShell(pre: ShellPending, ran: ToolResult | undefined, outcome: { status: Outcome; error?: string }, end: number) {
    let changed = 0
    let reconcile = pre.ev.reconcile
    let error = outcome.error
    if (pre.git) {
      try {
        const after = await this.gitState(this.cwd, pre.git)
        if (after) changed = await this.reconcileGit(pre, after)
        else reconcile = 'unavailable'
      } catch (err) {
        reconcile = 'unavailable'
        error = error ?? `git reconciliation failed: ${String((err as Error)?.message ?? err).slice(0, 120)}`
      }
    }
    const r = (ran?.result ?? {}) as Record<string, unknown>
    const bg = typeof r.backgroundTaskId === 'string' || pre.background
    this.put({
      ...pre.ev,
      status: outcome.status,
      error: bg ? 'Runs in the background: changes it makes after returning are not reconciled.' : error,
      reconcile,
      changed,
      endTs: end,
      rev: pre.ev.rev + 1,
    })
  }

  private async topOf(cwd: string): Promise<string | null> {
    const key = pathKey(cwd)
    if (this.gitTop.has(key)) return this.gitTop.get(key)!
    const r = await this.host.run(['git', 'rev-parse', '--show-toplevel'], cwd)
    const top = r.exitCode === 0 ? resolvePath(cwd, r.stdout.trim()) : null
    this.gitTop.set(key, top)
    return top
  }

  /** The working tree's dirty files, their blob hashes and (before a command) their content. */
  async gitState(cwd: string, prior?: GitState): Promise<GitState | null> {
    const top = await this.topOf(cwd)
    if (!top) return null
    const st = await this.host.run(['git', '-c', 'core.quotepath=off', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], top)
    if (st.exitCode !== 0) throw new Error(st.stderr.trim() || 'git status failed')
    const files = new Map<string, GitFile>()
    for (const entry of st.stdout.split('\0')) {
      if (entry.length < 4) continue
      const rel = entry.slice(3)
      const path = resolvePath(top, rel)
      if (this.excluded(path)) continue
      files.set(pathKey(path), { rel, path, xy: entry.slice(0, 2) })
    }
    const want = new Map(files)
    if (prior) for (const [k, f] of prior.files) if (!want.has(k)) want.set(k, { ...f, xy: '  ' })
    await this.hashFiles(top, [...want.values()])
    const snaps = new Map<string, Snap>()
    if (!prior) {
      // Before a command: keep the content of dirty files so their pre-command state is exact.
      let kept = 0
      for (const f of files.values()) {
        if (!f.hash || kept >= this.opts.maxShellCapture) continue
        let snap = this.gitHashSnap.get(f.hash)
        if (!snap) {
          snap = await this.snapshot(f.path)
          this.gitHashSnap.set(f.hash, snap)
        }
        snaps.set(pathKey(f.path), snap)
        kept++
      }
    } else for (const [k, f] of want) if (!files.has(k)) files.set(k, f)
    return { top, files, snaps }
  }

  private async hashFiles(top: string, files: GitFile[]) {
    const present: GitFile[] = []
    for (const f of files) {
      if (f.xy.includes('D')) continue
      const st = await this.host.stat(f.path).catch(() => null)
      if (st?.kind === 'file') present.push(f)
    }
    if (!present.length) return
    const r = await this.host.run(['git', 'hash-object', '--stdin-paths'], top, present.map(f => f.rel).join('\n') + '\n')
    if (r.exitCode !== 0) return
    const hashes = r.stdout.split(/\r?\n/).filter(Boolean)
    present.forEach((f, i) => (f.hash = hashes[i]))
  }

  private async headSnap(top: string, f: GitFile): Promise<Snap> {
    const r = await this.host.run(['git', 'show', `HEAD:${f.rel}`], top)
    if (r.exitCode !== 0) return { exists: false, source: 'git-head' }
    return this.fromText(f.path, r.stdout, 'git-head')
  }

  private async reconcileGit(pre: ShellPending, after: GitState): Promise<number> {
    const before = pre.git!
    type Change = { f: GitFile; op: FileOp; b: Snap; a: Snap; from?: string }
    const changes: Change[] = []
    for (const [k, fa] of after.files) {
      const fb = before.files.get(k)
      const editedAt = this.directEditAt.get(k)
      if (editedAt !== undefined && editedAt >= pre.startedAt) continue
      const aExists = !!fa.hash
      const bExists = fb ? !fb.xy.includes('D') && !!fb.hash : fa.xy !== '??'
      if (fb && aExists && bExists && fb.hash === fa.hash) continue
      if (!fb && fa.xy === '  ') continue
      if (!bExists && !aExists) continue
      let b: Snap
      if (!bExists) b = { exists: false, source: 'git-worktree' }
      else if (fb) b = before.snaps.get(k) ?? { exists: true, reason: 'not-captured', source: 'git-worktree' }
      else b = await this.headSnap(after.top, fa)
      const a: Snap = aExists ? await this.snapshot(fa.path) : { exists: false, source: 'fs' }
      if (b.hash !== undefined && a.hash !== undefined && b.hash === a.hash) continue
      const op: FileOp = !bExists ? 'create' : !aExists ? 'delete' : 'modify'
      changes.push({ f: fa, op, b, a })
    }
    // A deleted file whose exact content reappears elsewhere was renamed.
    const deletes = changes.filter(c => c.op === 'delete')
    for (const c of changes.filter(c => c.op === 'create')) {
      const twin = deletes.find(d => d.op === 'delete' && d.b.hash !== undefined && d.b.hash === c.a.hash)
      if (twin) {
        c.op = 'rename'
        c.b = twin.b
        twin.op = 'rename'
        c.from = twin.f.path
      }
    }
    let n = 0
    for (const c of changes) {
      if (c.op === 'rename' && !c.from) continue
      const stats = c.op === 'rename' ? { added: 0, removed: 0 } : await this.stats(c.b, c.a)
      this.put({
        ...(await this.base()),
        kind: 'op',
        op: c.op,
        status: 'completed',
        attribution: 'uncertain',
        tool: pre.ev.tool,
        toolUseId: pre.ev.toolUseId,
        agentId: pre.ev.agentId,
        commandId: pre.ev.id,
        path: c.f.path,
        fromPath: c.from,
        target: 'file',
        before: c.b,
        after: c.a,
        ...stats,
        note: `Detected change—attribution uncertain (git showed it changed while Claude's ${pre.ev.tool} command ran).`,
      })
      this.lastAfter.set(pathKey(c.f.path), c.a)
      n++
    }
    return n
  }
}

type OpPending = { kind: 'op'; ev: OpEvent }
type ShellPending = { kind: 'shell'; ev: CommandEvent; git?: GitState; startedAt: number; background: boolean }
type Pending = OpPending | ShellPending

const DENIED = /user (doesn't|does not|did not|didn't) want|was rejected|rejected by|permission (to use .* )?(was )?denied|denied by|blocked by/i

export function outcomeOf(ran: ToolResult | undefined, err?: unknown): { status: Outcome; error?: string } {
  if (err !== undefined || !ran) return { status: 'interrupted', error: excerpt(redact(String((err as Error)?.message ?? err ?? 'no result')), 160) }
  if (ran.deny !== undefined) return { status: 'denied', error: excerpt(redact(ran.deny), 160) }
  if (ran.isError) {
    const text = ran.text ?? (typeof ran.result === 'string' ? ran.result : '')
    const error = excerpt(redact(text), 160)
    if (DENIED.test(text)) return { status: 'denied', error }
    if (/interrupt/i.test(text)) return { status: 'interrupted', error }
    return { status: 'failed', error }
  }
  const r = ran.result as { interrupted?: unknown } | undefined
  if (r && r.interrupted === true) return { status: 'interrupted', error: 'The command was interrupted.' }
  return { status: 'completed' }
}

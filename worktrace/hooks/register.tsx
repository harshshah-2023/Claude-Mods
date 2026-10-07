// WorkTrace: a persistent record of the files Claude reads, searches and changes.

import { update } from 'claude-code'
import type { ModelCompleteResult, Register } from 'claude-code'
import type { WorkTraceUi } from '../types'
import { lists, scopeOf, viewData, type Source } from './data'
import { dumpView } from './dump'
import { buildGraph, clampY, revealY, wheelTarget } from './graph'
import { ALL, latestTaskEvents, opsFor, type OpEvent, type TraceEvent } from './model'
import { DEFAULTS, Recorder, type Host } from './recorder'
import { Blobs, deleteHistory, listSessions, loadSession, projectDir, projectKey, type DeleteScope, type Io, type SessionListing } from './store'
import { Summaries } from './summary'
import { isUnder, normPath, pathKey, randomId } from './util'
import { graphFrame, listHeight, renderPane, treeSelKey, type Actions, type Els, type GraphFrame } from './view'

const PANE = 'worktrace'
const UI_REF = { plugin: 'worktrace', key: 'ui' } as const
const REV_REF = { plugin: 'worktrace', key: 'rev' } as const
const WRITER_REF = { plugin: 'worktrace', key: 'writer' } as const

const DEFAULT_UI: WorkTraceUi = {
  tab: 'tree',
  collapsed: [],
  follow: false,
  top: {},
  diffScope: 'op',
  showOps: true,
  showDiff: true,
  showMatches: false,
  taskId: 'current',
}

const withDefaults = (ui: WorkTraceUi | undefined): WorkTraceUi => ({ ...DEFAULT_UI, ...(ui ?? {}) })

type Options = { summaries: boolean; model: string; storeSensitive: boolean; icons: 'emoji' | 'ascii' }

/** The engine calls WorkTrace makes outside a hook's own dispatch, each spelled at its call site in session.start. */
type Cap = {
  root: () => Promise<string>
  cwd: () => Promise<string>
  sessionId: () => Promise<string>
  home: () => Promise<string | undefined>
  fsRead: (path: string) => Promise<string>
  fsWrite: (path: string, text: string) => Promise<void>
  fsList: (path: string) => Promise<{ name: string; kind: 'file' | 'dir' | 'other' }[]>
  fsExists: (path: string) => Promise<boolean>
  fsStat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number }>
  run: (argv: readonly string[], cwd: string | undefined, stdin: string | undefined, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  now: () => Promise<number>
  after: (ms: number, fn: () => void) => { cancel: () => void }
  storeGet: (key: string) => Promise<unknown>
  storeSet: (key: string, value: unknown) => Promise<void>
  getUi: () => Promise<WorkTraceUi>
  setUi: (fn: (ui: WorkTraceUi) => WorkTraceUi) => Promise<unknown>
  bump: () => Promise<unknown>
  getWriter: () => Promise<string>
  setWriter: (writer: string) => Promise<unknown>
  status: (text: string | undefined) => void
  toast: (text: string) => void
  log: (text: string) => void
  ask: (question: string, options: readonly string[], header: string) => Promise<string>
  complete: (req: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<ModelCompleteResult>
}

type App = {
  cap: Cap
  root: string
  project: string
  key: string
  io: Io
  blobs: Blobs
  rec: Recorder
  summaries: Summaries
  sessions: SessionListing[]
  other: Map<string, TraceEvent[]>
  loading: boolean
  problems: string[]
  options: Options
  tick?: { cancel: () => void }
  summaryTimer?: { cancel: () => void }
  lastFollowed?: string
  lastHeight: number
  needsRebind: boolean
  /** The Graph tab's window as last drawn, for the actions and the wheel; absent off that tab. */
  graph?: GraphFrame
  /** The pane body's own scroll offset as last drawn. */
  paneOffset: number
}

let app: App | undefined
let booting: Promise<App | undefined> | undefined

// ---------------------------------------------------------------- host adapters

function makeIo(cap: Cap, storage: string): Io {
  return {
    read: p => cap.fsRead(p),
    write: (p, text) => cap.fsWrite(p, text),
    list: p => cap.fsList(p),
    exists: p => cap.fsExists(p),
    remove: async p => {
      // $.fs has no delete: remove through the host's own command, inside the storage root only.
      if (!isUnder(storage, p) || pathKey(p) === pathKey(storage)) throw new Error(`refusing to delete outside WorkTrace storage: ${p}`)
      const st = await cap.fsStat(p).catch(() => undefined)
      if (!st) return
      const win = /^[A-Z]:\//.test(p)
      const native = win ? p.replace(/\//g, '\\') : p
      const argv = win
        ? st.kind === 'dir'
          ? ['cmd', '/d', '/c', 'rmdir', '/s', '/q', native]
          : ['cmd', '/d', '/c', 'del', '/f', '/q', native]
        : ['rm', '-rf', '--', native]
      const r = await cap.run(argv, undefined, undefined, 60_000)
      if (r.exitCode !== 0 || (await cap.fsExists(p))) throw new Error(`could not delete ${p}: ${r.stderr.trim() || `exit ${r.exitCode}`}`)
    },
  }
}

function makeHost(cap: Cap, io: Io): Host {
  return {
    io,
    readFile: p => cap.fsRead(p),
    stat: async p => {
      try {
        const s = await cap.fsStat(p)
        return { kind: s.kind, size: s.size }
      } catch {
        return null
      }
    },
    run: (argv, cwd, stdin) => cap.run(argv, cwd, stdin, 15_000),
    now: () => cap.now(),
  }
}

function readOptions(options: Record<string, unknown>): Options {
  return {
    summaries: options.summaries !== 'off',
    model: typeof options.summaryModel === 'string' && options.summaryModel.trim() ? options.summaryModel.trim() : 'haiku',
    storeSensitive: options.storeSensitive === true,
    icons: options.icons === 'ascii' ? 'ascii' : 'emoji',
  }
}

// ---------------------------------------------------------------- lifecycle

async function boot(cap: Cap, options: Options): Promise<App> {
  const root = normPath(await cap.root())
  const cwd = normPath(await cap.cwd())
  const home = normPath((await cap.home()) ?? root)
  const storage = `${home}/.claude/worktrace`
  const key = await projectKey(root)
  const project = projectDir(home, key)
  const io = makeIo(cap, storage)
  let writer = await cap.getWriter()
  if (!writer) {
    writer = randomId(8)
    await cap.setWriter(writer)
  }
  const blobs = new Blobs(io, project)
  const sessionId = await cap.sessionId()
  const summaries = new Summaries(
    io,
    project,
    blobs,
    async req => {
      const r = await cap.complete(req)
      return r.isAnswered ? { isAnswered: true, text: r.text } : { isAnswered: false, reason: r.reason === 'api-error' ? `api error ${r.status ?? ''}`.trim() : r.reason }
    },
    () => ({ enabled: options.summaries, model: options.model }),
    () => changed(),
  )
  const rec = new Recorder(makeHost(cap, io), blobs, project, root, cwd, sessionId, writer, { ...DEFAULTS, storeSensitive: options.storeSensitive }, () => changed(), [storage])
  rec.tracking = (await cap.storeGet(`tracking:${key}`)) === true
  const a: App = { cap, root, project, key, io, blobs, rec, summaries, sessions: [], other: new Map(), loading: true, problems: [], options, lastHeight: 10, needsRebind: false, paneOffset: 0 }
  app = a
  try {
    await rec.load()
    if (!(await io.exists(`${project}/project.json`))) await io.write(`${project}/project.json`, JSON.stringify({ root, key, createdAt: await cap.now() }))
    a.sessions = await listSessions(io, project)
  } catch (err) {
    a.problems.push(`History could not be loaded: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
  }
  a.problems.push(...rec.loadProblems.slice(0, 3).map(p => `Skipped an unreadable history chunk: ${p}`))
  a.loading = false
  changed()
  return a
}

function ready(): Promise<App | undefined> {
  return app ? Promise.resolve(app) : (booting ?? Promise.resolve(undefined))
}

/** After /clear the session id changes: keep recording under the new session's own directory. */
async function rebind(a: App) {
  const id = await a.cap.sessionId()
  a.needsRebind = false
  if (id === a.rec.sessionId) return
  await a.rec.journal.flush()
  const old = a.rec
  const next = new Recorder(makeHost(a.cap, a.io), a.blobs, a.project, a.root, old.cwd, id, old.writer, { ...DEFAULTS, storeSensitive: a.options.storeSensitive }, () => changed(), [...old.exclude])
  next.tracking = old.tracking
  a.rec = next
  await next.load()
  a.sessions = await listSessions(a.io, a.project).catch(() => a.sessions)
  await a.cap.setUi(ui => ({ ...ui, sessionId: undefined, sel: undefined, selEvent: undefined, taskId: 'current', top: {} }))
  changed()
}

// ---------------------------------------------------------------- redraw, persistence, follow

function changed() {
  const a = app
  if (!a || a.tick) return
  a.tick = a.cap.after(150, () => {
    a.tick = undefined
    void tick(a)
  })
}

async function tick(a: App) {
  if (a.rec.journal.pending) await a.rec.journal.flush()
  const err = a.rec.journal.lastError
  a.problems = a.problems.filter(p => !p.startsWith('History not saved'))
  if (err) a.problems.unshift(`History not saved (${err.slice(0, 80)}); kept in memory and retried.`)
  const meta = a.rec.journal.meta()
  if (meta.events) {
    const at = a.sessions.findIndex(s => s.sessionId === meta.sessionId)
    if (at < 0) a.sessions.unshift({ ...meta, writers: 1 })
    else {
      const had = a.sessions[at]!
      a.sessions[at] = { ...had, updatedAt: Math.max(had.updatedAt, meta.updatedAt), events: Math.max(had.events, meta.events), files: Math.max(had.files, meta.files), tasks: meta.tasks.length >= had.tasks.length ? meta.tasks : had.tasks }
    }
  }
  await follow(a).catch(() => undefined)
  const files = new Set(a.rec.events.filter((e): e is OpEvent => e.kind === 'op' && e.taskId === a.rec.taskId).map(e => pathKey(e.path)))
  a.cap.status(a.rec.tracking ? `WorkTrace ● ${files.size} file${files.size === 1 ? '' : 's'}` : undefined)
  await a.cap.bump()
}

async function follow(a: App) {
  const ui = await a.cap.getUi()
  if (ui.sessionId !== undefined && ui.sessionId !== a.rec.sessionId) return
  const ops = a.rec.events.filter((e): e is OpEvent => e.kind === 'op' && e.taskId === a.rec.taskId)
  const latest = ops.findLast(o => o.status === 'active') ?? ops[ops.length - 1]
  if (!latest) return
  const mark = `${latest.id}:${latest.status}`
  if (mark === a.lastFollowed) return
  a.lastFollowed = mark
  // Without follow-live the selection is the person's: only an empty one is filled in.
  if (!ui.follow && ui.sel) return
  const sel = { kind: latest.target === 'dir' ? ('dir' as const) : ('file' as const), path: latest.path }
  await a.cap.setUi(u => (u.follow ? { ...u, sel, selEvent: latest.id, top: { ...u.top, tree: undefined, timeline: undefined } } : { ...u, sel }))
  if (ui.follow && latest.status === 'completed' && latest.target === 'file') {
    a.summaryTimer?.cancel()
    a.summaryTimer = a.cap.after(1500, () => void ensureSummary(a, latest.path))
  }
}

function source(a: App, ui: WorkTraceUi): Source & { pendingLoad: boolean } {
  const other = ui.sessionId !== undefined && ui.sessionId !== a.rec.sessionId
  const events = other ? a.other.get(ui.sessionId!) : a.rec.events
  return {
    root: a.root,
    events: events ?? [],
    live: !other,
    sessionId: other ? ui.sessionId! : a.rec.sessionId,
    currentTaskId: other ? '' : a.rec.taskId,
    sessions: a.sessions,
    blobs: a.blobs,
    summaries: a.summaries,
    pendingLoad: other && !events,
  }
}

async function ensureSummary(a: App, path: string, retry = false) {
  const ui = await a.cap.getUi()
  const src = source(a, ui)
  const scope = scopeOf(ui, src)
  await a.summaries.ensure(a.root, path, scope, opsFor(src.events, path, scope), retry)
}

async function loadOther(a: App, sessionId: string) {
  if (a.other.has(sessionId)) return
  const { events } = await loadSession(a.io, a.project, sessionId)
  // A writer that is not this process cannot still be running an operation it left open there.
  a.other.set(
    sessionId,
    events.map(e => ((e.kind === 'op' || e.kind === 'command') && e.status === 'active' ? { ...e, status: 'interrupted' as const, error: 'Recording ended before this finished.' } : e)),
  )
}

// ---------------------------------------------------------------- actions

function actions(a: App): Actions {
  const cap = a.cap
  const rowsNow = async () => {
    const ui = await cap.getUi()
    const { tree, timeline } = lists(ui, source(a, ui))
    const graph = ui.tab === 'graph' ? buildGraph(timeline).columns.flat() : []
    const keys =
      ui.tab === 'tree' ? tree.map(r => r.key) : ui.tab === 'timeline' ? timeline.map(r => r.key) : ui.tab === 'graph' ? graph.map(n => n.key) : a.sessions.map(s => 's:' + s.sessionId)
    const selectable = ui.tab === 'timeline' ? timeline.filter(r => r.kind === 'op' || r.kind === 'cmd').map(r => r.key) : keys
    return { ui, tree, timeline, graph, keys, selectable }
  }
  // Keeps the list window where it is unless the selection would leave it.
  const keepVisible = (ui: WorkTraceUi, keys: string[], selKey: string | undefined): WorkTraceUi['top'] => {
    const h = a.lastHeight
    const top = ui.top[ui.tab]
    let start = top === undefined ? -1 : keys.indexOf(top)
    if (start < 0) start = Math.max(0, keys.length - h)
    const sel = selKey ? keys.indexOf(selKey) : -1
    if (sel >= 0 && sel < start) start = Math.max(0, sel - 1)
    if (sel >= 0 && sel >= start + h - 2) start = sel - h + 3
    start = Math.max(0, Math.min(start, Math.max(0, keys.length - h)))
    return { ...ui.top, [ui.tab]: keys[start] }
  }
  const openSession = async (sessionId: string | undefined) => {
    if (sessionId) {
      await loadOther(a, sessionId)
      await cap.setUi(ui => ({ ...ui, sessionId, historySel: sessionId, tab: 'tree', taskId: 'all', sel: undefined, selEvent: undefined, top: {}, follow: false }))
    } else await cap.setUi(ui => ({ ...ui, sessionId: undefined, historySel: undefined, tab: 'tree', taskId: 'current', sel: undefined, selEvent: undefined, top: {} }))
    changed()
  }
  const select = async (key: string) => {
    if (key.startsWith('s:')) return openSession(key.slice(2) === a.rec.sessionId ? undefined : key.slice(2))
    const { ui, tree, timeline, graph, keys } = await rowsNow()
    let next: WorkTraceUi = { ...ui, follow: false }
    let summaryPath: string | undefined
    if (ui.tab === 'graph') {
      const node = graph.find(n => n.key === key)
      if (!node) return
      next = { ...next, sel: { kind: 'file', path: node.path }, selEvent: undefined }
      summaryPath = node.path
      next.graphY = revealGraph(next, node.key)
    } else if (ui.tab === 'tree') {
      const row = tree.find(r => r.key === key)
      if (!row) return
      next = { ...next, sel: { kind: row.kind, path: row.path }, selEvent: undefined }
      if (row.kind === 'file') summaryPath = row.path
    } else {
      const row = timeline.find(r => r.key === key)
      if (!row || (row.kind !== 'op' && row.kind !== 'cmd')) return
      next = { ...next, selEvent: row.ev.id }
      if (row.kind === 'op') {
        next.sel = { kind: row.ev.target === 'dir' ? 'dir' : 'file', path: row.ev.path }
        next.diffScope = 'op'
        if (row.ev.target === 'file') summaryPath = row.ev.path
      }
    }
    next.top = keepVisible(next, keys, ui.tab === 'tree' || ui.tab === 'graph' ? treeSelKey(next) : key)
    await cap.setUi(() => next)
    if (summaryPath) void ensureSummary(a, summaryPath)
  }
  /** The graph window's first row now, as the view computes it. */
  const graphAt = (f: GraphFrame, ui: WorkTraceUi) => (ui.follow || ui.graphY === undefined ? f.max : clampY(ui.graphY, f.lay.height, f.box))
  /** The graph's first row after the least move that shows card `key` whole; undefined pins the newest. */
  const revealGraph = (ui: WorkTraceUi, key: string): number | undefined => {
    const f = a.graph
    const span = f?.lay.spans.get(key)
    if (!f || !span) return ui.graphY
    const y = revealY(graphAt(f, { ...ui, follow: false }), span, f.box)
    return y >= f.max ? undefined : y
  }
  return {
    scrollGraph: delta =>
      void cap.setUi(ui => {
        const f = a.graph
        if (!f) return ui
        const y = clampY(graphAt(f, ui) + delta, f.lay.height, f.box)
        return { ...ui, follow: false, graphY: y >= f.max ? undefined : y }
      }),
    setTab: tab => void cap.setUi(ui => ({ ...ui, tab })),
    selectRow: key => void select(key),
    toggleDir: path =>
      void cap.setUi(ui => {
        const k = pathKey(path)
        const collapsed = ui.collapsed.includes(k) ? ui.collapsed.filter(c => c !== k) : [...ui.collapsed, k]
        return { ...ui, collapsed, sel: { kind: 'dir', path } }
      }),
    move: delta =>
      void (async () => {
        const { ui, selectable, keys } = await rowsNow()
        if (!selectable.length) return
        const current = ui.tab === 'tree' || ui.tab === 'graph' ? treeSelKey(ui) : ui.tab === 'timeline' ? (ui.selEvent ? 'e:' + ui.selEvent : undefined) : 's:' + (ui.historySel ?? ui.sessionId ?? a.rec.sessionId)
        const at = current ? selectable.indexOf(current) : -1
        const to = at < 0 ? (delta > 0 ? 0 : selectable.length - 1) : Math.max(0, Math.min(selectable.length - 1, at + delta))
        const key = selectable[to]!
        if (ui.tab === 'history') await cap.setUi(u => ({ ...u, historySel: key.slice(2), top: keepVisible(u, keys, key) }))
        else await select(key)
      })(),
    page: delta =>
      void (async () => {
        const { ui, keys } = await rowsNow()
        const h = a.lastHeight
        const top = ui.top[ui.tab]
        let start = top === undefined ? Math.max(0, keys.length - h) : Math.max(0, keys.indexOf(top))
        start = Math.max(0, Math.min(keys.length - h, start + delta * Math.max(1, h - 2)))
        await cap.setUi(u => ({ ...u, follow: false, top: { ...u.top, [u.tab]: keys[start] } }))
      })(),
    toggle: flag =>
      void (async () => {
        await cap.setUi(ui => ({ ...ui, [flag]: !ui[flag] }))
        if (flag === 'follow') {
          a.lastFollowed = undefined
          changed()
        }
      })(),
    setDiffScope: diffScope => void cap.setUi(ui => ({ ...ui, diffScope, showDiff: true })),
    selectOp: id =>
      void (async () => {
        const ui = await cap.getUi()
        const ev = source(a, ui).events.find(e => e.id === id)
        if (!ev || ev.kind !== 'op') return
        await cap.setUi(u => ({ ...u, follow: false, selEvent: id, sel: { kind: ev.target === 'dir' ? 'dir' : 'file', path: ev.path }, diffScope: 'op', showDiff: true }))
        if (ev.target === 'file') void ensureSummary(a, ev.path)
      })(),
    selectFile: path =>
      void (async () => {
        await cap.setUi(u => {
          const next = { ...u, follow: false, sel: { kind: 'file' as const, path }, selEvent: undefined }
          return u.tab === 'graph' ? { ...next, graphY: revealGraph(next, 'f:' + pathKey(path)) } : next
        })
        void ensureSummary(a, path)
      })(),
    setTask: taskId => void cap.setUi(ui => ({ ...ui, taskId, sel: undefined, selEvent: undefined, top: {} })),
    newTask: () =>
      void (async () => {
        if (!a.rec.tracking) return
        const t = await a.rec.startTask(undefined)
        await cap.setUi(ui => ({ ...ui, taskId: 'current', sel: undefined, selEvent: undefined, top: {} }))
        cap.toast(`Started ${t.title}; it takes its name from your next prompt.`)
      })(),
    openSession: id => void openSession(id),
    refreshSummary: () =>
      void (async () => {
        const ui = await cap.getUi()
        if (ui.sel?.kind === 'file') await ensureSummary(a, ui.sel.path, true)
      })(),
    deleteHistory: () => void deleteFlow(a),
    backToLive: () => void openSession(undefined),
  }
}

async function deleteFlow(a: App) {
  const cap = a.cap
  const ui = await cap.getUi()
  const src = source(a, ui)
  const sessionId = ui.historySel ?? ui.sessionId ?? a.rec.sessionId
  const listing = a.sessions.find(s => s.sessionId === sessionId)
  const scope = scopeOf(ui, src)
  const taskTitle = scope === ALL ? undefined : latestTaskEvents(src.events).find(t => t.taskId === scope)?.title
  const choices = [
    ...(taskTitle && sessionId === src.sessionId ? [`Task “${taskTitle.slice(0, 30)}”`] : []),
    `Session ${sessionId === a.rec.sessionId ? '(this one)' : sessionId.slice(0, 8)}${listing ? `, ${listing.events} events` : ''}`,
    'All WorkTrace history for this project',
    'Cancel',
  ]
  let pick: string
  try {
    pick = await cap.ask('Delete WorkTrace history? Recorded events, snapshots and summaries are removed from disk.', choices, 'WorkTrace')
    if (pick === 'Cancel' || !choices.includes(pick)) return
    const sure = await cap.ask(`Permanently delete: ${pick}?`, ['Delete permanently', 'Keep it'], 'Confirm')
    if (sure !== 'Delete permanently') return
  } catch {
    return
  }
  const del: DeleteScope = pick.startsWith('Task') ? { kind: 'task', sessionId, taskId: scope } : pick.startsWith('Session') ? { kind: 'session', sessionId } : { kind: 'project' }
  try {
    await a.rec.journal.flush()
    const live = sessionId === a.rec.sessionId
    if (del.kind === 'task' && live) a.rec.dropTask(del.taskId)
    if (del.kind === 'task' && live) await a.rec.journal.flush()
    await deleteHistory(a.io, a.project, del)
    if (del.kind === 'project' || (del.kind === 'session' && live)) a.rec.clearAll()
    a.other.clear()
    a.blobs.forget()
    a.summaries.forget()
    a.sessions = await listSessions(a.io, a.project).catch(() => [])
    await cap.setUi(u => ({ ...u, sessionId: undefined, historySel: undefined, sel: undefined, selEvent: undefined, taskId: 'current', top: {} }))
    cap.toast(`WorkTrace deleted: ${pick}.`)
  } catch (err) {
    cap.toast(`WorkTrace could not delete history: ${String((err as Error)?.message ?? err).slice(0, 120)}`)
  }
  changed()
}

async function setTracking(a: App, on: boolean) {
  a.rec.tracking = on
  if (on) await a.rec.ensureTask()
  await a.cap.storeSet(`tracking:${a.key}`, on).catch(() => undefined)
  await a.rec.journal.flush()
  a.lastFollowed = undefined
  changed()
  if (!on) a.cap.status(undefined)
}

// ---------------------------------------------------------------- registration

export const register: Register = (on, rawOptions) => {
  const options = readOptions(rawOptions as Record<string, unknown>)
  app = undefined
  booting = undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'worktrace',
      description: 'Record and show the files Claude touches: on, off, history, graph, task <name>, delete',
      argumentHint: 'on | off | history | task <name> | delete',
    })
    if ((await $.env.get('WORKTRACE_DEV')) === '1') {
      await $.tool.register({
        name: 'inspect',
        description:
          'WorkTrace developer check: control recording and print the pane content as text. action: on | off | task | view. view: tree | timeline | detail | history | all.',
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['on', 'off', 'task', 'view'] },
            view: { type: 'string', enum: ['tree', 'timeline', 'detail', 'history', 'all'] },
            path: { type: 'string' },
            kind: { type: 'string', enum: ['file', 'dir'] },
            session: { type: 'string' },
            task: { type: 'string' },
            title: { type: 'string' },
            summarize: { type: 'boolean' },
            diffScope: { type: 'string', enum: ['op', 'task'] },
          },
        },
      })
    }
    const cap: Cap = {
      root: () => $.session.root(),
      cwd: () => $.session.cwd(),
      sessionId: () => $.session.id(),
      home: async () => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
      fsRead: path => $.fs.read(path),
      fsWrite: (path, text) => $.fs.write(path, text),
      fsList: path => $.fs.list(path),
      fsExists: path => $.fs.exists(path),
      fsStat: path => $.fs.stat(path),
      run: (argv, cwd, stdin, timeoutMs) => $.process.run(argv, { cwd, stdin, timeoutMs }),
      now: () => $.clock.now(),
      after: (ms, fn) => $.clock.after(ms, fn),
      storeGet: key => $.store.get(key),
      storeSet: (key, value) => $.store.set(key, value),
      getUi: async () => withDefaults((await $.state.get(UI_REF)).value),
      setUi: fn => update($, UI_REF, ui => fn(withDefaults(ui))),
      bump: () => update($, REV_REF, n => (n ?? 0) + 1),
      getWriter: async () => (await $.state.get(WRITER_REF)).value ?? '',
      setWriter: writer => $.state.set(WRITER_REF, writer),
      status: text => $.ui.status(text),
      toast: text => $.ui.toast(text),
      log: text => $.ui.log(text, { to: 'debug' }),
      ask: (question, choices, header) => $.ui.ask(question, { options: choices, header }),
      complete: req => $.model.complete(req),
    }
    booting = boot(cap, options).catch(err => {
      cap.log(`WorkTrace could not start: ${String((err as Error)?.message ?? err)}`)
      return undefined
    })
    return started
  })

  on('session.end', async ($, e, next) => {
    const a = app
    if (a) {
      await a.rec.journal.flush()
      if (e.reason === 'clear') a.needsRebind = true
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const res = await next(e)
    const a = app
    if (a && res.drop === undefined) {
      try {
        if (a.needsRebind || a.rec.tracking) await rebind(a)
        await a.rec.turnStarted(e.text, e.origin.kind)
      } catch {
        // recording never gets in the prompt's way
      }
    }
    return res
  })

  // Observes every tool call; the call itself is never changed.
  on('tool.call', async ($, e, next) => {
    const a = app
    if (!a || !a.rec.tracking || String(e.tool).startsWith('mcp__worktrace__')) return next(e)
    return a.rec.onToolCall(e as never, next as never)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'mcp__worktrace__inspect' }, async ($, e) => {
    const a = await ready()
    if (!a) return { result: 'WorkTrace did not start.' }
    const input = e as unknown as Record<string, string | boolean | undefined>
    if (input.action === 'on' || input.action === 'off') {
      await setTracking(a, input.action === 'on')
      return { result: `tracking ${a.rec.tracking ? 'on' : 'off'}; storage ${a.project}` }
    }
    if (input.action === 'task') {
      const t = await a.rec.startTask(typeof input.title === 'string' ? input.title : undefined)
      return { result: `started task ${t.title} (${t.taskId})` }
    }
    let ui = await a.cap.getUi()
    if (typeof input.session === 'string') {
      await loadOther(a, input.session)
      ui = { ...ui, sessionId: input.session, taskId: 'all' }
    }
    if (typeof input.task === 'string') ui = { ...ui, taskId: input.task }
    if (typeof input.path === 'string') ui = { ...ui, sel: { kind: input.kind === 'dir' ? 'dir' : 'file', path: normPath(input.path) }, selEvent: undefined }
    if (input.diffScope === 'task' || input.diffScope === 'op') ui = { ...ui, diffScope: input.diffScope }
    const src = source(a, ui)
    if (input.summarize && ui.sel?.kind === 'file') {
      const scope = scopeOf(ui, src)
      await a.summaries.ensure(a.root, ui.sel.path, scope, opsFor(src.events, ui.sel.path, scope))
    }
    await a.rec.journal.flush()
    const data = await viewData({ ...ui, tab: 'tree' }, src)
    const view = (typeof input.view === 'string' ? input.view : 'all') as 'tree' | 'timeline' | 'detail' | 'history' | 'all'
    return { result: `${dumpView(data, a.root, a.sessions, view)}\n\nstorage: ${a.project}\nwriter: ${a.rec.writer} · session: ${a.rec.sessionId} · tracking: ${a.rec.tracking}` }
  })

  on('command.run', { command: 'worktrace' }, async ($, e) => {
    const a = await ready()
    if (!a) return { text: 'WorkTrace could not start; see the debug log.' }
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    switch (verb.toLowerCase()) {
      case 'on': {
        await setTracking(a, true)
        const opened = await $.ui.open({ id: PANE, title: 'WorkTrace', columns: 78 })
        return { text: `WorkTrace is recording file activity in ${a.root}.${opened.isPlaced ? '' : ' The pane is open but waits for a wider terminal.'}` }
      }
      case 'off': {
        await setTracking(a, false)
        await $.ui.close({ id: PANE }).catch(() => undefined)
        return { text: 'WorkTrace stopped recording. History is kept; /worktrace history shows it.' }
      }
      case 'history': {
        await update($, UI_REF, (ui): WorkTraceUi => ({ ...withDefaults(ui), tab: 'history' }))
        a.sessions = await listSessions(a.io, a.project).catch(() => a.sessions)
        await $.ui.open({ id: PANE, title: 'WorkTrace', columns: 78 })
        return { text: `WorkTrace history: ${a.sessions.length} recorded session${a.sessions.length === 1 ? '' : 's'} for this project.` }
      }
      case 'task': {
        if (!a.rec.tracking) return { text: 'WorkTrace is off. Run /worktrace on first.' }
        const t = await a.rec.startTask(rest.join(' ') || undefined)
        await update($, UI_REF, ui => ({ ...withDefaults(ui), taskId: 'current', sel: undefined, selEvent: undefined, top: {} }))
        return { text: `WorkTrace started a new task: ${t.title}.` }
      }
      case 'graph': {
        await update($, UI_REF, (ui): WorkTraceUi => ({ ...withDefaults(ui), tab: 'graph', sessionId: undefined }))
        const opened = await $.ui.open({ id: PANE, title: 'WorkTrace', columns: 96 })
        return { text: `WorkTrace graph: files in the order Claude touched them.${opened.isPlaced ? '' : ' The pane waits for a wider terminal.'}` }
      }
      case 'delete': {
        await update($, UI_REF, (ui): WorkTraceUi => ({ ...withDefaults(ui), tab: 'history' }))
        await $.ui.open({ id: PANE, title: 'WorkTrace', columns: 78 })
        void deleteFlow(a)
        return { text: 'WorkTrace: choose what to delete.' }
      }
      default:
        return { text: 'Usage: /worktrace on | off | history | graph | task <name> | delete. On records reads, searches and edits and opens the pane; off stops recording and keeps history.' }
    }
  })

  // The wheel, trackpad and scroll keys over the pane move a long graph before the pane itself.
  on('ui.scroll', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const a = app
    const f = a?.graph
    if (!a || !f) return next(e)
    const ui = withDefaults((await $.state.get(UI_REF)).value)
    if (ui.tab !== 'graph') return next(e)
    const at = ui.follow || ui.graphY === undefined ? f.max : clampY(ui.graphY, f.lay.height, f.box)
    const to = wheelTarget(a.paneOffset, at, f.lay.height, f.box, e.by)
    if (to === 'pane') return next(e)
    await update($, UI_REF, u => ({ ...withDefaults(u), follow: false, graphY: to }))
    return {}
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e) as unknown as Els
    const { Box, Text } = els
    const ui = withDefaults((await $.state.get(UI_REF)).value)
    await $.state.get(REV_REF)
    const width = Math.max(20, e.props.bodyColumns)
    const rows = Math.max(8, e.props.scroll.bodyRows)
    const a = app
    if (!a)
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="claude">◆ WorkTrace</Text>
          <Text color="inactive">Loading recorded history…</Text>
        </Box>
      )
    try {
      const src = source(a, ui)
      const data = await viewData(ui, src)
      a.lastHeight = listHeight(rows, ui.tab !== 'history')
      a.paneOffset = e.props.scroll.offset
      a.graph = ui.tab === 'graph' && data.graph?.files ? graphFrame(data.graph, width, rows, ui) : undefined
      return renderPane({
        ...data,
        els,
        hasSelect: e.surface !== 'mobile',
        width,
        rows,
        ui,
        icons: a.options.icons,
        root: a.root,
        tracking: a.rec.tracking,
        loading: a.loading || src.pendingLoad,
        problems: a.problems.slice(0, 2),
        sessions: a.sessions,
        liveSessionId: a.rec.sessionId,
        act: actions(a),
      })
    } catch (err) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text color="claude">◆ WorkTrace</Text>
          <Text color="error">The pane could not be drawn: {String((err as Error)?.message ?? err).slice(0, 200)}</Text>
          <Text color="inactive">Recording continues; history on disk is unaffected.</Text>
        </Box>
      )
    }
  })
}

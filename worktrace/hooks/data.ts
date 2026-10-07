// Assembles what the pane (and the text dump) shows from the recorded events and the UI state.

import type { WorkTraceUi } from '../types'
import { opDiff, taskDiff, type BlobReader } from './evidence'
import { buildGraph, type Graph } from './graph'
import {
  ALL,
  buildTree,
  fileStats,
  filesUnder,
  flattenTree,
  folderSummary,
  inTask,
  latestTaskEvents,
  opsFor,
  timelineRows,
  type CommandEvent,
  type OpEvent,
  type TaskEvent,
  type TraceEvent,
} from './model'
import type { SessionListing } from './store'
import type { Summaries } from './summary'
import { baseName, fmtDate, pathKey, relTo } from './util'
import type { DirDetail, FileDetail } from './view'

export type CmdDetail = { kind: 'cmd'; ev: CommandEvent; files: OpEvent[] }

export type ViewData = {
  live: boolean
  sessionId: string
  sessionLabel: string
  taskScope: string
  taskLabel: string
  tasks: TaskEvent[]
  counts: { ops: number; files: number; changed: number; active?: string }
  tree: ReturnType<typeof flattenTree>
  timeline: ReturnType<typeof timelineRows>
  stats: ReturnType<typeof fileStats>
  detail?: FileDetail | DirDetail | CmdDetail
  /** Only on the Graph tab. */
  graph?: Graph & { texts: Record<string, string> }
}

export type Source = {
  root: string
  events: TraceEvent[]
  live: boolean
  sessionId: string
  currentTaskId: string
  sessions: SessionListing[]
  blobs: BlobReader
  summaries: Summaries
}

export function scopeOf(ui: WorkTraceUi, src: Pick<Source, 'live' | 'currentTaskId' | 'events'>): string {
  if (ui.taskId === 'all') return ALL
  if (ui.taskId === 'current') {
    if (src.live && src.currentTaskId) return src.currentTaskId
    const tasks = latestTaskEvents(src.events)
    return tasks[tasks.length - 1]?.taskId ?? ALL
  }
  return ui.taskId
}

export function lists(ui: WorkTraceUi, src: Source) {
  const scope = scopeOf(ui, src)
  const scoped = src.events.filter(inTask(scope))
  const stats = fileStats(scoped, ui.showMatches)
  const tree = flattenTree(buildTree(src.root, stats), new Set(ui.collapsed))
  const timeline = timelineRows(src.events, scope)
  return { scope, scoped, stats, tree, timeline }
}

export async function viewData(ui: WorkTraceUi, src: Source): Promise<ViewData> {
  const { scope, scoped, stats, tree, timeline } = lists(ui, src)
  const tasks = latestTaskEvents(src.events)
  const task = tasks.find(t => t.taskId === scope)
  const ops = scoped.filter((e): e is OpEvent => e.kind === 'op')
  const files = [...stats.values()].filter(s => !s.isDir)
  const active = ops.filter(o => o.status === 'active').pop()
  const listing = src.sessions.find(s => s.sessionId === src.sessionId)
  const data: ViewData = {
    live: src.live,
    sessionId: src.sessionId,
    sessionLabel: src.live ? 'this session' : `session ${src.sessionId.slice(0, 8)}${listing ? ` · ${fmtDate(listing.startedAt)}` : ''}`,
    taskScope: scope,
    taskLabel: scope === ALL ? `All tasks (${tasks.length})` : task ? task.title : 'No task yet',
    tasks,
    counts: {
      ops: ops.length + scoped.filter(e => e.kind === 'command').length,
      files: files.length,
      changed: files.filter(f => ['created', 'deleted', 'renamed', 'modified'].includes(f.badge)).length,
      active: active ? baseName(active.path) : undefined,
    },
    tree,
    timeline,
    stats,
  }
  if (ui.tab === 'graph') {
    const graph = buildGraph(timeline)
    const texts: Record<string, string> = {}
    for (const col of graph.columns) for (const n of col) texts[n.key] = src.summaries.peek(n.path, scope) ?? n.activity
    data.graph = { ...graph, texts }
  }
  const selEv = ui.selEvent ? src.events.find(e => e.id === ui.selEvent) : undefined
  if (ui.tab === 'timeline' && selEv?.kind === 'command') {
    data.detail = { kind: 'cmd', ev: selEv, files: src.events.filter((e): e is OpEvent => e.kind === 'op' && e.commandId === selEv.id) }
  } else if (ui.sel?.kind === 'dir') {
    const under = filesUnder(stats, ui.sel.path)
    const rel = ui.sel.path.startsWith('⟨') ? 'paths outside the project' : relTo(src.root, ui.sel.path) ?? ui.sel.path
    data.detail = {
      kind: 'dir',
      path: ui.sel.path,
      files: under,
      summary: folderSummary(rel, under, scope === ALL ? 'all tasks' : 'this task'),
      self: stats.get(pathKey(ui.sel.path)),
    }
  } else if (ui.sel?.kind === 'file') {
    const path = ui.sel.path
    const fileOps = opsFor(src.events, path, scope)
    const own = fileOps.filter(o => pathKey(o.path) === pathKey(path))
    const picked = selEv?.kind === 'op' && fileOps.some(o => o.id === selEv.id) ? selEv : undefined
    const selected = picked ?? [...own].reverse().find(o => o.op !== 'read' && o.op !== 'search') ?? own[own.length - 1] ?? fileOps[fileOps.length - 1]
    const summary = await src.summaries.view(src.root, path, scope, fileOps)
    const diff = ui.diffScope === 'task' ? await taskDiff(src.blobs, path, fileOps) : selected ? await opDiff(src.blobs, selected) : undefined
    data.detail = { kind: 'file', path, stat: stats.get(pathKey(path)), ops: fileOps, selected, summary, diff }
  }
  return data
}

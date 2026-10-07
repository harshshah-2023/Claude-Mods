// The recorded history and the pure views over it: tree, timeline, aggregates, fallback summaries.

import type { Hunk } from './diff'
import { baseName, dirName, excerpt, fileKind, isUnder, pathKey, relTo } from './util'

export type FileOp = 'read' | 'search' | 'modify' | 'create' | 'delete' | 'rename'
export type Outcome = 'active' | 'completed' | 'failed' | 'denied' | 'interrupted'
export type Attribution = 'claude' | 'uncertain'
export type SnapReason = 'binary' | 'oversized' | 'sensitive' | 'unreadable' | 'not-captured'

/** One captured state of a file. `exists: false` is a captured absence (new or deleted file). */
export type Snap = {
  exists: boolean
  hash?: string
  /** Hash with CRLF read as LF, so a tool's normalised copy matches the file it came from. */
  nhash?: string
  size?: number
  lines?: number
  /** The content's blob id when the content itself was stored. */
  blob?: string
  /** Why the content was not stored. */
  reason?: SnapReason
  /** Where the state came from: our own read, the tool's record, or git. */
  source?: 'fs' | 'tool' | 'git-head' | 'git-worktree'
}

type Base = {
  id: string
  seq: number
  writer: string
  sessionId: string
  taskId: string
  turn: number
  ts: number
  rev: number
}

export type OpEvent = Base & {
  kind: 'op'
  op: FileOp
  status: Outcome
  attribution: Attribution
  tool: string
  toolUseId?: string
  agentId?: string
  path: string
  target: 'file' | 'dir'
  fromPath?: string
  detail?: string
  matches?: string[]
  matchCount?: number
  before?: Snap
  after?: Snap
  /** A bounded excerpt of what a Read returned, for summaries. */
  seen?: Snap
  /** The tool's own record of its edit, exact for this one operation. */
  toolPatch?: Hunk[]
  toolPatchCut?: boolean
  added?: number
  removed?: number
  error?: string
  note?: string
  endTs?: number
  commandId?: string
}

export type TurnEvent = Base & { kind: 'turn'; prompt: string; origin: string }
export type TaskEvent = Base & { kind: 'task'; title: string; titleFromPrompt?: boolean }
export type CommandEvent = Base & {
  kind: 'command'
  tool: string
  toolUseId?: string
  agentId?: string
  command: string
  status: Outcome
  reconcile: 'git' | 'not-repo' | 'unavailable' | 'off'
  changed: number
  endTs?: number
  error?: string
}

export type TraceEvent = OpEvent | TurnEvent | TaskEvent | CommandEvent

export const ALL = 'all'

export function sortEvents<T extends TraceEvent>(list: T[]): T[] {
  return list.sort((x, y) => x.ts - y.ts || (x.writer < y.writer ? -1 : x.writer > y.writer ? 1 : x.seq - y.seq))
}

export const inTask = (taskId: string) => (e: TraceEvent) => taskId === ALL || e.taskId === taskId

// ---------------------------------------------------------------- badges

export type Badge =
  | 'active'
  | 'created'
  | 'deleted'
  | 'renamed'
  | 'modified'
  | 'uncertain'
  | 'failed'
  | 'denied'
  | 'interrupted'
  | 'read'
  | 'searched'
  | 'found'

export const BADGE: Record<Badge, { label: string; short: string; color: string; glyph: string }> = {
  active: { label: 'Working', short: 'WORK', color: 'claude', glyph: '●' },
  created: { label: 'Created', short: 'NEW', color: 'success', glyph: '+' },
  deleted: { label: 'Deleted', short: 'DEL', color: 'error', glyph: '−' },
  renamed: { label: 'Renamed', short: 'REN', color: 'merged', glyph: '→' },
  modified: { label: 'Modified', short: 'MOD', color: 'warning', glyph: '~' },
  uncertain: { label: 'Changed (attribution uncertain)', short: 'CHG?', color: 'warning', glyph: '?' },
  failed: { label: 'Failed', short: 'FAIL', color: 'error', glyph: '✗' },
  denied: { label: 'Denied', short: 'DENY', color: 'error', glyph: '⊘' },
  interrupted: { label: 'Interrupted', short: 'INT', color: 'warning', glyph: '!' },
  read: { label: 'Read', short: 'READ', color: 'suggestion', glyph: '◦' },
  searched: { label: 'Searched', short: 'FIND', color: 'subtle', glyph: '⌕' },
  found: { label: 'Search match (not read)', short: 'HIT', color: 'subtle', glyph: '·' },
}

export const OP_LABEL: Record<FileOp, string> = {
  read: 'Read',
  search: 'Search',
  modify: 'Modify',
  create: 'Create',
  delete: 'Delete',
  rename: 'Rename',
}

export const OUTCOME: Record<Outcome, { label: string; glyph: string; color: string }> = {
  active: { label: 'running', glyph: '●', color: 'claude' },
  completed: { label: 'done', glyph: '✓', color: 'success' },
  failed: { label: 'failed', glyph: '✗', color: 'error' },
  denied: { label: 'denied', glyph: '⊘', color: 'error' },
  interrupted: { label: 'interrupted', glyph: '!', color: 'warning' },
}

export function opBadge(e: OpEvent): Badge {
  if (e.status === 'active') return 'active'
  if (e.status !== 'completed') return e.status
  if (e.attribution === 'uncertain' && e.op !== 'read' && e.op !== 'search') return 'uncertain'
  switch (e.op) {
    case 'read':
      return 'read'
    case 'search':
      return 'searched'
    case 'modify':
      return 'modified'
    case 'create':
      return 'created'
    case 'delete':
      return 'deleted'
    case 'rename':
      return 'renamed'
  }
}

// ---------------------------------------------------------------- per-file stats

export type FileStat = {
  path: string
  counts: Record<FileOp, number>
  attempts: number
  failed: number
  denied: number
  interrupted: number
  uncertain: number
  found: number
  active: boolean
  firstTs: number
  lastTs: number
  lastEventId: string
  badge: Badge
  added: number
  removed: number
  isDir: boolean
}

const zeroCounts = (): Record<FileOp, number> => ({ read: 0, search: 0, modify: 0, create: 0, delete: 0, rename: 0 })

export function fileStats(events: readonly TraceEvent[], showMatches: boolean): Map<string, FileStat> {
  const map = new Map<string, FileStat>()
  const lastOf = new Map<string, OpEvent>()
  const get = (path: string, ts: number, isDir: boolean): FileStat => {
    const key = pathKey(path)
    let s = map.get(key)
    if (!s) {
      s = {
        path,
        counts: zeroCounts(),
        attempts: 0,
        failed: 0,
        denied: 0,
        interrupted: 0,
        uncertain: 0,
        found: 0,
        active: false,
        firstTs: ts,
        lastTs: ts,
        lastEventId: '',
        badge: 'read',
        added: 0,
        removed: 0,
        isDir,
      }
      map.set(key, s)
    }
    return s
  }
  for (const e of events) {
    if (e.kind !== 'op') continue
    const s = get(e.path, e.ts, e.target === 'dir')
    lastOf.set(pathKey(e.path), e)
    s.attempts++
    s.lastTs = Math.max(s.lastTs, e.ts)
    s.lastEventId = e.id
    if (e.status === 'active') s.active = true
    else if (e.status === 'completed') {
      s.counts[e.op]++
      if (e.attribution === 'uncertain') s.uncertain++
      s.added += e.added ?? 0
      s.removed += e.removed ?? 0
    } else if (e.status === 'failed') s.failed++
    else if (e.status === 'denied') s.denied++
    else s.interrupted++
    if (e.op === 'rename' && e.fromPath && e.status === 'completed') {
      const from = get(e.fromPath, e.ts, false)
      from.counts.rename++
      from.lastTs = Math.max(from.lastTs, e.ts)
      from.lastEventId = e.id
    }
    if (showMatches && e.op === 'search' && e.status === 'completed')
      for (const m of e.matches ?? []) {
        const f = get(m, e.ts, false)
        f.found++
      }
  }
  // An active op only counts while it is the latest for its file.
  for (const [key, s] of map) s.badge = badgeOf(s, lastOf.get(key))
  return map
}

function badgeOf(s: FileStat, last: OpEvent | undefined): Badge {
  if (last?.status === 'active') return 'active'
  const c = s.counts
  const claudeChanges = c.modify + c.create + c.delete + c.rename - s.uncertain
  if (last && last.status === 'completed' && last.op === 'delete') return last.attribution === 'uncertain' ? 'uncertain' : 'deleted'
  if (c.create > 0 && claudeChanges > 0) return 'created'
  if (c.rename > 0) return 'renamed'
  if (claudeChanges > 0) return 'modified'
  if (s.uncertain > 0) return 'uncertain'
  if (c.read > 0) return 'read'
  if (s.failed > 0) return 'failed'
  if (s.denied > 0) return 'denied'
  if (s.interrupted > 0) return 'interrupted'
  if (c.search > 0) return 'searched'
  return 'found'
}

// ---------------------------------------------------------------- tree

export type DirNode = {
  path: string
  name: string
  dirs: Map<string, DirNode>
  files: Map<string, FileStat>
  self?: FileStat
}

export type TreeRow =
  | { kind: 'dir'; key: string; path: string; label: string; depth: number; expanded: boolean; agg: Agg; self?: FileStat }
  | { kind: 'file'; key: string; path: string; label: string; depth: number; stat: FileStat }

export type Agg = { files: number; changed: number; read: number; failed: number; active: boolean; uncertain: number; found: number }

const OUTSIDE = '⟨outside project⟩'

function emptyDir(path: string, name: string): DirNode {
  return { path, name, dirs: new Map(), files: new Map() }
}

export function buildTree(root: string, stats: Map<string, FileStat>): DirNode {
  const top = emptyDir(root, baseName(root) || root)
  const outside = emptyDir(OUTSIDE, OUTSIDE)
  for (const s of stats.values()) {
    const rel = relTo(root, s.path)
    let node = rel === null ? outside : top
    const parts = rel === null ? s.path.split('/').filter(Boolean) : rel.split('/').filter(Boolean)
    if (rel === null && /^[A-Z]:$/.test(parts[0] ?? '')) parts[0] = parts[0] + '/'
    if (parts.length === 0) {
      top.self = s
      continue
    }
    let acc = rel === null ? '' : root
    const dirParts = s.isDir ? parts : parts.slice(0, -1)
    for (const part of dirParts) {
      acc = acc === '' ? part : acc.endsWith('/') ? acc + part : `${acc}/${part}`
      const k = pathKey(acc)
      let next = node.dirs.get(k)
      if (!next) {
        next = emptyDir(acc, part.replace(/\/$/, ''))
        node.dirs.set(k, next)
      }
      node = next
    }
    if (s.isDir) node.self = s
    else node.files.set(pathKey(s.path), s)
  }
  if (outside.dirs.size || outside.files.size) top.dirs.set(OUTSIDE, outside)
  return top
}

export function aggregate(d: DirNode): Agg {
  const agg: Agg = { files: 0, changed: 0, read: 0, failed: 0, active: false, uncertain: 0, found: 0 }
  const visit = (n: DirNode) => {
    if (n.self?.active) agg.active = true
    for (const f of n.files.values()) {
      agg.files++
      if (['created', 'deleted', 'renamed', 'modified'].includes(f.badge)) agg.changed++
      else if (f.badge === 'read') agg.read++
      else if (f.badge === 'uncertain') agg.uncertain++
      else if (f.badge === 'found') agg.found++
      if (f.failed + f.denied + f.interrupted > 0) agg.failed++
      if (f.active) agg.active = true
    }
    for (const c of n.dirs.values()) visit(c)
  }
  visit(d)
  return agg
}

const sortByName = <T extends { name?: string; path: string }>(a: T, b: T) => {
  const x = (a.name ?? baseName(a.path)).toLowerCase()
  const y = (b.name ?? baseName(b.path)).toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

/** Visible rows: folders before files, alphabetical, single-folder chains joined (`src/sync`). */
export function flattenTree(top: DirNode, collapsed: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = []
  const walk = (n: DirNode, depth: number) => {
    for (const d of [...n.dirs.values()].sort((a, b) => (a.path === OUTSIDE ? 1 : b.path === OUTSIDE ? -1 : sortByName(a, b)))) {
      let node = d
      let label = d.name
      while (node.files.size === 0 && node.dirs.size === 1 && !node.self && node.path !== OUTSIDE) {
        const only = [...node.dirs.values()][0]!
        if (only.self) break
        label = `${label}/${only.name}`
        node = only
      }
      const expanded = !collapsed.has(pathKey(node.path))
      rows.push({ kind: 'dir', key: 'd:' + pathKey(node.path), path: node.path, label, depth, expanded, agg: aggregate(node), self: node.self })
      if (expanded) walk(node, depth + 1)
    }
    for (const f of [...n.files.values()].sort(sortByName))
      rows.push({ kind: 'file', key: 'f:' + pathKey(f.path), path: f.path, label: baseName(f.path), depth, stat: f })
  }
  walk(top, 0)
  return rows
}

/** Files under a folder (any depth) with their stats. */
export function filesUnder(stats: Map<string, FileStat>, dir: string): FileStat[] {
  return [...stats.values()].filter(s => !s.isDir && s.path !== dir && isUnder(dir, s.path)).sort((a, b) => b.lastTs - a.lastTs)
}

// ---------------------------------------------------------------- timeline

export type TimelineRow =
  | { kind: 'task'; key: string; ev: TaskEvent; ops: number }
  | { kind: 'turn'; key: string; ev: TurnEvent; ops: number }
  | { kind: 'op'; key: string; ev: OpEvent }
  | { kind: 'cmd'; key: string; ev: CommandEvent }

export function timelineRows(events: readonly TraceEvent[], taskId: string): TimelineRow[] {
  const rows: TimelineRow[] = []
  const shown = events.filter(inTask(taskId))
  let header: { ops: number } | undefined
  let turn: { ops: number } | undefined
  for (const e of shown) {
    if (e.kind === 'task') {
      const r = { kind: 'task' as const, key: 't:' + e.id, ev: e, ops: 0 }
      rows.push(r)
      header = r
      turn = undefined
    } else if (e.kind === 'turn') {
      const r = { kind: 'turn' as const, key: 'u:' + e.id, ev: e, ops: 0 }
      rows.push(r)
      turn = r
    } else if (e.kind === 'op') {
      rows.push({ kind: 'op', key: 'e:' + e.id, ev: e })
      if (header) header.ops++
      if (turn) turn.ops++
    } else {
      rows.push({ kind: 'cmd', key: 'e:' + e.id, ev: e })
      if (header) header.ops++
      if (turn) turn.ops++
    }
  }
  return rows
}

export function latestTaskEvents(events: readonly TraceEvent[]): TaskEvent[] {
  const byId = new Map<string, TaskEvent>()
  for (const e of events) if (e.kind === 'task') byId.set(e.taskId, e)
  return [...byId.values()].sort((a, b) => a.ts - b.ts)
}

// ---------------------------------------------------------------- list windows

/** The first row index of a fixed-height window that keeps `top` anchored and `sel` visible. */
export function windowStart(keys: readonly string[], height: number, topKey: string | undefined, selKey: string | undefined): number {
  const total = keys.length
  if (total <= height) return 0
  let start = topKey === undefined ? -1 : keys.indexOf(topKey)
  if (start < 0) start = total - height
  const sel = selKey === undefined ? -1 : keys.indexOf(selKey)
  if (sel >= 0 && sel < start) start = sel
  if (sel >= 0 && sel >= start + height) start = sel - height + 1
  return Math.max(0, Math.min(start, total - height))
}

// ---------------------------------------------------------------- facts for summaries

export function opsFor(events: readonly TraceEvent[], path: string, taskId: string): OpEvent[] {
  const k = pathKey(path)
  return events.filter(
    (e): e is OpEvent =>
      e.kind === 'op' &&
      inTask(taskId)(e) &&
      (pathKey(e.path) === k || (e.fromPath !== undefined && pathKey(e.fromPath) === k) || (e.matches ?? []).some(m => pathKey(m) === k)),
  )
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

/** What Claude did to the file in this scope, from the record alone. Ends with "No changes made." when nothing changed. */
export function activitySentence(ops: readonly OpEvent[], path: string): string {
  const k = pathKey(path)
  const done = ops.filter(o => o.status === 'completed')
  const mine = done.filter(o => pathKey(o.path) === k || (o.fromPath && pathKey(o.fromPath) === k))
  const changes = mine.filter(o => o.op !== 'read' && o.op !== 'search')
  const byClaude = changes.filter(o => o.attribution === 'claude')
  const uncertain = changes.filter(o => o.attribution === 'uncertain')
  const unsuccessful = ops.filter(o => pathKey(o.path) === k && o.status !== 'completed' && o.status !== 'active')
  const parts: string[] = []
  if (byClaude.length) {
    const added = byClaude.reduce((n, o) => n + (o.added ?? 0), 0)
    const removed = byClaude.reduce((n, o) => n + (o.removed ?? 0), 0)
    const kinds = new Set(byClaude.map(o => o.op))
    const lines = added + removed > 0 ? ` (+${added} −${removed} lines)` : ''
    if (kinds.has('create')) parts.push(`Claude created it${byClaude.length > 1 ? ` and changed it ${plural(byClaude.length - 1, 'more time')}` : ''}${lines}`)
    else if (kinds.has('delete')) parts.push('Claude deleted it')
    else if (kinds.has('rename')) parts.push('Claude renamed it')
    else parts.push(`Claude modified it ${plural(byClaude.length, 'time')}${lines}`)
  }
  if (uncertain.length) parts.push(`${plural(uncertain.length, 'change')} detected with uncertain attribution`)
  if (unsuccessful.length) {
    const s = unsuccessful.map(o => OUTCOME[o.status].label)
    parts.push(`${plural(unsuccessful.length, 'attempt')} ${[...new Set(s)].join('/')}`)
  }
  if (parts.length) return sentence(parts.join('; ')) + (byClaude.length || uncertain.length ? '' : ' No changes made.')
  const reads = mine.filter(o => o.op === 'read')
  const searches = done.filter(o => o.op === 'search')
  const bits: string[] = []
  if (reads.length) {
    const spans = reads.map(r => r.detail).filter((d): d is string => !!d)
    bits.push(`Claude read it${reads.length > 1 ? ` ${plural(reads.length, 'time')}` : ''}${spans.length ? ` (${[...new Set(spans)].slice(0, 2).join('; ')})` : ''}`)
  }
  if (searches.length) {
    const how = searches.filter(s => pathKey(s.path) !== k).map(s => s.detail ?? s.tool)
    if (how.length) bits.push(`it matched ${excerpt([...new Set(how)].slice(0, 2).join(', '), 80)}`)
    else bits.push(`Claude searched it with ${excerpt([...new Set(searches.map(s => s.detail ?? s.tool))].slice(0, 2).join(', '), 80)}`)
  }
  if (!bits.length) return 'No completed operations in this scope. No changes made.'
  return sentence(bits.join('; ')) + ' No changes made.'
}

const sentence = (s: string) => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/[.\s]*$/, '.')

/** The first sentence when no model summary is available: facts about the file only. */
export function factualFirstSentence(path: string, root: string, lines?: number, size?: number): string {
  const rel = relTo(root, path)
  const where = rel === null ? dirName(path) : dirName(rel) || 'the project root'
  const extent = lines !== undefined ? `${plural(lines, 'line')}` : size !== undefined ? `${size} bytes` : ''
  return `${baseName(path)} is a ${fileKind(path)} in ${where}${extent ? ` (${extent} at last capture)` : ''}.`
}

export function folderSummary(dirRel: string, files: readonly FileStat[], scopeLabel: string): string {
  const changed = files.filter(f => ['created', 'deleted', 'renamed', 'modified'].includes(f.badge))
  const read = files.filter(f => f.badge === 'read')
  const other = files.length - changed.length - read.length
  const failed = files.reduce((n, f) => n + f.failed + f.denied + f.interrupted, 0)
  const first = `${plural(files.length, 'file')} touched under ${dirRel || 'the project root'} in ${scopeLabel}.`
  const parts = [
    changed.length ? `${changed.length} changed by Claude` : '',
    read.length ? `${read.length} only read` : '',
    other ? `${other} searched, matched or uncertain` : '',
  ].filter(Boolean)
  const second = parts.length ? sentence(parts.join(', ')) : 'No completed operations.'
  return `${first} ${second}${failed ? ` ${plural(failed, 'operation')} did not complete.` : ''}${changed.length ? '' : ' No changes made.'}`
}

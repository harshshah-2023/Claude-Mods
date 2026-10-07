// The WorkTrace pane, in plain language: a short header, three tabs (Files, Activity,
// Past sessions) over a fixed-height list, and the selected item's details beneath.
// Pure: data in, tree out.

import type { Elements, RenderElement } from 'claude-code'
import type { WorkTraceUi } from '../types'
import type { CmdDetail, ViewData } from './data'
import { unified } from './diff'
import type { DiffView } from './evidence'
import { CARD_H, CONN_W, GAP, cardWidth, clampY, columnHeight, columnOffset, connector, layoutAll, type Graph, type GraphLayout, type GraphNode } from './graph'
import { BADGE, OUTCOME, opBadge, windowStart, type Badge, type FileStat, type OpEvent } from './model'
import type { SessionListing } from './store'
import type { SummaryView } from './summary'
import { baseName, excerpt, fmtDate, fmtTime, middle, pathKey, relTo } from './util'

export type Els = Elements['terminal']

export type Actions = {
  setTab: (tab: WorkTraceUi['tab']) => void
  selectRow: (key: string) => void
  toggleDir: (path: string) => void
  move: (delta: number) => void
  page: (delta: number) => void
  /** Moves the Graph tab's window by rows (negative toward the oldest cards). */
  scrollGraph: (delta: number) => void
  toggle: (flag: 'follow' | 'showOps' | 'showDiff' | 'showMatches' | 'showHelp') => void
  setDiffScope: (scope: 'op' | 'task') => void
  selectOp: (id: string) => void
  selectFile: (path: string) => void
  setTask: (taskId: string) => void
  newTask: () => void
  openSession: (sessionId: string | undefined) => void
  refreshSummary: () => void
  deleteHistory: () => void
  backToLive: () => void
}

export type FileDetail = {
  kind: 'file'
  path: string
  stat?: FileStat
  ops: OpEvent[]
  selected?: OpEvent
  summary: SummaryView
  diff?: DiffView
}

export type DirDetail = { kind: 'dir'; path: string; files: FileStat[]; summary: string; self?: FileStat }

export type ViewModel = Omit<ViewData, 'stats'> & {
  els: Els
  hasSelect: boolean
  width: number
  rows: number
  ui: WorkTraceUi
  icons: 'emoji' | 'ascii'
  root: string
  tracking: boolean
  loading: boolean
  problems: string[]
  sessions: SessionListing[]
  liveSessionId: string
  act: Actions
}

const ICON = {
  emoji: { dirOpen: '📂', dir: '📁', file: '📄', outside: '🌐' },
  ascii: { dirOpen: '[-]', dir: '[+]', file: ' · ', outside: '[~]' },
}

const DIM = 'inactive'

/** Plain words for each status; colour only reinforces them. */
const WORD: Record<Badge, string> = {
  active: 'working now',
  created: 'new',
  deleted: 'deleted',
  renamed: 'renamed',
  modified: 'edited',
  uncertain: 'changed (maybe not by Claude)',
  failed: 'failed',
  denied: 'blocked',
  interrupted: 'stopped',
  read: 'read',
  searched: 'searched',
  found: 'search hit',
}

const SHORT: Record<Badge, string> = { ...WORD, uncertain: 'changed?', active: 'working' }

/** The verb an activity row starts with. */
function verb(ev: OpEvent): string {
  if (ev.status === 'active') return 'Working'
  if (ev.attribution === 'uncertain' && ev.op !== 'read' && ev.op !== 'search') return 'Changed?'
  return { read: 'Read', search: 'Searched', modify: 'Edited', create: 'Created', delete: 'Deleted', rename: 'Renamed' }[ev.op]
}

const OUTCOME_WORD: Record<OpEvent['status'], string> = {
  active: 'in progress',
  completed: '',
  failed: 'failed',
  denied: 'blocked',
  interrupted: 'stopped',
}

function statusParts(stat: FileStat): { text: string; color: string }[] {
  const parts: { text: string; color: string }[] = []
  const add = (b: Badge, n = 0) => parts.push({ text: SHORT[b] + (n > 1 ? ` ${n}×` : ''), color: BADGE[b].color })
  const c = stat.counts
  if (stat.active) add('active')
  if (c.create) add('created')
  if (c.delete) add('deleted', c.delete)
  if (c.rename) add('renamed', c.rename)
  const edits = c.modify - Math.min(stat.uncertain, c.modify)
  if (edits > 0) add('modified', edits)
  if (stat.uncertain) add('uncertain', stat.uncertain)
  if (c.read) add('read', c.read)
  if (c.search) add('searched', c.search)
  if (stat.found && !c.read) add('found')
  if (stat.failed) add('failed', stat.failed)
  if (stat.denied) add('denied', stat.denied)
  if (stat.interrupted) add('interrupted', stat.interrupted)
  return parts
}

function Status({ els, stat, max }: { els: Els; stat: FileStat; max?: number }): RenderElement {
  const { Text } = els
  const parts = statusParts(stat).slice(0, max ?? 99)
  return (
    <Text>
      {parts.map((p, i) => (
        <Text color={p.color}>{(i ? ' · ' : '') + p.text}</Text>
      ))}
    </Text>
  )
}

const statusWidth = (stat: FileStat, max?: number) =>
  statusParts(stat)
    .slice(0, max ?? 99)
    .reduce((n, p, i) => n + p.text.length + (i ? 3 : 0), 0)

function Pointer({ els, on }: { els: Els; on: boolean }): RenderElement {
  return <els.Text color={on ? 'claude' : undefined}>{on ? '❯ ' : '  '}</els.Text>
}

function Heading({ els, title }: { els: Els; title: string }): RenderElement {
  return (
    <els.Text bold color="claude">
      {title.toUpperCase()}
    </els.Text>
  )
}

// ---------------------------------------------------------------- header and tabs

function Header(vm: ViewModel): RenderElement {
  const { Box, Text } = vm.els
  const state = !vm.live
    ? { text: 'Viewing a past session', color: 'suggestion' }
    : vm.tracking
      ? { text: '● Recording', color: 'error' }
      : { text: '○ Not recording', color: DIM }
  const counts = `${vm.counts.files} file${vm.counts.files === 1 ? '' : 's'} touched · ${vm.counts.changed} changed`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" justifyContent="space-between">
        <Text>
          <Text bold color="claude">
            ◆ WorkTrace
          </Text>
          <Text color={state.color}>{'  ' + state.text}</Text>
        </Text>
        {vm.width >= 56 && <Text color={DIM}>{counts}</Text>}
      </Box>
      <Text wrap="truncate-end">
        <Text color={DIM}>Task: </Text>
        <Text bold>{vm.taskLabel}</Text>
      </Text>
      {vm.counts.active && (
        <Text color="claude" wrap="truncate-end">
          ● Claude is working on {vm.counts.active}
        </Text>
      )}
    </Box>
  )
}

function Tabs(vm: ViewModel): RenderElement {
  const { Box, Button, Select, Text } = vm.els
  const tab = vm.ui.tab
  const taskOptions = [
    { value: 'current', label: vm.live ? 'Current task' : 'Last task' },
    { value: 'all', label: 'All tasks' },
    ...vm.tasks
      .slice()
      .reverse()
      .slice(0, 20)
      .map(t => ({ value: t.taskId, label: excerpt(t.title, 40) })),
  ]
  return (
    <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="tab-tree" hotkey="1" label="Files" variant={tab === 'tree' ? 'primary' : undefined} onPress={() => vm.act.setTab('tree')} />
        <Button key="tab-timeline" hotkey="2" label="Activity" variant={tab === 'timeline' ? 'primary' : undefined} onPress={() => vm.act.setTab('timeline')} />
        <Button key="tab-history" hotkey="3" label="Past sessions" variant={tab === 'history' ? 'primary' : undefined} onPress={() => vm.act.setTab('history')} />
        <Button key="tab-graph" hotkey="4" label="Graph" variant={tab === 'graph' ? 'primary' : undefined} onPress={() => vm.act.setTab('graph')} />
        <Button key="help" hotkey="i" plain dimColor label={vm.ui.showHelp ? 'Hide help' : 'Help'} onPress={() => vm.act.toggle('showHelp')} />
      </Box>
      {tab !== 'history' && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {vm.tasks.length > 1 && vm.hasSelect && <Select key="task" label="Show" options={taskOptions} value={vm.ui.taskId} onSelect={v => vm.act.setTask(v)} />}
          {vm.live && <Button key="follow" hotkey="f" plain label={vm.ui.follow ? 'Following Claude ●' : 'Follow Claude ○'} onPress={() => vm.act.toggle('follow')} />}
          {vm.live && vm.tracking && <Button key="new-task" hotkey="n" plain label="Start new task" onPress={() => vm.act.newTask()} />}
          {tab === 'tree' && <Button key="matches" hotkey="m" plain dimColor label={vm.ui.showMatches ? 'Hide search hits' : 'Show search hits'} onPress={() => vm.act.toggle('showMatches')} />}
          {!vm.live && <Button key="live" hotkey="l" plain label="Back to this session" onPress={() => vm.act.backToLive()} />}
        </Box>
      )}
    </Box>
  )
}

function Help(vm: ViewModel): RenderElement {
  const { Box, Text } = vm.els
  const line = (key: string, text: string) => (
    <Text>
      <Text bold>{key.padEnd(10)}</Text>
      <Text color={DIM}>{text}</Text>
    </Text>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={DIM} paddingX={1}>
      <Text>WorkTrace keeps a record of every file Claude looks at or changes, so you can see what happened and why.</Text>
      {line('Files', 'every file touched, grouped by folder. Click one for its summary and changes.')}
      {line('Activity', 'the same work in time order, one row per step, split by your prompts.')}
      {line('Past', 'earlier sessions in this project, kept on disk until you delete them.')}
      {line('Graph', 'one card per file in the order Claude touched it; files touched together share a column; ┃ = changed.')}
      <Text> </Text>
      <Text>
        <Text color={BADGE.read.color}>read</Text>
        <Text color={DIM}> looked at only · </Text>
        <Text color={BADGE.modified.color}>edited</Text>
        <Text color={DIM}> changed · </Text>
        <Text color={BADGE.created.color}>new</Text>
        <Text color={DIM}> created · </Text>
        <Text color={BADGE.deleted.color}>deleted</Text>
        <Text color={DIM}> · </Text>
        <Text color={BADGE.failed.color}>failed / blocked</Text>
        <Text color={DIM}> tried but did not happen</Text>
      </Text>
      <Text>
        <Text color={BADGE.uncertain.color}>changed?</Text>
        <Text color={DIM}> the file changed, but WorkTrace cannot prove Claude did it (a shell command or your editor).</Text>
      </Text>
      <Text> </Text>
      {line('j / k', 'move down / up       1 2 3 4  switch tabs')}
      {line('w / s', 'scroll the graph up / down (the mouse wheel or trackpad over the pane too)')}
      {line('f', 'follow Claude: keep the newest step selected')}
      {line('n', 'start a new task (otherwise follow-up prompts stay in this task)')}
      {line('Commands', '/worktrace on · off · history · task <name> · delete')}
    </Box>
  )
}

// ---------------------------------------------------------------- list window

type ListRow = { key: string; draw: () => RenderElement; selectable: boolean }

function ListWindow(vm: ViewModel, list: ListRow[], height: number, topKey: string | undefined, selKey: string | undefined, empty: RenderElement): RenderElement {
  const { Box, Button, Text } = vm.els
  if (!list.length)
    return (
      <Box flexDirection="column" height={height} justifyContent="center" paddingX={2}>
        {empty}
      </Box>
    )
  const keys = list.map(r => r.key)
  const first = windowStart(keys, height, topKey, selKey)
  const above = first > 0
  const room = height - (above ? 1 : 0)
  let shown = list.slice(first, first + room)
  if (first + shown.length < list.length && shown.length === room) shown = shown.slice(0, Math.max(1, room - 1))
  const left = list.length - first - shown.length
  return (
    <Box flexDirection="column" height={height} overflow="hidden">
      {above && <Button key="page-up" plain dimColor label={`  ↑ ${first} more`} onPress={() => vm.act.page(-1)} />}
      {shown.map(r => r.draw())}
      {left > 0 && <Button key="page-down" plain dimColor label={`  ↓ ${left} more`} onPress={() => vm.act.page(1)} />}
      {!above && left <= 0 && list.length < height && <Text> </Text>}
    </Box>
  )
}

export const treeSelKey = (ui: WorkTraceUi): string | undefined => (ui.sel ? `${ui.sel.kind === 'dir' ? 'd' : 'f'}:${pathKey(ui.sel.path)}` : undefined)

function fileList(vm: ViewModel): ListRow[] {
  const { Box, Button, Text } = vm.els
  const icon = ICON[vm.icons]
  const selKey = treeSelKey(vm.ui)
  const narrow = vm.width < 60
  return vm.tree.map(row => {
    const isSel = row.key === selKey
    const indent = '  '.repeat(Math.min(row.depth, 10))
    if (row.kind === 'dir') {
      const ic = row.path.startsWith('⟨') ? icon.outside : row.expanded ? icon.dirOpen : icon.dir
      const agg = row.agg
      const summary = narrow ? `${agg.files}` : `${agg.files} file${agg.files === 1 ? '' : 's'}${agg.changed ? `, ${agg.changed} changed` : ''}`
      const room = Math.max(6, vm.width - indent.length - 10 - summary.length)
      return {
        key: row.key,
        selectable: true,
        draw: () => (
          <Box key={`row-${row.key}`} flexDirection="row">
            <Pointer els={vm.els} on={isSel} />
            <Text>{indent}</Text>
            <Button key={`fold-${row.key}`} plain dimColor label={row.expanded ? '▾' : '▸'} onPress={() => vm.act.toggleDir(row.path)} />
            <Text> {ic} </Text>
            <Button key={`sel-${row.key}`} plain label={middle(row.label + '/', room)} onPress={() => vm.act.selectRow(row.key)} />
            <Box flexGrow={1} />
            {agg.active && <Text color="claude">● </Text>}
            <Text color={DIM}>{summary}</Text>
          </Box>
        ),
      }
    }
    const stat = row.stat
    const max = narrow ? 1 : 3
    const room = Math.max(6, vm.width - indent.length - 10 - statusWidth(stat, max))
    return {
      key: row.key,
      selectable: true,
      draw: () => (
        <Box key={`row-${row.key}`} flexDirection="row">
          <Pointer els={vm.els} on={isSel} />
          <Text>{indent}  </Text>
          <Text>{icon.file} </Text>
          <Button key={`sel-${row.key}`} plain dimColor={stat.badge === 'found' || stat.badge === 'searched'} label={middle(row.label, room)} onPress={() => vm.act.selectRow(row.key)} />
          <Box flexGrow={1} />
          <Status els={vm.els} stat={stat} max={max} />
        </Box>
      ),
    }
  })
}

function activityList(vm: ViewModel): ListRow[] {
  const { Box, Button, Text } = vm.els
  const narrow = vm.width < 64
  return vm.timeline.map(row => {
    if (row.kind === 'task') {
      return {
        key: row.key,
        selectable: false,
        draw: () => (
          <Box key={`row-${row.key}`} flexDirection="row" marginTop={1}>
            <Text bold color="claude" wrap="truncate-end">
              {`■ ${excerpt(row.ev.title, vm.width - 18)}`}
            </Text>
            <Box flexGrow={1} />
            <Text color={DIM}>
              {row.ops} step{row.ops === 1 ? '' : 's'}
            </Text>
          </Box>
        ),
      }
    }
    if (row.kind === 'turn') {
      return {
        key: row.key,
        selectable: false,
        draw: () => (
          <Box key={`row-${row.key}`} flexDirection="row">
            <Text color={DIM} wrap="truncate-end">
              {`  You asked (${fmtTime(row.ev.ts).slice(0, 5)}): “${excerpt(row.ev.prompt, Math.max(10, vm.width - 26))}”`}
            </Text>
          </Box>
        ),
      }
    }
    const isSel = vm.ui.selEvent === row.ev.id
    const time = narrow ? fmtTime(row.ev.ts).slice(0, 5) : fmtTime(row.ev.ts)
    if (row.kind === 'cmd') {
      const ev = row.ev
      const outcome = OUTCOME_WORD[ev.status]
      return {
        key: row.key,
        selectable: true,
        draw: () => (
          <Box key={`row-${row.key}`} flexDirection="row">
            <Pointer els={vm.els} on={isSel} />
            <Text color={DIM}>{time} </Text>
            <Text color="bashBorder">{'Ran      '}</Text>
            <Button key={`sel-${row.key}`} plain label={excerpt(ev.command || ev.tool, Math.max(8, vm.width - 30))} onPress={() => vm.act.selectRow(row.key)} />
            <Box flexGrow={1} />
            {ev.changed > 0 && <Text color={BADGE.uncertain.color}>{ev.changed} changed? </Text>}
            {outcome && <Text color={OUTCOME[ev.status].color}>{outcome}</Text>}
          </Box>
        ),
      }
    }
    const ev = row.ev
    const b = BADGE[opBadge(ev)]
    const rel = relTo(vm.root, ev.path) ?? ev.path
    const lines = ev.added !== undefined && (ev.added || ev.removed) ? `+${ev.added} −${ev.removed ?? 0}` : ''
    const outcome = OUTCOME_WORD[ev.status]
    const room = Math.max(8, vm.width - 26 - lines.length - outcome.length)
    return {
      key: row.key,
      selectable: true,
      draw: () => (
        <Box key={`row-${row.key}`} flexDirection="row">
          <Pointer els={vm.els} on={isSel} />
          <Text color={DIM}>{time} </Text>
          <Text color={b.color}>{verb(ev).padEnd(9)}</Text>
          <Button key={`sel-${row.key}`} plain label={middle(ev.op === 'search' ? rel + '/' : rel, room)} onPress={() => vm.act.selectRow(row.key)} />
          <Box flexGrow={1} />
          {lines !== '' && (
            <Text>
              <Text color="success">+{ev.added}</Text>
              <Text color="error"> −{ev.removed ?? 0} </Text>
            </Text>
          )}
          {outcome && <Text color={OUTCOME[ev.status].color}>{outcome}</Text>}
        </Box>
      ),
    }
  })
}

function sessionList(vm: ViewModel): ListRow[] {
  const { Box, Button, Text } = vm.els
  return vm.sessions.map(s => {
    const key = 's:' + s.sessionId
    const isLive = s.sessionId === vm.liveSessionId
    const isSel = (vm.ui.historySel ?? vm.ui.sessionId ?? vm.liveSessionId) === s.sessionId
    const title = s.tasks[s.tasks.length - 1]?.title
    return {
      key,
      selectable: true,
      draw: () => (
        <Box key={`row-${key}`} flexDirection="row">
          <Pointer els={vm.els} on={isSel} />
          <Text color={DIM}>{fmtDate(s.startedAt)} </Text>
          <Button
            key={`sel-${key}`}
            plain
            label={excerpt(isLive ? 'This session' : title ?? `Session ${s.sessionId.slice(0, 8)}`, Math.max(10, vm.width - 40))}
            onPress={() => vm.act.openSession(isLive ? undefined : s.sessionId)}
          />
          <Box flexGrow={1} />
          <Text color={DIM}>
            {s.files} file{s.files === 1 ? '' : 's'} · {s.tasks.length} task{s.tasks.length === 1 ? '' : 's'}
          </Text>
        </Box>
      ),
    }
  })
}

// ---------------------------------------------------------------- graph

function Card({ vm, n, text, w }: { vm: ViewModel; n: GraphNode; text: string; w: number }): RenderElement {
  const { Box, Button, Text } = vm.els
  const sel = vm.ui.sel?.kind === 'file' && pathKey(vm.ui.sel.path) === pathKey(n.path)
  const mark = sel
    ? { text: '•', color: 'suggestion' }
    : n.active
      ? { text: '●', color: 'claude' }
      : n.failed && !n.changed
        ? { text: '✗', color: 'error' }
        : n.changed
          ? { text: '✓', color: 'success' }
          : { text: '', color: DIM }
  const what = n.active ? 'working now' : n.changed ? `edited +${n.added} −${n.removed}` : n.failed ? 'failed' : 'read'
  const inner = w - 4 - (n.changed ? 1 : 0)
  return (
    <Box key={`g-${n.key}`} flexDirection="row" width={w} height={CARD_H} borderStyle="round" borderColor={sel ? 'suggestion' : n.active ? 'claude' : DIM}>
      {n.changed && (
        <Box flexDirection="column" width={1}>
          {[0, 1, 2, 3].map(() => (
            <Text color="success">┃</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} paddingLeft={1} overflow="hidden">
        <Box flexDirection="row">
          <Button key={`g-sel-${n.key}`} plain label={middle(n.name, Math.max(6, inner - 2))} onPress={() => vm.act.selectFile(n.path)} />
          <Box flexGrow={1} />
          <Text color={mark.color}>{mark.text}</Text>
        </Box>
        <Text color={DIM} wrap="truncate-end">
          {fmtTime(n.lastTs)} · {what}
        </Text>
        <Box height={2} overflow="hidden">
          <Text color={sel ? undefined : DIM} wrap="wrap">
            {excerpt(text, inner * 2)}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}

function Connector({ vm, from, to, rowH, k }: { vm: ViewModel; from: number; to: number; rowH: number; k: string }): RenderElement {
  const { Box, Text } = vm.els
  return (
    <Box key={k} flexDirection="column" width={CONN_W}>
      {connector(from, to, rowH).map(l => (
        <Text color={DIM}>{l}</Text>
      ))}
    </Box>
  )
}

/**
 * The Graph tab's window over the whole drawing: `box` rows of it shown from row `y`. Shared by
 * the view and by the actions and wheel hook that move it, so both agree on the geometry.
 */
export type GraphFrame = { lay: GraphLayout; box: number; y: number; max: number }

export function graphFrame(g: Graph, width: number, rows: number, ui: Pick<WorkTraceUi, 'graphY' | 'follow'>): GraphFrame {
  const lay = layoutAll(g.columns, width, cardWidth(width))
  // One line under the window says where it is and holds the scroll buttons.
  const box = graphHeight(rows) - 1
  const max = Math.max(0, lay.height - box)
  // Following Claude, or never scrolled, keeps the newest cards in view.
  const y = ui.follow || ui.graphY === undefined ? max : clampY(ui.graphY, lay.height, box)
  return { lay, box, y, max }
}

function GraphView(vm: ViewModel, height: number): RenderElement {
  const { Box, Button, Text } = vm.els
  const g = vm.graph
  if (!g || !g.files)
    return (
      <Box flexDirection="column" height={height} justifyContent="center" paddingX={2}>
        <Text>No files in this view yet.</Text>
        <Text color={DIM}>Each file Claude reads or changes becomes a card here, linked in the order it was touched.</Text>
      </Box>
    )
  const w = cardWidth(vm.width)
  const { lay, box, y, max } = graphFrame(g, vm.width, vm.rows, vm.ui)
  // Only the rows of cards the window touches are drawn, shifted up by the part above it.
  const tops: number[] = []
  lay.rowHeights.reduce((at, h) => (tops.push(at), at + h + 1), 0)
  const shown = lay.rows.map((_, ri) => ri).filter(ri => tops[ri]! < y + box && tops[ri]! + lay.rowHeights[ri]! > y)
  const first = shown[0] ?? 0
  const step = Math.max(2, box - 2)
  const end = Math.min(lay.height, y + box)
  return (
    <Box flexDirection="column" height={height}>
      <Box flexDirection="column" height={box} overflow="hidden">
        <Box flexDirection="column" flexShrink={0} position="relative" top={tops[first]! - y}>
          {shown.map(ri => {
            const row = lay.rows[ri]!
            const rowH = lay.rowHeights[ri]!
            return (
              <Box key={`g-row-${ri}`} flexDirection="row" flexShrink={0} height={rowH} marginBottom={ri < lay.rows.length - 1 ? 1 : 0}>
                {row.map((col, ci) => {
                  // The first column of a wrapped row continues from the row before.
                  const from = ci > 0 ? row[ci - 1]!.length : ri > 0 ? 0 : -1
                  return (
                    <Box key={`g-col-${ri}-${ci}`} flexDirection="row">
                      {from >= 0 && <Connector vm={vm} from={from} to={col.length} rowH={rowH} k={`g-c-${ri}-${ci}`} />}
                      <Box flexDirection="column" rowGap={GAP} marginTop={columnOffset(col.length, rowH)} height={columnHeight(col.length)}>
                        {col.map(n => (
                          <Card vm={vm} n={n} text={g.texts[n.key] ?? n.activity} w={w} />
                        ))}
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            )
          })}
        </Box>
      </Box>
      {max === 0 ? (
        <Text key="g-pos" color={DIM}>{`All ${g.files} file${g.files === 1 ? '' : 's'} shown`}</Text>
      ) : (
        <Box flexDirection="row" columnGap={2}>
          <Button key="g-up" hotkey="w" plain dimColor={y === 0} label={y === 0 ? '▲ top' : `▲ ${y} rows above`} onPress={() => vm.act.scrollGraph(-step)} />
          <Button key="g-down" hotkey="s" plain dimColor={y >= max} label={y >= max ? '▼ newest' : `▼ ${lay.height - end} rows below`} onPress={() => vm.act.scrollGraph(step)} />
          <Box flexGrow={1} />
          <Text key="g-pos" color={DIM}>{`rows ${y + 1}–${end} of ${lay.height}`}</Text>
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- details

function SectionTitle({ vm, title, open, hotkey, onToggle, extra }: { vm: ViewModel; title: string; open: boolean; hotkey: string; onToggle: () => void; extra?: RenderElement }): RenderElement {
  const { Box, Button } = vm.els
  return (
    <Box flexDirection="row" columnGap={2} marginTop={1}>
      <Heading els={vm.els} title={title} />
      {extra}
      <Box flexGrow={1} />
      <Button key={`sec-${hotkey}`} hotkey={hotkey} plain dimColor label={open ? 'hide' : 'show'} onPress={onToggle} />
    </Box>
  )
}

function Changes({ vm, diff, path }: { vm: ViewModel; diff: DiffView; path: string }): RenderElement {
  const { Box, Text, Code } = vm.els
  if (diff.kind === 'note')
    return (
      <Box paddingLeft={2}>
        <Text color={diff.tone === 'warn' ? 'warning' : DIM}>{(diff.tone === 'warn' ? '⚠ ' : '') + diff.text}</Text>
      </Box>
    )
  const body = unified(diff.hunks, Math.max(40, vm.rows * 3))
  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Text>
        <Text color="success">{diff.added} line{diff.added === 1 ? '' : 's'} added</Text>
        <Text color={DIM}> · </Text>
        <Text color="error">{diff.removed} removed</Text>
        <Text color={DIM}>{diff.source === 'snapshots' ? '   exact, from the file before and after' : "   exact, from the tool's own record"}</Text>
      </Text>
      {diff.caveats.map(c => (
        <Text color="warning">⚠ {c}</Text>
      ))}
      <Code source={body.text} format="diff" path={path} wrap="truncate-end" />
      {body.omittedLines > 0 && <Text color={DIM}>… {body.omittedLines} more lines not shown</Text>}
    </Box>
  )
}

function StepLine({ vm, ev, selected }: { vm: ViewModel; ev: OpEvent; selected: boolean }): RenderElement {
  const { Box, Button, Text } = vm.els
  const b = BADGE[opBadge(ev)]
  const what = [
    ev.tool === 'external' ? 'outside Claude' : `with ${ev.tool}`,
    ev.detail ?? '',
    ev.fromPath ? `from ${baseName(ev.fromPath)}` : '',
    ev.error ? `— ${ev.error}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  const outcome = OUTCOME_WORD[ev.status]
  return (
    <Box key={`op-${ev.id}`} flexDirection="row">
      <Pointer els={vm.els} on={selected} />
      <Text color={DIM}>{fmtTime(ev.ts)} </Text>
      <Text color={b.color}>{verb(ev).padEnd(9)}</Text>
      <Button key={`op-${ev.id}`} plain dimColor label={excerpt(what, Math.max(10, vm.width - 36))} onPress={() => vm.act.selectOp(ev.id)} />
      <Box flexGrow={1} />
      {ev.added !== undefined && (ev.added > 0 || (ev.removed ?? 0) > 0) && (
        <Text>
          <Text color="success">+{ev.added}</Text>
          <Text color="error"> −{ev.removed ?? 0} </Text>
        </Text>
      )}
      {outcome && <Text color={OUTCOME[ev.status].color}>{outcome}</Text>}
    </Box>
  )
}

function FileDetails({ vm, d }: { vm: ViewModel; d: FileDetail }): RenderElement {
  const { Box, Button, Text } = vm.els
  const rel = relTo(vm.root, d.path) ?? d.path
  const s = d.summary
  const labelColor = s.state === 'ai' ? 'success' : s.state === 'stale' || s.state === 'pending' ? 'warning' : DIM
  const steps = d.ops.slice(-40)
  const changed = d.ops.some(o => o.status === 'completed' && o.op !== 'read' && o.op !== 'search')
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text bold>
          {ICON[vm.icons].file} {baseName(d.path)}
        </Text>
        <Box flexGrow={1} />
        {d.stat && <Status els={vm.els} stat={d.stat} />}
      </Box>
      <Text color={DIM} wrap="truncate-start">
        {rel}
      </Text>
      <Box marginTop={1}>
        <Heading els={vm.els} title="Summary" />
      </Box>
      <Box flexDirection="row">
        <Text color="claude">┃ </Text>
        <Box flexDirection="column" flexShrink={1}>
          <Text>{s.text}</Text>
          <Box flexDirection="row" columnGap={2}>
            <Text color={labelColor} italic>
              {s.label}
            </Text>
            {s.state !== 'ai' && s.state !== 'off' && <Button key="refresh" hotkey="r" plain dimColor label="Get AI summary" onPress={() => vm.act.refreshSummary()} />}
          </Box>
        </Box>
      </Box>
      <SectionTitle vm={vm} title={`What Claude did (${d.ops.length})`} open={vm.ui.showOps} hotkey="h" onToggle={() => vm.act.toggle('showOps')} />
      {vm.ui.showOps && (
        <Box flexDirection="column">
          {d.ops.length > steps.length && <Text color={DIM}> … {d.ops.length - steps.length} earlier steps</Text>}
          {steps.map(ev => (
            <StepLine vm={vm} ev={ev} selected={d.selected?.id === ev.id} />
          ))}
          {d.ops.length === 0 && <Text color={DIM}> Nothing in this task.</Text>}
          {d.ops.length > 1 && <Text color={DIM}> Click a step to see exactly what it changed.</Text>}
        </Box>
      )}
      <SectionTitle
        vm={vm}
        title="Changes"
        open={vm.ui.showDiff}
        hotkey="c"
        onToggle={() => vm.act.toggle('showDiff')}
        extra={
          changed ? (
            <Box flexDirection="row" columnGap={1}>
              <Button key="scope-op" hotkey="d" plain label={vm.ui.diffScope === 'op' ? '● this step' : '○ this step'} onPress={() => vm.act.setDiffScope('op')} />
              <Button key="scope-task" plain label={vm.ui.diffScope === 'task' ? '● whole task' : '○ whole task'} onPress={() => vm.act.setDiffScope('task')} />
            </Box>
          ) : undefined
        }
      />
      {vm.ui.showDiff && !changed && <Text color={DIM}>  No changes made: Claude only looked at this file.</Text>}
      {vm.ui.showDiff && changed && d.diff && <Changes vm={vm} diff={d.diff} path={d.path} />}
    </Box>
  )
}

function FolderDetails({ vm, d }: { vm: ViewModel; d: DirDetail }): RenderElement {
  const { Box, Button, Text } = vm.els
  const rel = d.path.startsWith('⟨') ? 'Files outside the project' : relTo(vm.root, d.path) ?? d.path
  const shown = d.files.slice(0, 30)
  return (
    <Box flexDirection="column">
      <Text bold>
        {ICON[vm.icons].dirOpen} {rel === '' ? baseName(vm.root) : rel}/
      </Text>
      <Text color={DIM} wrap="truncate-start">
        {d.path}
      </Text>
      <Box marginTop={1}>
        <Heading els={vm.els} title="Summary" />
      </Box>
      <Box flexDirection="row">
        <Text color="claude">┃ </Text>
        <Text>{d.summary}</Text>
      </Box>
      {d.self && d.self.counts.search > 0 && <Text color={DIM}>  Claude searched this folder {d.self.counts.search}×. Search hits are not reads.</Text>}
      <Box marginTop={1}>
        <Heading els={vm.els} title={`Files in this folder (${d.files.length})`} />
      </Box>
      {shown.map(f => (
        <Box key={`df-${f.path}`} flexDirection="row">
          <Text>  {ICON[vm.icons].file} </Text>
          <Button key={`df-${f.path}`} plain label={middle(relTo(d.path, f.path) ?? f.path, Math.max(10, vm.width - 30))} onPress={() => vm.act.selectFile(f.path)} />
          <Box flexGrow={1} />
          <Status els={vm.els} stat={f} max={vm.width < 60 ? 1 : 3} />
        </Box>
      ))}
      {d.files.length > shown.length && <Text color={DIM}> … {d.files.length - shown.length} more</Text>}
      {d.files.length === 0 && <Text color={DIM}> No files touched here in this task.</Text>}
    </Box>
  )
}

function CommandDetails({ vm, d }: { vm: ViewModel; d: CmdDetail }): RenderElement {
  const { Box, Button, Text } = vm.els
  const how =
    d.ev.reconcile === 'git'
      ? d.files.length
        ? `Git shows ${d.files.length} file${d.files.length === 1 ? '' : 's'} changed while it ran. WorkTrace cannot prove the command made those changes.`
        : 'Git shows no file changes while it ran.'
      : d.ev.reconcile === 'not-repo'
        ? 'Not a git repository, so file changes from this command are not tracked.'
        : 'Git was unavailable, so file changes from this command are not tracked.'
  return (
    <Box flexDirection="column">
      <Text bold>
        {'$ '}
        {d.ev.tool} command {OUTCOME_WORD[d.ev.status] && <Text color={OUTCOME[d.ev.status].color}>({OUTCOME_WORD[d.ev.status]})</Text>}
      </Text>
      <Text color={DIM}>
        {fmtTime(d.ev.ts)}
        {d.ev.agentId ? ' · by a subagent' : ''}
      </Text>
      <Box flexDirection="row" marginTop={1}>
        <Text color="bashBorder">┃ </Text>
        <Box flexDirection="column" flexShrink={1}>
          <Text>{d.ev.command || '(no command text)'}</Text>
          <Text color={DIM}>{how}</Text>
          <Text color={DIM}>Files a command only reads cannot be seen.</Text>
          {d.ev.error && <Text color="warning">⚠ {d.ev.error}</Text>}
        </Box>
      </Box>
      {d.files.map(f => (
        <Box key={`cf-${f.id}`} flexDirection="row">
          <Text color={BADGE[opBadge(f)].color}>  {verb(f).padEnd(9)}</Text>
          <Button key={`cf-${f.id}`} plain label={middle(relTo(vm.root, f.path) ?? f.path, Math.max(10, vm.width - 20))} onPress={() => vm.act.selectOp(f.id)} />
        </Box>
      ))}
    </Box>
  )
}

// ---------------------------------------------------------------- pane

export function listHeight(rows: number, hasDetail: boolean): number {
  const room = rows - 9
  return Math.max(5, Math.min(hasDetail ? 14 : 30, Math.floor(hasDetail ? room * 0.42 : room)))
}

export function graphHeight(rows: number): number {
  return Math.max(CARD_H + 2, Math.floor((rows - 9) * 0.6))
}

export function renderPane(vm: ViewModel): RenderElement {
  const { Box, Button, Text } = vm.els
  const rule = '─'.repeat(Math.max(4, vm.width))
  const tab = vm.ui.tab
  const height = listHeight(vm.rows, tab !== 'history')
  let body: RenderElement
  if (vm.loading) {
    body = (
      <Box height={height} paddingX={2} justifyContent="center" flexDirection="column">
        <Text color={DIM}>Loading saved history…</Text>
      </Box>
    )
  } else if (tab === 'graph') {
    body = GraphView(vm, graphHeight(vm.rows))
  } else if (tab === 'history') {
    body = ListWindow(vm, sessionList(vm), height, vm.ui.top.history, 's:' + (vm.ui.historySel ?? vm.ui.sessionId ?? vm.liveSessionId), <Text color={DIM}>No saved sessions for this project yet.</Text>)
  } else {
    const empty = vm.tracking ? (
      <Box flexDirection="column">
        <Text>Recording. Nothing touched yet in this task.</Text>
        <Text color={DIM}>Ask Claude to do something: every file it reads or changes will appear here.</Text>
      </Box>
    ) : (
      <Box flexDirection="column">
        <Text>WorkTrace is not recording right now.</Text>
        <Text color={DIM}>Type /worktrace on to start. Earlier work is under Past sessions (3).</Text>
      </Box>
    )
    const list = tab === 'tree' ? fileList(vm) : activityList(vm)
    const selKey = tab === 'tree' ? treeSelKey(vm.ui) : vm.ui.selEvent ? 'e:' + vm.ui.selEvent : undefined
    body = ListWindow(vm, list, height, tab === 'tree' ? vm.ui.top.tree : vm.ui.top.timeline, selKey, empty)
  }
  const detail = tab === 'history' ? undefined : vm.detail
  return (
    <Box flexDirection="column" width={vm.width}>
      <Header {...vm} />
      <Tabs {...vm} />
      {vm.ui.showHelp && <Help {...vm} />}
      {vm.problems.map(p => (
        <Text color="warning" wrap="truncate-end">
          ⚠ {p}
        </Text>
      ))}
      <Text color={DIM}>{rule}</Text>
      {body}
      <Box flexDirection="row" columnGap={2} flexWrap="wrap">
        <Button key="next" hotkey="j" plain dimColor label="down" onPress={() => vm.act.move(1)} />
        <Button key="prev" hotkey="k" plain dimColor label="up" onPress={() => vm.act.move(-1)} />
        {tab === 'tree' && vm.ui.sel?.kind === 'dir' && <Button key="fold" hotkey="o" plain dimColor label="open/close folder" onPress={() => vm.act.toggleDir(vm.ui.sel!.path)} />}
        {tab === 'history' && <Button key="delete" hotkey="x" plain dimColor label="delete saved history…" onPress={() => vm.act.deleteHistory()} />}
        {tab !== 'history' && <Text color={DIM}>or click any row</Text>}
      </Box>
      <Text color={DIM}>{rule}</Text>
      {detail?.kind === 'file' && <FileDetails vm={vm} d={detail} />}
      {detail?.kind === 'dir' && <FolderDetails vm={vm} d={detail} />}
      {detail?.kind === 'cmd' && <CommandDetails vm={vm} d={detail} />}
      {tab !== 'history' && !detail && !vm.loading && vm.tree.length > 0 && <Text color={DIM}>Select a file or folder above to see what Claude did to it.</Text>}
      {tab === 'history' && (
        <Box flexDirection="column">
          <Text color={DIM}>Pick a session to see its files and activity.</Text>
          <Text color={DIM}>Saved in ~/.claude/worktrace, one folder per project. Nothing is deleted unless you press x.</Text>
        </Box>
      )}
    </Box>
  )
}

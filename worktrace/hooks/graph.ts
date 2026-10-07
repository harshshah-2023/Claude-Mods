// The Graph tab's layout: one card per file in the order Claude first touched it, files touched
// together (within a couple of seconds, e.g. parallel reads) stacked in one column, and an arrow
// from each column to the next. Pure and cheap: built from the recorded timeline only.

import { activitySentence, type OpEvent, type TimelineRow } from './model'
import { baseName, pathKey } from './util'

export type GraphNode = {
  key: string
  path: string
  name: string
  firstTs: number
  lastTs: number
  ops: OpEvent[]
  changed: boolean
  active: boolean
  failed: boolean
  added: number
  removed: number
  /** The factual sentence from the record; the view prefers a summary already held in memory. */
  activity: string
}

export type Graph = { columns: GraphNode[][]; files: number }

/** Files first touched within this many milliseconds of a column's first file share the column. */
export const STACK_MS = 2500
export const MAX_STACK = 3

const CHANGING = new Set(['modify', 'create', 'delete', 'rename'])

export const graphKey = (path: string) => 'f:' + pathKey(path)

export function buildGraph(timeline: readonly TimelineRow[]): Graph {
  const nodes = new Map<string, GraphNode>()
  const order: GraphNode[] = []
  for (const row of timeline) {
    if (row.kind !== 'op' || row.ev.target !== 'file') continue
    const ev = row.ev
    const key = graphKey(ev.path)
    let n = nodes.get(key)
    if (!n) {
      n = { key, path: ev.path, name: baseName(ev.path), firstTs: ev.ts, lastTs: ev.ts, ops: [], changed: false, active: false, failed: false, added: 0, removed: 0, activity: '' }
      nodes.set(key, n)
      order.push(n)
    }
    n.ops.push(ev)
    n.lastTs = Math.max(n.lastTs, ev.ts)
    if (ev.status === 'active') n.active = true
    if (ev.status === 'failed' || ev.status === 'denied') n.failed = true
    if (ev.status === 'completed' && CHANGING.has(ev.op)) {
      n.changed = true
      n.added += ev.added ?? 0
      n.removed += ev.removed ?? 0
    }
  }
  for (const n of order) n.activity = activitySentence(n.ops, n.path)
  const columns: GraphNode[][] = []
  for (const n of order) {
    const col = columns[columns.length - 1]
    if (col && col.length < MAX_STACK && n.firstTs - col[0]!.firstTs <= STACK_MS) col.push(n)
    else columns.push([n])
  }
  return { columns, files: order.length }
}

/** Card geometry, in terminal cells. */
export const CARD_H = 6
export const GAP = 1
export const CONN_W = 5

export const columnHeight = (n: number) => n * CARD_H + Math.max(0, n - 1) * GAP

/** How far down a column of `n` cards sits so it is centred in a row `rowH` tall. */
export const columnOffset = (n: number, rowH: number) => Math.max(0, Math.floor((rowH - columnHeight(n)) / 2))

const centres = (n: number, rowH: number) => Array.from({ length: n }, (_, i) => columnOffset(n, rowH) + i * (CARD_H + GAP) + Math.floor(CARD_H / 2))

const JOIN: Record<string, string> = {
  // up, down, left, right
  '0011': '─',
  '1100': '│',
  '0110': '┐',
  '1010': '┘',
  '0101': '┌',
  '1001': '└',
  '1110': '┤',
  '1101': '├',
  '0111': '┬',
  '1011': '┴',
  '1111': '┼',
  '0100': '│',
  '1000': '│',
  '0010': '─',
  '0001': '─',
}

/**
 * The connector between a column of `from` cards and one of `to` cards, both centred in a row
 * `rowH` tall: CONN_W wide, lines top to bottom. `from` 0 starts a wrapped row: a plain arrow
 * into each card.
 */
export function connector(from: number, to: number, rowH = Math.max(columnHeight(from), columnHeight(to))): string[] {
  const h = rowH
  const right = new Set(centres(to, rowH))
  const left = from === 0 ? right : new Set(centres(from, rowH))
  const all = [...left, ...right]
  const lo = Math.min(...all)
  const hi = Math.max(...all)
  const lines: string[] = []
  for (let r = 0; r < h; r++) {
    const l = left.has(r)
    const rt = right.has(r)
    const up = r > lo && r <= hi
    const down = r >= lo && r < hi
    const mid = up || down || l || rt ? JOIN[`${+up}${+down}${+l}${+rt}`] ?? ' ' : ' '
    lines.push((l ? '──' : '  ') + mid + (rt ? '─▶' : '  '))
  }
  return lines
}

/** Splits columns into rows that fit `width`, keeping the newest columns when height runs out. */
export function layoutRows(columns: GraphNode[][], width: number, cardW: number, maxHeight: number): { rows: GraphNode[][][]; hidden: number } {
  // Every column, including the first of a wrapped row, may carry a connector on its left.
  const perRow = Math.max(1, Math.floor(width / (cardW + CONN_W)))
  const rows: GraphNode[][][] = []
  for (let i = 0; i < columns.length; i += perRow) rows.push(columns.slice(i, i + perRow))
  let hidden = 0
  const heightOf = (row: GraphNode[][]) => Math.max(...row.map(c => columnHeight(c.length))) + 1
  while (rows.length > 1 && rows.reduce((s, r) => s + heightOf(r), 0) > maxHeight) hidden += rows.shift()!.reduce((s, c) => s + c.length, 0)
  return { rows, hidden }
}

export function cardWidth(width: number): number {
  return Math.max(18, Math.min(30, Math.floor(width / 3) - CONN_W))
}

export type GraphLayout = {
  rows: GraphNode[][][]
  rowHeights: number[]
  /** Rows of the whole drawing: every row of cards, one blank line between rows. */
  height: number
  /** Where each card sits in the drawing, top and bottom row (exclusive), by key. */
  spans: Map<string, { top: number; bottom: number }>
}

/** Every column wrapped to the width, nothing dropped: the Graph tab scrolls over it. */
export function layoutAll(columns: GraphNode[][], width: number, cardW: number): GraphLayout {
  const { rows } = layoutRows(columns, width, cardW, Infinity)
  const rowHeights = rows.map(r => Math.max(...r.map(c => columnHeight(c.length))))
  const spans = new Map<string, { top: number; bottom: number }>()
  let y = 0
  rows.forEach((row, ri) => {
    const rowH = rowHeights[ri]!
    for (const col of row)
      col.forEach((n, i) => {
        const top = y + columnOffset(col.length, rowH) + i * (CARD_H + GAP)
        spans.set(n.key, { top, bottom: top + CARD_H })
      })
    y += rowH + (ri < rows.length - 1 ? 1 : 0)
  })
  return { rows, rowHeights, height: y, spans }
}

/** The first drawing row a window `box` rows tall may show over `content` rows. */
export const clampY = (y: number, content: number, box: number): number => Math.max(0, Math.min(y, Math.max(0, content - box)))

/** The window's first row after the smallest move that shows the card whole (its top, when taller than the window). */
export function revealY(y: number, span: { top: number; bottom: number }, box: number): number {
  if (span.bottom - span.top >= box || span.top < y) return span.top
  if (span.bottom > y + box) return span.bottom - box
  return y
}

/**
 * Where a wheel, trackpad or scroll-key move over the pane goes on the Graph tab, nested-scroll
 * style: the graph moves first while the pane sits at its top, the pane takes it at the graph's
 * ends (so the details below stay reachable). A tick moves two rows; a page key its own rows.
 * Returns the graph's new first row (`undefined` pins the newest cards), or 'pane'.
 */
export function wheelTarget(paneOffset: number, graphY: number, content: number, box: number, by: number): number | undefined | 'pane' {
  const max = Math.max(0, content - box)
  if (max === 0 || by === 0) return 'pane'
  if (by > 0 && (paneOffset > 0 || graphY >= max)) return 'pane'
  if (by < 0 && (paneOffset > 0 || graphY <= 0)) return 'pane'
  const step = by > 0 ? Math.max(2, by) : Math.min(-2, by)
  const y = clampY(graphY + step, content, box)
  return y >= max ? undefined : y
}

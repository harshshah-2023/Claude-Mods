// Pure tests of the Graph tab's layout: grouping, arrows and wrapping.
import { expect, test } from 'claude-code/testing'
import { buildGraph, cardWidth, clampY, connector, layoutAll, layoutRows, revealY, STACK_MS, wheelTarget } from '../hooks/graph'
import type { TimelineRow } from '../hooks/model'

let n = 0
const op = (path: string, ts: number, kind: 'read' | 'modify' = 'read'): TimelineRow =>
  ({
    kind: 'op',
    key: 'e:' + ++n,
    ev: { kind: 'op', id: String(n), ts, taskId: 't', op: kind, status: 'completed', attribution: 'claude', tool: kind === 'read' ? 'Read' : 'Edit', path, target: 'file', added: kind === 'modify' ? 2 : undefined, removed: kind === 'modify' ? 1 : undefined },
  }) as unknown as TimelineRow

test('files touched together share a column; later files follow in order', () => {
  const g = buildGraph([op('D:/p/logout.ts', 0), op('D:/p/login.tsx', 100), op('D:/p/client.ts', 10_000, 'modify'), op('D:/p/session.ts', 20_000, 'modify'), op('D:/p/logout.ts', 30_000)])
  expect(g.files).toBe(4)
  expect(g.columns.map(c => c.map(x => x.name))).toEqual([['logout.ts', 'login.tsx'], ['client.ts'], ['session.ts']])
  expect(g.columns[1]![0]!.changed).toBe(true)
  expect(g.columns[1]![0]!.added).toBe(2)
  expect(g.columns[0]![0]!.ops.length).toBe(2)
  expect(STACK_MS).toBeGreaterThan(0)
})

test('connectors fan in and point right', () => {
  const two = connector(2, 1)
  expect(two.join('\n')).toContain('─▶')
  expect(two.join('\n')).toContain('┐')
  expect(two.join('\n')).toContain('┘')
  expect(connector(1, 1).filter(l => l.trim()).length).toBe(1)
})

test('rows wrap to the width and keep the newest when height runs out', () => {
  const g = buildGraph(Array.from({ length: 9 }, (_, i) => op(`D:/p/f${i}.ts`, i * 10_000)))
  const w = cardWidth(78)
  const { rows, hidden } = layoutRows(g.columns, 78, w, 7)
  expect(rows.length).toBe(1)
  expect(hidden).toBe(6)
  expect(rows[0]!.map(c => c[0]!.name)).toEqual(['f6.ts', 'f7.ts', 'f8.ts'])
})

test('the whole graph is laid out, nothing dropped, with each card placed', () => {
  const g = buildGraph([op('D:/p/a.ts', 0), op('D:/p/b.ts', 100), op('D:/p/c.ts', 200), ...Array.from({ length: 8 }, (_, i) => op(`D:/p/f${i}.ts`, 10_000 + i * 10_000))])
  const lay = layoutAll(g.columns, 78, cardWidth(78))
  expect(lay.rows.flat(2).length).toBe(11)
  // three cards stacked (20 rows) + gap + a row of single cards (6) + gap + another (6)
  expect(lay.rowHeights).toEqual([20, 6, 6])
  expect(lay.height).toBe(20 + 1 + 6 + 1 + 6)
  expect(lay.spans.get('f:d:/p/c.ts')).toEqual({ top: 14, bottom: 20 })
  // the last card sits at the bottom of the content
  expect(lay.spans.get('f:d:/p/f7.ts')!.bottom).toBe(lay.height)
})

test('the window clamps to the content and moves just enough to reveal a card', () => {
  expect(clampY(-5, 40, 10)).toBe(0)
  expect(clampY(99, 40, 10)).toBe(30)
  expect(clampY(5, 8, 10)).toBe(0)
  const span = { top: 21, bottom: 27 }
  expect(revealY(0, span, 10)).toBe(17) // below: bottom edge lands at the window's bottom
  expect(revealY(25, span, 10)).toBe(21) // above: top edge lands at the window's top
  expect(revealY(19, span, 10)).toBe(19) // already whole: stays
  expect(revealY(0, { top: 30, bottom: 50 }, 10)).toBe(30) // taller than the window: its top
})

test('the wheel moves the graph first, and hands over to the pane at its ends', () => {
  // 40 rows of graph in a 10-row window, pane at its top
  expect(wheelTarget(0, 0, 40, 10, 1)).toBe(2)
  expect(wheelTarget(0, 10, 40, 10, -1)).toBe(8)
  expect(wheelTarget(0, 29, 40, 10, 1)).toBeUndefined() // reaching the end pins the newest
  expect(wheelTarget(0, 30, 40, 10, 1)).toBe('pane') // at the end: the pane scrolls to the details
  expect(wheelTarget(0, 0, 40, 10, -1)).toBe('pane') // at the top
  expect(wheelTarget(5, 10, 40, 10, -1)).toBe('pane') // pane scrolled down: it comes back first
  expect(wheelTarget(0, 0, 8, 10, 1)).toBe('pane') // graph fits: nothing to scroll
  expect(wheelTarget(0, 0, 40, 10, 20)).toBe(20) // a page key moves its own rows
})

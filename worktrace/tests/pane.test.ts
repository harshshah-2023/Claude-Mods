// MOCKED engine test: the plugin loaded by the engine's own test host, its tool.call hook
// fed by the test's tools over an in-memory file system, and the pane mounted on surfaces.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { MemFs } from './memhost'

const ROOT = 'D:/proj'
const HOME = 'C:/Users/u'
const print = (text: string) => (globalThis as unknown as { console: { log: (s: string) => void } }).console.log(text)

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** An approximate text paint of a drawn tree, for eyeballing layouts in test output. */
export function paint(node: unknown): string[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap(paint)
  const n = node as Node
  const kids = (n.children ?? []) as unknown[]
  const p = n.props ?? {}
  if (n.type === 'Text') return [kids.map(k => paint(k).join('')).join('')]
  if (n.type === 'Button') {
    const label = String(p.label ?? '')
    const hk = p.hotkey ? `${p.hotkey}: ` : ''
    return [p.plain ? hk + label : `[ ${hk}${label} ]`]
  }
  if (n.type === 'Select') return [`${p.label ?? ''}: ‹${p.value ?? ''}›`]
  if (n.type === 'Code') return String(p.source ?? '').split('\n').map(l => '    ' + l)
  const parts = kids.map(paint)
  if (n.type === 'Box' && p.flexDirection === 'row') return [parts.map(x => x.join(' ')).join(' ')]
  return parts.flat()
}

function world(on: On, fs: MemFs) {
  mock.store(on)
  mock.env(on, { USERPROFILE: HOME })
  const v = <T,>(x: T) => ({ value: x })
  const n = (p: string) => p.split(String.fromCharCode(92)).join('/')
  on('session.root', () => v(ROOT))
  on('session.cwd', () => v(ROOT))
  on('session.id', () => v('sess-1'))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  on('command.register', ($, e) => v({ command: e.name }))
  on('ui.status', () => v(undefined))
  on('ui.toast', () => v(undefined))
  on('ui.log', () => v(undefined))
  on('ui.open', () => v({ isPlaced: true as const }))
  on('ui.close', () => v(undefined))
  on('ui.invalidate', () => v(undefined))
  on('process.run', () => v({ exitCode: 128, stdout: '', stderr: 'not a git repository', isStdoutTruncated: false, isStderrTruncated: false }))
  on('model.complete', () => v({ isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }))
  const io = fs.io()
  const host = fs.host()
  on('fs.read', async ($, e) => v(await io.read(n(e.path))))
  on('fs.write', async ($, e) => v(await io.write(n(e.path), e.text)))
  on('fs.list', async ($, e) => v((await io.list(n(e.path))).map(x => ({ ...x, size: 0, mtimeMs: 0, isLink: false }))))
  on('fs.exists', async ($, e) => v(await io.exists(n(e.path))))
  on('fs.stat', async ($, e) => {
    const s = await host.stat(n(e.path))
    if (!s) throw new Error('ENOENT')
    return v({ ...s, mtimeMs: 0, isLink: false })
  })
  on('tool.call', ($, e) => {
    const input = e as unknown as Record<string, string>
    if (e.tool === 'Read') {
      const content = fs.files.get(input.file_path!)!
      const n = content.split('\n').length - 1
      return { result: { type: 'text', file: { filePath: input.file_path, content, numLines: n, startLine: 1, totalLines: n } } } as never
    }
    if (e.tool === 'Edit') {
      const original = fs.files.get(input.file_path!)!
      fs.files.set(input.file_path!, original.replace(input.old_string!, input.new_string!))
      return { result: { filePath: input.file_path, oldString: input.old_string, newString: input.new_string, originalFile: original, structuredPatch: [], userModified: false, replaceAll: false } } as never
    }
    if (e.tool === 'Write') {
      fs.files.set(input.file_path!, input.content!)
      return { result: { type: 'create', filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null } } as never
    }
    return { result: 'ok' } as never
  })
}

const PANE = (bodyColumns: number, bodyRows: number) =>
  ({
    component: 'Pane',
    requestId: 'worktrace',
    props: { title: 'WorkTrace', isFocused: true, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: {} },
    viewport: { columns: bodyColumns + 60, rows: bodyRows + 4, isFullscreen: true },
  }) as const

test('records real tool calls through the engine, and the pane shows tree, timeline, summaries and diffs', { timeoutMs: 20_000 }, async ($, on) => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/src/sync/cache.ts`, 'export function save(job) {\n  db.put(job)\n}\n')
  fs.files.set(`${ROOT}/src/sync/net.ts`, 'export const online = () => true\n')
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  world(on, fs)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await clock.advance(10)
  const ran = await $.command.run({ command: 'worktrace', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  expect(String((ran as { text?: string }).text)).toContain('recording')
  await $.prompt.submit({ text: 'Make cache writes transactional', wait: false, origin: { kind: 'composer' } } as never)
  // the session's own tools, as the model calls them
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/sync/cache.ts` } as never)
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/sync/net.ts` } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sync/cache.ts`, old_string: '  db.put(job)', new_string: '  db.tx(() => db.put(job))' } as never)
  await $.tool.call({ tool: 'Edit', file_path: `${ROOT}/src/sync/cache.ts`, old_string: 'save(job)', new_string: 'save(job, opts)' } as never)
  await $.tool.call({ tool: 'Write', file_path: `${ROOT}/src/sync/retry.ts`, content: 'export const retries = 3\n' } as never)
  // the pass-through: the files changed exactly as the tools said
  expect(fs.files.get(`${ROOT}/src/sync/cache.ts`)).toBe('export function save(job, opts) {\n  db.tx(() => db.put(job))\n}\n')
  await clock.advance(400)
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const [cols, rows] of [
      [96, 44],
      [44, 30],
    ] as const) {
      const ui = await $.ui.mount({ plugin: 'worktrace', surface, ...PANE(cols, rows) })
      const text = paint(await ui.drawn()).join('\n')
      if (surface === 'terminal') print(`\n===== terminal pane, ${cols} columns × ${rows} rows (approximate text paint) =====\n${text}\n`)
      expect(text).toContain('WorkTrace')
      expect(text).toContain('cache.ts')
      expect(text).toContain('net.ts')
      expect(text).toContain('retry.ts')
      // click the folder: aggregate summary and its children
      await ui.press({ key: 'sel-d:d:/proj/src/sync' })
      const folder = paint(await ui.drawn()).join('\n')
      expect(folder).toContain('3 files touched under src/sync')
      expect(folder).toContain('FILES IN THIS FOLDER (3)')
      // click the file: its two sentences, history and diff
      await ui.press({ key: 'sel-f:d:/proj/src/sync/cache.ts' })
      await clock.advance(50)
      const file = paint(await ui.drawn()).join('\n')
      expect(file).toContain('cache.ts is a TypeScript file in src/sync')
      expect(file).toContain('Claude modified it 2 times')
      expect(file).toContain('AI summary failed')
      expect(file).toContain('WHAT CLAUDE DID (3)')
      expect(file).toContain('+export function save(job, opts) {')
      if (surface === 'terminal' && cols === 96) print(`\n===== after clicking cache.ts =====\n${file}\n`)
      // whole-task diff
      await ui.press({ key: 'scope-task' })
      const task = paint(await ui.drawn()).join('\n')
      expect(task).toContain('-export function save(job) {')
      expect(task).toContain('+export function save(job, opts) {')
      await ui.press({ key: 'scope-op' })
      // the timeline, and an event opening its file and evidence
      await ui.press({ key: 'tab-timeline' })
      const tl = paint(await ui.drawn()).join('\n')
      expect(tl).toContain('You asked')
      expect(tl).toMatch(/Read[\s\S]*Read[\s\S]*Edited[\s\S]*Edited[\s\S]*Created/)
      if (surface === 'terminal') print(`\n===== timeline, ${cols} columns =====\n${tl}\n`)
      const rowsFound = await ui.findAll({ type: 'Button' })
      const netRow = rowsFound.find(b => String(b.props.label).includes('net.ts'))
      expect(netRow).toBeDefined()
      await ui.press({ key: netRow!.key! })
      const net = paint(await ui.drawn()).join('\n')
      expect(net).toContain('No changes made.')
      // the graph: one card per file, clicking a card opens that file's details
      await ui.press({ key: 'tab-graph' })
      const graph = paint(await ui.drawn()).join('\n')
      for (const name of ['cache.ts', 'net.ts', 'retry.ts']) expect(graph).toContain(name)
      expect(graph).toContain('edited +')
      if (surface === 'terminal' && cols === 96) print(`\n===== graph, ${cols} columns =====\n${graph}\n`)
      await ui.press({ key: 'g-sel-f:d:/proj/src/sync/net.ts' })
      expect(paint(await ui.drawn()).join('\n')).toContain('No changes made.')
      await ui.press({ key: 'tab-tree' })
      await ui.unmount()
    }
  }
  // more activity: earlier entries stay
  await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/sync/retry.ts` } as never)
  await clock.advance(400)
  const ui = await $.ui.mount({ plugin: 'worktrace', surface: 'terminal', ...PANE(96, 44) })
  const later = paint(await ui.drawn()).join('\n')
  for (const name of ['cache.ts', 'net.ts', 'retry.ts']) expect(later).toContain(name)
  await ui.unmount()
  // history persisted to the (mocked) disk under the project and session
  const stored = [...fs.files.keys()].filter(k => k.startsWith(`${HOME}/.claude/worktrace/v1/`))
  expect(stored.some(k => /\/sessions\/sess-1\/ev-.*\.json$/.test(k))).toBe(true)
  expect(stored.some(k => /\/blobs\//.test(k))).toBe(true)
})

test('a long graph scrolls: nothing is dropped, buttons move the window, a selected card is brought into view', { timeoutMs: 20_000 }, async ($, on) => {
  const fs = new MemFs()
  const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}.ts`)
  for (const f of names) fs.files.set(`${ROOT}/src/${f}`, `export const x = 1\n`)
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  world(on, fs)
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'worktrace', args: 'on', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 160 } } as never)
  await $.prompt.submit({ text: 'Read everything', wait: false, origin: { kind: 'composer' } } as never)
  // ten seconds apart: one column per file, three columns to a row at 96 columns, four rows
  for (const f of names) {
    await $.tool.call({ tool: 'Read', file_path: `${ROOT}/src/${f}` } as never)
    await clock.advance(10_000)
  }
  const ui = await $.ui.mount({ plugin: 'worktrace', surface: 'terminal', ...PANE(96, 44) })
  await ui.press({ key: 'tab-graph' })
  // the graph area only: between the first rule and the j/k line (the details below name the selected file too)
  const shown = async () => {
    const t = paint(await ui.drawn()).join('\n')
    return t.slice(t.indexOf('────'), t.indexOf('j: down'))
  }
  const pos = async () => /rows \d+–\d+ of \d+/.exec(await shown())?.[0] ?? ''
  // opens on the newest files, and says how much lies above
  let text = await shown()
  expect(text).toContain('f11.ts')
  expect(text).not.toContain('f00.ts')
  expect(await pos()).toMatch(/of 27/)
  expect(text).not.toContain('earlier file')
  // scroll to the top: the first files come into view
  for (let i = 0; i < 5; i++) await ui.press({ key: 'g-up' })
  text = await shown()
  expect(text).toContain('f00.ts')
  expect(await pos()).toMatch(/^rows 1–/)
  // and back down
  for (let i = 0; i < 5; i++) await ui.press({ key: 'g-down' })
  expect(await shown()).toContain('f11.ts')
  // j/k selection walks the cards and the window follows the selected one, both ways
  for (let i = 0; i < 11; i++) await ui.press({ key: 'next' })
  expect(await shown()).toContain('f11.ts')
  for (let i = 0; i < 11; i++) await ui.press({ key: 'prev' })
  text = await shown()
  expect(text).toContain('f00.ts')
  expect(await pos()).toMatch(/^rows 1–/)
  print(`\n===== scrolled graph, 96 × 44 =====\n${text}\n`)
  await ui.unmount()
})

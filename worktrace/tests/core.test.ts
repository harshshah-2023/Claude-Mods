// MOCKED tests: the recorder, storage, evidence and summaries against an in-memory host.
import { expect, test } from 'claude-code/testing'
import { diffText, unified } from '../hooks/diff'
import { opDiff, taskDiff } from '../hooks/evidence'
import { ALL, buildTree, fileStats, flattenTree, opsFor, timelineRows, type OpEvent } from '../hooks/model'
import { DEFAULTS, Recorder, outcomeOf } from '../hooks/recorder'
import { Blobs, deleteHistory, listSessions, loadSession } from '../hooks/store'
import { Summaries } from '../hooks/summary'
import { normPath, redact } from '../hooks/util'
import { MemFs } from './memhost'

const ROOT = 'D:/proj'
const PROJECT = 'C:/Users/u/.claude/worktrace/v1/proj-abc'

function recorder(fs: MemFs, session = 's1', writer = 'w1', run?: Parameters<MemFs['host']>[0]) {
  const host = fs.host(run)
  const rec = new Recorder(host, new Blobs(host.io, PROJECT), PROJECT, ROOT, ROOT, session, writer, DEFAULTS, () => {}, ['C:/Users/u/.claude/worktrace'])
  rec.tracking = true
  return rec
}

// Simulates the engine's own tools over the in-memory files.
async function read(rec: Recorder, fs: MemFs, path: string) {
  return rec.onToolCall({ tool: 'Read', tool_use_id: 'r' + path, file_path: path }, async () => {
    const content = fs.files.get(path)
    if (content === undefined) return { isError: true, result: 'File does not exist.', text: 'File does not exist.' }
    const n = content.split('\n').length
    return { result: { type: 'text', file: { filePath: path, content, numLines: n, startLine: 1, totalLines: n } } }
  })
}

async function edit(rec: Recorder, fs: MemFs, path: string, from: string, to: string) {
  return rec.onToolCall({ tool: 'Edit', tool_use_id: 'e' + Math.random(), file_path: path, old_string: from, new_string: to }, async () => {
    const original = fs.files.get(path)
    if (original === undefined || !original.includes(from)) return { isError: true, result: 'String to replace not found in file.', text: 'String to replace not found in file.' }
    fs.files.set(path, original.replace(from, to))
    return { result: { filePath: path, oldString: from, newString: to, originalFile: original, structuredPatch: [], userModified: false, replaceAll: false } }
  })
}

async function write(rec: Recorder, fs: MemFs, path: string, content: string) {
  return rec.onToolCall({ tool: 'Write', tool_use_id: 'w' + path, file_path: path, content }, async () => {
    const original = fs.files.get(path) ?? null
    fs.files.set(path, content)
    return { result: { type: original === null ? 'create' : 'update', filePath: path, content, structuredPatch: [], originalFile: original } }
  })
}

const ops = (rec: Recorder) => rec.events.filter((e): e is OpEvent => e.kind === 'op')

test('diff: exact hunks with line numbers, identical and oversized inputs', () => {
  const d = diffText('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nC\nd\ne\nf\ng\nh\ni\n')
  expect(d.kind).toBe('ok')
  if (d.kind !== 'ok') return
  expect(d.added).toBe(2)
  expect(d.removed).toBe(1)
  const text = unified(d.hunks, 100).text
  expect(text).toContain('@@ -1,8 +1,9 @@')
  expect(text).toContain('-c\n+C')
  expect(text).toContain('+i')
  expect(diffText('same', 'same').kind).toBe('identical')
  const big = Array.from({ length: 40_000 }, (_, i) => `l${i}`).join('\n')
  expect(diffText(big, big + '\nx\n' + big).kind).toBe('too-large')
  // a created file: every line added, numbered from 1
  const created = diffText('', 'one\ntwo\n')
  expect(created.kind === 'ok' && unified(created.hunks, 10).text).toBe('@@ -0,0 +1,2 @@\n+one\n+two')
})

test('ordering, repeated edits and the tree: read two, modify one twice, create another', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/src/a.ts`, 'export const a = 1\n')
  fs.files.set(`${ROOT}/src/b.ts`, 'export const b = 2\n')
  const rec = recorder(fs)
  await rec.turnStarted('Read a and b, then change a twice and add c', 'composer')
  await read(rec, fs, `${ROOT}/src/a.ts`)
  await read(rec, fs, `${ROOT}/src/b.ts`)
  await edit(rec, fs, `${ROOT}/src/a.ts`, '= 1', '= 10')
  await edit(rec, fs, `${ROOT}/src/a.ts`, '= 10', '= 100')
  await write(rec, fs, `${ROOT}/src/c.ts`, 'export const c = 3\n')
  const list = ops(rec)
  expect(list.map(o => `${o.op}:${o.path.split('/').pop()}:${o.status}`)).toEqual([
    'read:a.ts:completed',
    'read:b.ts:completed',
    'modify:a.ts:completed',
    'modify:a.ts:completed',
    'create:c.ts:completed',
  ])
  for (let i = 1; i < list.length; i++) expect(list[i]!.ts).toBeGreaterThan(list[i - 1]!.ts)
  const stats = fileStats(rec.events, false)
  const tree = flattenTree(buildTree(ROOT, stats), new Set())
  expect(tree.map(r => `${'  '.repeat(r.depth)}${r.label}${r.kind === 'file' ? ':' + r.stat.badge : '/'}`)).toEqual(['src/', '  a.ts:modified', '  b.ts:read', '  c.ts:created'])
  const a = [...stats.values()].find(s => s.path.endsWith('a.ts'))!
  expect(a.counts.modify).toBe(2)
  expect(a.counts.read).toBe(1)
  // the timeline keeps the task header, the turn and every operation in order
  const rows = timelineRows(rec.events, ALL)
  expect(rows.map(r => r.kind)).toEqual(['task', 'turn', 'op', 'op', 'op', 'op', 'op'])
  // the task's cumulative diff runs from the first pre-edit state to the last post-edit state
  const cumulative = await taskDiff(rec.blobs, `${ROOT}/src/a.ts`, opsFor(rec.events, `${ROOT}/src/a.ts`, rec.taskId))
  expect(cumulative.kind === 'diff' && unified(cumulative.hunks, 20).text).toBe('@@ -1,1 +1,1 @@\n-export const a = 1\n+export const a = 100')
  const second = await opDiff(rec.blobs, list[3]!)
  expect(second.kind === 'diff' && unified(second.hunks, 20).text).toBe('@@ -1,1 +1,1 @@\n-export const a = 10\n+export const a = 100')
  const created = await opDiff(rec.blobs, list[4]!)
  expect(created.kind === 'diff' && created.added).toBe(1)
})

test('baseline: uncommitted user changes are the pre-edit state, never attributed to Claude', async () => {
  const fs = new MemFs()
  const p = `${ROOT}/cache.ts`
  fs.files.set(p, 'line1\nuser edit not committed\nline3\n')
  const rec = recorder(fs)
  await edit(rec, fs, p, 'line3', 'line3 by claude')
  const op = ops(rec)[0]!
  const d = await opDiff(rec.blobs, op)
  expect(d.kind === 'diff' && unified(d.hunks, 20).text).toBe('@@ -1,3 +1,3 @@\n line1\n user edit not committed\n-line3\n+line3 by claude')
  // someone edits the file between Claude's operations
  fs.files.set(p, fs.files.get(p)!.replace('line1', 'line1 edited in the editor'))
  await edit(rec, fs, p, 'by claude', 'by claude again')
  const list = ops(rec)
  expect(list.map(o => `${o.tool}:${o.attribution}`)).toEqual(['Edit:claude', 'external:uncertain', 'Edit:claude'])
  expect(list[1]!.note).toContain('attribution uncertain')
  // the cumulative diff says it spans a change that was not Claude's
  const cumulative = await taskDiff(rec.blobs, p, opsFor(rec.events, p, rec.taskId))
  expect(cumulative.kind === 'diff' && cumulative.caveats.join(' ')).toContain('uncertain attribution')
  // the historical per-operation diff survives later changes to the file
  fs.files.set(p, 'rewritten entirely\n')
  const again = await opDiff(rec.blobs, list[0]!)
  expect(again.kind === 'diff' && unified(again.hunks, 20).text).toContain('+line3 by claude')
})

test('missing baseline is labelled, never shown as exact', async () => {
  const fs = new MemFs()
  const p = `${ROOT}/.env`
  fs.files.set(p, 'TOKEN=abc\n')
  const rec = recorder(fs)
  await edit(rec, fs, p, 'abc', 'xyz')
  const d = await opDiff(rec.blobs, ops(rec)[0]!)
  expect(d.kind).toBe('note')
  expect(d.kind === 'note' && d.text).toContain('credentials')
  // the stored history holds no copy of the sensitive content
  const stored = [...fs.files.entries()].filter(([k]) => k.startsWith(PROJECT)).map(([, v]) => v).join('\n')
  expect(stored).not.toContain('TOKEN=xyz')
  expect(stored).not.toContain('TOKEN=abc')
})

test('failed, denied and interrupted calls are recorded apart from successes; results pass through unchanged', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/x.ts`, 'x\n')
  const rec = recorder(fs)
  const failed = await edit(rec, fs, `${ROOT}/x.ts`, 'nope', 'y')
  expect(failed.isError).toBe(true)
  const sentinel = { deny: 'blocked by policy' }
  const denied = await rec.onToolCall({ tool: 'Write', file_path: `${ROOT}/y.ts`, content: 'y' }, async () => sentinel)
  expect(denied).toBe(sentinel)
  let thrown: unknown
  try {
    await rec.onToolCall({ tool: 'Read', file_path: `${ROOT}/x.ts` }, async () => {
      throw new Error('aborted by user')
    })
  } catch (err) {
    thrown = err
  }
  expect(String(thrown)).toContain('aborted')
  expect(ops(rec).map(o => o.status)).toEqual(['failed', 'denied', 'interrupted'])
  expect(fs.files.has(`${ROOT}/y.ts`)).toBe(false)
  expect(outcomeOf({ isError: true, text: "The user doesn't want to proceed with this tool use." }).status).toBe('denied')
  // tracking off: nothing is recorded and the call still runs
  rec.tracking = false
  await read(rec, fs, `${ROOT}/x.ts`)
  expect(ops(rec).length).toBe(3)
})

test('restart recovery: a new process reads the same history; an operation left running is marked interrupted', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/a.ts`, 'a\n')
  const first = recorder(fs, 's1', 'w1')
  await read(first, fs, `${ROOT}/a.ts`)
  await edit(first, fs, `${ROOT}/a.ts`, 'a', 'b')
  // a call that never finishes: the process dies mid-operation
  void first.onToolCall({ tool: 'Read', file_path: `${ROOT}/a.ts` }, () => new Promise<never>(() => {}))
  for (let i = 0; i < 50; i++) await Promise.resolve()
  await first.journal.flush()
  const again = recorder(fs, 's1', 'w1')
  await again.load()
  expect(ops(again).map(o => `${o.op}:${o.status}`)).toEqual(['read:completed', 'modify:completed', 'read:interrupted'])
  const d = await opDiff(again.blobs, ops(again)[1]!)
  expect(d.kind === 'diff' && unified(d.hunks, 10).text).toBe('@@ -1,1 +1,1 @@\n-a\n+b')
  // the task continues, numbering does not collide
  await read(again, fs, `${ROOT}/a.ts`)
  await again.journal.flush()
  const loaded = await loadSession(fs.io(), PROJECT, 's1')
  expect(new Set(loaded.events.map(e => e.id)).size).toBe(loaded.events.length)
})

test('concurrent sessions write separate files and never overwrite each other', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/a.ts`, 'a\n')
  const one = recorder(fs, 'session-one', 'p1')
  const two = recorder(fs, 'session-two', 'p2')
  const same = recorder(fs, 'session-one', 'p3') // a second process on the same resumed session
  await Promise.all([read(one, fs, `${ROOT}/a.ts`), read(two, fs, `${ROOT}/a.ts`), read(same, fs, `${ROOT}/a.ts`)])
  await Promise.all([one.journal.flush(), two.journal.flush(), same.journal.flush()])
  const sessions = await listSessions(fs.io(), PROJECT)
  expect(sessions.map(s => s.sessionId).sort()).toEqual(['session-one', 'session-two'])
  expect(sessions.find(s => s.sessionId === 'session-one')!.writers).toBe(2)
  expect((await loadSession(fs.io(), PROJECT, 'session-one')).events.filter(e => e.kind === 'op').length).toBe(2)
})

test('a failed disk write keeps events in memory and retries', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/a.ts`, 'a\n')
  const rec = recorder(fs)
  fs.failWrites = true
  await read(rec, fs, `${ROOT}/a.ts`)
  await rec.journal.flush()
  expect(rec.journal.lastError).toContain('disk full')
  expect(ops(rec).length).toBe(1)
  fs.failWrites = false
  await rec.journal.flush()
  expect(rec.journal.lastError).toBe(undefined)
  expect((await loadSession(fs.io(), PROJECT, 's1')).events.filter(e => e.kind === 'op').length).toBe(1)
})

test('summaries: model failure falls back to facts; success is cached by evidence; read-only says no changes', async () => {
  const fs = new MemFs()
  const p = `${ROOT}/src/store.ts`
  fs.files.set(p, 'export function save(job) { db.put(job) }\n')
  const rec = recorder(fs)
  await read(rec, fs, p)
  let answer: { isAnswered: true; text: string } | { isAnswered: false; reason: string } = { isAnswered: false, reason: 'api error 529' }
  let calls = 0
  const s = new Summaries(fs.io(), PROJECT, rec.blobs, async () => (calls++, answer), () => ({ enabled: true, model: 'haiku' }), () => {})
  const scoped = opsFor(rec.events, p, rec.taskId)
  await s.ensure(ROOT, p, rec.taskId, scoped)
  const failed = await s.view(ROOT, p, rec.taskId, scoped)
  expect(failed.state).toBe('fallback')
  expect(failed.label).toContain('api error 529')
  expect(failed.text).toContain('store.ts is a TypeScript file in src')
  expect(failed.text).toContain('No changes made.')
  answer = { isAnswered: true, text: 'Saves jobs to the local database. Extra text.' }
  await s.ensure(ROOT, p, rec.taskId, scoped, true)
  const ok = await s.view(ROOT, p, rec.taskId, scoped)
  expect(ok.state).toBe('ai')
  expect(ok.text).toBe('Saves jobs to the local database. Claude read it (all 2 lines). No changes made.')
  // a second Summaries (a restart) reads the cache instead of asking again
  const later = new Summaries(fs.io(), PROJECT, rec.blobs, async () => (calls++, answer), () => ({ enabled: true, model: 'haiku' }), () => {})
  await later.ensure(ROOT, p, rec.taskId, scoped)
  expect(calls).toBe(2)
  // new evidence makes the old summary stale until it is regenerated
  await edit(rec, fs, p, 'db.put(job)', 'db.tx(() => db.put(job))')
  const changed = opsFor(rec.events, p, rec.taskId)
  const stale = await s.view(ROOT, p, rec.taskId, changed)
  expect(stale.state).toBe('stale')
})

test('shell commands: git evidence finds changes, labels them uncertain and pairs renames', async () => {
  const fs = new MemFs()
  const head = new Map<string, string>([['keep.ts', 'k\n'], ['old.ts', 'moved content\n'], ['dirty.ts', 'committed\n']])
  for (const [k, v] of head) fs.files.set(`${ROOT}/${k}`, v)
  fs.files.set(`${ROOT}/dirty.ts`, 'committed\nuser work in progress\n')
  const h = (s: string) => 'g' + [...s].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16)
  const run = async (argv: readonly string[], _cwd: string, stdin?: string) => {
    const cmd = argv.filter(a => a !== '-c' && a !== 'core.quotepath=off')
    if (cmd[1] === 'rev-parse') return { exitCode: 0, stdout: ROOT + '\n', stderr: '' }
    if (cmd[1] === 'status') {
      const out: string[] = []
      const work = new Map([...fs.files].filter(([k]) => k.startsWith(ROOT + '/')).map(([k, v]) => [k.slice(ROOT.length + 1), v]))
      for (const [k, v] of head) if (!work.has(k)) out.push(` D ${k}`)
      else if (work.get(k) !== v) out.push(` M ${k}`)
      for (const k of work.keys()) if (!head.has(k)) out.push(`?? ${k}`)
      return { exitCode: 0, stdout: out.map(o => o + '\0').join(''), stderr: '' }
    }
    if (cmd[1] === 'hash-object') return { exitCode: 0, stdout: (stdin ?? '').split('\n').filter(Boolean).map(r => h(fs.files.get(`${ROOT}/${r}`) ?? '')).join('\n') + '\n', stderr: '' }
    if (cmd[1] === 'show') {
      const v = head.get(cmd[2]!.slice(5))
      return v === undefined ? { exitCode: 128, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: v, stderr: '' }
    }
    return { exitCode: 1, stdout: '', stderr: 'unknown' }
  }
  const rec = recorder(fs, 's1', 'w1', run)
  await rec.onToolCall({ tool: 'Bash', command: 'git mv old.ts new.ts && echo x >> keep.ts && echo y >> dirty.ts' }, async () => {
    fs.files.set(`${ROOT}/new.ts`, fs.files.get(`${ROOT}/old.ts`)!)
    fs.files.delete(`${ROOT}/old.ts`)
    fs.files.set(`${ROOT}/keep.ts`, 'k\nx\n')
    fs.files.set(`${ROOT}/dirty.ts`, 'committed\nuser work in progress\ny\n')
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  const changes = ops(rec)
  expect(changes.every(c => c.attribution === 'uncertain')).toBe(true)
  expect(changes.map(c => `${c.op}:${c.path.split('/').pop()}`).sort()).toEqual(['modify:dirty.ts', 'modify:keep.ts', 'rename:new.ts'])
  const dirty = changes.find(c => c.path.endsWith('dirty.ts'))!
  const d = await opDiff(rec.blobs, dirty)
  // the user's uncommitted line is context, not a change of Claude's
  expect(d.kind === 'diff' && unified(d.hunks, 10).text).toBe('@@ -1,2 +1,3 @@\n committed\n user work in progress\n+y')
  const cmd = rec.events.find(e => e.kind === 'command')!
  expect(cmd.kind === 'command' && cmd.changed).toBe(3)
})

test('explicit delete removes a task, then a session, then the project; nothing else', async () => {
  const fs = new MemFs()
  fs.files.set(`${ROOT}/a.ts`, 'a\n')
  const rec = recorder(fs, 's1')
  await read(rec, fs, `${ROOT}/a.ts`)
  const first = rec.taskId
  await rec.startTask('second')
  await edit(rec, fs, `${ROOT}/a.ts`, 'a', 'b')
  await rec.journal.flush()
  const other = recorder(fs, 's2', 'w2')
  await read(other, fs, `${ROOT}/a.ts`)
  await other.journal.flush()
  rec.dropTask(first)
  await rec.journal.flush()
  await deleteHistory(fs.io(), PROJECT, { kind: 'task', sessionId: 's1', taskId: first })
  const left = (await loadSession(fs.io(), PROJECT, 's1')).events
  expect(left.some(e => e.taskId === first)).toBe(false)
  expect(left.some(e => e.kind === 'op')).toBe(true)
  await deleteHistory(fs.io(), PROJECT, { kind: 'session', sessionId: 's1' })
  expect((await listSessions(fs.io(), PROJECT)).map(s => s.sessionId)).toEqual(['s2'])
  await deleteHistory(fs.io(), PROJECT, { kind: 'project' })
  expect([...fs.files.keys()].some(k => k.startsWith(PROJECT))).toBe(false)
  expect(fs.files.get(`${ROOT}/a.ts`)).toBe('b\n')
})

test('paths and redaction', () => {
  expect(normPath('d:\\proj\\src\\..\\a.ts')).toBe('D:/proj/a.ts')
  expect(redact('curl -H "Authorization: Bearer abcdefghijkl123" API_KEY=sk-12345678901234567890')).not.toContain('abcdefghijkl123')
  expect(redact('export GITHUB_TOKEN=ghp_aaaaaaaaaaaaaaaaaaaa')).not.toContain('ghp_aaaa')
})

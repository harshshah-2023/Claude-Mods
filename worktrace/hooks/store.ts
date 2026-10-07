// Durable history on local disk, one directory per project and session.
//
// <home>/.claude/worktrace/v1/<project>/
//   project.json                          the project's root, written once
//   sessions/<session>/ev-<writer>-NNNN.json   events, 200 per chunk, written only by that writer
//   sessions/<session>/meta-<writer>.json      what the History tab lists without loading events
//   blobs/<ab>/<sha256>.txt               content snapshots, content-addressed and never rewritten
//   summaries/<key>.json                  model summaries cached by evidence hash
//
// A writer is one Claude Code process recording one session, so two sessions (or two
// processes on one resumed session) never write the same file.

import { ALL, latestTaskEvents, sortEvents, type TraceEvent } from './model'
import { pathKey, sha256 } from './util'

export type IoEntry = { name: string; kind: 'file' | 'dir' | 'other' }

export type Io = {
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
  list: (path: string) => Promise<IoEntry[]>
  exists: (path: string) => Promise<boolean>
  /** Removes a file or a directory tree inside the storage root. */
  remove: (path: string) => Promise<void>
}

export const CHUNK = 200

export type SessionMeta = {
  sessionId: string
  writer: string
  root: string
  startedAt: number
  updatedAt: number
  events: number
  files: number
  tasks: { id: string; title: string }[]
}

export type SessionListing = Omit<SessionMeta, 'writer'> & { writers: number }

export const projectDir = (home: string, key: string) => `${home}/.claude/worktrace/v1/${key}`

export async function projectKey(root: string): Promise<string> {
  const name = root.split('/').filter(Boolean).pop()?.replace(/[^A-Za-z0-9._-]+/g, '-') ?? 'root'
  return `${name.slice(0, 32)}-${(await sha256(pathKey(root))).slice(0, 10)}`
}

const pad = (n: number) => String(n).padStart(4, '0')

export class Journal {
  readonly dir: string
  private mine: TraceEvent[] = []
  private index = new Map<string, number>()
  private dirty = new Set<number>()
  private chain: Promise<void> = Promise.resolve()
  private metaDirty = false
  private seq = 0
  startedAt = 0
  lastError: string | undefined
  writes = 0

  constructor(
    private io: Io,
    readonly project: string,
    readonly root: string,
    readonly sessionId: string,
    readonly writer: string,
  ) {
    this.dir = `${project}/sessions/${safeName(sessionId)}`
  }

  /** Adopts what this writer already wrote for the session (a hot reload, a resumed session). */
  adopt(events: readonly TraceEvent[]) {
    for (const e of events) {
      if (e.writer !== this.writer || this.index.has(e.id)) continue
      this.index.set(e.id, this.mine.length)
      this.mine.push(e)
      this.seq = Math.max(this.seq, e.seq + 1)
      this.startedAt = this.startedAt ? Math.min(this.startedAt, e.ts) : e.ts
    }
  }

  nextSeq(): number {
    return this.seq++
  }

  /** Records a new event or a newer revision of one; durable once the next flush lands. */
  put(e: TraceEvent) {
    const at = this.index.get(e.id)
    if (at === undefined) {
      this.index.set(e.id, this.mine.length)
      this.mine.push(e)
      this.dirty.add(Math.floor((this.mine.length - 1) / CHUNK))
      if (!this.startedAt) this.startedAt = e.ts
    } else {
      this.mine[at] = e
      this.dirty.add(Math.floor(at / CHUNK))
    }
    this.metaDirty = true
  }

  /** Drops events (an explicit task delete), rewriting this writer's chunks. */
  drop(pred: (e: TraceEvent) => boolean) {
    const kept = this.mine.filter(e => !pred(e))
    const chunks = Math.ceil(this.mine.length / CHUNK)
    this.mine = kept
    this.index = new Map(kept.map((e, i) => [e.id, i]))
    for (let c = 0; c < chunks; c++) this.dirty.add(c)
    this.metaDirty = true
  }

  /** Writes every dirty chunk, one flush at a time. Rejections are kept, never thrown. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.write()).catch(err => {
      this.lastError = String((err as Error)?.message ?? err)
    })
    return this.chain
  }

  get pending(): boolean {
    return this.dirty.size > 0 || this.metaDirty
  }

  private async write() {
    const chunks = [...this.dirty].sort((a, b) => a - b)
    this.dirty.clear()
    const meta = this.metaDirty
    this.metaDirty = false
    try {
      for (const c of chunks) {
        const events = this.mine.slice(c * CHUNK, (c + 1) * CHUNK)
        await this.io.write(`${this.dir}/ev-${this.writer}-${pad(c)}.json`, JSON.stringify({ v: 1, sessionId: this.sessionId, writer: this.writer, chunk: c, events }))
        this.writes++
      }
      if (meta) await this.io.write(`${this.dir}/meta-${this.writer}.json`, JSON.stringify(this.meta()))
      this.lastError = undefined
    } catch (err) {
      for (const c of chunks) this.dirty.add(c)
      if (meta) this.metaDirty = true
      throw err
    }
  }

  meta(): SessionMeta {
    const files = new Set<string>()
    let updatedAt = this.startedAt
    for (const e of this.mine) {
      if (e.kind === 'op') files.add(pathKey(e.path))
      updatedAt = Math.max(updatedAt, (e.kind === 'op' || e.kind === 'command' ? e.endTs : undefined) ?? e.ts)
    }
    return {
      sessionId: this.sessionId,
      writer: this.writer,
      root: this.root,
      startedAt: this.startedAt,
      updatedAt,
      events: this.mine.length,
      files: files.size,
      tasks: latestTaskEvents(this.mine).map(t => ({ id: t.taskId, title: t.title })),
    }
  }
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)

async function listOr(io: Io, path: string): Promise<IoEntry[]> {
  try {
    return (await io.exists(path)) ? await io.list(path) : []
  } catch {
    return []
  }
}

/** Every event any writer recorded for the session, merged and in order. Unreadable chunks are reported, not fatal. */
export async function loadSession(io: Io, project: string, sessionId: string): Promise<{ events: TraceEvent[]; problems: string[] }> {
  const dir = `${project}/sessions/${safeName(sessionId)}`
  const byId = new Map<string, TraceEvent>()
  const problems: string[] = []
  for (const f of await listOr(io, dir)) {
    if (f.kind !== 'file' || !/^ev-.*\.json$/.test(f.name)) continue
    try {
      const doc = JSON.parse(await io.read(`${dir}/${f.name}`)) as { events?: TraceEvent[] }
      for (const e of doc.events ?? []) {
        const had = byId.get(e.id)
        if (!had || (had.rev ?? 0) <= (e.rev ?? 0)) byId.set(e.id, e)
      }
    } catch (err) {
      problems.push(`${f.name}: ${String((err as Error)?.message ?? err)}`)
    }
  }
  return { events: sortEvents([...byId.values()]), problems }
}

export async function listSessions(io: Io, project: string): Promise<SessionListing[]> {
  const out: SessionListing[] = []
  for (const d of await listOr(io, `${project}/sessions`)) {
    if (d.kind !== 'dir') continue
    const metas: SessionMeta[] = []
    for (const f of await listOr(io, `${project}/sessions/${d.name}`)) {
      if (f.kind !== 'file' || !/^meta-.*\.json$/.test(f.name)) continue
      try {
        metas.push(JSON.parse(await io.read(`${project}/sessions/${d.name}/${f.name}`)) as SessionMeta)
      } catch {
        // a meta being rewritten by its writer is read again next time
      }
    }
    if (!metas.length) continue
    const tasks = new Map<string, string>()
    for (const m of metas) for (const t of m.tasks) tasks.set(t.id, t.title)
    out.push({
      sessionId: metas[0]!.sessionId,
      root: metas[0]!.root,
      startedAt: Math.min(...metas.map(m => m.startedAt || Infinity)),
      updatedAt: Math.max(...metas.map(m => m.updatedAt)),
      events: metas.reduce((n, m) => n + m.events, 0),
      files: Math.max(...metas.map(m => m.files)),
      tasks: [...tasks].map(([id, title]) => ({ id, title })),
      writers: metas.length,
    })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ---------------------------------------------------------------- blobs

export class Blobs {
  private known = new Set<string>()
  private cache = new Map<string, string>()
  private cacheBytes = 0

  constructor(
    private io: Io,
    private project: string,
    private maxCache = 8 * 1024 * 1024,
  ) {}

  path(hash: string) {
    return `${this.project}/blobs/${hash.slice(0, 2)}/${hash}.txt`
  }

  /** Stores text under its own hash; a blob already there is never rewritten. */
  async put(text: string, hash?: string): Promise<string> {
    const h = hash ?? (await sha256(text))
    this.remember(h, text)
    if (this.known.has(h)) return h
    const p = this.path(h)
    if (!(await this.io.exists(p))) await this.io.write(p, text)
    this.known.add(h)
    return h
  }

  async get(hash: string): Promise<string | undefined> {
    const hit = this.cache.get(hash)
    if (hit !== undefined) {
      this.cache.delete(hash)
      this.cache.set(hash, hit)
      return hit
    }
    try {
      const text = await this.io.read(this.path(hash))
      this.remember(hash, text)
      return text
    } catch {
      return undefined
    }
  }

  private remember(hash: string, text: string) {
    if (this.cache.has(hash) || text.length > this.maxCache / 4) return
    this.cache.set(hash, text)
    this.cacheBytes += text.length
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= this.maxCache) break
      this.cache.delete(k)
      this.cacheBytes -= v.length
    }
  }

  forget() {
    this.known.clear()
    this.cache.clear()
    this.cacheBytes = 0
  }
}

// ---------------------------------------------------------------- deletion

export type DeleteScope = { kind: 'task'; sessionId: string; taskId: string } | { kind: 'session'; sessionId: string } | { kind: 'project' }

/** Deletes what the person chose, then the blobs and summaries nothing references any more. */
export async function deleteHistory(io: Io, project: string, scope: DeleteScope): Promise<{ removedEvents: number }> {
  let removedEvents = 0
  if (scope.kind === 'project') {
    await io.remove(project)
    return { removedEvents: -1 }
  }
  const dir = `${project}/sessions/${safeName(scope.sessionId)}`
  if (scope.kind === 'session') {
    const { events } = await loadSession(io, project, scope.sessionId)
    removedEvents = events.length
    await io.remove(dir)
  } else {
    for (const f of await listOr(io, dir)) {
      if (f.kind !== 'file' || !/^(ev|meta)-.*\.json$/.test(f.name)) continue
      const path = `${dir}/${f.name}`
      const doc = JSON.parse(await io.read(path)) as Record<string, unknown> & { events?: TraceEvent[]; tasks?: { id: string }[] }
      if (f.name.startsWith('ev-')) {
        const before = doc.events?.length ?? 0
        doc.events = (doc.events ?? []).filter(e => scope.taskId === ALL || e.taskId !== scope.taskId)
        removedEvents += before - doc.events.length
      } else doc.tasks = (doc.tasks ?? []).filter(t => t.id !== scope.taskId)
      await io.write(path, JSON.stringify(doc))
    }
  }
  await collectGarbage(io, project)
  return { removedEvents }
}

async function collectGarbage(io: Io, project: string) {
  const used = new Set<string>()
  for (const s of await listSessions(io, project)) {
    const { events } = await loadSession(io, project, s.sessionId)
    for (const e of events) {
      if (e.kind !== 'op') continue
      for (const snap of [e.before, e.after, e.seen]) if (snap?.blob) used.add(snap.blob)
    }
  }
  for (const d of await listOr(io, `${project}/blobs`)) {
    if (d.kind !== 'dir') continue
    for (const f of await listOr(io, `${project}/blobs/${d.name}`)) {
      const hash = f.name.replace(/\.txt$/, '')
      if (!used.has(hash)) await io.remove(`${project}/blobs/${d.name}/${f.name}`)
    }
  }
  if (await io.exists(`${project}/summaries`)) await io.remove(`${project}/summaries`)
}

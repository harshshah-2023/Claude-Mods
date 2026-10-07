// Two-sentence file summaries: asked of the session's model in the background, cached by
// evidence hash, and replaced by a factual sentence pair whenever the model cannot answer.

import { unified } from './diff'
import { taskDiff, type BlobReader } from './evidence'
import { activitySentence, factualFirstSentence, type OpEvent } from './model'
import type { Io } from './store'
import { excerpt, pathKey, relTo, sha256 } from './util'

export type CompleteFn = (request: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<
  { isAnswered: true; text: string } | { isAnswered: false; reason: string }
>

export type SummaryView = {
  /** The two sentences shown. */
  text: string
  state: 'ai' | 'pending' | 'stale' | 'fallback' | 'off'
  /** What the label under the summary says. */
  label: string
}

type Evidence = { key: string; content?: string; diff?: string; changed: boolean; activity: string; first: string; reason?: string }

const SYSTEM =
  'You write short summaries for a developer activity log. Use only the evidence given. Do not guess at code that is not shown, ' +
  "and never describe anyone's reasoning or intent. Plain text only: no markdown, no quotes, no lists."

export class Summaries {
  private ready = new Map<string, string>()
  private pending = new Set<string>()
  private failed = new Map<string, string>()
  private lastGood = new Map<string, string>()
  private evidenceCache = new Map<string, Evidence>()

  constructor(
    private io: Io,
    private project: string,
    private blobs: BlobReader,
    private complete: CompleteFn,
    private settings: () => { enabled: boolean; model: string },
    private changed: () => void,
  ) {}

  private async evidence(root: string, path: string, scope: string, ops: readonly OpEvent[]): Promise<Evidence> {
    const k = pathKey(path)
    const mine = ops.filter(o => pathKey(o.path) === k && o.status === 'completed')
    const changing = mine.filter(o => o.op !== 'read' && o.op !== 'search')
    const latest = [...changing].reverse().find(o => o.after?.exists) ?? [...mine].reverse().find(o => o.seen?.blob || o.before?.blob)
    const snap = latest?.after?.exists ? latest.after : latest?.seen?.blob ? latest.seen : latest?.before
    const content = snap?.blob ? await this.blobs.get(snap.blob) : undefined
    let diff: string | undefined
    if (changing.length) {
      const view = await taskDiff(this.blobs, path, ops)
      if (view.kind === 'diff') diff = unified(view.hunks, 160).text.slice(0, 6000)
    }
    const activity = activitySentence(ops, path)
    const first = factualFirstSentence(path, root, snap?.lines, snap?.size)
    const reason = !snap ? 'no captured content' : !snap.blob ? `content not stored (${snap.reason ?? 'unavailable'})` : undefined
    const sig = JSON.stringify({ v: 3, path: k, content: snap?.hash, diff: diff ? await sha256(diff) : null, activity, model: this.settings().model })
    return { key: await sha256(sig), content, diff, changed: changing.some(o => o.attribution === 'claude'), activity, first, reason }
  }

  /** The last AI summary already in memory for a file in a task: no disk read, no model call. */
  peek(path: string, scope: string): string | undefined {
    return this.lastGood.get(`${pathKey(path)}|${scope}`)
  }

  /** What to draw now for a file in a task; never waits on the model. */
  async view(root: string, path: string, scope: string, ops: readonly OpEvent[]): Promise<SummaryView> {
    const ev = await this.evidence(root, path, scope, ops)
    this.evidenceCache.set(`${pathKey(path)}|${scope}`, ev)
    const slot = `${pathKey(path)}|${scope}`
    const fallback = `${ev.first} ${ev.activity}`
    const settings = this.settings()
    if (!settings.enabled) return { text: fallback, state: 'off', label: 'Basic summary from the record (AI summaries are turned off)' }
    const hit = this.ready.get(ev.key) ?? (await this.readCache(ev.key))
    if (hit) {
      this.lastGood.set(slot, hit)
      return { text: hit, state: 'ai', label: 'AI summary, based only on the captured file and changes' }
    }
    if (ev.content === undefined) return { text: fallback, state: 'fallback', label: `Basic summary from the record (no AI summary: ${ev.reason ?? 'no content captured'})` }
    const failure = this.failed.get(ev.key)
    if (failure) return { text: fallback, state: 'fallback', label: `Basic summary from the record (AI summary failed: ${failure})` }
    const previous = this.lastGood.get(slot)
    if (previous) return { text: previous, state: 'stale', label: this.pending.has(ev.key) ? 'Out of date: the file changed since, updating…' : 'Out of date: the file changed since this summary' }
    return { text: fallback, state: 'pending', label: this.pending.has(ev.key) ? 'Writing an AI summary…' : 'Basic summary from the record' }
  }

  private async readCache(key: string): Promise<string | undefined> {
    try {
      const doc = JSON.parse(await this.io.read(`${this.project}/summaries/${key}.json`)) as { text?: string }
      if (typeof doc.text === 'string') {
        this.ready.set(key, doc.text)
        return doc.text
      }
    } catch {
      // not cached
    }
    return undefined
  }

  /** Starts a summary in the background when none is ready, pending or failed for this evidence. */
  async ensure(root: string, path: string, scope: string, ops: readonly OpEvent[], retry = false): Promise<void> {
    const settings = this.settings()
    if (!settings.enabled) return
    const ev = await this.evidence(root, path, scope, ops)
    if (retry) this.failed.delete(ev.key)
    if (ev.content === undefined || this.ready.has(ev.key) || this.pending.has(ev.key) || this.failed.has(ev.key)) return
    if (await this.readCache(ev.key)) return this.changed()
    this.pending.add(ev.key)
    this.changed()
    try {
      const rel = relTo(root, path) ?? path
      const r = await this.complete({ model: settings.model, system: SYSTEM, prompt: promptFor(rel, ev), maxTokens: 220, timeoutMs: 45_000 })
      if (r.isAnswered) {
        const text = clean(r.text, ev)
        if (text) {
          this.ready.set(ev.key, text)
          await this.io.write(`${this.project}/summaries/${ev.key}.json`, JSON.stringify({ text, model: settings.model, path: rel })).catch(() => undefined)
        } else this.failed.set(ev.key, 'empty reply')
      } else this.failed.set(ev.key, r.reason)
    } catch (err) {
      this.failed.set(ev.key, excerpt(String((err as Error)?.message ?? err), 60))
    } finally {
      this.pending.delete(ev.key)
      this.changed()
    }
  }

  forget() {
    this.ready.clear()
    this.failed.clear()
    this.lastGood.clear()
    this.evidenceCache.clear()
  }
}

function promptFor(rel: string, ev: Evidence): string {
  const content = (ev.content ?? '').split('\n').slice(0, 160).join('\n').slice(0, 6000)
  const parts = [`File: ${rel}`, `Content of the file as last captured (may be partial):\n<<<\n${content}\n>>>`]
  if (ev.changed && ev.diff) {
    parts.push(`Unified diff of the changes made in this task:\n<<<\n${ev.diff}\n>>>`)
    parts.push(
      'Write exactly two sentences, at most 45 words in total.\n' +
        'Sentence 1: what this file does, judged only from the content shown, without naming the file.\n' +
        'Sentence 2: start with "Claude" and say what changed, judged only from the diff.',
    )
  } else {
    parts.push('Write exactly one sentence, at most 25 words: what this file does, judged only from the content shown, without naming the file.')
  }
  return parts.join('\n\n')
}

function clean(raw: string, ev: Evidence): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!text) return ''
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [text]
  if (ev.changed && ev.diff) text = sentences.slice(0, 2).map(s => s.trim()).join(' ')
  else text = `${(sentences[0] ?? text).trim()} ${ev.activity}`
  return text.slice(0, 420)
}

// Turns recorded snapshots into diffs, and says plainly when a diff cannot be exact.

import { diffText, hunkStats, type Hunk } from './diff'
import type { OpEvent, Snap } from './model'
import { baseName, fmtBytes, pathKey } from './util'

export type DiffView =
  | { kind: 'diff'; hunks: Hunk[]; added: number; removed: number; source: 'snapshots' | 'tool'; caveats: string[] }
  | { kind: 'note'; text: string; tone: 'info' | 'warn' }

export type BlobReader = { get: (hash: string) => Promise<string | undefined> }

const CHANGES = new Set(['modify', 'create', 'delete', 'rename'])

const sizeOf = (s?: Snap) => (s?.size !== undefined ? fmtBytes(s.size) : 'unknown size')

function snapProblem(s: Snap | undefined, which: string): string | undefined {
  if (!s) return `The ${which} state was not captured.`
  if (!s.exists || s.blob) return undefined
  switch (s.reason) {
    case 'binary':
      return `Binary file (${which} ${sizeOf(s)}): contents are not diffed.`
    case 'sensitive':
      return `Contents not stored: the path looks like a credentials file (${which} ${sizeOf(s)}). Turn on “Store sensitive file contents” to keep them.`
    case 'oversized':
      return `File too large to store (${which} ${sizeOf(s)}): no exact diff kept.`
    case 'not-captured':
      return `The ${which} content was not captured (it was already modified and past the capture limit).`
    default:
      return `The ${which} content could not be read.`
  }
}

async function textOf(blobs: BlobReader, s: Snap): Promise<string | undefined> {
  if (!s.exists) return ''
  return s.blob ? blobs.get(s.blob) : undefined
}

async function between(blobs: BlobReader, before: Snap | undefined, after: Snap | undefined, patch: Hunk[] | undefined, caveats: string[]): Promise<DiffView> {
  const problem = snapProblem(before, 'pre-edit') ?? snapProblem(after, 'post-edit')
  if (!problem && before && after) {
    const [a, b] = await Promise.all([textOf(blobs, before), textOf(blobs, after)])
    if (a !== undefined && b !== undefined) {
      const d = diffText(a, b)
      if (d.kind === 'identical') return { kind: 'note', text: 'No content change: the file is identical before and after.', tone: 'info' }
      if (d.kind === 'ok' && d.eolOnly) return { kind: 'note', text: 'Only line endings or the final newline changed.', tone: 'info' }
      if (d.kind === 'ok') return { kind: 'diff', hunks: d.hunks, added: d.added, removed: d.removed, source: 'snapshots', caveats }
      if (patch?.length) return fromPatch(patch, [...caveats, `Full diff skipped (${d.reason}); showing the tool's own patch.`])
      return { kind: 'note', text: `Diff not computed: ${d.reason}.`, tone: 'warn' }
    }
  }
  if (patch?.length) return fromPatch(patch, [...caveats, `${problem ?? 'Snapshot unavailable.'} Showing the tool's own record of this edit, which is exact for this operation.`])
  return { kind: 'note', text: problem ?? 'No exact baseline was captured for this change, so no diff is shown.', tone: 'warn' }
}

function fromPatch(hunks: Hunk[], caveats: string[]): DiffView {
  const { added, removed } = hunkStats(hunks)
  return { kind: 'diff', hunks, added, removed, source: 'tool', caveats }
}

export async function opDiff(blobs: BlobReader, ev: OpEvent): Promise<DiffView> {
  if (ev.op === 'read') return { kind: 'note', text: `Read-only: ${ev.detail ?? 'file inspected'}. No changes made.`, tone: 'info' }
  if (ev.op === 'search')
    return { kind: 'note', text: `Search: ${ev.detail ?? ev.tool}. Matches are discoveries, not reads. No changes made.`, tone: 'info' }
  if (ev.status === 'active') return { kind: 'note', text: 'Running now; the diff appears when it finishes.', tone: 'info' }
  if (ev.status !== 'completed') return { kind: 'note', text: `Attempt ${ev.status}${ev.error ? `: ${ev.error}` : ''}. No change recorded.`, tone: 'warn' }
  const caveats: string[] = []
  if (ev.attribution === 'uncertain') caveats.push(ev.note ?? 'Detected change—attribution uncertain.')
  if (ev.toolPatchCut) caveats.push("The tool's patch was cut for storage.")
  if (ev.op === 'rename') {
    const from = ev.fromPath ? baseName(ev.fromPath) : 'its old path'
    const sameContent = ev.before?.hash !== undefined && ev.before.hash === ev.after?.hash
    if (sameContent) return { kind: 'note', text: `Renamed from ${from}; content unchanged.`, tone: 'info' }
    caveats.push(`Renamed from ${from}.`)
  }
  return between(blobs, ev.before, ev.after, ev.toolPatch, caveats)
}

/** Claude's net change to one file across a task: first pre-edit state to last post-edit state. */
export async function taskDiff(blobs: BlobReader, path: string, ops: readonly OpEvent[]): Promise<DiffView> {
  const k = pathKey(path)
  const chain = ops.filter(o => o.status === 'completed' && CHANGES.has(o.op) && pathKey(o.path) === k)
  if (!chain.length) return { kind: 'note', text: 'No changes to this file in this task.', tone: 'info' }
  const caveats: string[] = []
  const uncertain = chain.filter(o => o.attribution === 'uncertain').length
  if (uncertain) caveats.push(`Includes ${uncertain} change${uncertain === 1 ? '' : 's'} detected with uncertain attribution (shown in the operation history).`)
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1]!.after
    const b = chain[i]!.before
    if (a?.hash && b?.hash && (a.nhash ?? a.hash) !== (b.nhash ?? b.hash)) {
      caveats.push('The file changed between two recorded operations without a recorded cause; this span is not attributed to Claude.')
      break
    }
  }
  const first = chain[0]!
  const last = chain[chain.length - 1]!
  if (chain.length === 1) return opDiff(blobs, first)
  const view = await between(blobs, first.before, last.after, undefined, caveats)
  if (view.kind === 'note' && view.tone === 'warn')
    return { kind: 'note', text: `${view.text} The cumulative diff needs both ends stored; per-operation diffs may still be available.`, tone: 'warn' }
  return view
}

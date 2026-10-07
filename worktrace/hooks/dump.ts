// A plain-text rendering of the same view data the pane draws. Used by the developer
// inspection tool (WORKTRACE_DEV=1) and by tests; never shown to the model otherwise.

import { unified } from './diff'
import type { ViewData } from './data'
import { BADGE, OUTCOME, opBadge, type FileStat } from './model'
import type { SessionListing } from './store'
import { fmtDate, fmtTime, relTo } from './util'

const badges = (s: FileStat) => {
  const out: string[] = []
  const c = s.counts
  if (s.active) out.push('WORK')
  if (c.create) out.push(`NEW×${c.create}`)
  if (c.delete) out.push(`DEL×${c.delete}`)
  if (c.rename) out.push(`REN×${c.rename}`)
  if (c.modify) out.push(`MOD×${c.modify}`)
  if (s.uncertain) out.push(`CHG?×${s.uncertain}`)
  if (c.read) out.push(`READ×${c.read}`)
  if (c.search) out.push(`FIND×${c.search}`)
  if (s.found && !c.read) out.push(`HIT×${s.found}`)
  if (s.failed) out.push(`FAIL×${s.failed}`)
  if (s.denied) out.push(`DENY×${s.denied}`)
  if (s.interrupted) out.push(`INT×${s.interrupted}`)
  return out.join(' ')
}

export function dumpView(d: ViewData, root: string, sessions: SessionListing[], what: 'tree' | 'timeline' | 'detail' | 'history' | 'all'): string {
  const out: string[] = []
  out.push(`WorkTrace · ${d.sessionLabel} · task: ${d.taskLabel} · ${d.counts.ops} ops · ${d.counts.files} files · ${d.counts.changed} changed`)
  if (what === 'tree' || what === 'all') {
    out.push('', '[Tree]')
    for (const r of d.tree) {
      const pad = '  '.repeat(r.depth)
      if (r.kind === 'dir') out.push(`${pad}${r.expanded ? '▾' : '▸'} ${r.label}/  (${r.agg.files} files, ${r.agg.changed} changed${r.agg.active ? ', working' : ''})`)
      else out.push(`${pad}  ${r.label}  ${badges(r.stat)}`)
    }
    if (!d.tree.length) out.push('  (empty)')
  }
  if (what === 'timeline' || what === 'all') {
    out.push('', '[Timeline]')
    for (const r of d.timeline) {
      if (r.kind === 'task') out.push(`━━ ${r.ev.title} (${r.ops} ops)`)
      else if (r.kind === 'turn') out.push(`  ── ${fmtTime(r.ev.ts)} Turn ${r.ev.turn} “${r.ev.prompt}”`)
      else if (r.kind === 'cmd')
        out.push(`  ${fmtTime(r.ev.ts)} SH   ${OUTCOME[r.ev.status].glyph} ${r.ev.command}  [${r.ev.reconcile}, ${r.ev.changed} changes]`)
      else {
        const e = r.ev
        const stat = e.added !== undefined ? ` +${e.added} −${e.removed ?? 0}` : ''
        out.push(
          `  ${fmtTime(e.ts)} ${BADGE[opBadge(e)].short.padEnd(4)} ${OUTCOME[e.status].glyph} ${relTo(root, e.path) ?? e.path}  ${e.tool}${stat}${e.error ? `  (${e.error})` : ''}${e.attribution === 'uncertain' ? '  [attribution uncertain]' : ''}`,
        )
      }
    }
    if (!d.timeline.length) out.push('  (empty)')
  }
  if ((what === 'detail' || what === 'all') && d.detail) {
    out.push('', '[Detail]')
    const det = d.detail
    if (det.kind === 'file') {
      out.push(`${relTo(root, det.path) ?? det.path}  ${det.stat ? badges(det.stat) : ''}`)
      out.push(`Summary: ${det.summary.text}`, `  (${det.summary.label})`)
      out.push(`Operations (${det.ops.length}):`)
      for (const e of det.ops)
        out.push(`  ${det.selected?.id === e.id ? '›' : ' '} ${fmtTime(e.ts)} ${BADGE[opBadge(e)].short.padEnd(4)} ${OUTCOME[e.status].glyph} ${e.tool} ${e.detail ?? ''}${e.error ? ` — ${e.error}` : ''}`)
      if (det.diff?.kind === 'diff') {
        out.push(`Diff (+${det.diff.added} −${det.diff.removed}, ${det.diff.source}):`)
        for (const c of det.diff.caveats) out.push(`  ⚠ ${c}`)
        out.push(unified(det.diff.hunks, 80).text)
      } else if (det.diff) out.push(`Diff: ${det.diff.text}`)
    } else if (det.kind === 'dir') {
      out.push(`${det.path}/`, `Summary: ${det.summary}`)
      for (const f of det.files) out.push(`  ${relTo(det.path, f.path) ?? f.path}  ${badges(f)}`)
    } else {
      out.push(`$ ${det.ev.command}  ${OUTCOME[det.ev.status].label}  (${det.ev.reconcile})`)
      for (const f of det.files) out.push(`  ${BADGE[opBadge(f)].short} ${relTo(root, f.path) ?? f.path}`)
    }
  }
  if (what === 'history' || what === 'all') {
    out.push('', '[History]')
    for (const s of sessions)
      out.push(`  ${fmtDate(s.startedAt)} ${s.sessionId.slice(0, 8)}  ${s.events} events · ${s.files} files · tasks: ${s.tasks.map(t => t.title).join(' | ')}`)
    if (!sessions.length) out.push('  (none)')
  }
  return out.join('\n')
}

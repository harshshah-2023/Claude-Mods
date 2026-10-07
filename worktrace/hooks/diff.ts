// Exact line diff (Myers) into unified hunks, bounded so a huge file never stalls a hook.

export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export type DiffResult =
  | { kind: 'ok'; hunks: Hunk[]; added: number; removed: number; eolOnly: boolean }
  | { kind: 'identical' }
  | { kind: 'too-large'; reason: string }

export const MAX_DIFF_LINES = 60_000
export const MAX_EDIT_DISTANCE = 2_500

export function splitLines(s: string): string[] {
  if (s === '') return []
  const a = s.split('\n')
  if (a[a.length - 1] === '') a.pop()
  return a.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

type Step = { t: '=' | '-' | '+'; a: number; b: number }

/** The edit script between a and b, or null when the edit distance passes maxD. */
function myers(a: readonly string[], b: readonly string[], maxD: number): Step[] | null {
  const n = a.length
  const m = b.length
  let pre = 0
  while (pre < n && pre < m && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++
  const A = a.slice(pre, n - suf)
  const B = b.slice(pre, m - suf)
  const N = A.length
  const M = B.length
  const mid: Step[] = []
  if (N === 0) for (let j = 0; j < M; j++) mid.push({ t: '+', a: pre, b: pre + j })
  else if (M === 0) for (let i = 0; i < N; i++) mid.push({ t: '-', a: pre + i, b: pre })
  else {
    const max = N + M
    const off = max + 1
    const v = new Int32Array(2 * max + 3)
    v[off + 1] = 0
    const trace: Int32Array[] = []
    let found = -1
    for (let d = 0; d <= Math.min(max, maxD); d++) {
      trace.push(v.slice(off - d - 1, off + d + 2))
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1
        let y = x - k
        while (x < N && y < M && A[x] === B[y]) {
          x++
          y++
        }
        v[off + k] = x
        if (x >= N && y >= M) {
          found = d
          break
        }
      }
      if (found >= 0) break
    }
    if (found < 0) return null
    let x = N
    let y = M
    const back: Step[] = []
    for (let d = found; d >= 0; d--) {
      const t = trace[d]!
      const at = (k: number) => t[k + d + 1]!
      const k = x - y
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
      const prevX = d === 0 ? 0 : at(prevK)
      const prevY = d === 0 ? 0 : prevX - prevK
      while (x > prevX && y > prevY) {
        x--
        y--
        back.push({ t: '=', a: pre + x, b: pre + y })
      }
      if (d > 0) {
        if (x === prevX) back.push({ t: '+', a: pre + x, b: pre + y - 1 })
        else back.push({ t: '-', a: pre + x - 1, b: pre + y })
      }
      x = prevX
      y = prevY
    }
    back.reverse()
    mid.push(...back)
  }
  const steps: Step[] = []
  for (let i = 0; i < pre; i++) steps.push({ t: '=', a: i, b: i })
  steps.push(...mid)
  for (let i = 0; i < suf; i++) steps.push({ t: '=', a: n - suf + i, b: m - suf + i })
  return steps
}

export function diffText(before: string, after: string, context = 3): DiffResult {
  if (before === after) return { kind: 'identical' }
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length + b.length > MAX_DIFF_LINES) {
    return { kind: 'too-large', reason: `${a.length + b.length} lines is past the ${MAX_DIFF_LINES}-line diff limit` }
  }
  const steps = myers(a, b, MAX_EDIT_DISTANCE)
  if (!steps) return { kind: 'too-large', reason: `more than ${MAX_EDIT_DISTANCE} changed lines` }
  const hunks = toHunks(steps, a, b, context)
  let added = 0
  let removed = 0
  for (const s of steps) {
    if (s.t === '+') added++
    else if (s.t === '-') removed++
  }
  return { kind: 'ok', hunks, added, removed, eolOnly: hunks.length === 0 }
}

function toHunks(steps: Step[], a: readonly string[], b: readonly string[], ctx: number): Hunk[] {
  const changes: number[] = []
  steps.forEach((s, i) => {
    if (s.t !== '=') changes.push(i)
  })
  if (changes.length === 0) return []
  const ranges: [number, number][] = []
  let start = Math.max(0, changes[0]! - ctx)
  let end = Math.min(steps.length - 1, changes[0]! + ctx)
  for (const c of changes.slice(1)) {
    if (c - ctx <= end + 1) end = Math.min(steps.length - 1, c + ctx)
    else {
      ranges.push([start, end])
      start = Math.max(0, c - ctx)
      end = Math.min(steps.length - 1, c + ctx)
    }
  }
  ranges.push([start, end])
  return ranges.map(([s, e]) => {
    const part = steps.slice(s, e + 1)
    const lines = part.map(st => (st.t === '=' ? ' ' + a[st.a] : st.t === '-' ? '-' + a[st.a] : '+' + b[st.b]))
    const oldLines = part.filter(st => st.t !== '+').length
    const newLines = part.filter(st => st.t !== '-').length
    const first = part[0]!
    return {
      oldStart: oldLines === 0 ? first.a : first.a + 1,
      oldLines,
      newStart: newLines === 0 ? first.b : first.b + 1,
      newLines,
      lines,
    }
  })
}

export function hunkStats(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks)
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  return { added, removed }
}

/** Unified text of whole hunks up to `maxLines` lines; what is left out is counted. */
export function unified(hunks: readonly Hunk[], maxLines: number): { text: string; shown: number; omittedLines: number } {
  const out: string[] = []
  let used = 0
  let shown = 0
  let omitted = 0
  for (const h of hunks) {
    const cost = h.lines.length + 1
    if (shown > 0 && used + cost > maxLines) {
      omitted += h.lines.length
      continue
    }
    out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`)
    // A lone hunk longer than the budget is cut at a line; the cut is counted and its header stays honest.
    const room = shown === 0 ? Math.max(1, maxLines - 1) : h.lines.length
    const lines = h.lines.slice(0, room).map(l => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '?'))
    if (lines.length < h.lines.length) {
      omitted += h.lines.length - lines.length
      const o = lines.filter(l => !l.startsWith('+')).length
      const n = lines.filter(l => !l.startsWith('-')).length
      out[out.length - 1] = `@@ -${h.oldStart},${o} +${h.newStart},${n} @@`
    }
    out.push(...lines)
    used += lines.length + 1
    shown++
  }
  return { text: out.join('\n'), shown, omittedLines: omitted }
}

/** Bounds a tool-reported patch for storage. */
export function boundHunks(hunks: readonly Hunk[], maxLines: number): { hunks: Hunk[]; cut: boolean } {
  const out: Hunk[] = []
  let used = 0
  for (const h of hunks) {
    if (used + h.lines.length > maxLines) return { hunks: out, cut: true }
    out.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: [...h.lines] })
    used += h.lines.length
  }
  return { hunks: out, cut: false }
}

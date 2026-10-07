// Pure helpers: paths, hashing, redaction, sensitivity, text facts, time.

/** Forward slashes, `.`/`..` resolved, upper-case drive letter, no trailing slash. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, '/')
  const unc = s.startsWith('//')
  s = s.replace(/\/{2,}/g, '/')
  if (unc) s = '/' + s
  if (/^[a-zA-Z]:/.test(s)) s = s.charAt(0).toUpperCase() + s.slice(1)
  const parts = s.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..' && out.length > 1 && out[out.length - 1] !== '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  s = out.join('/')
  if (/^[A-Z]:$/.test(s)) s += '/'
  if (s.length > 1 && s.endsWith('/') && !/^[A-Z]:\/$/.test(s)) s = s.slice(0, -1)
  return s
}

export const isAbs = (p: string): boolean => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\')

export function resolvePath(base: string, p: string): string {
  return isAbs(p) ? normPath(p) : normPath(`${base}/${p}`)
}

/** Comparison key: Windows paths compare case-insensitively. */
export const pathKey = (p: string): string => (/^[A-Z]:\//.test(p) ? p.toLowerCase() : p)

export function isUnder(root: string, p: string): boolean {
  const r = pathKey(root)
  const k = pathKey(p)
  return k === r || k.startsWith(r.endsWith('/') ? r : r + '/')
}

/** Path relative to root ('' for the root itself), or null when outside. */
export function relTo(root: string, p: string): string | null {
  if (!isUnder(root, p)) return null
  const cut = root.endsWith('/') ? root.length : root.length + 1
  return p.length <= root.length ? '' : p.slice(cut)
}

export const baseName = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1) || p
}

export const dirName = (p: string): string => {
  const i = p.lastIndexOf('/')
  if (i < 0) return ''
  if (i === 0) return '/'
  const d = p.slice(0, i)
  return /^[A-Z]:$/.test(d) ? d + '/' : d
}

const enc = new TextEncoder()

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function randomId(len = 10): string {
  const bytes = new Uint8Array(len)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => (b % 36).toString(36)).join('')
}

export const byteLength = (s: string): number => enc.encode(s).length

const SENSITIVE_NAME = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^\.?(netrc|npmrc|pypirc|pgpass|git-credentials)$/i,
  /credential/i,
  /secret/i,
  /(^|[._-])token(s)?([._-]|$)/i,
  /password/i,
]
const SENSITIVE_DIR = /(^|\/)\.(ssh|aws|gnupg|azure|kube|docker)(\/|$)/i

/** Paths whose contents WorkTrace does not store by default. */
export function isSensitivePath(p: string): boolean {
  const name = baseName(p)
  return SENSITIVE_DIR.test(p) || SENSITIVE_NAME.some(re => re.test(name))
}

/** Masks values that look like credentials in a shell command or prompt excerpt. */
export function redact(text: string): string {
  return text
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(
      /\b([A-Za-z_]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd|auth(?:orization)?|credential)[A-Za-z_]*)(\s*[:=]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
      '$1$2***',
    )
    .replace(/\b(?:sk|pk|ghp|gho|xox[abp]|AKIA)[A-Za-z0-9_-]{12,}\b/g, '***')
    .replace(/\b[A-Fa-f0-9]{40,}\b|\b[A-Za-z0-9+/]{48,}={0,2}/g, '***')
}

export function excerpt(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : one.slice(0, max - 1) + '…'
}

export function isBinaryText(s: string): boolean {
  const head = s.slice(0, 8000)
  if (head.includes('\u0000')) return true
  let bad = 0
  for (const ch of head) if (ch === '�' && ++bad > 8) return true
  return false
}

export function lineCount(s: string): number {
  if (s === '') return 0
  const n = s.split('\n').length
  return s.endsWith('\n') ? n - 1 : n
}

const pad2 = (n: number) => String(n).padStart(2, '0')

export function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function fmtDate(ms: number): string {
  const d = new Date(ms)
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${months[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Cuts the middle of a string to fit `max` cells, keeping the file name end. */
export function middle(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max))
  if (s.length <= max) return s
  const keep = max - 1
  const tail = Math.ceil(keep * 0.6)
  return s.slice(0, keep - tail) + '…' + s.slice(s.length - tail)
}

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'root'
}

const LANG: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript React', js: 'JavaScript', jsx: 'JavaScript React', mjs: 'JavaScript', cjs: 'JavaScript',
  py: 'Python', rs: 'Rust', go: 'Go', java: 'Java', kt: 'Kotlin', cs: 'C#', cpp: 'C++', c: 'C', h: 'C header', rb: 'Ruby',
  php: 'PHP', swift: 'Swift', sql: 'SQL', md: 'Markdown', json: 'JSON', yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  html: 'HTML', css: 'CSS', scss: 'SCSS', sh: 'shell script', ps1: 'PowerShell script', txt: 'text', xml: 'XML',
  ini: 'INI', cfg: 'config', lock: 'lock', csv: 'CSV', ipynb: 'Jupyter notebook', vue: 'Vue', svelte: 'Svelte',
}

export function fileKind(p: string): string {
  const name = baseName(p)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  const lang = LANG[ext]
  if (lang) return `${lang} file`
  return ext ? `.${ext} file` : 'file'
}

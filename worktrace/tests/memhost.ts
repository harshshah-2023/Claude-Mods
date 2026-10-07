// An in-memory file system and git-less host for tests (MOCKED: nothing here touches disk).

import type { Host } from '../hooks/recorder'
import type { Io, IoEntry } from '../hooks/store'

export class MemFs {
  files = new Map<string, string>()
  writes = 0
  failWrites = false
  clock = 1_700_000_000_000

  io(): Io {
    return {
      read: async p => {
        const t = this.files.get(p)
        if (t === undefined) throw new Error(`ENOENT ${p}`)
        return t
      },
      write: async (p, text) => {
        if (this.failWrites) throw new Error('disk full')
        this.files.set(p, text)
        this.writes++
      },
      list: async p => {
        const out = new Map<string, IoEntry>()
        const prefix = p.endsWith('/') ? p : p + '/'
        for (const k of this.files.keys()) {
          if (!k.startsWith(prefix)) continue
          const rest = k.slice(prefix.length)
          const name = rest.split('/')[0]!
          out.set(name, { name, kind: rest.includes('/') ? 'dir' : 'file' })
        }
        return [...out.values()]
      },
      exists: async p => this.files.has(p) || [...this.files.keys()].some(k => k.startsWith(p + '/')),
      remove: async p => {
        for (const k of [...this.files.keys()]) if (k === p || k.startsWith(p + '/')) this.files.delete(k)
      },
    }
  }

  host(run?: Host['run']): Host {
    return {
      io: this.io(),
      readFile: async p => {
        const t = this.files.get(p)
        if (t === undefined) throw new Error(`ENOENT ${p}`)
        return t
      },
      stat: async p => {
        const t = this.files.get(p)
        if (t !== undefined) return { kind: 'file', size: new TextEncoder().encode(t).length }
        if ([...this.files.keys()].some(k => k.startsWith(p + '/'))) return { kind: 'dir', size: 0 }
        return null
      },
      run: run ?? (async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' })),
      now: async () => ++this.clock,
    }
  }
}

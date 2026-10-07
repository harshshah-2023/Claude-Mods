export type WorkTraceTab = 'tree' | 'timeline' | 'history' | 'graph'

export type WorkTraceUi = {
  tab: WorkTraceTab
  /** The selected tree node: a file or a folder, by absolute path. */
  sel?: { kind: 'file' | 'dir'; path: string }
  /** The selected operation (timeline row, or a row of the detail's history). */
  selEvent?: string
  /** Folder paths (comparison keys) the person collapsed; new folders open expanded. */
  collapsed: string[]
  follow: boolean
  /** The key of the first row shown in each tab's list window. */
  top: { tree?: string; timeline?: string; history?: string; graph?: string }
  /** The Graph tab's first drawing row shown; absent keeps the newest cards in view. */
  graphY?: number
  diffScope: 'op' | 'task'
  showOps: boolean
  showDiff: boolean
  showMatches: boolean
  /** The help panel explaining tabs, words and keys. */
  showHelp?: boolean
  /** 'current', 'all', or a task id. */
  taskId: string
  /** The session shown; absent for the live one. */
  sessionId?: string
  /** The History tab's highlighted session. */
  historySel?: string
}

declare module 'claude-code' {
  interface PluginState {
    worktrace: { ui: WorkTraceUi; rev: number; writer: string }
  }
}

export type Theme = 'dark' | 'acrylic'
export type AutostartState = 'unset' | 'enabled' | 'disabled'

export interface ByteMeta {
  encoding: 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk'
  hasBom: boolean
  eol: 'crlf' | 'lf'
  mixedEol: boolean
  trailingNewline: boolean
  hash: string
  size: number
  lineCount: number
}

export interface SaveResult {
  status: 'ok' | 'conflict' | 'error'
  diskHash: string | null
  meta: ByteMeta | null
  message: string | null
}

export interface Task {
  id: string
  index: number
  line: number
  depth: number
  checked: boolean
  text: string
}

export interface DisplayLine {
  id: string
  line: number
  depth: number
  /** 任务行可勾选；普通文本行仅展示。 */
  task: Task | null
  text: string
}

export interface TaskDocument {
  title: string | null
  tasks: Task[]
  /** 组件按文档顺序显示的内容行（任务 + 普通文本），已跳过空行与代码块。 */
  content: DisplayLine[]
  lines: string[]
  lineCount: number
}

export interface WindowPosition {
  x: number
  y: number
  monitorDevicePath?: string
}

export interface EditorWindowState {
  x: number
  y: number
  width: number
  height: number
  monitorDevicePath?: string
}

export interface Settings {
  schemaVersion: number
  theme: Theme
  fontSize: number
  width: number
  compact: number
  expanded: number
  hideCompleted: boolean
  locked: boolean
  autostart: AutostartState
  autostartAsked: boolean
  lastFile: string
  recentFiles: string[]
  windowPosition: WindowPosition | null
  editorWindow: EditorWindowState | null
  widgetVisible: boolean
  keepOnShowDesktop: boolean
}

export interface Snapshot {
  text: string
  path: string
  title: string | null
  tasks: Task[]
  content: DisplayLine[]
  settings: Settings
  meta?: ByteMeta | null
  readOnlyReason?: string | null
  /** 文件当前不存在（被移动/删除），不是空文件。 */
  missing?: boolean
  /** 读取失败但保留了缓存内容。 */
  readError?: string | null
}

export interface EditorState {
  text: string
  path: string
  settings: Settings
  dirty: boolean
  savedAt: number | null
  saveState: 'idle' | 'saving' | 'saved' | 'error' | 'conflict'
  error: string | null
}

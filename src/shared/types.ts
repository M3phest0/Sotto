export type Theme = 'dark' | 'acrylic'
export type AutostartState = 'unset' | 'enabled' | 'disabled'

export interface Task {
  id: string
  index: number
  line: number
  depth: number
  checked: boolean
  text: string
}

export interface TaskDocument {
  title: string | null
  tasks: Task[]
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
  settings: Settings
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

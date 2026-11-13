export interface Theme {
  bg: string
  text: string
  accent: string
}

export interface Settings {
  theme: Theme
  soundEnabled: boolean
  soundVolume: number
  soundPath: string | null
  hotkey: string
  autostart: boolean
  widgetWidth: number
  widgetHeight: number
  widgetX: number | null
  widgetY: number | null
  editorX: number | null
  editorY: number | null
  editorWidth: number | null
  editorHeight: number | null
}

export interface Task {
  id: string
  title: string
  ddl: string | null
  detail: string
  order: number
  createdAt: number
  completedAt: number | null
}

export interface Tomato {
  id: string
  taskId: string
  ts: number
}

export interface AppData {
  version: number
  tasks: Task[]
  tomatoes: Tomato[]
  settings: Settings
}

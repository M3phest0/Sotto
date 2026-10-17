import type { Snapshot, Settings, TaskDocument } from './types'
import { DEFAULT_SETTINGS, normalizeSettings } from './settings'
import { parseTaskDocument } from './taskParser'

export const DOCUMENT_KEY = 'sotto:document'
export const SETTINGS_KEY = 'sotto:settings'
export const ASKED_KEY = 'sotto:autostart-asked'
export const CHANNEL_NAME = 'sotto:sync'

export const SAMPLE_MARKDOWN = `# 今日待办

- [ ] 写周报
  - [ ] 收集数据
    1. [x] 核对预算
- [x] 买牛奶
- [ ] 看文档
- [ ] 整理桌面
- [ ] 回复邮件
- [ ] 规划下周
- [ ] 备份照片
- [ ] 给绿植浇水
`

export const MOCK_FILE_PATH = 'Documents/Sotto.md'

interface SyncMessage {
  type: 'document' | 'settings'
  text?: string
  settings?: Settings
}

const channel: BroadcastChannel | null =
  typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL_NAME) : null

function safeLocalStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function loadDocumentText(): string {
  const storage = safeLocalStorage()
  const value = storage?.getItem(DOCUMENT_KEY)
  return value && value.trim().length > 0 ? value : SAMPLE_MARKDOWN
}

export function saveDocumentText(text: string): void {
  const storage = safeLocalStorage()
  storage?.setItem(DOCUMENT_KEY, text)
  channel?.postMessage({ type: 'document', text } satisfies SyncMessage)
  window.dispatchEvent(new CustomEvent('sotto:changed'))
}

export function loadSettings(): Settings {
  const storage = safeLocalStorage()
  const raw = storage?.getItem(SETTINGS_KEY)
  if (!raw) {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      autostartAsked: storage?.getItem(ASKED_KEY) === '1',
    }
    return settings
  }
  try {
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  const storage = safeLocalStorage()
  storage?.setItem(SETTINGS_KEY, JSON.stringify(settings))
  channel?.postMessage({ type: 'settings', settings } satisfies SyncMessage)
  window.dispatchEvent(new CustomEvent('sotto:changed'))
}

export function markAsked(settings: Settings): Settings {
  const storage = safeLocalStorage()
  storage?.setItem(ASKED_KEY, '1')
  const next = normalizeSettings({ ...settings, autostartAsked: true })
  saveSettings(next)
  return next
}

export function loadSnapshot(): Snapshot {
  const text = loadDocumentText()
  const doc: TaskDocument = parseTaskDocument(text)
  const settings = loadSettings()
  return {
    text,
    path: MOCK_FILE_PATH,
    title: doc.title,
    tasks: doc.tasks,
    settings,
  }
}

export function subscribeToChanges(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === DOCUMENT_KEY || event.key === SETTINGS_KEY) callback()
  }
  const onCustom = () => callback()
  const onMessage = (event: MessageEvent<SyncMessage>) => {
    if (event.data?.type === 'document' || event.data?.type === 'settings') callback()
  }
  window.addEventListener('storage', onStorage)
  window.addEventListener('sotto:changed', onCustom)
  channel?.addEventListener('message', onMessage)
  return () => {
    window.removeEventListener('storage', onStorage)
    window.removeEventListener('sotto:changed', onCustom)
    channel?.removeEventListener('message', onMessage)
  }
}

export function openEditorWindow(): void {
  window.open('editor.html', 'sotto-editor', 'popup=yes,width=980,height=680')
}

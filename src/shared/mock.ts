import type { Snapshot, Settings, TaskDocument } from './types'
import { DEFAULT_SETTINGS, migrateSettings, normalizeSettings } from './settings'
import { parseTaskDocument } from './taskParser'

export const DOCUMENT_KEY = 'sotto:document'
export const SETTINGS_KEY = 'sotto:settings'
export const ASKED_KEY = 'sotto:autostart-asked'
export const CHANNEL_NAME = 'sotto:sync'
// 仅浏览器 mock 使用：模拟原生快照里的文件缺失/读取错误状态。
export const MOCK_MISSING_KEY = 'sotto:mock-missing'
export const MOCK_READ_ERROR_KEY = 'sotto:mock-read-error'

// M1 使用的键名；读取时迁移到 sotto:*，写回后删除旧键。
export const LEGACY_SETTINGS_KEY = 'todo-list:settings'
export const LEGACY_ASKED_KEY = 'todo-list:autostart-asked'

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
  // 键存在时保留空字符串，才能测试空文件状态；只有从未写入过才用示例。
  return value !== null && value !== undefined ? value : SAMPLE_MARKDOWN
}

export function saveDocumentText(text: string): void {
  const storage = safeLocalStorage()
  storage?.setItem(DOCUMENT_KEY, text)
  channel?.postMessage({ type: 'document', text } satisfies SyncMessage)
  window.dispatchEvent(new CustomEvent('sotto:changed'))
}

export function loadSettings(): Settings {
  const storage = safeLocalStorage()
  const legacyAsked = storage?.getItem(LEGACY_ASKED_KEY) === '1'
  const asked = storage?.getItem(ASKED_KEY) === '1' || legacyAsked
  let raw = storage?.getItem(SETTINGS_KEY)
  let fromLegacy = false
  if (!raw) {
    raw = storage?.getItem(LEGACY_SETTINGS_KEY) ?? null
    fromLegacy = raw !== null
  }
  if (!raw) {
    return {
      ...DEFAULT_SETTINGS,
      autostartAsked: asked,
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...DEFAULT_SETTINGS, autostartAsked: asked }
  }
  const result = migrateSettings(parsed)
  const settings = result.settings
  if (asked && !settings.autostartAsked) {
    settings.autostartAsked = true
  }
  if (fromLegacy || result.migrated) {
    storage?.setItem(SETTINGS_KEY, JSON.stringify(settings))
    if (fromLegacy) storage?.removeItem(LEGACY_SETTINGS_KEY)
  }
  if (asked) {
    storage?.setItem(ASKED_KEY, '1')
    if (legacyAsked) storage?.removeItem(LEGACY_ASKED_KEY)
  }
  return settings
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
  const storage = safeLocalStorage()
  return {
    text,
    path: MOCK_FILE_PATH,
    title: doc.title,
    tasks: doc.tasks,
    content: doc.content,
    settings,
    missing: storage?.getItem(MOCK_MISSING_KEY) === '1',
    readError: storage?.getItem(MOCK_READ_ERROR_KEY) || null,
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

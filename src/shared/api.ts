import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { isTauri } from './desktop'
import {
  loadSnapshot as loadMockSnapshot,
  openEditorWindow as openMockEditor,
  saveSettings as saveMockSettings,
  subscribeToChanges as subscribeMock,
} from './mock'
import { normalizeSettings } from './settings'
import { parseTaskDocument } from './taskParser'
import type { ByteMeta, SaveResult, Settings, Snapshot } from './types'

interface RawSnapshot {
  text: string
  path: string
  settings: unknown
  meta?: ByteMeta | null
  readOnlyReason?: string | null
  missing?: boolean
  readError?: string | null
}

function mapSnapshot(raw: RawSnapshot): Snapshot {
  const doc = parseTaskDocument(raw.text)
  return {
    text: raw.text,
    path: raw.path,
    title: doc.title,
    tasks: doc.tasks,
    content: doc.content,
    settings: normalizeSettings(raw.settings),
    meta: raw.meta ?? null,
    readOnlyReason: raw.readOnlyReason ?? null,
    missing: raw.missing ?? false,
    readError: raw.readError ?? null,
  }
}

export async function loadSnapshot(): Promise<Snapshot> {
  if (!isTauri()) return loadMockSnapshot()
  const raw = await invoke<RawSnapshot>('get_snapshot')
  return mapSnapshot(raw)
}

export async function openMarkdownFile(path: string): Promise<Snapshot> {
  if (!isTauri()) return loadMockSnapshot()
  const raw = await invoke<RawSnapshot>('open_markdown_file', { path })
  return mapSnapshot(raw)
}

export async function pickMarkdownFile(): Promise<Snapshot | null> {
  if (!isTauri()) return null
  const raw = await invoke<RawSnapshot | null>('pick_markdown_file')
  return raw ? mapSnapshot(raw) : null
}

export async function newMarkdownFile(): Promise<Snapshot | null> {
  if (!isTauri()) return null
  const raw = await invoke<RawSnapshot | null>('new_markdown_file')
  return raw ? mapSnapshot(raw) : null
}

export async function saveMarkdownAs(content: string): Promise<Snapshot | null> {
  if (!isTauri()) return null
  const raw = await invoke<RawSnapshot | null>('save_markdown_as', { content })
  return raw ? mapSnapshot(raw) : null
}

export async function saveSettings(settings: Settings): Promise<void> {
  if (!isTauri()) {
    saveMockSettings(settings)
    return
  }
  await invoke('save_settings', { settings })
}

export async function syncDraft(text: string, baseDiskHash: string): Promise<void> {
  if (!isTauri()) return
  await invoke('sync_draft', { text, baseDiskHash })
}

export async function clearDraft(): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_draft')
}

export async function saveMarkdown(
  baseDiskHash: string,
  revision: number,
  content: string,
): Promise<SaveResult> {
  if (!isTauri()) {
    return { status: 'ok', diskHash: null, meta: null, message: null }
  }
  return invoke<SaveResult>('save_markdown', { baseDiskHash, revision, content })
}

export async function backupCurrent(reason: 'interval' | 'editor-close'): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('backup_current', { reason })
}

export async function resizeWidgetWindow(width: number, height: number): Promise<void> {
  if (!isTauri()) return
  await invoke('resize_widget', { width, height })
}

export async function resetWidgetPosition(): Promise<void> {
  if (!isTauri()) return
  await invoke('reset_widget_position')
}

export async function openDataDir(): Promise<void> {
  if (!isTauri()) return
  await invoke('open_data_dir')
}

export async function openEditorWindow(): Promise<void> {
  if (!isTauri()) {
    openMockEditor()
    return
  }
  await invoke('open_editor')
}

export interface AutostartStatus {
  registered: boolean
  disabledBySystem: boolean
  command: string | null
}

const MOCK_AUTOSTART: AutostartStatus = {
  registered: false,
  disabledBySystem: false,
  command: null,
}

export async function getAutostartStatus(): Promise<AutostartStatus> {
  if (!isTauri()) return MOCK_AUTOSTART
  return invoke<AutostartStatus>('get_autostart_status')
}

export async function applyAutostart(enabled: boolean): Promise<AutostartStatus> {
  if (!isTauri()) return { ...MOCK_AUTOSTART, registered: enabled }
  return invoke<AutostartStatus>('apply_autostart', { enabled })
}

export async function quitApp(): Promise<void> {
  if (!isTauri()) return
  await invoke('quit_app')
}

export function subscribeToChanges(callback: () => void): () => void {
  if (!isTauri()) return subscribeMock(callback)
  let disposed = false
  let unlisten: UnlistenFn | undefined
  void listen('file-changed', () => callback()).then((fn) => {
    if (disposed) fn()
    else unlisten = fn
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}

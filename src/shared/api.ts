import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { AppData, BackupEntry, Settings, Task } from './types'

export const getData = () => invoke<AppData>('get_data')

export const addTask = (title: string, ddl: string | null) =>
  invoke<Task>('add_task', { title, ddl })

export const saveTask = (task: Task) => invoke<void>('save_task', { task })

export const deleteTask = (id: string) => invoke<void>('delete_task', { id })

export const deleteTasks = (ids: string[]) => invoke<void>('delete_tasks', { ids })

export const setDone = (id: string, done: boolean) =>
  invoke<void>('set_done', { id, done })

export const addTomato = (taskId: string) =>
  invoke('add_tomato', { taskId })

export const undoTomato = (taskId: string) =>
  invoke<boolean>('undo_tomato', { taskId })

export const saveSettings = (settings: Settings) =>
  invoke<void>('save_settings', { settings })

export const setWidgetSize = (width: number, height: number) =>
  invoke<void>('set_widget_size', { width, height })

export const setHotkey = (hotkey: string) => invoke<void>('set_hotkey', { hotkey })

export const openEditor = (taskId?: string) =>
  invoke<void>('open_editor', { taskId: taskId ?? null })

export const hideEditor = () => invoke<void>('hide_editor')

export const setAutostart = (enabled: boolean) =>
  invoke<boolean>('set_autostart', { enabled })

export const openDataDir = () => invoke<void>('open_data_dir').catch(() => {})

export const exportData = () => invoke<string | null>('export_data')

export const importData = () => invoke<boolean>('import_data')

export const listBackups = () => invoke<BackupEntry[]>('list_backups')

export const restoreBackup = (name: string) => invoke<void>('restore_backup', { name })

export const getStartupWarning = () => invoke<string | null>('get_startup_warning')

export const pickSoundFile = () => invoke<string | null>('pick_sound_file')

export const quitApp = () => invoke<void>('quit_app')

export const onStateChanged = (cb: () => void) => listen('state-changed', cb)

export const onFocusTask = (cb: (taskId: string) => void) =>
  listen<string>('focus-task', (event) => cb(event.payload))

export const onOpenView = (cb: (view: string) => void) =>
  listen<string>('open-view', (event) => cb(event.payload))

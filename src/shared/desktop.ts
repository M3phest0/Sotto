import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Theme } from './types'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function setupDesktopLayer(theme: Theme): Promise<void> {
  if (!isTauri()) return
  const win = getCurrentWindow()
  await Promise.allSettled([
    invoke('set_desktop_layer'),
    win.setFocusable(false),
    invoke('set_acrylic', { enabled: theme === 'acrylic' }),
  ])
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauri()) return
  try {
    await getCurrentWindow().startDragging()
  } catch {
    // P0 已验证拖动可用；失败时记录并为 Win32 兜底。
  }
}

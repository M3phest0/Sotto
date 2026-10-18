import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { Theme } from './types'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function setupDesktopLayer(theme: Theme): Promise<void> {
  if (!isTauri()) return
  const win = getCurrentWindow()
  // setFocusable 会按 tao 缓存的窗口标志重写扩展样式，可能把
  // set_desktop_layer 写入的 WS_EX_TOOLWINDOW 冲掉；先取消焦点再入层。
  await win.setFocusable(false)
  await Promise.allSettled([
    invoke('set_desktop_layer'),
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

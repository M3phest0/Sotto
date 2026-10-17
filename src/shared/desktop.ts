import { getCurrentWindow } from '@tauri-apps/api/window'

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function setupDesktopLayer(): Promise<void> {
  if (!isTauri()) return
  const win = getCurrentWindow()
  await Promise.allSettled([win.setAlwaysOnBottom(true), win.setFocusable(false)])
}

export async function startWindowDrag(): Promise<void> {
  if (!isTauri()) return
  try {
    await getCurrentWindow().startDragging()
  } catch {
    // P0 会验证；失败时由设计页记录并为 Win32 兜底。
  }
}

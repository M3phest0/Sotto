import { convertFileSrc } from '@tauri-apps/api/core'
import type { Settings } from './types'

let current: HTMLAudioElement | null = null

export function playTomato(settings: Settings) {
  if (!settings.soundEnabled) return
  const src = settings.soundPath
    ? convertFileSrc(settings.soundPath)
    : '/sound/tomato.wav'
  try {
    current?.pause()
    current = new Audio(src)
    current.volume = Math.min(1, Math.max(0, settings.soundVolume))
    void current.play().catch(() => {})
  } catch {
    // 音频播放失败不影响贴番茄。
  }
}

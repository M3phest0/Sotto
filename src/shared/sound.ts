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

/** 完成任务的两声轻快提示音；用 WebAudio 合成，不依赖音频文件。 */
export function playComplete(settings: Settings) {
  if (!settings.soundEnabled) return
  try {
    const ctx = new AudioContext()
    const master = ctx.createGain()
    master.gain.value = Math.min(1, Math.max(0, settings.soundVolume)) * 0.7
    master.connect(ctx.destination)
    const now = ctx.currentTime
    const notes = [
      { freq: 1046.5, at: 0, dur: 0.28 },
      { freq: 1568, at: 0.11, dur: 0.34 },
    ]
    for (const note of notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = note.freq
      gain.gain.setValueAtTime(0.0001, now + note.at)
      gain.gain.exponentialRampToValueAtTime(0.5, now + note.at + 0.015)
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.dur)
      osc.connect(gain)
      gain.connect(master)
      osc.start(now + note.at)
      osc.stop(now + note.at + note.dur + 0.02)
    }
    window.setTimeout(() => void ctx.close(), 900)
  } catch {
    // 音效失败不影响任务完成。
  }
}

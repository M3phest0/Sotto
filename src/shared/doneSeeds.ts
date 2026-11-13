import type { CSSProperties } from 'react'

export type DoneSeed = { dx: number; dy: number; size: number; delay: number }

/** 完成任务的绿色粒子，从勾选圈向右上散开。 */
export function makeDoneSeeds(seed: number): DoneSeed[] {
  let state = Math.abs(Math.floor(seed * 1000)) % 2147483647
  if (state === 0) state = 1
  const next = () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
  return Array.from({ length: 8 }, () => ({
    dx: 8 + next() * 56,
    dy: -34 + next() * 52,
    size: 3 + next() * 3.5,
    delay: next() * 60,
  }))
}

export function doneSeedStyle(seed: DoneSeed): CSSProperties {
  return {
    '--dx': `${seed.dx}px`,
    '--dy': `${seed.dy}px`,
    '--size': `${seed.size}px`,
    '--delay': `${seed.delay}ms`,
  } as CSSProperties
}

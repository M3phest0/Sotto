import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settings'

describe('normalizeSettings', () => {
  it('returns sane defaults', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS)
  })

  it('clamps numeric ranges and keeps expanded >= compact', () => {
    const settings = normalizeSettings({
      fontSize: 99,
      width: 100,
      compact: 10,
      expanded: 5,
    })
    expect(settings.fontSize).toBe(20)
    expect(settings.width).toBe(300)
    expect(settings.compact).toBe(10)
    expect(settings.expanded).toBe(10)
  })

  it('normalizes autostart, theme and asked state', () => {
    const settings = normalizeSettings({
      theme: 'unknown',
      autostart: 'enabled',
      autostartAsked: true,
      recentFiles: ['a.md', 'a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md'],
    })
    expect(settings.theme).toBe('dark')
    expect(settings.autostart).toBe('enabled')
    expect(settings.recentFiles).toEqual(['a.md', 'b.md', 'c.md', 'd.md', 'e.md'])
  })

  it('migrates an unasked invalid autostart to unset', () => {
    const settings = normalizeSettings({ autostart: 'nope', autostartAsked: false })
    expect(settings.autostart).toBe('unset')
  })

  it('drops invalid window objects and keeps valid ones', () => {
    expect(normalizeSettings({ windowPosition: { x: 'x' } }).windowPosition).toBeNull()
    expect(normalizeSettings({ windowPosition: { x: 10, y: 20 } }).windowPosition).toEqual({
      x: 10,
      y: 20,
      monitorDevicePath: undefined,
    })
    expect(
      normalizeSettings({ editorWindow: { x: 1, y: 2, width: 10, height: 10 } }).editorWindow,
    ).toEqual({ x: 1, y: 2, width: 760, height: 520, monitorDevicePath: undefined })
  })
})

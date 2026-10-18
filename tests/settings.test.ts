import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  migrateSettings,
  normalizeSettings,
} from '../src/shared/settings'

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

  it('migrates legacy v0 field names and stamps the schema version', () => {
    const result = migrateSettings({
      lastOpenedFile: 'Notes/todo.md',
      position: { x: 12, y: 34 },
      recent: ['a.md', 'a.md', 'b.md'],
      theme: 'acrylic',
    })
    expect(result.fromVersion).toBe(0)
    expect(result.migrated).toBe(true)
    expect(result.settings.schemaVersion).toBe(SCHEMA_VERSION)
    expect(result.settings.lastFile).toBe('Notes/todo.md')
    expect(result.settings.windowPosition).toEqual({ x: 12, y: 34, monitorDevicePath: undefined })
    expect(result.settings.recentFiles).toEqual(['a.md', 'b.md'])
    expect(result.settings.theme).toBe('acrylic')
  })

  it('keeps current settings untouched and reports unknown fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = migrateSettings({
        schemaVersion: SCHEMA_VERSION,
        theme: 'dark',
        fontSize: 16,
        futureFlag: true,
      })
      expect(result.migrated).toBe(false)
      expect(result.fromVersion).toBe(SCHEMA_VERSION)
      expect(result.settings.fontSize).toBe(16)
      expect(result.warnings.some((line) => line.includes('futureFlag'))).toBe(true)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('reads newer schemas without dropping valid fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = migrateSettings({ schemaVersion: SCHEMA_VERSION + 3, width: 420 })
      expect(result.settings.width).toBe(420)
      expect(result.settings.schemaVersion).toBe(SCHEMA_VERSION)
      expect(result.warnings.some((line) => line.includes('更高版本'))).toBe(true)
    } finally {
      warn.mockRestore()
    }
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

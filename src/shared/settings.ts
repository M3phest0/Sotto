import type { Settings, WindowPosition, EditorWindowState, Theme, AutostartState } from './types'

export const SCHEMA_VERSION = 1

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  theme: 'dark',
  fontSize: 14,
  width: 360,
  compact: 5,
  expanded: 15,
  hideCompleted: false,
  locked: false,
  autostart: 'unset',
  autostartAsked: false,
  lastFile: 'Documents/Sotto.md',
  recentFiles: [],
  windowPosition: null,
  editorWindow: null,
  widgetVisible: true,
  keepOnShowDesktop: false,
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(max, Math.max(min, n))
}

function asTheme(value: unknown): Theme {
  return value === 'acrylic' ? 'acrylic' : 'dark'
}

function asAutostart(value: unknown, asked: boolean): AutostartState {
  if (value === 'enabled' || value === 'disabled' || value === 'unset') return value
  return asked ? 'disabled' : 'unset'
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asWindowPosition(value: unknown): WindowPosition | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.x !== 'number' || typeof v.y !== 'number') return null
  return {
    x: Math.round(v.x),
    y: Math.round(v.y),
    monitorDevicePath: typeof v.monitorDevicePath === 'string' ? v.monitorDevicePath : undefined,
  }
}

function asEditorWindow(value: unknown): EditorWindowState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.x !== 'number' || typeof v.y !== 'number') return null
  return {
    x: Math.round(v.x),
    y: Math.round(v.y),
    width: clampInt(v.width, 960, 760, 2000),
    height: clampInt(v.height, 640, 520, 1600),
    monitorDevicePath: typeof v.monitorDevicePath === 'string' ? v.monitorDevicePath : undefined,
  }
}

function asRecentFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0) continue
    if (seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length === 5) break
  }
  return out
}

export function normalizeSettings(input: unknown): Settings {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const autostartAsked = asBool(raw.autostartAsked, false)
  const compact = clampInt(raw.compact, DEFAULT_SETTINGS.compact, 3, 10)
  const expanded = Math.max(compact, clampInt(raw.expanded, DEFAULT_SETTINGS.expanded, 5, 30))
  return {
    schemaVersion: SCHEMA_VERSION,
    theme: asTheme(raw.theme),
    fontSize: clampInt(raw.fontSize, DEFAULT_SETTINGS.fontSize, 12, 20),
    width: clampInt(raw.width, DEFAULT_SETTINGS.width, 300, 480),
    compact,
    expanded,
    hideCompleted: asBool(raw.hideCompleted, DEFAULT_SETTINGS.hideCompleted),
    locked: asBool(raw.locked, DEFAULT_SETTINGS.locked),
    autostart: asAutostart(raw.autostart, autostartAsked),
    autostartAsked,
    lastFile: asString(raw.lastFile, DEFAULT_SETTINGS.lastFile),
    recentFiles: asRecentFiles(raw.recentFiles),
    windowPosition: asWindowPosition(raw.windowPosition),
    editorWindow: asEditorWindow(raw.editorWindow),
    widgetVisible: asBool(raw.widgetVisible, DEFAULT_SETTINGS.widgetVisible),
    keepOnShowDesktop: asBool(raw.keepOnShowDesktop, DEFAULT_SETTINGS.keepOnShowDesktop),
  }
}

export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  return normalizeSettings({ ...current, ...patch })
}

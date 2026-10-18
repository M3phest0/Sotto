import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type KeyboardEvent,
} from 'react'
import { CloseIcon } from '../shared/icons'
import { MarkdownInline } from '../shared/MarkdownInline'
import { renderFullMarkdown } from '../shared/markdown'
import { getProgress, listContinuation, parseTaskDocument, taskSubtree, toggleTaskAtLine } from '../shared/taskParser'
import type { Settings, Snapshot, TaskDocument } from '../shared/types'
import {
  loadSnapshot as loadMockSnapshot,
  saveDocumentText,
} from '../shared/mock'
import {
  applyAutostart,
  backupCurrent,
  clearDraft,
  getAutostartStatus,
  loadSnapshot as loadBackendSnapshot,
  newMarkdownFile,
  openDataDir,
  openMarkdownFile,
  pickMarkdownFile,
  quitApp,
  resetWidgetPosition,
  saveMarkdown,
  saveMarkdownAs,
  saveSettings,
  subscribeToChanges,
  syncDraft,
} from '../shared/api'
import { listen } from '@tauri-apps/api/event'
import { isTauri } from '../shared/desktop'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings'
import './editor.css'

type Tab = 'edit' | 'settings'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type PreviewMode = 'tasks' | 'full'

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(md|markdown)$/i, '') || 'Sotto'
}


function statusLabel(state: SaveState): string {
  if (state === 'saving') return '保存中'
  if (state === 'saved') return '已保存'
  if (state === 'error') return '保存失败'
  return '未修改'
}

type PendingSwitch =
  | { kind: 'picker' }
  | { kind: 'new' }
  | { kind: 'path'; path: string }
  | { kind: 'text'; text: string; path: string }

export function EditorApp() {
  const useBackend = isTauri()
  const initial = useMemo(() => (useBackend ? null : loadMockSnapshot()), [useBackend])
  const [text, setText] = useState(initial?.text ?? '')
  const [path, setPath] = useState(initial?.path ?? 'Documents/Sotto.md')
  const [settings, setSettings] = useState<Settings>(initial?.settings ?? DEFAULT_SETTINGS)
  const [booting, setBooting] = useState(useBackend)
  const [tab, setTab] = useState<Tab>('edit')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('tasks')
  const [revision, setRevision] = useState(0)
  const [renderedRevision, setRenderedRevision] = useState(0)
  const [preview, setPreview] = useState<TaskDocument>(() => parseTaskDocument(initial?.text ?? ''))
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [pendingSwitch, setPendingSwitch] = useState<PendingSwitch | null>(null)
  const [showReloadConfirm, setShowReloadConfirm] = useState(false)
  const [conflictHash, setConflictHash] = useState<string | null>(null)
  const conflictHashRef = useRef<string | null>(null)
  const [readOnlyReason, setReadOnlyReason] = useState<string | null>(initial?.readOnlyReason ?? null)
  const [missing, setMissing] = useState(initial?.missing ?? false)
  const [readError, setReadError] = useState<string | null>(initial?.readError ?? null)
  const missingRef = useRef(initial?.missing ?? false)
  const autosaveTimerRef = useRef<number | null>(null)
  const [compositionTick, setCompositionTick] = useState(0)
  const [autostartNote, setAutostartNote] = useState<string | null>(null)
  const [editorNonce, setEditorNonce] = useState(0)
  const revisionRef = useRef(0)
  const baseHashRef = useRef(initial?.meta?.hash ?? '')
  const savingRef = useRef(false)
  const pendingRef = useRef(false)
  const blockedRef = useRef(false)
  const saveErrorRef = useRef(false)
  const dirtyRef = useRef(false)
  const cascadeUndoRef = useRef<{ before: string; after: string } | null>(null)
  const composingRef = useRef(false)
  const exitAfterCloseRef = useRef(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const largeFile = text.length > 512 * 1024 || text.split('\n').length > 2000
  const progress = getProgress(preview.tasks)
  const recentFiles = settings.recentFiles

  function bumpRevision(): number {
    revisionRef.current += 1
    setRevision(revisionRef.current)
    return revisionRef.current
  }

  function commitPreview(nextText: string, revisionNumber: number): void {
    setPreview(parseTaskDocument(nextText))
    setRenderedRevision(revisionNumber)
  }

  function markChanged(nextText: string, immediatePreview = false): void {
    setText(nextText)
    const rev = bumpRevision()
    setDirty(true)
    setSaveState('saving')
    if (immediatePreview) commitPreview(nextText, rev)
  }

  function applySnapshot(next: Snapshot): void {
    setText(next.text)
    setPath(next.path)
    setSettings(next.settings)
    setPreview(parseTaskDocument(next.text))
    revisionRef.current = 0
    setRevision(0)
    setRenderedRevision(0)
    baseHashRef.current = next.meta?.hash ?? ''
    setDirty(false)
    setSaveState('idle')
    setLastSavedAt(null)
    setEditorNonce((value) => value + 1)
    blockedRef.current = false
    savingRef.current = false
    pendingRef.current = false
    saveErrorRef.current = false
    setConflictHash(null)
    setMissing(next.missing ?? false)
    setReadError(next.readError ?? null)
    missingRef.current = next.missing ?? false
    // 切换文件后默认回到任务视图，避免大文件延续全文预览造成卡顿。
    setPreviewMode('tasks')
    const oversize = next.meta && (next.meta.size > 1_048_576 || next.meta.lineCount > 5000)
      ? '文件超过 1MB 或 5000 行；只读展示，请拆分文件'
      : null
    const readOnly = next.readOnlyReason ?? oversize ?? null
    setReadOnlyReason(readOnly)
    if (next.missing) {
      setNotice('文件不存在，请重新选择文件；当前草稿仍保留在编辑器中')
    } else if (readOnly) {
      setNotice(readOnly)
    } else if (next.readError) {
      setNotice(next.readError)
    } else if (next.meta?.mixedEol) {
      const label = next.meta.eol === 'crlf' ? 'CRLF' : 'LF'
      setNotice(`检测到混合换行；保存时将统一为 ${label}`)
      console.info('sotto: mixed EOL, save will normalize to', next.meta.eol)
    }
  }

  function pickFile(): void {
    // 原生选择器会立即切换后端当前文件；有草稿时先确认，再打开选择器。
    if (dirtyRef.current || conflictHashRef.current) {
      setPendingSwitch({ kind: 'picker' })
      return
    }
    openPicker()
  }

  function rememberFile(next: Snapshot): void {
    const updated = normalizeSettings({
      ...next.settings,
      lastFile: next.path,
      recentFiles: [next.path, ...next.settings.recentFiles.filter((item) => item !== next.path)].slice(0, 5),
    })
    setSettings(updated)
    void saveSettings(updated)
  }

  function openPicker(): void {
    if (!useBackend) {
      fileInputRef.current?.click()
      return
    }
    void (async () => {
      try {
        const next = await pickMarkdownFile()
        if (!next) return
        applySnapshot(next)
        rememberFile(next)
        setNotice(`已加载 ${next.path}`)
      } catch (err) {
        setNotice(String(err))
      }
    })()
  }

  function requestNewFile(): void {
    if (dirtyRef.current || conflictHashRef.current) {
      setPendingSwitch({ kind: 'new' })
      return
    }
    openNewFile()
  }

  function openNewFile(): void {
    if (!useBackend) {
      setNotice('浏览器预览不支持新建文件；请在 Windows 构建中使用')
      return
    }
    void (async () => {
      try {
        const next = await newMarkdownFile()
        if (!next) return
        applySnapshot(next)
        rememberFile(next)
        setNotice(`已新建 ${next.path}`)
      } catch (err) {
        setNotice(String(err))
      }
    })()
  }

  function requestOpenPath(path: string): void {
    if (!path) return
    if (dirtyRef.current || conflictHashRef.current) {
      setPendingSwitch({ kind: 'path', path })
      return
    }
    loadPath(path)
  }

  function loadPath(path: string): void {
    if (!useBackend) {
      setNotice('浏览器预览只能通过文件输入框打开文件')
      return
    }
    void (async () => {
      try {
        const next = await openMarkdownFile(path)
        applySnapshot(next)
        rememberFile(next)
        setNotice(`已加载 ${next.path}`)
      } catch (err) {
        // 最近文件可能已被移动/删除：失败后从列表移除，避免反复点同一个坏路径。
        const updated = normalizeSettings({
          ...settings,
          recentFiles: settings.recentFiles.filter((item) => item !== path),
        })
        setSettings(updated)
        void saveSettings(updated)
        setNotice(`无法打开 ${path}：${String(err)}`)
      }
    })()
  }

  function saveAsNow(): void {
    if (!useBackend) {
      setNotice('浏览器预览不支持另存为；请在 Windows 构建中使用')
      return
    }
    const content = textareaRef.current?.value ?? text
    void (async () => {
      try {
        const next = await saveMarkdownAs(content)
        if (!next) return
        applySnapshot(next)
        rememberFile(next)
        setNotice(`已另存为 ${next.path}`)
      } catch (err) {
        setNotice(String(err))
      }
    })()
  }

  useEffect(() => {
    if (!useBackend) return
    let active = true
    void loadBackendSnapshot()
      .then((next) => {
        if (!active) return
        applySnapshot(next)
        setBooting(false)
      })
      .catch((err) => {
        if (!active) return
        setBooting(false)
        setSaveState('error')
        setNotice(String(err))
      })
    return () => {
      active = false
    }
  }, [useBackend])

  useEffect(() => {
    if (composingRef.current) return
    const timer = window.setTimeout(() => {
      commitPreview(text, revision)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [text, revision])

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  useEffect(() => {
    conflictHashRef.current = conflictHash
  }, [conflictHash])

  useEffect(() => {
    if (!useBackend) return
    const unsubscribe = subscribeToChanges(() => {
      void (async () => {
        try {
          const next = await loadBackendSnapshot()
          const diskHash = next.meta?.hash ?? ''
          if (!diskHash || diskHash === baseHashRef.current) return
          if (dirtyRef.current) {
            blockedRef.current = true
            setConflictHash(diskHash)
            setSaveState('error')
            setNotice('磁盘文件已被外部修改，当前草稿未覆盖')
          } else {
            applySnapshot(next)
            setNotice('已从磁盘同步')
          }
        } catch {
          // 文件暂时不可读时保留当前内容，下一次保存会走冲突检测。
        }
      })()
    })
    return unsubscribe
  }, [useBackend])

  useEffect(() => {
    if (!useBackend) return
    const timer = window.setInterval(() => {
      void backupCurrent('interval')
    }, 5 * 60 * 1000)
    return () => window.clearInterval(timer)
  }, [useBackend])

  // 标题栏 X / Alt+F4 也走同一套未保存确认；requestClose 只读 ref，无需重建监听。
  useEffect(() => {
    if (!useBackend) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWindow()
      .onCloseRequested((event) => {
        event.preventDefault()
        requestClose()
      })
      .then((fn) => {
        if (disposed) fn()
        else unlisten = fn
      })
    return () => {
      disposed = true
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useBackend])

  // 托盘“退出”：有未保存修改时先走确认，确认后由 finishClose 退出整个应用。
  useEffect(() => {
    if (!useBackend) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen('exit-requested', () => {
      exitAfterCloseRef.current = true
      requestClose()
    }).then((fn) => {
      if (disposed) fn()
      else unlisten = fn
    })
    return () => {
      disposed = true
      unlisten?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useBackend])

  useEffect(() => {
    if (!useBackend) return
    let active = true
    void getAutostartStatus()
      .then((status) => {
        if (!active) return
        if (status.disabledBySystem) {
          setAutostartNote('Windows 已禁用该自启项，请到“启动应用”中手动启用')
        } else if (settings.autostart === 'enabled' && !status.registered) {
          setAutostartNote('自启项未注册，将在下次启动时重新写入')
        } else {
          setAutostartNote(null)
        }
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [useBackend, settings.autostart])

  useEffect(() => {
    if (!dirty || composingRef.current || blockedRef.current || readOnlyReason || missing) return
    const timer = window.setTimeout(() => {
      // 定时器触发时可能刚好进入输入法组合，回调里再确认一次。
      if (!composingRef.current) void persistNow()
    }, 1000)
    autosaveTimerRef.current = timer
    return () => {
      window.clearTimeout(timer)
      if (autosaveTimerRef.current === timer) autosaveTimerRef.current = null
    }
  }, [dirty, text, readOnlyReason, missing, compositionTick])

  useEffect(() => {
    if (!useBackend || !dirty || readOnlyReason || missing) return
    const timer = window.setTimeout(() => {
      if (!composingRef.current) {
        void syncDraft(text, baseHashRef.current).catch(() => {})
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [text, dirty, useBackend, readOnlyReason, missing, compositionTick])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  async function persistNow(): Promise<boolean> {
    if (blockedRef.current) return false
    // 输入法组合期间不保存：否则会把拼音中间态写入磁盘。
    if (composingRef.current) return false
    if (missingRef.current) {
      setNotice('文件不存在，请重新选择文件；当前草稿仍保留')
      return false
    }
    if (readOnlyReason) {
      setNotice(readOnlyReason)
      return false
    }
    if (savingRef.current) {
      pendingRef.current = true
      return false
    }
    const content = textareaRef.current?.value ?? text
    const revisionAtSave = revisionRef.current
    savingRef.current = true
    setSaveState('saving')
    try {
      if (!useBackend) {
        saveDocumentText(content)
      } else {
        const result = await saveMarkdown(baseHashRef.current, revisionAtSave, content)
        if (result.status === 'conflict') {
          blockedRef.current = true
          saveErrorRef.current = true
          setConflictHash(result.diskHash)
          setSaveState('error')
          setNotice(result.message ?? '磁盘文件已变化；未覆盖')
          return false
        }
        if (result.status === 'error') {
          saveErrorRef.current = true
          setSaveState('error')
          setNotice(result.message ?? '保存失败')
          return false
        }
        baseHashRef.current = result.diskHash ?? ''
      }
      setLastSavedAt(Date.now())
      void clearDraft()
      if (revisionRef.current === revisionAtSave) {
        setDirty(false)
        setConflictHash(null)
        setSaveState('saved')
      } else {
        pendingRef.current = true
        setSaveState('saving')
      }
      saveErrorRef.current = false
      return true
    } catch (err) {
      saveErrorRef.current = true
      setSaveState('error')
      setNotice(String(err))
      return false
    } finally {
      savingRef.current = false
      // 无论在途保存期间排队的请求是否还有新内容，都要清掉 pending，
      // 否则 revision 未变化时 waitForSaveIdle 会一直等到超时。
      if (pendingRef.current) {
        pendingRef.current = false
        if (revisionRef.current !== revisionAtSave) void persistNow()
      }
    }
  }

  /** 等待在途保存和 pending 队列落定；超时返回 false。 */
  function waitForSaveIdle(timeoutMs = 5000): Promise<boolean> {
    const started = Date.now()
    return new Promise((resolve) => {
      const tick = () => {
        if (!savingRef.current && !pendingRef.current) {
          resolve(true)
          return
        }
        if (Date.now() - started >= timeoutMs) {
          resolve(false)
          return
        }
        window.setTimeout(tick, 50)
      }
      tick()
    })
  }

  async function finishClose(): Promise<void> {
    setShowCloseConfirm(false)
    if (useBackend) {
      try {
        await backupCurrent('editor-close')
      } catch {
        // 备份失败不阻塞关闭；下次启动仍可从未备份的磁盘内容读取。
      }
      try {
        await clearDraft()
      } catch {
        // 清理失败时后端会话结束会看到旧草稿；下次保存会覆盖它。
      }
      if (exitAfterCloseRef.current) {
        await quitApp()
        return
      }
      await getCurrentWindow().destroy()
      return
    }
    window.close()
  }

  function requestClose(): void {
    if (savingRef.current) {
      setNotice('保存中，请稍候')
      return
    }
    if (dirtyRef.current || conflictHashRef.current) {
      setShowCloseConfirm(true)
      return
    }
    void finishClose()
  }

  async function closeAfterSave(): Promise<void> {
    await persistNow()
    const settled = await waitForSaveIdle()
    if (!settled) {
      setNotice('保存超时，请重试或选择放弃')
      return
    }
    if (blockedRef.current || conflictHashRef.current) return
    if (readOnlyReason) {
      setNotice(readOnlyReason)
      return
    }
    // 保存失败时不要关窗：用户已经选择“保存”，关掉就等同于静默丢弃。
    if (saveErrorRef.current) {
      setSaveState('error')
      setNotice('保存失败，窗口未关闭；请重试或选择放弃')
      return
    }
    await finishClose()
  }

  function closeWithoutSave(): void {
    void finishClose()
  }

  function saveNow(): void {
    void persistNow()
  }

  function handleInput(event: ChangeEvent<HTMLTextAreaElement>): void {
    cascadeUndoRef.current = null
    markChanged(event.currentTarget.value)
  }

  function handleCompositionStart(): void {
    composingRef.current = true
    cascadeUndoRef.current = null
    // 取消已经排队的自动保存；组合结束时会重新排队。
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
  }

  function handleCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void {
    composingRef.current = false
    markChanged(event.currentTarget.value)
    // dirty 可能本来就是 true，单靠 effect 依赖不会重新触发，用 tick 强制排队。
    setCompositionTick((value) => value + 1)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    // setRangeText 一次替换整棵树在某些 WebView2 版本中不会进入原生撤销栈；
    // 级联勾选单独记一笔，Ctrl+Z 时原样还原整棵树。
    if (
      (event.ctrlKey || event.metaKey) &&
      event.key.toLowerCase() === 'z' &&
      !event.shiftKey
    ) {
      const undo = cascadeUndoRef.current
      const el = event.currentTarget
      if (undo && el.value === undo.after) {
        event.preventDefault()
        el.setRangeText(undo.before, 0, el.value.length, 'preserve')
        cascadeUndoRef.current = null
        markChanged(el.value, true)
        return
      }
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      if (event.shiftKey) {
        // 反缩进选区覆盖的每一行，而不是只处理光标所在行。
        const lineStart = el.value.lastIndexOf('\n', start - 1) + 1
        let blockEnd = end
        if (blockEnd > start && el.value[blockEnd - 1] === '\n') blockEnd -= 1
        const block = el.value.slice(lineStart, blockEnd)
        let cursor = lineStart
        let removedBeforeStart = 0
        let removedBeforeEnd = 0
        let changed = false
        const nextBlock = block
          .split('\n')
          .map((line) => {
            const remove = Math.min(4, line.match(/^ {1,4}/)?.[0].length ?? 0)
            if (remove > 0) changed = true
            if (cursor < start) removedBeforeStart += remove
            if (cursor < end) removedBeforeEnd += remove
            cursor += line.length + 1
            return line.slice(remove)
          })
          .join('\n')
        if (changed) {
          el.setRangeText(nextBlock, lineStart, blockEnd, 'preserve')
          el.selectionStart = Math.max(lineStart, start - removedBeforeStart)
          el.selectionEnd = Math.max(lineStart, end - removedBeforeEnd)
          markChanged(el.value)
        }
      } else if (start === end) {
        el.setRangeText('    ', start, end, 'end')
        markChanged(el.value)
      } else {
        // 有选区时按行缩进，不能用空格替换选中的文字。
        const lineStart = el.value.lastIndexOf('\n', start - 1) + 1
        const blockEnd = end > lineStart && el.value[end - 1] === '\n' ? end - 1 : end
        const block = el.value.slice(lineStart, blockEnd)
        const indented = block.replace(/^/gm, '    ')
        el.setRangeText(indented, lineStart, blockEnd, 'select')
        markChanged(el.value)
      }
      return
    }
    if (
      event.key === 'Enter' &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing &&
      !composingRef.current
    ) {
      const el = event.currentTarget
      if (el.selectionStart === el.selectionEnd) {
        const caret = el.selectionStart
        const lineStart = el.value.lastIndexOf('\n', caret - 1) + 1
        const lineEnd = el.value.indexOf('\n', caret)
        const line = el.value.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
        const next = listContinuation(line)
        if (next && caret - lineStart >= next.contentStart) {
          event.preventDefault()
          el.setRangeText(`\n${next.insert}`, caret, caret, 'end')
          markChanged(el.value)
        }
      }
      return
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      saveNow()
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      const el = event.currentTarget
      if (el.value !== text) markChanged(el.value)
    }
  }

  function togglePreviewTask(index: number, checked: boolean): void {
    if (composingRef.current) return
    const oldTask = preview.tasks.find((item) => item.index === index)
    // 输入后预览还没刷新时，直接按当前草稿解析，避免吞掉第一次点击。
    const currentPreview = renderedRevision === revision ? preview : parseTaskDocument(text)
    if (renderedRevision !== revision) {
      setPreview(currentPreview)
      setRenderedRevision(revision)
    }
    // 按旧索引对应的源行定位任务，避免输入导致 index 变化时点错。
    const task = currentPreview.tasks.find((item) => item.line === oldTask?.line)
      ?? currentPreview.tasks.find((item) => item.index === index)
    const el = textareaRef.current
    if (!task || !el) return
    const source = el.value
    let nextSource = source
    for (const target of taskSubtree(currentPreview.tasks, task.id)) {
      nextSource = toggleTaskAtLine(nextSource, target.line, checked)
    }
    if (nextSource === source) return
    const start = el.selectionStart
    const end = el.selectionEnd
    el.focus()
    // 整段替换只生成一个原生撤销步骤，Ctrl+Z 可一次还原父项和全部子项。
    el.setRangeText(nextSource, 0, source.length, 'preserve')
    el.setSelectionRange(Math.min(start, nextSource.length), Math.min(end, nextSource.length))
    cascadeUndoRef.current = { before: source, after: nextSource }
    markChanged(el.value, true)
  }

  function updateSettings(patch: Partial<Settings>, markAsked = false): void {
    const next = normalizeSettings({ ...settings, ...patch, autostartAsked: markAsked ? true : settings.autostartAsked })
    setSettings(next)
    void saveSettings(next)
  }

  async function updateAutostart(value: Settings['autostart']): Promise<void> {
    if (value === 'enabled') {
      try {
        const status = await applyAutostart(true)
        if (!status.registered) {
          setAutostartNote(
            status.disabledBySystem
              ? 'Windows 已禁用该自启项，请到“启动应用”中手动启用'
              : '自启注册失败，未标记为启用',
          )
          updateSettings({ autostart: 'disabled' }, true)
          return
        }
        setAutostartNote(null)
        updateSettings({ autostart: 'enabled' }, true)
      } catch (err) {
        setAutostartNote(`自启注册失败：${String(err)}`)
        updateSettings({ autostart: 'disabled' }, true)
      }
      return
    }
    try {
      await applyAutostart(false)
    } catch (err) {
      setAutostartNote(`删除自启项失败：${String(err)}`)
    }
    updateSettings({ autostart: value }, true)
  }

  function applyTextSwitch(nextText: string, nextPath: string): void {
    setText(nextText)
    setPath(nextPath)
    revisionRef.current += 1
    setRevision(revisionRef.current)
    setPreview(parseTaskDocument(nextText))
    setRenderedRevision(revisionRef.current)
    setEditorNonce((value) => value + 1)
    setDirty(false)
    setMissing(false)
    setReadError(null)
    missingRef.current = false
    setPreviewMode('tasks')
    const oversize = nextText.length > 1_048_576 || nextText.split('\n').length > 5000
    setReadOnlyReason(oversize ? '文件超过 1MB 或 5000 行；只读展示，请拆分文件' : null)
    setSaveState('saved')
    saveDocumentText(nextText)
    const next = normalizeSettings({
      ...settings,
      lastFile: nextPath,
      recentFiles: [nextPath, ...settings.recentFiles.filter((item) => item !== nextPath)].slice(0, 5),
    })
    setSettings(next)
    saveSettings(next)
    setNotice(`已加载 ${nextPath}`)
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>): void {
    if (useBackend) {
      event.currentTarget.value = ''
      setNotice('Windows 原生文件选择器将在 M2 后半段接入')
      return
    }
    const file = event.currentTarget.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const nextText = typeof reader.result === 'string' ? reader.result : ''
      if (dirtyRef.current || conflictHashRef.current) {
        setPendingSwitch({ kind: 'text', text: nextText, path: file.name })
        return
      }
      applyTextSwitch(nextText, file.name)
    }
    reader.readAsText(file, 'utf-8')
    event.currentTarget.value = ''
  }

  async function confirmSwitch(saveFirst: boolean): Promise<void> {
    const target = pendingSwitch
    if (!target) return
    if (saveFirst) {
      await persistNow()
      const settled = await waitForSaveIdle()
      if (!settled) {
        setNotice('保存超时，请重试或选择放弃')
        return
      }
      if (blockedRef.current || conflictHashRef.current) return
      if (readOnlyReason) {
        setNotice(readOnlyReason)
        return
      }
      if (saveErrorRef.current) {
        setSaveState('error')
        setNotice('保存失败，未切换文件')
        return
      }
    }
    setPendingSwitch(null)
    if (target.kind === 'picker') openPicker()
    else if (target.kind === 'new') openNewFile()
    else if (target.kind === 'path') loadPath(target.path)
    else applyTextSwitch(target.text, target.path)
  }

  function reloadFromDisk(): void {
    if (dirtyRef.current || conflictHashRef.current) {
      setShowReloadConfirm(true)
      return
    }
    void doReloadFromDisk()
  }

  async function doReloadFromDisk(): Promise<void> {
    try {
      const next = await loadBackendSnapshot()
      applySnapshot(next)
      blockedRef.current = false
      setConflictHash(null)
      setNotice('已重新加载磁盘文件')
    } catch (err) {
      setNotice(String(err))
    }
  }

  async function overwriteDisk(): Promise<void> {
    if (!conflictHash) return
    blockedRef.current = false
    baseHashRef.current = conflictHash
    setConflictHash(null)
    await persistNow()
  }

  const fullHtml = useMemo(
    () => (previewMode === 'full' ? renderFullMarkdown(text) : ''),
    [previewMode, text],
  )

  return (
    <div className="editor-shell">
      <header className="editor-topbar">
        <div className="editor-file">
          <span className="editor-kicker">Markdown</span>
          <span className="editor-path" title={path}>
            {path}
          </span>
        </div>
        <div className="editor-actions">
          <button className="editor-button" type="button" title="新建 Markdown 文件" onClick={requestNewFile}>
            新建
          </button>
          <button className="editor-button" type="button" title="另存为 Markdown 文件" onClick={saveAsNow}>
            另存为
          </button>
          <button
            className="editor-button"
            type="button"
            title="选择 Markdown 文件"
            onClick={() => void pickFile()}
          >
            选择文件
          </button>
          <select
            className="editor-select recent-select"
            value=""
            onChange={(event) => {
              const selected = event.currentTarget.value
              if (selected) requestOpenPath(selected)
            }}
            aria-label="最近文件"
          >
            <option value="">最近文件</option>
            {recentFiles.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
          <button
            className="editor-button primary"
            type="button"
            onClick={saveNow}
            disabled={Boolean(readOnlyReason) || missing}
            title={missing ? '文件不存在，请重新选择文件' : (readOnlyReason ?? '保存')}
          >
            保存
          </button>
          <button className="editor-icon-button" type="button" aria-label="关闭编辑窗口" title="关闭" onClick={requestClose}>
            <CloseIcon size={16} />
          </button>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".md,.markdown,text/markdown"
          hidden
          onChange={handleFile}
        />
      </header>

      {missing ? (
        <div className="editor-missing" role="alert">
          <span>文件不存在（可能被移动或删除）· 当前草稿仍保留</span>
          <button type="button" className="primary" onClick={() => pickFile()}>
            重新选择文件
          </button>
        </div>
      ) : readError ? (
        <div className="editor-missing" role="alert" title={readError}>
          <span>无法读取文件 · 当前显示的是缓存内容</span>
          <button type="button" onClick={() => void doReloadFromDisk()}>
            重试读取
          </button>
        </div>
      ) : null}

      {readOnlyReason ? (
        <div className="editor-readonly" role="status">
          {readOnlyReason}
        </div>
      ) : null}

      {conflictHash ? (
        <div className="editor-conflict" role="alert">
          <span>磁盘文件已被外部修改，当前草稿未覆盖。</span>
          <button type="button" onClick={() => void reloadFromDisk()}>重新加载</button>
          <button type="button" className="primary" onClick={() => void overwriteDisk()}>覆盖保存</button>
        </div>
      ) : null}

      <nav className="editor-tabs" aria-label="编辑与设置">
        <button
          className={tab === 'edit' ? 'is-active' : ''}
          type="button"
          onClick={() => setTab('edit')}
        >
          编辑
        </button>
        <button
          className={tab === 'settings' ? 'is-active' : ''}
          type="button"
          onClick={() => setTab('settings')}
        >
          设置
        </button>
        <div className="editor-tab-spacer" />
        <span className="editor-count">
          {progress.completed}/{progress.total} 完成 · {preview.tasks.length} 条任务
        </span>
      </nav>

      {tab === 'edit' ? (
        <main className="editor-main">
          <section className="editor-source-pane">
            <div className="pane-label">
              <span>源码</span>
              <span>{largeFile ? '大文件 · 默认任务视图' : 'Markdown'}</span>
            </div>
            <textarea
              key={`${path}-${editorNonce}`}
              ref={textareaRef}
              className="editor-textarea"
              defaultValue={text}
              disabled={booting}
              spellCheck={false}
              onChange={handleInput}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              aria-label="Markdown 源码"
            />
          </section>

          <section className="editor-preview-pane">
            <div className="pane-label preview-label">
              <div className="preview-tabs">
                <button
                  className={previewMode === 'tasks' ? 'is-active' : ''}
                  type="button"
                  onClick={() => setPreviewMode('tasks')}
                >
                  任务
                </button>
                <button
                  className={previewMode === 'full' ? 'is-active' : ''}
                  type="button"
                  onClick={() => setPreviewMode('full')}
                >
                  完整预览
                </button>
              </div>
              {previewMode === 'full' ? <span className="pane-note">只读</span> : null}
            </div>
            {previewMode === 'tasks' ? (
              <div className="editor-task-preview" data-testid="editor-task-preview">
                {preview.tasks.length === 0 ? (
                  <div className="editor-empty">还没有任务。在上方源码里输入 `- [ ] 任务`。</div>
                ) : (
                  preview.tasks.map((task) => (
                    <label
                      className={`editor-task-row ${task.checked ? 'is-done' : ''}`}
                      key={task.id}
                      style={{ paddingLeft: `${Math.min(task.depth, 3) * 18 + 6}px` }}
                    >
                      <input
                        type="checkbox"
                        checked={task.checked}
                        data-task-index={task.index}
                        onChange={(event) => togglePreviewTask(task.index, event.currentTarget.checked)}
                      />
                      <span className="editor-task-text">
                        <MarkdownInline text={task.text} />
                      </span>
                    </label>
                  ))
                )}
              </div>
            ) : (
              <div
                className="editor-full-preview markdown-body"
                dangerouslySetInnerHTML={{ __html: fullHtml }}
                data-testid="editor-full-preview"
              />
            )}
            {largeFile ? (
              <div className="editor-large-note">
                文件超过 512KB 或 2000 行，默认使用任务视图；完整预览为只读，建议拆分文件。
              </div>
            ) : null}
          </section>
        </main>
      ) : (
        <main className="editor-settings">
          <div className="settings-grid">
            <label className="setting-field">
              <span>主题</span>
              <select
                value={settings.theme}
                onChange={(event) => updateSettings({ theme: event.currentTarget.value as Settings['theme'] })}
              >
                <option value="dark">深色模式</option>
                <option value="acrylic">亚克力模糊</option>
              </select>
            </label>
            <label className="setting-field">
              <span>字号</span>
              <input
                type="number"
                min={12}
                max={20}
                value={settings.fontSize}
                onChange={(event) => updateSettings({ fontSize: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="setting-field">
              <span>宽度（px）</span>
              <input
                type="number"
                min={300}
                max={480}
                value={settings.width}
                onChange={(event) => updateSettings({ width: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="setting-field">
              <span>紧凑条数</span>
              <input
                type="number"
                min={3}
                max={10}
                value={settings.compact}
                onChange={(event) => updateSettings({ compact: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="setting-field">
              <span>展开条数</span>
              <input
                type="number"
                min={5}
                max={30}
                value={settings.expanded}
                onChange={(event) => updateSettings({ expanded: Number(event.currentTarget.value) })}
              />
            </label>
            <label className="setting-field checkbox-field">
              <span>隐藏已完成</span>
              <input
                type="checkbox"
                checked={settings.hideCompleted}
                onChange={(event) => updateSettings({ hideCompleted: event.currentTarget.checked })}
              />
            </label>
            <label className="setting-field checkbox-field">
              <span>锁定位置</span>
              <input
                type="checkbox"
                checked={settings.locked}
                onChange={(event) => updateSettings({ locked: event.currentTarget.checked })}
              />
            </label>
            <label className="setting-field">
              <span>开机自启</span>
              <select
                value={settings.autostart}
                onChange={(event) =>
                  void updateAutostart(event.currentTarget.value as Settings['autostart'])
                }
              >
                <option value="unset">未设置</option>
                <option value="enabled">启用</option>
                <option value="disabled">暂不启用</option>
              </select>
              {autostartNote ? <span className="setting-note">{autostartNote}</span> : null}
            </label>
          </div>

          <div className="settings-actions">
            <button
              className="editor-button"
              type="button"
              onClick={() => {
                void openDataDir()
                  .then(() => setNotice('已打开数据目录'))
                  .catch((err) => setNotice(`打开数据目录失败：${String(err)}`))
              }}
            >
              打开数据目录
            </button>
            <button
              className="editor-button"
              type="button"
              onClick={() => {
                updateSettings({ windowPosition: null })
                void resetWidgetPosition()
                  .then(() => setNotice('组件已移到主屏右下角'))
                  .catch((err) => setNotice(`重置位置失败：${String(err)}`))
              }}
            >
              重置位置
            </button>
          </div>

          <div className="shortcut-help">
            <div className="pane-label">快捷键</div>
            <p><code>Ctrl+S</code> 保存 · <code>Ctrl+Z</code> / <code>Ctrl+Y</code> 撤销/重做 · <code>Tab</code> 插入 4 空格 · <code>Shift+Tab</code> 反缩进</p>
            <p className="muted">快捷键固定，不提供自定义。</p>
          </div>
          <div className="settings-hint">
            最近文件：{recentFiles.length > 0 ? recentFiles.join(' · ') : '暂无'}
          </div>
        </main>
      )}

      <footer className="editor-statusbar">
        <span className={`save-state state-${saveState}`} data-testid="save-state">
          {statusLabel(saveState)}
        </span>
        {saveState === 'error' && !conflictHash ? (
          <button className="status-retry" type="button" onClick={() => void persistNow()}>
            重试
          </button>
        ) : null}
        <span>{lastSavedAt ? `上次保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}` : dirty ? '尚未保存' : '已加载'}</span>
        {preview.title === null ? (
          <span className="editor-title-hint" title="第一个 # 标题会作为组件标题；没有时使用文件名">
            未找到 # 标题 · 组件显示文件名
          </span>
        ) : null}
        <span className="status-spacer" />
        <span>{fileStem(path)} · {text.length.toLocaleString('zh-CN')} 字符</span>
      </footer>

      {notice ? <div className="editor-toast">{notice}</div> : null}

      {showCloseConfirm ? (
        <div className="editor-modal-backdrop">
          <div className="editor-modal" role="dialog" aria-modal="true" aria-label="关闭编辑窗口">
            <div className="modal-title">还有未保存修改</div>
            <p className="modal-copy">
              {readOnlyReason ? '文件为只读，无法保存。可以放弃修改或取消。' : '保存后关闭，或放弃本次修改。'}
            </p>
            <div className="modal-actions">
              <button className="danger-button" type="button" onClick={closeWithoutSave}>
                {readOnlyReason ? '关闭' : '放弃'}
              </button>
              <button
                className="editor-button"
                type="button"
                onClick={() => {
                  exitAfterCloseRef.current = false
                  setShowCloseConfirm(false)
                }}
              >
                取消
              </button>
              {readOnlyReason ? null : (
                <button className="editor-button primary" type="button" onClick={() => void closeAfterSave()}>
                  保存并关闭
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {pendingSwitch ? (
        <div className="editor-modal-backdrop">
          <div className="editor-modal" role="dialog" aria-modal="true" aria-label="切换文件">
            <div className="modal-title">当前文件有未保存修改</div>
            <p className="modal-copy">
              {pendingSwitch.kind === 'picker'
                ? '选择新文件前，请先保存或放弃当前修改。'
                : '加载新文件会替换当前内容，请先保存或放弃本次修改。'}
            </p>
            <div className="modal-actions">
              <button className="danger-button" type="button" onClick={() => void confirmSwitch(false)}>
                {pendingSwitch.kind === 'picker' ? '放弃并选择' : '放弃并切换'}
              </button>
              <button className="editor-button" type="button" onClick={() => setPendingSwitch(null)}>
                取消
              </button>
              <button className="editor-button primary" type="button" onClick={() => void confirmSwitch(true)}>
                {pendingSwitch.kind === 'picker' ? '保存并选择' : '保存并切换'}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showReloadConfirm ? (
        <div className="editor-modal-backdrop">
          <div className="editor-modal" role="dialog" aria-modal="true" aria-label="重新加载">
            <div className="modal-title">重新加载会丢弃当前草稿</div>
            <p className="modal-copy">磁盘上的版本会替换编辑器中的内容，未保存的修改无法恢复。</p>
            <div className="modal-actions">
              <button
                className="danger-button"
                type="button"
                onClick={() => {
                  setShowReloadConfirm(false)
                  void doReloadFromDisk()
                }}
              >
                放弃并重新加载
              </button>
              <button className="editor-button" type="button" onClick={() => setShowReloadConfirm(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

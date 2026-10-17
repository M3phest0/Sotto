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
import { getProgress, parseTaskDocument } from '../shared/taskParser'
import type { Settings, TaskDocument } from '../shared/types'
import {
  loadSnapshot,
  saveDocumentText,
  saveSettings,
} from '../shared/mock'
import { normalizeSettings } from '../shared/settings'
import './editor.css'

type Tab = 'edit' | 'settings'
type SaveState = 'idle' | 'saving' | 'saved' | 'error'
type PreviewMode = 'tasks' | 'full'

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(md|markdown)$/i, '') || 'Sotto'
}

function lineOffset(source: string, line: number): number {
  const lines = source.split('\n')
  let offset = 0
  for (let i = 0; i < line; i += 1) offset += lines[i].length + 1
  return offset
}

function statusLabel(state: SaveState): string {
  if (state === 'saving') return '保存中'
  if (state === 'saved') return '已保存'
  if (state === 'error') return '保存失败'
  return '未修改'
}

export function EditorApp() {
  const initial = useMemo(() => loadSnapshot(), [])
  const [text, setText] = useState(initial.text)
  const [path, setPath] = useState(initial.path)
  const [settings, setSettings] = useState<Settings>(initial.settings)
  const [tab, setTab] = useState<Tab>('edit')
  const [previewMode, setPreviewMode] = useState<PreviewMode>('tasks')
  const [revision, setRevision] = useState(0)
  const [renderedRevision, setRenderedRevision] = useState(0)
  const [preview, setPreview] = useState<TaskDocument>(() => parseTaskDocument(initial.text))
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [showCloseConfirm, setShowCloseConfirm] = useState(false)
  const [editorNonce, setEditorNonce] = useState(0)
  const revisionRef = useRef(0)
  const composingRef = useRef(false)
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

  useEffect(() => {
    if (composingRef.current) return
    const timer = window.setTimeout(() => {
      commitPreview(text, revision)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [text, revision])

  useEffect(() => {
    if (!dirty || composingRef.current) return
    const timer = window.setTimeout(() => {
      try {
        saveDocumentText(text)
        setDirty(false)
        setSaveState('saved')
        setLastSavedAt(Date.now())
      } catch {
        setSaveState('error')
      }
    }, 1000)
    return () => window.clearTimeout(timer)
  }, [dirty, text])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), 2400)
    return () => window.clearTimeout(timer)
  }, [notice])

  function saveNow(): void {
    try {
      saveDocumentText(text)
      setDirty(false)
      setSaveState('saved')
      setLastSavedAt(Date.now())
    } catch {
      setSaveState('error')
    }
  }

  function handleInput(event: ChangeEvent<HTMLTextAreaElement>): void {
    markChanged(event.currentTarget.value)
  }

  function handleCompositionStart(): void {
    composingRef.current = true
  }

  function handleCompositionEnd(event: CompositionEvent<HTMLTextAreaElement>): void {
    composingRef.current = false
    markChanged(event.currentTarget.value)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Tab') {
      event.preventDefault()
      const el = event.currentTarget
      const start = el.selectionStart
      const end = el.selectionEnd
      if (event.shiftKey) {
        const before = el.value.slice(0, start)
        const lineStart = before.lastIndexOf('\n') + 1
        const segment = el.value.slice(lineStart, start)
        const remove = Math.min(4, segment.match(/^ {1,4}/)?.[0].length ?? 0)
        if (remove > 0) {
          el.setRangeText('', lineStart, lineStart + remove, 'preserve')
          markChanged(el.value)
        }
      } else {
        el.setRangeText('    ', start, end, 'end')
        markChanged(el.value)
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
    if (renderedRevision !== revision) {
      commitPreview(text, revision)
      setNotice('预览已刷新，请再点一次')
      return
    }
    const task = preview.tasks.find((item) => item.index === index)
    const el = textareaRef.current
    if (!task || !el) return
    const source = el.value
    const offset = lineOffset(source, task.line)
    const rest = source.slice(offset)
    const nextNewline = rest.indexOf('\n')
    const lineText = nextNewline === -1 ? rest : rest.slice(0, nextNewline)
    const checkboxMatch = /\[[ xX]\]/.exec(lineText)
    if (!checkboxMatch) return
    const checkboxOffset = offset + (checkboxMatch.index ?? 0)
    el.focus()
    el.setRangeText(checked ? '[x]' : '[ ]', checkboxOffset, checkboxOffset + 3, 'end')
    markChanged(el.value, true)
  }

  function updateSettings(patch: Partial<Settings>, markAsked = false): void {
    const next = normalizeSettings({ ...settings, ...patch, autostartAsked: markAsked ? true : settings.autostartAsked })
    setSettings(next)
    saveSettings(next)
  }

  function handleFile(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const nextText = typeof reader.result === 'string' ? reader.result : ''
      const nextPath = file.name
      setText(nextText)
      setPath(nextPath)
      revisionRef.current += 1
      setRevision(revisionRef.current)
      setPreview(parseTaskDocument(nextText))
      setRenderedRevision(revisionRef.current)
      setEditorNonce((value) => value + 1)
      setDirty(false)
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
    reader.readAsText(file, 'utf-8')
    event.currentTarget.value = ''
  }

  function requestClose(): void {
    if (dirty) {
      setShowCloseConfirm(true)
      return
    }
    window.close()
  }

  function closeAfterSave(): void {
    saveNow()
    setShowCloseConfirm(false)
    window.setTimeout(() => window.close(), 30)
  }

  function closeWithoutSave(): void {
    setShowCloseConfirm(false)
    window.close()
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
          <button className="editor-button" type="button" onClick={() => fileInputRef.current?.click()}>
            选择文件
          </button>
          <select
            className="editor-select recent-select"
            value=""
            onChange={(event) => {
              const selected = event.currentTarget.value
              if (selected) setNotice(`最近文件：${selected}（请在 Windows 构建后从磁盘加载）`)
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
          <button className="editor-button primary" type="button" onClick={saveNow}>
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
                  updateSettings({ autostart: event.currentTarget.value as Settings['autostart'] }, true)
                }
              >
                <option value="unset">未设置</option>
                <option value="enabled">启用</option>
                <option value="disabled">暂不启用</option>
              </select>
            </label>
          </div>

          <div className="settings-actions">
            <button className="editor-button" type="button" onClick={() => setNotice('Windows 构建后会打开 LocalAppData 数据目录')}>
              打开数据目录
            </button>
            <button
              className="editor-button"
              type="button"
              onClick={() => {
                updateSettings({ windowPosition: null })
                setNotice('位置已重置')
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
        <span>{lastSavedAt ? `上次保存 ${new Date(lastSavedAt).toLocaleTimeString('zh-CN')}` : dirty ? '尚未保存' : '已加载'}</span>
        <span className="status-spacer" />
        <span>{fileStem(path)} · {text.length.toLocaleString('zh-CN')} 字符</span>
      </footer>

      {notice ? <div className="editor-toast">{notice}</div> : null}

      {showCloseConfirm ? (
        <div className="editor-modal-backdrop">
          <div className="editor-modal" role="dialog" aria-modal="true" aria-label="关闭编辑窗口">
            <div className="modal-title">还有未保存修改</div>
            <p className="modal-copy">保存后关闭，或放弃本次修改。</p>
            <div className="modal-actions">
              <button className="danger-button" type="button" onClick={closeWithoutSave}>
                放弃
              </button>
              <button className="editor-button" type="button" onClick={() => setShowCloseConfirm(false)}>
                取消
              </button>
              <button className="editor-button primary" type="button" onClick={closeAfterSave}>
                保存并关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

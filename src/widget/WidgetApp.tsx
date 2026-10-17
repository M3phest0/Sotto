import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { GripIcon, LockIcon, PencilIcon, CheckIcon, CloseIcon } from '../shared/icons'
import { MarkdownInline } from '../shared/MarkdownInline'
import { getProgress, getVisibleTasks } from '../shared/taskParser'
import type { Snapshot } from '../shared/types'
import {
  loadSnapshot,
  openEditorWindow,
  saveSettings,
  subscribeToChanges,
} from '../shared/mock'
import { normalizeSettings } from '../shared/settings'
import { setupDesktopLayer, startWindowDrag } from '../shared/desktop'
import './widget.css'

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(md|markdown)$/i, '') || 'Sotto'
}

export function WidgetApp() {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => loadSnapshot())
  const [expanded, setExpanded] = useState(false)
  const [atBottom, setAtBottom] = useState(false)
  const [showFirstRun, setShowFirstRun] = useState(() => !loadSnapshot().settings.autostartAsked)
  const [pulse, setPulse] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const lastToggleRef = useRef(0)

  useEffect(() => {
    const unsubscribe = subscribeToChanges(() => setSnapshot(loadSnapshot()))
    return unsubscribe
  }, [])

  useEffect(() => {
    void setupDesktopLayer()
  }, [])

  useEffect(() => {
    setAtBottom(false)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [expanded, snapshot.text])

  useEffect(() => {
    if (!pulse) return
    const timer = window.setTimeout(() => setPulse(false), 420)
    return () => window.clearTimeout(timer)
  }, [pulse])

  const settings = snapshot.settings
  const allTasks = snapshot.tasks
  const visibleTasks = useMemo(
    () => getVisibleTasks(allTasks, settings.hideCompleted),
    [allTasks, settings.hideCompleted],
  )
  const limit = expanded ? settings.expanded : settings.compact
  const shownTasks = visibleTasks.slice(0, limit)
  const overflowCount = Math.max(0, visibleTasks.length - limit)
  const { completed, total } = getProgress(allTasks)
  const title = snapshot.title ?? fileStem(snapshot.path)

  const style = {
    '--widget-width': `${settings.width}px`,
    '--widget-font-size': `${settings.fontSize}px`,
    '--visible-rows': limit,
  } as CSSProperties

  function toggleExpanded() {
    const now = Date.now()
    if (now - lastToggleRef.current < 300) return
    lastToggleRef.current = now
    setExpanded((current) => !current)
    setPulse(true)
  }

  function handleCardClick(event: MouseEvent<HTMLDivElement>) {
    if (showFirstRun) return
    const target = event.target as HTMLElement
    if (target.closest('button, a, input, textarea, select, [data-no-toggle="true"]')) return
    toggleExpanded()
  }

  function handleScroll() {
    const el = viewportRef.current
    if (!el) return
    setAtBottom(el.scrollTop + el.clientHeight >= el.scrollHeight - 2)
  }

  function openEditor() {
    openEditorWindow()
  }

  function chooseAutostart(enabled: boolean) {
    const next = normalizeSettings({
      ...settings,
      autostart: enabled ? 'enabled' : 'disabled',
      autostartAsked: true,
    })
    saveSettings(next)
    setShowFirstRun(false)
    setSnapshot(loadSnapshot())
  }

  function openEditorFromPrompt() {
    const next = normalizeSettings({
      ...settings,
      autostart: 'disabled',
      autostartAsked: true,
    })
    saveSettings(next)
    setSnapshot(loadSnapshot())
    setShowFirstRun(false)
    openEditor()
  }

  const footerText = (() => {
    if (visibleTasks.length === 0) {
      return allTasks.length > 0 ? '全部完成' : '打开编辑器'
    }
    if (!expanded && overflowCount === 0) return '点击展开'
    if (expanded && overflowCount === 0) return '点击收起'
    if (overflowCount > 0 && atBottom) return '已到底'
    return `还有 ${overflowCount} 条`
  })()

  const emptyText = (() => {
    if (visibleTasks.length > 0) return null
    if (allTasks.length > 0) return '全部完成'
    if (snapshot.text.trim().length === 0) return '文件为空 · 点铅笔打开编辑器'
    return '没有任务 · 点铅笔打开编辑器'
  })()

  return (
    <div className={`widget-root theme-${settings.theme}`} data-testid="widget">
      <div
        className={`widget-card ${pulse ? 'is-pulsing' : ''}`}
        style={style}
        onClick={handleCardClick}
        data-testid="widget-card"
      >
        <header className="widget-header">
          <div
            className="drag-strip"
            data-no-toggle="true"
            title={settings.locked ? '位置已锁定' : '拖动窗口（Windows 桌面层）'}
            aria-label={settings.locked ? '位置已锁定' : '拖动窗口'}
            onPointerDown={(event) => {
              if (event.button !== 0 || settings.locked) return
              event.preventDefault()
              void startWindowDrag()
            }}
          >
            {settings.locked ? <LockIcon size={15} /> : <GripIcon size={15} />}
          </div>
          <div className="widget-title" title={title} data-testid="widget-title">
            {title}
          </div>
          <div className="widget-progress" aria-label={`已完成 ${completed} 条，共 ${total} 条`}>
            {completed}/{total}
          </div>
          <button
            className="icon-button edit-button"
            type="button"
            title="编辑 Markdown"
            aria-label="编辑 Markdown"
            onClick={(event) => {
              event.stopPropagation()
              openEditor()
            }}
            data-testid="edit-button"
          >
            <PencilIcon size={16} />
          </button>
        </header>

        <div
          className="task-viewport"
          ref={viewportRef}
          onScroll={handleScroll}
          data-testid="task-viewport"
        >
          {emptyText ? (
            <div className="empty-state" data-testid="empty-state">
              {emptyText}
            </div>
          ) : (
            shownTasks.map((task) => (
              <div
                className={`task-row ${task.checked ? 'is-done' : ''}`}
                key={task.id}
                style={{ paddingLeft: `${Math.min(task.depth, 3) * 16 + 8}px` }}
                data-testid="task-row"
              >
                <span className="task-bullet" aria-hidden="true">
                  {task.checked ? <CheckIcon size={11} /> : <span className="pending-dot" />}
                </span>
                <span className="task-text" title={task.text}>
                  <MarkdownInline text={task.text} />
                </span>
              </div>
            ))
          )}
        </div>

        <div className={`widget-footer ${overflowCount > 0 ? 'has-overflow' : ''}`} data-testid="widget-footer">
          <span>{footerText}</span>
        </div>

        {showFirstRun ? (
          <div
            className="first-run-backdrop"
            data-testid="first-run-dialog"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="first-run-card" role="dialog" aria-modal="true" aria-label="首次运行">
              <div className="first-run-title">是否开机自动启动 Sotto？</div>
              <p className="first-run-copy">之后可在托盘或设置中修改。</p>
              <div className="first-run-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => chooseAutostart(true)}
                  data-testid="autostart-enable"
                >
                  启用
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => chooseAutostart(false)}
                  data-testid="autostart-disable"
                >
                  暂不启用
                </button>
              </div>
              <button className="link-button" type="button" onClick={openEditorFromPrompt}>
                打开编辑器
              </button>
            </div>
            <button
              className="first-run-close"
              type="button"
              aria-label="关闭"
              onClick={() => chooseAutostart(false)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

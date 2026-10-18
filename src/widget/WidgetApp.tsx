import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type WheelEvent,
} from 'react'
import { GripIcon, LockIcon, PencilIcon, CheckIcon, CloseIcon } from '../shared/icons'
import { MarkdownInline } from '../shared/MarkdownInline'
import { getProgress, getVisibleContent } from '../shared/taskParser'
import type { Snapshot } from '../shared/types'
import {
  applyAutostart,
  loadSnapshot,
  openEditorWindow,
  resizeWidgetWindow,
  saveSettings,
  subscribeToChanges,
} from '../shared/api'
import { DEFAULT_SETTINGS, normalizeSettings } from '../shared/settings'
import { isTauri, setupDesktopLayer, startWindowDrag } from '../shared/desktop'
import './widget.css'

function fileStem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base.replace(/\.(md|markdown)$/i, '') || 'Sotto'
}

export function WidgetApp() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [atBottom, setAtBottom] = useState(false)
  const [showFirstRun, setShowFirstRun] = useState(false)
  const [autostartError, setAutostartError] = useState<string | null>(null)
  const [pulse, setPulse] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const lastToggleRef = useRef(0)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const next = await loadSnapshot()
        if (!active) return
        setSnapshot(next)
        setShowFirstRun(!next.settings.autostartAsked)
      } catch {
        // 首次加载失败时保留加载态，避免误显示空文件。
      }
    }
    void refresh()
    const unsubscribe = subscribeToChanges(() => {
      void refresh()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (snapshot) void setupDesktopLayer(snapshot.settings.theme)
  }, [snapshot?.settings.theme])

  useEffect(() => {
    setAtBottom(false)
    if (viewportRef.current) viewportRef.current.scrollTop = 0
  }, [expanded, snapshot?.text])

  useEffect(() => {
    if (!pulse) return
    const timer = window.setTimeout(() => setPulse(false), 420)
    return () => window.clearTimeout(timer)
  }, [pulse])

  const settings = snapshot?.settings ?? DEFAULT_SETTINGS
  const allTasks = snapshot?.tasks ?? []
  // 组件显示原文本的前几行：任务行带状态，普通文本行原样展示。
  const visibleLines = useMemo(
    () => getVisibleContent(snapshot?.content ?? [], allTasks, settings.hideCompleted),
    [snapshot?.content, allTasks, settings.hideCompleted],
  )
  const limit = expanded ? settings.expanded : settings.compact
  const shownLines = visibleLines.slice(0, limit)
  const overflowCount = Math.max(0, visibleLines.length - limit)
  const { completed, total } = getProgress(allTasks)
  const title = snapshot?.title ?? fileStem(snapshot?.path ?? '')
  const missing = snapshot?.missing ?? false
  const readError = snapshot?.readError ?? null

  const style = {
    '--widget-width': `${settings.width}px`,
    '--widget-font-size': `${settings.fontSize}px`,
    '--visible-rows': limit,
  } as CSSProperties

  // 原生窗口跟随内容高度；Rust 侧再按工作区 60% 封顶并保持右边缘。
  useEffect(() => {
    if (!isTauri() || !snapshot) return
    const frame = window.requestAnimationFrame(() => {
      const card = cardRef.current
      if (!card) return
      const viewport = card.querySelector<HTMLElement>('.task-viewport')
      const header = card.querySelector<HTMLElement>('.widget-header')
      const footer = card.querySelector<HTMLElement>('.widget-footer')
      const alert = card.querySelector<HTMLElement>('.widget-alert')
      const rowsHeight = Math.min(viewport?.scrollHeight ?? 38, limit * 38 + 4)
      const cardHeight =
        (header?.offsetHeight ?? 46) +
        rowsHeight +
        (footer?.offsetHeight ?? 30) +
        (alert?.offsetHeight ?? 0) +
        2
      const chrome = settings.theme === 'acrylic' ? 0 : 24
      void resizeWidgetWindow(settings.width + chrome, cardHeight + chrome).catch(() => {})
    })
    return () => window.cancelAnimationFrame(frame)
  }, [snapshot?.text, snapshot?.path, expanded, limit, settings.width, settings.fontSize, settings.theme, missing, readError])

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

  function handleWheel(event: WheelEvent<HTMLDivElement>) {
    const el = viewportRef.current
    if (!el) return
    // 列表自身可滚动时保留原生行为；在标题/页脚上滚动则转交给列表。
    if ((event.target as HTMLElement).closest('.task-viewport')) return
    if (el.scrollHeight <= el.clientHeight) return
    el.scrollTop += event.deltaY
  }

  function openEditor() {
    void openEditorWindow()
  }

  async function chooseAutostart(enabled: boolean) {
    let autostart: 'enabled' | 'disabled' = 'disabled'
    let error: string | null = null
    try {
      const status = await applyAutostart(enabled)
      if (enabled && status.registered) {
        autostart = 'enabled'
      } else if (enabled) {
        error = status.disabledBySystem
          ? 'Windows 已禁用该自启项，请到“启动应用”中手动启用'
          : '自启注册失败，未写入注册表'
      }
    } catch (err) {
      error = `自启注册失败：${String(err)}`
    }
    const next = normalizeSettings({
      ...settings,
      autostart,
      autostartAsked: true,
    })
    setSnapshot((current) => (current ? { ...current, settings: next } : current))
    void saveSettings(next)
    if (error) {
      setAutostartError(error)
      return
    }
    setAutostartError(null)
    setShowFirstRun(false)
  }

  function openEditorFromPrompt() {
    const next = normalizeSettings({
      ...settings,
      autostart: 'disabled',
      autostartAsked: true,
    })
    setSnapshot((current) => (current ? { ...current, settings: next } : current))
    setShowFirstRun(false)
    void saveSettings(next)
    openEditor()
  }

  const footerText = (() => {
    if (missing) return '文件不存在 · 请重新选择'
    if (readError) return '读取失败 · 打开编辑器查看'
    if (visibleLines.length === 0) {
      return allTasks.length > 0 && allTasks.every((task) => task.text.trim().length > 0) ? '全部完成' : '打开编辑器'
    }
    if (!expanded && overflowCount === 0) return '点击展开'
    if (expanded && overflowCount === 0) return '点击收起'
    if (overflowCount > 0 && atBottom) return '已到底'
    return `还有 ${overflowCount} 条`
  })()

  const emptyText = (() => {
    if (missing) return '文件不存在 · 点铅笔重新选择'
    if (visibleLines.length > 0) return null
    if (readError) return '无法读取文件 · 打开编辑器查看详情'
    if (allTasks.length > 0 && allTasks.every((task) => task.text.trim().length > 0)) return '全部完成'
    if ((snapshot?.text ?? '').trim().length === 0) return '文件为空 · 点铅笔打开编辑器'
    return '没有任务 · 点铅笔打开编辑器'
  })()

  if (!snapshot) {
    return (
      <div
        className={`widget-root theme-${settings.theme}${isTauri() ? ' is-native' : ''}`}
        data-testid="widget"
      >
        <div className="widget-card" style={style} data-testid="widget-card">
          <div className="empty-state">加载中…</div>
        </div>
      </div>
    )
  }

  return (
    <div
      className={`widget-root theme-${settings.theme}${isTauri() ? ' is-native' : ''}`}
      data-testid="widget"
    >
      <div
        ref={cardRef}
        className={`widget-card ${pulse ? 'is-pulsing' : ''}`}
        style={style}
        onClick={handleCardClick}
        onWheel={handleWheel}
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
            shownLines.map((line) => (
              <div
                className={`task-row ${line.task ? '' : 'is-text'} ${line.task?.checked ? 'is-done' : ''}`}
                key={line.id}
                style={{ paddingLeft: `${Math.min(line.depth, 3) * 16 + 8}px` }}
                data-testid={line.task ? 'task-row' : 'text-row'}
              >
                {line.task ? (
                  <span className="task-bullet" aria-hidden="true">
                    {line.task.checked ? <CheckIcon size={11} /> : <span className="pending-dot" />}
                  </span>
                ) : null}
                <span className="task-text" title={line.text}>
                  <MarkdownInline text={line.text} />
                </span>
              </div>
            ))
          )}
        </div>

        {readError && visibleLines.length > 0 ? (
          <div className="widget-alert" role="alert" title={readError} data-testid="read-error">
            读取失败 · 显示缓存内容
          </div>
        ) : null}

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
              {autostartError ? (
                <p className="first-run-error" role="alert">
                  {autostartError}
                </p>
              ) : null}
              <div className="first-run-actions">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void chooseAutostart(true)}
                  data-testid="autostart-enable"
                >
                  启用
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void chooseAutostart(false)}
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
              onClick={() => void chooseAutostart(false)}
            >
              <CloseIcon size={14} />
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

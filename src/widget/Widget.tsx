import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addTomato, getData, onStateChanged, openEditor, setDone, undoTomato } from '../shared/api'
import { playTomato } from '../shared/sound'
import type { AppData, Task } from '../shared/types'
import './widget.css'

function formatHotkey(hotkey: string) {
  return hotkey
    .split('+')
    .map((part) => {
      const key = part.trim().toLowerCase()
      if (key === 'ctrl' || key === 'control') return 'Ctrl'
      if (key === 'alt') return 'Alt'
      if (key === 'shift') return 'Shift'
      if (key === 'space') return 'Space'
      return key.length === 1 ? key.toUpperCase() : key
    })
    .join('+')
}

function startOfToday() {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function formatDdl(ddl: string | null) {
  if (!ddl) return null
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const datePart = ddl.slice(0, 10)
  const timePart = ddl.length > 10 ? ddl.slice(11, 16) : ''
  const due = new Date(`${datePart}T00:00:00`)
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000)
  let label: string
  if (days === 0) label = '今天'
  else if (days === 1) label = '明天'
  else if (days === -1) label = '昨天'
  else label = `${due.getMonth() + 1}/${due.getDate()}`
  if (timePart) label += ` ${timePart}`
  return { label, overdue: days < 0 }
}

export function Widget() {
  const [data, setData] = useState<AppData | null>(null)
  const [pulse, setPulse] = useState<Record<string, number>>({})
  const timers = useRef<Record<string, number>>({})

  const refresh = useCallback(() => {
    getData().then(setData).catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
    const unlisten = onStateChanged(() => refresh())
    // 便签上不需要浏览器右键菜单；番茄按钮自己处理右键。
    const stopMenu = (event: MouseEvent) => event.preventDefault()
    window.addEventListener('contextmenu', stopMenu)
    return () => {
      unlisten.then((fn) => fn())
      window.removeEventListener('contextmenu', stopMenu)
    }
  }, [refresh])

  const settings = data?.settings
  const activeTasks = useMemo(
    () =>
      (data?.tasks ?? [])
        .filter((task) => !task.completedAt)
        .sort((a, b) => a.order - b.order),
    [data],
  )

  const countFor = useCallback(
    (task: Task) => (data?.tomatoes ?? []).filter((t) => t.taskId === task.id).length,
    [data],
  )

  const todayCount = useMemo(() => {
    const from = startOfToday()
    return (data?.tomatoes ?? []).filter((t) => t.ts >= from).length
  }, [data])

  const giveTomato = (task: Task) => {
    playTomato(settings!)
    setPulse((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? 0) + 1 }))
    window.clearTimeout(timers.current[task.id])
    timers.current[task.id] = window.setTimeout(() => {
      setPulse((prev) => {
        const next = { ...prev }
        delete next[task.id]
        return next
      })
    }, 420)
    addTomato(task.id).catch(() => {})
  }

  const takeTomato = (task: Task) => {
    if (countFor(task) === 0) return
    undoTomato(task.id).catch(() => {})
  }

  if (!settings) return <div className="widget" />

  const style = {
    '--bg': settings.theme.bg,
    '--text': settings.theme.text,
    '--accent': settings.theme.accent,
  } as React.CSSProperties

  const now = new Date()

  return (
    <div className="widget" style={style}>
      <header className="widget-head" data-tauri-drag-region>
        <div className="head-left" data-tauri-drag-region>
          <span className="head-title" data-tauri-drag-region>
            待办
          </span>
          <span className="head-date" data-tauri-drag-region>
            {now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' })}
          </span>
        </div>
        <div className="head-right" data-tauri-drag-region>
          <span className="today-tomato" title="今日番茄">
            🍅 {todayCount}
          </span>
        </div>
      </header>

      <div className="widget-list">
        {activeTasks.length === 0 && (
          <div className="empty">
            <div className="empty-emoji">🌱</div>
            <div className="empty-text">还没有任务</div>
            <div className="empty-hint">按 {formatHotkey(settings.hotkey)} 添加</div>
          </div>
        )}
        {activeTasks.map((task) => {
          const ddl = formatDdl(task.ddl)
          const count = countFor(task)
          const popping = pulse[task.id]
          return (
            <div className={`row ${popping ? 'popping' : ''}`} key={task.id}>
              <button
                className="check"
                title="标记完成"
                onClick={() => setDone(task.id, true).catch(() => {})}
              >
                <span className="check-dot" />
              </button>
              <button
                className="row-main"
                title="打开编辑界面"
                onClick={() => openEditor(task.id).catch(() => {})}
              >
                <span className="row-title">{task.title || '未命名任务'}</span>
                {ddl && (
                  <span className={`ddl ${ddl.overdue ? 'overdue' : ''}`}>{ddl.label}</span>
                )}
              </button>
              <button
                className={`tomato-btn ${count > 0 ? 'has-count' : ''}`}
                title="左键贴一个番茄 · 右键撤销一个"
                onClick={() => giveTomato(task)}
                onContextMenu={(event) => {
                  event.preventDefault()
                  takeTomato(task)
                }}
              >
                {count === 0 ? (
                  <span className="tomato ghost">🍅</span>
                ) : (
                  Array.from({ length: count }, (_, index) => (
                    <span className="tomato" key={index}>
                      🍅
                    </span>
                  ))
                )}
              </button>
              {popping && <span className="float-plus">+1</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

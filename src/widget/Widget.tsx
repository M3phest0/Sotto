import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { addTomato, getData, onStateChanged, openEditor, setDone, undoTomato } from '../shared/api'
import { playComplete, playTomato } from '../shared/sound'
import { doneSeedStyle, makeDoneSeeds } from '../shared/doneSeeds'
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

type Seed = {
  dx: number
  dy: number
  rot: number
  size: number
  delay: number
  emoji: boolean
}

/** 用点击时间做种子，保证同一次爆汁的粒子在重渲染时位置不变。 */
function makeSeeds(seed: number): Seed[] {
  let state = Math.abs(Math.floor(seed * 1000)) % 2147483647
  if (state === 0) state = 1
  const next = () => {
    state = (state * 48271) % 2147483647
    return state / 2147483647
  }
  return Array.from({ length: 10 }, (_, index) => ({
    dx: -34 + next() * 42,
    dy: 4 + next() * 28,
    rot: -160 + next() * 320,
    size: 3 + next() * 3.5,
    delay: next() * 40,
    emoji: index < 2,
  }))
}

function seedStyle(seed: Seed): React.CSSProperties {
  return {
    '--dx': `${seed.dx}px`,
    '--dy': `${seed.dy}px`,
    '--rot': `${seed.rot}deg`,
    '--size': `${seed.size}px`,
    '--delay': `${seed.delay}ms`,
  } as React.CSSProperties
}

export function Widget() {
  const [data, setData] = useState<AppData | null>(null)
  const [pulse, setPulse] = useState<Record<string, number>>({})
  const [tide, setTide] = useState<number | null>(null)
  const [doneAnim, setDoneAnim] = useState<Record<string, number>>({})
  const timers = useRef<Record<string, number>>({})
  const tideTimer = useRef<number | null>(null)
  const doneTimers = useRef<Record<string, number>>({})

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

  // 跨天自动刷新"今日"计数与 DDL 相对日期。
  useEffect(() => {
    let timer = 0
    const schedule = () => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 2)
      timer = window.setTimeout(() => {
        refresh()
        schedule()
      }, next.getTime() - now.getTime())
    }
    schedule()
    return () => window.clearTimeout(timer)
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
    // 用时间戳做动画 key：连续点击也能重新触发整套动画。
    setPulse((prev) => ({ ...prev, [task.id]: performance.now() }))
    setTide(performance.now())
    if (tideTimer.current !== null) window.clearTimeout(tideTimer.current)
    tideTimer.current = window.setTimeout(() => setTide(null), 3900)
    window.clearTimeout(timers.current[task.id])
    timers.current[task.id] = window.setTimeout(() => {
      setPulse((prev) => {
        const next = { ...prev }
        delete next[task.id]
        return next
      })
    }, 650)
    addTomato(task.id).catch(() => {})
  }

  const takeTomato = (task: Task) => {
    if (countFor(task) === 0) return
    undoTomato(task.id).catch(() => {})
  }

  const completeTask = (task: Task) => {
    if (doneTimers.current[task.id] !== undefined) return
    playComplete(settings!)
    setDoneAnim((prev) => ({ ...prev, [task.id]: performance.now() }))
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    doneTimers.current[task.id] = window.setTimeout(() => {
      delete doneTimers.current[task.id]
      setDone(task.id, true).catch(() => {})
      setDoneAnim((prev) => {
        const next = { ...prev }
        delete next[task.id]
        return next
      })
    }, reduced ? 0 : 800)
  }

  if (!settings) return <div className="widget" />

  const style = {
    '--bg': settings.theme.bg,
    '--text': settings.theme.text,
    '--accent': settings.theme.accent,
  } as React.CSSProperties

  const now = new Date()
  const glowing = Object.keys(doneAnim).length > 0

  return (
    <div className={`widget ${glowing ? 'done-glow' : ''}`} style={style}>
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
          const completing = doneAnim[task.id]
          const seeds = popping ? makeSeeds(popping) : []
          return (
            <div
              className={`row ${popping ? 'popping' : ''} ${completing ? 'completing' : ''}`}
              key={`${task.id}-${popping ?? 0}`}
            >
              <button
                className="check"
                title="标记完成"
                onClick={() => completeTask(task)}
              >
                <span className="check-dot">{completing ? '✓' : ''}</span>
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
                {popping && (
                  <>
                    <span className="ring" aria-hidden="true" />
                    <span className="burst" aria-hidden="true">
                      {seeds.map((seed, index) => (
                        <i
                          className={`seed${seed.emoji ? ' emoji' : ''}`}
                          key={index}
                          style={seedStyle(seed)}
                        >
                          {seed.emoji ? '🍅' : ''}
                        </i>
                      ))}
                    </span>
                  </>
                )}
                {count === 0 ? (
                  <span className="tomato ghost">🍅</span>
                ) : (
                  Array.from({ length: count }, (_, index) => (
                    <span
                      className="tomato"
                      key={index}
                      style={{ animationDelay: `${Math.min(index * 16, 180)}ms` }}
                    >
                      🍅
                    </span>
                  ))
                )}
              </button>
              {popping && <span className="float-plus">+1</span>}
              {completing && (
                <>
                  <span className="done-wash" aria-hidden="true" />
                  <span className="done-flash" aria-hidden="true" />
                  <span className="done-burst" aria-hidden="true">
                    {makeDoneSeeds(completing).map((seed, index) => (
                      <i key={index} style={doneSeedStyle(seed)} />
                    ))}
                  </span>
                  <span className="done-ring" aria-hidden="true" />
                  <span className="done-ring done-ring-b" aria-hidden="true" />
                  <span className="done-star" aria-hidden="true">
                    ✦
                  </span>
                  <span className="done-sparks" aria-hidden="true">
                    {Array.from({ length: 10 }, (_, index) => (
                      <i
                        key={index}
                        style={
                          {
                            '--i': index,
                            '--dir': index % 2 === 0 ? -1 : 1,
                          } as React.CSSProperties
                        }
                      />
                    ))}
                  </span>
                  <span className="done-big-check" aria-hidden="true">
                    ✓
                  </span>
                  <span className="done-label" aria-hidden="true">
                    ✓ 完成
                  </span>
                </>
              )}
            </div>
          )
        })}
      </div>

      {tide && (
        <div className="tide" key={tide} aria-hidden="true">
          <svg viewBox="0 0 360 140" preserveAspectRatio="none">
            <g className="tide-drift tide-drift-back">
              <g className="tide-bob tide-bob-back">
                <path
                  className="tide-wave tide-back"
                  d="M0 10 C30 32 60 0 90 10 C120 32 150 0 180 10 C210 32 240 0 270 10 C300 32 330 0 360 10 L360 160 L0 160 Z"
                />
              </g>
            </g>
            <g className="tide-drift tide-drift-front">
              <g className="tide-bob tide-bob-front">
                <path
                  className="tide-wave tide-front"
                  d="M0 20 C30 44 60 2 90 20 C120 44 150 2 180 20 C210 44 240 2 270 20 C300 44 330 2 360 20 L360 160 L0 160 Z"
                />
              </g>
            </g>
          </svg>
        </div>
      )}
    </div>
  )
}

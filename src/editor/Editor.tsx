import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addTask,
  addTomato,
  deleteTasks,
  exportData,
  getData,
  hideEditor,
  importData,
  onFocusTask,
  onOpenView,
  onStateChanged,
  openDataDir,
  pickSoundFile,
  saveSettings,
  saveTask,
  setAutostart,
  setDone,
  setHotkey,
  setWidgetSize,
  undoTomato,
} from '../shared/api'
import { playTomato } from '../shared/sound'
import type { AppData, Settings, Task, Tomato } from '../shared/types'
import './editor.css'

type View = 'tasks' | 'stats' | 'settings'

const ZOOM_KEY = 'sotto.editorZoom'
const ZOOM_MIN = 0.75
const ZOOM_MAX = 2
const ZOOM_STEP = 0.1

const EMPTY_SETTINGS: Settings = {
  theme: { bg: '#FFF9F2', text: '#2A2622', accent: '#E8563F' },
  soundEnabled: true,
  soundVolume: 0.7,
  soundPath: null,
  hotkey: 'ctrl+alt+e',
  autostart: true,
  widgetWidth: 360,
  widgetHeight: 520,
  widgetX: null,
  widgetY: null,
  editorX: null,
  editorY: null,
  editorWidth: null,
  editorHeight: null,
}

export function Editor() {
  const [view, setView] = useState<View>('tasks')
  const [tasks, setTasks] = useState<Task[]>([])
  const [tomatoes, setTomatoes] = useState<Tomato[]>([])
  const [tomatoCounts, setTomatoCounts] = useState<Record<string, number>>({})
  const [settings, setSettings] = useState<Settings>(EMPTY_SETTINGS)
  const [selected, setSelected] = useState<string | null>(null)
  const [multi, setMulti] = useState<Set<string>>(new Set())
  const [draft, setDraft] = useState<Task | null>(null)
  const [loading, setLoading] = useState(true)
  const [toast, setToast] = useState('')
  const [dragId, setDragId] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const draftTimer = useRef<number | null>(null)
  const toastTimer = useRef<number | null>(null)

  const applyData = useCallback((data: AppData) => {
    setTasks(data.tasks)
    setTomatoes(data.tomatoes)
    setSettings((prev) => (prev === EMPTY_SETTINGS ? data.settings : prev))
    const counts: Record<string, number> = {}
    for (const tomato of data.tomatoes) {
      counts[tomato.taskId] = (counts[tomato.taskId] ?? 0) + 1
    }
    setTomatoCounts(counts)
  }, [])

  const refresh = useCallback(() => {
    getData()
      .then((data) => {
        applyData(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [applyData])

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(''), 2000)
  }, [])

  // 页面缩放：Ctrl + = / - / 0，或 Ctrl + 滚轮。
  const zoomRef = useRef(1)

  const applyZoom = useCallback(
    (next: number) => {
      const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(next * 10) / 10))
      zoomRef.current = clamped
      document.documentElement.style.zoom = String(clamped)
      localStorage.setItem(ZOOM_KEY, String(clamped))
      showToast(`缩放 ${Math.round(clamped * 100)}%`)
    },
    [showToast],
  )

  useEffect(() => {
    const saved = Number(localStorage.getItem(ZOOM_KEY))
    const initial =
      Number.isFinite(saved) && saved >= ZOOM_MIN && saved <= ZOOM_MAX ? saved : 1
    zoomRef.current = initial
    document.documentElement.style.zoom = String(initial)
  }, [])

  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return
      event.preventDefault()
      applyZoom(zoomRef.current + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP))
    }
    window.addEventListener('wheel', onWheel, { passive: false })
    return () => window.removeEventListener('wheel', onWheel)
  }, [applyZoom])

  useEffect(() => {
    refresh()
    const unlisten = onStateChanged(() => refresh())
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [refresh])

  useEffect(() => {
    const unFocus = onFocusTask((taskId) => {
      setView('tasks')
      setSelected(taskId)
    })
    const unView = onOpenView((target) => {
      setView(target === 'settings' ? 'settings' : 'tasks')
    })
    return () => {
      unFocus.then((fn) => fn())
      unView.then((fn) => fn())
    }
  }, [])

  // 选中任务变化时同步编辑草稿；同一任务的后台刷新只同步完成状态，避免覆盖正在输入的内容。
  useEffect(() => {
    const task = tasks.find((t) => t.id === selected) ?? null
    if (!task) {
      setDraft(null)
      return
    }
    setDraft((prev) =>
      prev && prev.id === task.id ? { ...prev, completedAt: task.completedAt } : { ...task },
    )
  }, [selected, tasks])

  const active = useMemo(
    () => tasks.filter((t) => !t.completedAt).sort((a, b) => a.order - b.order),
    [tasks],
  )
  const completed = useMemo(
    () =>
      tasks
        .filter((t) => t.completedAt)
        .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0)),
    [tasks],
  )
  const ordered = [...active, ...completed]

  const persistDraft = useCallback(
    (value: Task) => {
      if (draftTimer.current) window.clearTimeout(draftTimer.current)
      draftTimer.current = window.setTimeout(() => {
        saveTask(value).catch(() => showToast('保存失败'))
      }, 350)
    },
    [showToast],
  )

  const updateDraft = (patch: Partial<Task>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    persistDraft(next)
  }

  const createTask = async () => {
    const task = await addTask('新任务', null)
    setView('tasks')
    setSelected(task.id)
    setMulti(new Set([task.id]))
    window.setTimeout(() => {
      titleRef.current?.focus()
      titleRef.current?.select()
    }, 30)
  }

  const removeTasks = (ids: string[]) => {
    if (ids.length === 0) return
    const label = ids.length === 1 ? '这个任务' : `这 ${ids.length} 个任务`
    if (!window.confirm(`删除${label}？番茄记录也会一起删除。`)) return
    deleteTasks(ids)
      .then(() => {
        if (selected && ids.includes(selected)) setSelected(null)
        setMulti(new Set())
        showToast('已删除')
      })
      .catch(() => showToast('删除失败'))
  }

  const toggleDone = (task: Task) => {
    setDone(task.id, !task.completedAt).catch(() => showToast('操作失败'))
  }

  const selectRow = (task: Task, event: React.MouseEvent) => {
    if (event.shiftKey) {
      const anchor = selected ?? task.id
      const from = ordered.findIndex((t) => t.id === anchor)
      const to = ordered.findIndex((t) => t.id === task.id)
      if (from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from]
        setMulti(new Set(ordered.slice(a, b + 1).map((t) => t.id)))
      }
      return
    }
    if (event.ctrlKey || event.metaKey) {
      const next = new Set(multi)
      if (next.has(task.id)) next.delete(task.id)
      else next.add(task.id)
      setMulti(next)
      setSelected(task.id)
      return
    }
    setSelected(task.id)
    setMulti(new Set([task.id]))
  }

  const moveSelection = (delta: number, extend: boolean) => {
    if (ordered.length === 0) return
    const index = Math.max(0, ordered.findIndex((t) => t.id === selected))
    const next = Math.min(ordered.length - 1, Math.max(0, index + delta))
    const task = ordered[next]
    setSelected(task.id)
    if (!extend) setMulti(new Set([task.id]))
    else setMulti((prev) => {
      const set = new Set(prev)
      set.add(task.id)
      return set
    })
  }

  // 全局快捷键。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      const inField =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable

      if (event.ctrlKey || event.metaKey) {
        if (event.key === '=' || event.key === '+') {
          event.preventDefault()
          applyZoom(zoomRef.current + ZOOM_STEP)
          return
        }
        if (event.key === '-') {
          event.preventDefault()
          applyZoom(zoomRef.current - ZOOM_STEP)
          return
        }
        if (event.key === '0') {
          event.preventDefault()
          applyZoom(1)
          return
        }
      }

      if ((event.ctrlKey && event.key.toLowerCase() === 'w') || (event.key === 'Escape' && !inField)) {
        event.preventDefault()
        hideEditor().catch(() => {})
        return
      }
      if (view !== 'tasks') return
      if (!inField) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          moveSelection(1, event.shiftKey)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          moveSelection(-1, event.shiftKey)
        } else if (event.key === 'Delete') {
          event.preventDefault()
          removeTasks(multi.size > 0 ? [...multi] : selected ? [selected] : [])
        } else if (event.key === 'F2' && selected) {
          event.preventDefault()
          titleRef.current?.focus()
          titleRef.current?.select()
        } else if (event.key === 'Enter' && selected) {
          event.preventDefault()
          titleRef.current?.focus()
        }
      }
      if (event.ctrlKey && event.key.toLowerCase() === 'n') {
        event.preventDefault()
        void createTask()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // 拖动排序。
  const dropOn = (target: Task) => {
    if (!dragId || dragId === target.id) return
    const list = [...active]
    const from = list.findIndex((t) => t.id === dragId)
    const to = list.findIndex((t) => t.id === target.id)
    if (from < 0 || to < 0) return
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    list.forEach((task, index) => {
      if (task.order !== index + 1) {
        saveTask({ ...task, order: index + 1 }).catch(() => {})
      }
    })
    setDragId(null)
  }

  const applySettings = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    saveSettings(next).catch(() => showToast('设置保存失败'))
  }

  const changeTheme = (key: keyof Settings['theme'], value: string) => {
    applySettings({ theme: { ...settings.theme, [key]: value } })
  }

  if (loading) return <div className="editor-loading">载入中…</div>

  return (
    <div className="editor">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          Sotto
        </div>
        <nav className="tabs">
          <button
            className={`tab ${view === 'tasks' ? 'active' : ''}`}
            onClick={() => setView('tasks')}
          >
            任务
          </button>
          <button
            className={`tab ${view === 'stats' ? 'active' : ''}`}
            onClick={() => setView('stats')}
          >
            统计
          </button>
          <button
            className={`tab ${view === 'settings' ? 'active' : ''}`}
            onClick={() => setView('settings')}
          >
            设置
          </button>
        </nav>
        {view === 'tasks' && (
          <>
            <button className="new-task" onClick={() => void createTask()}>
              + 新任务 <kbd>Ctrl N</kbd>
            </button>
            <div className="list">
              {active.length > 0 && <div className="section-label">进行中 · {active.length}</div>}
              {active.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  count={tomatoCounts[task.id] ?? 0}
                  selected={selected === task.id}
                  multi={multi.has(task.id)}
                  onClick={(event) => selectRow(task, event)}
                  onToggle={() => toggleDone(task)}
                  draggable
                  onDragStart={() => setDragId(task.id)}
                  onDrop={() => dropOn(task)}
                />
              ))}
              {completed.length > 0 && (
                <div className="section-label">已完成 · {completed.length}</div>
              )}
              {completed.map((task) => (
                <TaskRow
                  key={task.id}
                  task={task}
                  count={tomatoCounts[task.id] ?? 0}
                  selected={selected === task.id}
                  multi={multi.has(task.id)}
                  onClick={(event) => selectRow(task, event)}
                  onToggle={() => toggleDone(task)}
                  done
                />
              ))}
              {tasks.length === 0 && (
                <div className="list-empty">还没有任务，点上面的「新任务」。</div>
              )}
            </div>
            <div className="sidebar-foot">
              <span>Esc / Ctrl W 关闭</span>
              <button className="link" onClick={() => hideEditor().catch(() => {})}>
                收起
              </button>
            </div>
          </>
        )}
        {view === 'stats' && (
          <div className="settings-hint">
            <div className="section-label">统计</div>
            <p>今天和昨天的对比，以及本周与上周的每日番茄。</p>
            <p className="muted">每天 0 点换日，数据来自每一次贴番茄。</p>
          </div>
        )}
        {view === 'settings' && <SettingsList />}
      </aside>

      <main className="detail">
        {view === 'tasks' && draft && (
          <TaskDetail
            task={draft}
            count={tomatoCounts[draft.id] ?? 0}
            titleRef={titleRef}
            onChange={updateDraft}
            onToggle={() => toggleDone(draft)}
            onDelete={() => removeTasks([draft.id])}
            onTomato={() => {
              playTomato(settings)
              addTomato(draft.id).catch(() => {})
            }}
            onUndoTomato={() => undoTomato(draft.id).catch(() => {})}
          />
        )}
        {view === 'tasks' && !draft && (
          <div className="detail-empty">
            <div className="detail-empty-emoji">🍅</div>
            <p>选中左侧的任务查看和编辑详情。</p>
            <p className="muted">
              ↑ ↓ 切换 · Shift ↑↓ 多选 · Delete 删除 · F2 改标题
            </p>
          </div>
        )}
        {view === 'stats' && (
          <StatsPanel tomatoes={tomatoes} tasks={tasks} accent={settings.theme.accent} />
        )}
        {view === 'settings' && (
          <SettingsPanel
            settings={settings}
            onChange={applySettings}
            onThemeChange={changeTheme}
            onWidgetSize={(width, height) =>
              setWidgetSize(width, height).catch(() => showToast('调整失败'))
            }
            onHotkey={(hotkey) =>
              setHotkey(hotkey)
                .then(() => showToast('快捷键已保存'))
                .catch((err) => showToast(String(err)))
            }
            onSoundPick={() =>
              pickSoundFile()
                .then((path) => {
                  if (path) applySettings({ soundPath: path })
                })
                .catch(() => showToast('选择音效失败'))
            }
            onTestSound={() => playTomato({ ...settings, soundEnabled: true })}
            onAutostart={(enabled) =>
              setAutostart(enabled)
                .then(() => showToast(enabled ? '已开启自启' : '已关闭自启'))
                .catch(() => showToast('自启设置失败'))
            }
            onExport={() =>
              exportData()
                .then((path) => path && showToast(`已导出到 ${path}`))
                .catch(() => showToast('导出失败'))
            }
            onImport={() =>
              importData()
                .then((ok) => ok && showToast('导入完成'))
                .catch(() => showToast('导入失败'))
            }
            onOpenDataDir={() => openDataDir()}
            onDeleteAll={() => removeTasks(active.map((t) => t.id))}
          />
        )}
      </main>
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}

function TaskRow(props: {
  task: Task
  count: number
  selected: boolean
  multi: boolean
  done?: boolean
  draggable?: boolean
  onClick: (event: React.MouseEvent) => void
  onToggle: () => void
  onDragStart?: () => void
  onDrop?: () => void
}) {
  const { task, count, selected, multi, done, onClick, onToggle } = props
  return (
    <div
      className={`task-row ${selected ? 'selected' : ''} ${multi ? 'multi' : ''} ${done ? 'done' : ''}`}
      onClick={onClick}
      draggable={Boolean(props.draggable)}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        props.onDragStart?.()
      }}
      onDragOver={(event) => {
        if (props.draggable) event.preventDefault()
      }}
      onDrop={(event) => {
        event.preventDefault()
        props.onDrop?.()
      }}
    >
      <button
        className="row-check"
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        title={done ? '恢复' : '完成'}
      >
        {done ? '✓' : ''}
      </button>
      <div className="row-body">
        <div className="row-name">{task.title || '未命名任务'}</div>
        <div className="row-meta">
          {task.ddl ? task.ddl.slice(0, 10) : '无 DDL'}
          {count > 0 && <span className="row-tomato">🍅 {count}</span>}
        </div>
      </div>
    </div>
  )
}

function TaskDetail(props: {
  task: Task
  count: number
  titleRef: React.RefObject<HTMLInputElement | null>
  onChange: (patch: Partial<Task>) => void
  onToggle: () => void
  onDelete: () => void
  onTomato: () => void
  onUndoTomato: () => void
}) {
  const { task, count, titleRef, onChange } = props
  const date = task.ddl?.slice(0, 10) ?? ''
  const time = task.ddl && task.ddl.length > 10 ? task.ddl.slice(11, 16) : ''

  const setDdl = (nextDate: string, nextTime: string) => {
    if (!nextDate) {
      onChange({ ddl: null })
      return
    }
    onChange({ ddl: nextTime ? `${nextDate}T${nextTime}` : nextDate })
  }

  return (
    <div className="detail-card">
      <input
        ref={titleRef}
        className="title-input"
        value={task.title}
        onChange={(event) => onChange({ title: event.target.value })}
        placeholder="任务名称"
      />

      <div className="field-grid">
        <label className="field">
          <span className="field-label">截止日期</span>
          <input
            type="date"
            value={date}
            onChange={(event) => setDdl(event.target.value, time)}
          />
        </label>
        <label className="field">
          <span className="field-label">时间（可选）</span>
          <input
            type="time"
            value={time}
            onChange={(event) => setDdl(date, event.target.value)}
            disabled={!date}
          />
        </label>
      </div>

      <label className="field">
        <span className="field-label">详情</span>
        <textarea
          rows={9}
          value={task.detail}
          onChange={(event) => onChange({ detail: event.target.value })}
          placeholder="记录这个任务的上下文、下一步…"
        />
      </label>

      <div className="tomato-panel">
        <div>
          <div className="tomato-count">🍅 {count}</div>
          <div className="field-label">已投入 {((count * 0.5).toFixed(1)).replace(/\.0$/, '')} 小时</div>
        </div>
        <div className="tomato-actions">
          <button onClick={props.onUndoTomato}>−1</button>
          <button className="primary" onClick={props.onTomato}>
            +1 番茄
          </button>
        </div>
      </div>

      <div className="detail-actions">
        <button onClick={props.onToggle}>{task.completedAt ? '恢复任务' : '标记完成'}</button>
        <button className="danger" onClick={props.onDelete}>
          删除任务
        </button>
      </div>
    </div>
  )
}

const DAY_MS = 86_400_000
const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const TASK_COLORS = ['#E8563F', '#E9A23B', '#6FA65B', '#5B8AC7', '#9B6BB5', '#C96F8E']

function startOfDay(ts: number) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function startOfWeek(ts: number) {
  const start = new Date(startOfDay(ts))
  const offset = (start.getDay() + 6) % 7 // 周一为一周起点
  start.setDate(start.getDate() - offset)
  return start.getTime()
}

interface TaskSlice {
  taskId: string
  title: string
  count: number
}

type Period = 'today' | 'yesterday' | 'thisWeek' | 'lastWeek'

function sliceTasks(tomatoes: Tomato[], tasks: Task[], from: number, to: number): TaskSlice[] {
  const map = new Map<string, number>()
  for (const tomato of tomatoes) {
    if (tomato.ts >= from && tomato.ts < to) {
      map.set(tomato.taskId, (map.get(tomato.taskId) ?? 0) + 1)
    }
  }
  return [...map.entries()]
    .map(([taskId, count]) => ({
      taskId,
      title: tasks.find((task) => task.id === taskId)?.title ?? '已删除任务',
      count,
    }))
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title))
}

function hoursText(count: number) {
  const hours = count * 0.5
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`
}

function dateLabel(ts: number) {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/// 同一任务在所有时间段使用同一颜色：按任务在列表里的顺序固定分配。
function buildTaskColors(tasks: Task[]) {
  const map = new Map<string, string>()
  const sorted = [...tasks].sort((a, b) => a.order - b.order)
  sorted.forEach((task, index) => {
    map.set(task.id, TASK_COLORS[index % TASK_COLORS.length])
  })
  return map
}

function Breakdown({ items, colors }: { items: TaskSlice[]; colors: Map<string, string> }) {
  if (items.length === 0) return <p className="muted small">这个时间段没有番茄。</p>
  const max = items[0].count
  return (
    <div className="breakdown">
      {items.map((item) => (
        <div className="breakdown-row" key={item.taskId}>
          <i className="dot task" style={{ background: colors.get(item.taskId) }} />
          <span className="breakdown-title">{item.title}</span>
          <span className="breakdown-bar">
            <i
              style={{
                width: `${(item.count / max) * 100}%`,
                background: colors.get(item.taskId),
              }}
            />
          </span>
          <span className="breakdown-count" title={`${item.count} 个番茄`}>
            {hoursText(item.count)}
          </span>
        </div>
      ))}
    </div>
  )
}

function StatsPanel(props: { tomatoes: Tomato[]; tasks: Task[]; accent: string }) {
  const { tomatoes, tasks, accent } = props
  const [period, setPeriod] = useState<Period>('today')

  const today = startOfDay(Date.now())
  const weekStart = startOfWeek(today)
  const isDay = period === 'today' || period === 'yesterday'
  const dayStart = period === 'yesterday' ? today - DAY_MS : today
  const weekBase = period === 'lastWeek' ? weekStart - 7 * DAY_MS : weekStart

  const counts = useMemo(() => {
    const map = new Map<number, number>()
    for (const tomato of tomatoes) {
      const day = startOfDay(tomato.ts)
      map.set(day, (map.get(day) ?? 0) + 1)
    }
    return map
  }, [tomatoes])

  const on = (day: number) => counts.get(day) ?? 0

  const daySlices = useMemo(
    () => (isDay ? sliceTasks(tomatoes, tasks, dayStart, dayStart + DAY_MS) : []),
    [tomatoes, tasks, isDay, dayStart],
  )
  const dayTotal = daySlices.reduce((sum, item) => sum + item.count, 0)
  const dayMax = Math.max(on(today), on(today - DAY_MS), 1)
  const colors = useMemo(() => buildTaskColors(tasks), [tasks])

  // 24h 分成 12 个 2h 区间；同一区间的番茄并列显示。
  const timeline = useMemo(() => {
    const bins: { id: string; time: string; title: string }[][] = Array.from(
      { length: 12 },
      () => [],
    )
    if (!isDay) return bins
    const list = tomatoes
      .filter((tomato) => tomato.ts >= dayStart && tomato.ts < dayStart + DAY_MS)
      .sort((a, b) => a.ts - b.ts)
    for (const tomato of list) {
      const d = new Date(tomato.ts)
      const bin = Math.min(11, Math.floor(d.getHours() / 2))
      bins[bin].push({
        id: tomato.id,
        time: `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
        title: tasks.find((task) => task.id === tomato.taskId)?.title ?? '已删除任务',
      })
    }
    return bins
  }, [tomatoes, tasks, dayStart, isDay])

  const weekDaySlices = useMemo(() => {
    if (isDay) return [] as TaskSlice[][]
    return WEEKDAY_LABELS.map((_, index) => {
      const from = weekBase + index * DAY_MS
      return sliceTasks(tomatoes, tasks, from, from + DAY_MS)
    })
  }, [tomatoes, tasks, weekBase, isDay])
  const weekTotals = weekDaySlices.map((slices) =>
    slices.reduce((sum, item) => sum + item.count, 0),
  )
  const weekMax = Math.max(...weekTotals, 1)
  const weekSlices = useMemo(
    () => (isDay ? [] : sliceTasks(tomatoes, tasks, weekBase, weekBase + 7 * DAY_MS)),
    [tomatoes, tasks, weekBase, isDay],
  )
  const style = { '--accent': accent } as React.CSSProperties

  return (
    <div className="stats" style={style}>
      <section className="chart-card">
        <div className="chart-head">
          <h3>
            {isDay
              ? `日表 · ${dateLabel(dayStart)}`
              : `周表 · ${dateLabel(weekBase)}–${dateLabel(weekBase + 6 * DAY_MS)}`}
          </h3>
          <div className="seg-group">
            <div className="seg">
              <button
                className={period === 'today' ? 'active' : ''}
                onClick={() => setPeriod('today')}
              >
                今天
              </button>
              <button
                className={period === 'yesterday' ? 'active' : ''}
                onClick={() => setPeriod('yesterday')}
              >
                昨天
              </button>
            </div>
            <div className="seg">
              <button
                className={period === 'thisWeek' ? 'active' : ''}
                onClick={() => setPeriod('thisWeek')}
              >
                本周
              </button>
              <button
                className={period === 'lastWeek' ? 'active' : ''}
                onClick={() => setPeriod('lastWeek')}
              >
                上周
              </button>
            </div>
          </div>
        </div>

        {isDay ? (
          <>
            <div className="day-summary">
              <span className="day-number">
                {dayTotal}
                <em>个</em>
              </span>
              <span className="day-hours">{hoursText(dayTotal)}</span>
            </div>
            <div className="stack-track">
              <div className="stack" style={{ width: `${(dayTotal / dayMax) * 100}%` }}>
                {daySlices.map((item) => (
                  <i
                    key={item.taskId}
                    style={{ flexGrow: item.count, background: colors.get(item.taskId) }}
                  />
                ))}
              </div>
            </div>

            <div className="timeline">
              <div
                className="timeline-bins"
                style={{ height: Math.max(26, Math.max(...timeline.map((bin) => bin.length), 1) * 16 + 6) }}
              >
                {timeline.map((bin, index) => (
                  <div className="timeline-bin" key={index}>
                    <div className="timeline-bin-inner">
                      {bin.map((item) => (
                        <span
                          className="timeline-tomato"
                          key={item.id}
                          title={`${item.time} · ${item.title}`}
                        >
                          🍅
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <div className="timeline-axis">
                {[0, 6, 12, 18, 24].map((hour) => (
                  <span
                    className={`axis-label ${hour === 0 ? 'first' : ''} ${hour === 24 ? 'last' : ''}`}
                    style={{ left: `${(hour / 24) * 100}%` }}
                    key={hour}
                  >
                    {hour === 24 ? '24时' : `${hour}时`}
                  </span>
                ))}
              </div>
            </div>

            <Breakdown items={daySlices} colors={colors} />
          </>
        ) : (
          <>
            <div className="chart">
              {WEEKDAY_LABELS.map((label, index) => {
                const total = weekTotals[index]
                const isToday = weekBase + index * DAY_MS === today
                return (
                  <div className={`chart-col ${isToday ? 'today' : ''}`} key={label}>
                    <div className="col-plot">
                      {total > 0 && <span className="bar-hours">{total * 0.5}h</span>}
                      <div className="bar-stack" style={{ height: `${(total / weekMax) * 100}%` }}>
                        {weekDaySlices[index].map((item) => (
                          <i
                            key={item.taskId}
                            style={{
                              flexGrow: item.count,
                              background: colors.get(item.taskId),
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="chart-day">{label}</div>
                  </div>
                )
              })}
            </div>
            <Breakdown items={weekSlices} colors={colors} />
          </>
        )}
      </section>
    </div>
  )
}

function SettingsList() {
  return (
    <div className="settings-hint">
      <div className="section-label">设置</div>
      <p>右侧调整主题、便签大小、音效、快捷键和自启。</p>
      <p className="muted">所有设置即时保存。</p>
    </div>
  )
}

function SettingsPanel(props: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onThemeChange: (key: keyof Settings['theme'], value: string) => void
  onWidgetSize: (width: number, height: number) => void
  onHotkey: (hotkey: string) => void
  onSoundPick: () => void
  onTestSound: () => void
  onAutostart: (enabled: boolean) => void
  onExport: () => void
  onImport: () => void
  onOpenDataDir: () => void
  onDeleteAll: () => void
}) {
  const { settings, onChange, onThemeChange } = props
  const [width, setWidth] = useState(String(settings.widgetWidth))
  const [height, setHeight] = useState(String(settings.widgetHeight))
  const [hotkey, setHotkeyDraft] = useState(settings.hotkey)

  useEffect(() => {
    setWidth(String(settings.widgetWidth))
    setHeight(String(settings.widgetHeight))
    setHotkeyDraft(settings.hotkey)
  }, [settings.widgetWidth, settings.widgetHeight, settings.hotkey])

  return (
    <div className="settings">
      <section className="settings-section">
        <h3>外观</h3>
        <div className="theme-row">
          <ColorField
            label="背景"
            value={settings.theme.bg}
            onChange={(value) => onThemeChange('bg', value)}
          />
          <ColorField
            label="文字"
            value={settings.theme.text}
            onChange={(value) => onThemeChange('text', value)}
          />
          <ColorField
            label="强调色"
            value={settings.theme.accent}
            onChange={(value) => onThemeChange('accent', value)}
          />
        </div>
        <div
          className="theme-preview"
          style={{
            background: settings.theme.bg,
            color: settings.theme.text,
            borderColor: settings.theme.accent,
          }}
        >
          <span>待办</span>
          <span style={{ color: settings.theme.accent }}>🍅 3</span>
        </div>
      </section>

      <section className="settings-section">
        <h3>便签大小</h3>
        <div className="inline-fields">
          <label className="field">
            <span className="field-label">宽度</span>
            <input
              type="number"
              min={240}
              max={720}
              value={width}
              onChange={(event) => setWidth(event.target.value)}
            />
          </label>
          <label className="field">
            <span className="field-label">高度</span>
            <input
              type="number"
              min={240}
              max={1000}
              value={height}
              onChange={(event) => setHeight(event.target.value)}
            />
          </label>
          <button
            onClick={() =>
              props.onWidgetSize(Number(width) || settings.widgetWidth, Number(height) || settings.widgetHeight)
            }
          >
            应用
          </button>
        </div>
      </section>

      <section className="settings-section">
        <h3>番茄音效</h3>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={settings.soundEnabled}
            onChange={(event) => onChange({ soundEnabled: event.target.checked })}
          />
          <span>贴番茄时播放音效</span>
        </label>
        <label className="field">
          <span className="field-label">音量 · {Math.round(settings.soundVolume * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={settings.soundVolume}
            onChange={(event) => onChange({ soundVolume: Number(event.target.value) })}
          />
        </label>
        <div className="inline-fields">
          <button onClick={props.onSoundPick}>选择音效文件…</button>
          <button onClick={props.onTestSound}>试听</button>
        </div>
        <p className="muted small">
          {settings.soundPath ? `当前：${settings.soundPath.split(/[\\/]/).pop()}` : '当前：内置音效'}
        </p>
      </section>

      <section className="settings-section">
        <h3>快捷键</h3>
        <div className="inline-fields">
          <input
            className="hotkey-input"
            value={hotkey}
            onChange={(event) => setHotkeyDraft(event.target.value)}
            placeholder="ctrl+alt+e"
          />
          <button onClick={() => props.onHotkey(hotkey.trim())}>保存</button>
        </div>
        <p className="muted small">格式：ctrl+alt+e、ctrl+shift+space 等。</p>
      </section>

      <section className="settings-section">
        <h3>启动</h3>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={settings.autostart}
            onChange={(event) => props.onAutostart(event.target.checked)}
          />
          <span>开机自动启动</span>
        </label>
      </section>

      <section className="settings-section">
        <h3>数据</h3>
        <div className="inline-fields">
          <button onClick={props.onExport}>导出备份</button>
          <button onClick={props.onImport}>导入备份</button>
        </div>
        <p className="muted small">数据保存在 %APPDATA%\Sotto\data.json，每天自动备份 7 份。</p>
        <div className="inline-fields">
          <button onClick={props.onOpenDataDir}>打开数据目录</button>
        </div>
      </section>

      <section className="settings-section">
        <h3>关于</h3>
        <p className="muted small">Sotto v2.0.0 · Windows 11 桌面便签</p>
      </section>

      <section className="settings-section danger-zone">
        <h3>危险操作</h3>
        <button className="danger" onClick={props.onDeleteAll}>
          删除全部进行中的任务
        </button>
      </section>
    </div>
  )
}

function ColorField(props: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="color-field">
      <span className="field-label">{props.label}</span>
      <span className="color-wrap" style={{ background: props.value }}>
        <input
          type="color"
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </span>
      <code>{props.value}</code>
    </label>
  )
}

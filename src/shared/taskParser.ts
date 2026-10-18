import type { DisplayLine, Task, TaskDocument } from './types'

const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/
const CHECKBOX = /^\[([ xX])\](?:[ \t]+(.*))?$/
// 缩进由 fenceInfo 结合列表上下文判断：列表项内的围栏可以缩进 4 格以上。
const FENCE = /^([ \t]*)(`{3,}|~{3,})(.*)$/
const H1 = /^#[ \t]+(.+?)[ \t]*$/

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export function normalizeNewlines(text: string): string {
  return stripBom(text).replace(/\r\n?/g, '\n')
}

export function leadingColumns(whitespace: string): number {
  let column = 0
  for (const ch of whitespace) {
    if (ch === '\t') column += 4 - (column % 4)
    else column += 1
  }
  return column
}

function isBlockquote(line: string): boolean {
  return line.replace(/^[ \t]*/, '').startsWith('>')
}

function fenceInfo(line: string): { char: string; length: number; rest: string; indent: number } | null {
  const match = FENCE.exec(line)
  if (!match) return null
  const fence = match[2]
  return {
    char: fence[0],
    length: fence.length,
    rest: match[3],
    indent: leadingColumns(match[1]),
  }
}

function isFrontMatterStart(lines: string[]): number {
  if (lines.length === 0 || lines[0].trim() !== '---') return 0
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim()
    if (trimmed === '---' || trimmed === '...') return i + 1
  }
  return 0
}

export function parseTaskDocument(raw: string): TaskDocument {
  const normalized = normalizeNewlines(raw)
  const lines = normalized.split('\n')
  const tasks: Task[] = []
  const content: DisplayLine[] = []
  const indentationStack: number[] = []
  let title: string | null = null
  let titleLine = -1
  let fence: { char: string; length: number } | null = null
  let inComment = false
  const start = isFrontMatterStart(lines)

  for (let lineIndex = start; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]

    if (fence) {
      const info = fenceInfo(line)
      if (info && info.char === fence.char && info.length >= fence.length) {
        fence = null
      }
      continue
    }

    const openingFence = fenceInfo(line)
    // 顶层缩进 >= 4 的是缩进代码块；列表项内部的围栏按列表内容缩进判断。
    if (openingFence && (indentationStack.length > 0 || openingFence.indent <= 3)) {
      fence = { char: openingFence.char, length: openingFence.length }
      continue
    }

    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    const commentStart = line.indexOf('<!--')
    if (commentStart >= 0 && line.slice(0, commentStart).trim().length === 0) {
      if (!line.slice(commentStart + 4).includes('-->')) inComment = true
      continue
    }

    if (isBlockquote(line)) continue

    if (title === null) {
      const h1 = H1.exec(line)
      if (h1) {
        title = h1[1].trim()
        titleLine = lineIndex
      }
    }

    if (line.trim().length === 0) continue

    const leading = line.match(/^[ \t]*/)?.[0] ?? ''
    const lineIndent = leadingColumns(leading)
    if (indentationStack.length === 0 && lineIndent >= 4) {
      // 顶层缩进 >= 4 的文本视为缩进代码块，不当作任务。
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (!item) {
      // 标题行已作为组件标题，正文里的普通文本按原样显示。
      if (lineIndex === titleLine) continue
      const text = line.replace(/^[ \t]{0,3}#{1,6}[ \t]+/, '').trim()
      if (text.length === 0) continue
      const depth =
        indentationStack.length > 0 &&
        lineIndent > indentationStack[indentationStack.length - 1]
          ? indentationStack.length
          : 0
      content.push({ id: `line-${lineIndex}`, line: lineIndex, depth, task: null, text })
      continue
    }

    const itemIndent = leadingColumns(item[1])
    while (indentationStack.length > 0 && itemIndent <= indentationStack[indentationStack.length - 1]) {
      indentationStack.pop()
    }
    const depth = indentationStack.length
    indentationStack.push(itemIndent)

    const rest = item[4]
    const check = CHECKBOX.exec(rest)
    if (!check) {
      // 普通列表项也显示，只是没有完成状态。
      const plain = rest.trimEnd()
      if (plain.length > 0) {
        content.push({ id: `line-${lineIndex}`, line: lineIndex, depth, task: null, text: plain })
      }
      continue
    }

    const checked = check[1].toLowerCase() === 'x'
    const text = (check[2] ?? '').trimEnd()
    const task: Task = {
      id: `task-${lineIndex}`,
      index: tasks.length,
      line: lineIndex,
      depth,
      checked,
      text,
    }
    tasks.push(task)
    // 空任务仍计入进度，但没有可显示的文字，不占组件行数。
    if (text.length > 0) {
      content.push({ id: `line-${lineIndex}`, line: lineIndex, depth, task, text })
    }
  }

  return { title, tasks, content, lines, lineCount: lines.length }
}

export function toggleTaskAtLine(source: string, lineIndex: number, checked: boolean): string {
  const lines = source.split('\n')
  if (lineIndex < 0 || lineIndex >= lines.length) return source
  const line = lines[lineIndex]
  const match = /^([ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](.*)$/.exec(line)
  if (!match) return source
  lines[lineIndex] = `${match[1]}[${checked ? 'x' : ' '}]${match[3]}`
  return lines.join('\n')
}

export interface ListContinuation {
  /** 新行在列表标记之后的内容起点（相对行首的字符数）。 */
  contentStart: number
  /** 下一行要插入的缩进 + 标记 + 间隔（任务项再带 `[ ] `）。 */
  insert: string
}

/** 按当前行生成回车续写内容；非列表行返回 null。 */
export function listContinuation(line: string): ListContinuation | null {
  const match = LIST_ITEM.exec(line)
  if (!match) return null
  const [, indent, marker, spacing, rest] = match
  const ordered = /^(\d+)([.)])$/.exec(marker)
  const nextMarker = ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker
  const isTask = CHECKBOX.test(rest)
  return {
    contentStart: indent.length + marker.length + spacing.length,
    insert: `${indent}${nextMarker}${spacing}${isTask ? '[ ] ' : ''}`,
  }
}

/** 返回任务自身及其全部后代（按文档顺序）。 */
export function taskSubtree(tasks: Task[], id: string): Task[] {
  const { children } = buildTaskHierarchy(tasks)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const result: Task[] = []
  const walk = (taskId: string): void => {
    const task = byId.get(taskId)
    if (!task) return
    result.push(task)
    for (const childId of children.get(taskId) ?? []) walk(childId)
  }
  walk(id)
  return result
}

export function getProgress(tasks: Task[]): { completed: number; total: number } {
  return { completed: tasks.filter((task) => task.checked).length, total: tasks.length }
}

export interface TaskHierarchy {
  parents: Map<string, string | null>
  children: Map<string, string[]>
}

export function buildTaskHierarchy(tasks: Task[]): TaskHierarchy {
  const parents = new Map<string, string | null>()
  const children = new Map<string, string[]>()
  const stack: Task[] = []

  for (const task of tasks) {
    while (stack.length > 0 && stack[stack.length - 1].depth >= task.depth) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1] : null
    parents.set(task.id, parent?.id ?? null)
    if (parent) {
      const siblings = children.get(parent.id) ?? []
      siblings.push(task.id)
      children.set(parent.id, siblings)
    }
    stack.push(task)
  }

  return { parents, children }
}

function descendantsComplete(
  task: Task,
  children: Map<string, string[]>,
  byId: Map<string, Task>,
  memo: Map<string, boolean>,
): boolean {
  const cached = memo.get(task.id)
  if (cached !== undefined) return cached
  const kids = children.get(task.id) ?? []
  const result = kids.every((id) => {
    const child = byId.get(id)
    if (!child) return true
    return child.checked && descendantsComplete(child, children, byId, memo)
  })
  memo.set(task.id, result)
  return result
}

export function getVisibleTasks(tasks: Task[], hideCompleted: boolean): Task[] {
  if (!hideCompleted) return tasks
  const { children } = buildTaskHierarchy(tasks)
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const memo = new Map<string, boolean>()
  const hidden = new Set<string>()

  for (const task of tasks) {
    if (hidden.has(task.id)) continue
    if (!task.checked) continue

    const kids = children.get(task.id) ?? []
    const allDescendantsDone = kids.every((id) => {
      const child = byId.get(id)
      return child ? child.checked && descendantsComplete(child, children, byId, memo) : true
    })

    // 已完成父项还有未完成后代时，保留父项上下文。
    if (kids.length > 0 && !allDescendantsDone) continue

    hidden.add(task.id)
    const collect = (id: string): void => {
      hidden.add(id)
      for (const childId of children.get(id) ?? []) collect(childId)
    }
    for (const id of kids) collect(id)
  }

  return tasks.filter((task) => !hidden.has(task.id))
}

export function findTaskByLine(tasks: Task[], lineIndex: number): Task | undefined {
  return tasks.find((task) => task.line === lineIndex)
}

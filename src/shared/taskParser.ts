import type { Task, TaskDocument } from './types'

const LIST_ITEM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)(.*)$/
const CHECKBOX = /^\[([ xX])\](?:[ \t]+(.*))?$/
const FENCE = /^([ \t]{0,3})(`{3,}|~{3,})(.*)$/
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

function fenceInfo(line: string): { char: string; length: number; rest: string } | null {
  const match = FENCE.exec(line)
  if (!match) return null
  const fence = match[2]
  return { char: fence[0], length: fence.length, rest: match[3] }
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
  const indentationStack: number[] = []
  let title: string | null = null
  let fence: { char: string; length: number } | null = null
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
    if (openingFence) {
      fence = { char: openingFence.char, length: openingFence.length }
      continue
    }

    if (isBlockquote(line)) continue

    if (title === null) {
      const h1 = H1.exec(line)
      if (h1) title = h1[1].trim()
    }

    const leading = line.match(/^[ \t]*/)?.[0] ?? ''
    const lineIndent = leadingColumns(leading)
    if (indentationStack.length === 0 && lineIndent >= 4) {
      // 顶层缩进 >= 4 的文本视为缩进代码块，不当作任务。
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (!item) continue

    const itemIndent = leadingColumns(item[1])
    while (indentationStack.length > 0 && itemIndent <= indentationStack[indentationStack.length - 1]) {
      indentationStack.pop()
    }
    const depth = indentationStack.length
    indentationStack.push(itemIndent)

    const rest = item[4]
    const check = CHECKBOX.exec(rest)
    if (!check) continue

    const checked = check[1].toLowerCase() === 'x'
    const text = (check[2] ?? '').trimEnd()
    tasks.push({
      id: `task-${lineIndex}`,
      index: tasks.length,
      line: lineIndex,
      depth,
      checked,
      text,
    })
  }

  return { title, tasks, lines, lineCount: lines.length }
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

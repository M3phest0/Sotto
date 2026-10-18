import { describe, expect, it } from 'vitest'
import {
  getProgress,
  getVisibleTasks,
  listContinuation,
  normalizeNewlines,
  parseTaskDocument,
  taskSubtree,
  toggleTaskAtLine,
} from '../src/shared/taskParser'

describe('parseTaskDocument', () => {
  it('parses nested and ordered tasks with depth', () => {
    const doc = parseTaskDocument(`# 今日\n\n- [ ] top\n  - [ ] child\n    1. [x] grand\n- [X] done\n`)
    expect(doc.title).toBe('今日')
    expect(doc.tasks).toHaveLength(4)
    expect(doc.tasks.map((task) => task.depth)).toEqual([0, 1, 2, 0])
    expect(doc.tasks.map((task) => task.checked)).toEqual([false, false, true, true])
    expect(doc.tasks[2].text).toBe('grand')
  })

  it('skips blockquote, fenced code, indented code, and table cells', () => {
    const doc = parseTaskDocument(
      [
        '# T',
        '> - [ ] quoted',
        '```md',
        '- [ ] fenced',
        '```',
        '    - [ ] indented code',
        '| - [ ] table cell |',
        '- [ ] real',
      ].join('\n'),
    )
    expect(doc.tasks.map((task) => task.text)).toEqual(['real'])
  })

  it('skips YAML front matter only when closed', () => {
    const closed = parseTaskDocument('---\ntitle: x\n- [ ] hidden\n---\n- [ ] visible\n')
    expect(closed.tasks.map((task) => task.text)).toEqual(['visible'])

    const open = parseTaskDocument('---\n- [ ] not front matter\n')
    expect(open.tasks.map((task) => task.text)).toEqual(['not front matter'])
  })

  it('normalizes CRLF and BOM', () => {
    const doc = parseTaskDocument('\uFEFF# T\r\n\r\n- [ ] a\r\n- [x] b\r\n')
    expect(doc.title).toBe('T')
    expect(doc.tasks.map((task) => task.checked)).toEqual([false, true])
    expect(normalizeNewlines('a\r\nb\rc')).toBe('a\nb\nc')
  })

  it('keeps non-task parent list items in the depth stack', () => {
    const doc = parseTaskDocument('- 非任务父项\n  - [ ] 子任务\n')
    expect(doc.tasks).toHaveLength(1)
    expect(doc.tasks[0].depth).toBe(1)
  })

  it('handles ordered markers and uppercase X', () => {
    const doc = parseTaskDocument('1) [X] done\n2. [ ] todo\n')
    expect(doc.tasks).toHaveLength(2)
    expect(doc.tasks[0].checked).toBe(true)
    expect(doc.tasks[0].depth).toBe(0)
  })
})

describe('parseTaskDocument content lines', () => {
  it('keeps plain text and non-task list items in document order', () => {
    const doc = parseTaskDocument(
      '# T\n\n今天先做这些：\n- [ ] 任务\n  备注一行\n- 普通条目\n\n## 小节\n段落\n',
    )
    expect(doc.content.map((line) => line.text)).toEqual([
      '今天先做这些：',
      '任务',
      '备注一行',
      '普通条目',
      '小节',
      '段落',
    ])
    expect(doc.content[0].task).toBeNull()
    expect(doc.content[1].task?.checked).toBe(false)
    expect(doc.content[1].depth).toBe(0)
    expect(doc.content[2].depth).toBe(1)
  })

  it('keeps empty tasks in progress but not in display lines', () => {
    const doc = parseTaskDocument('- [ ] 有字\n- [ ] \n看B站\n')
    expect(doc.tasks).toHaveLength(2)
    expect(doc.content.map((line) => line.text)).toEqual(['有字', '看B站'])
  })

  it('skips the title, front matter, blockquotes, and code blocks', () => {
    const doc = parseTaskDocument('---\ntitle: x\n---\n# T\n> quote\n```\ncode\n```\n正文\n')
    expect(doc.content.map((line) => line.text)).toEqual(['正文'])
  })
})

describe('toggleTaskAtLine', () => {
  it('toggles only the checkbox and preserves the rest', () => {
    const source = '# T\n\n- [ ] a **bold**\n  - [x] child\n'
    const next = toggleTaskAtLine(source, 2, true)
    expect(next).toBe('# T\n\n- [x] a **bold**\n  - [x] child\n')
    expect(toggleTaskAtLine(next, 2, false)).toBe(source)
  })

  it('returns the source unchanged for non-task lines', () => {
    const source = '# T\n- [ ] a\n'
    expect(toggleTaskAtLine(source, 0, true)).toBe(source)
  })
})

describe('listContinuation', () => {
  it('continues task bullets, indentation, and ordered numbers', () => {
    expect(listContinuation('- [ ] top')?.insert).toBe('- [ ] ')
    expect(listContinuation('  - [x] child')?.insert).toBe('  - [ ] ')
    expect(listContinuation('1. [ ] one')?.insert).toBe('2. [ ] ')
    expect(listContinuation('3) [x] three')?.insert).toBe('4) [ ] ')
    expect(listContinuation('- plain')?.insert).toBe('- ')
  })

  it('returns null for non-list lines', () => {
    expect(listContinuation('normal text')).toBeNull()
    expect(listContinuation('> - [ ] quote')).toBeNull()
  })
})

describe('taskSubtree', () => {
  it('returns the task and all descendants in document order', () => {
    const doc = parseTaskDocument(
      '- [ ] a\n  - [ ] a1\n    - [ ] a1a\n  - [ ] a2\n- [ ] b\n',
    )
    expect(taskSubtree(doc.tasks, doc.tasks[0].id).map((task) => task.text)).toEqual([
      'a',
      'a1',
      'a1a',
      'a2',
    ])
    expect(taskSubtree(doc.tasks, doc.tasks[1].id).map((task) => task.text)).toEqual([
      'a1',
      'a1a',
    ])
  })
})

describe('visibility and progress', () => {
  const tasks = parseTaskDocument(
    [
      '- [ ] parent',
      '  - [x] child done',
      '  - [ ] child open',
      '- [x] leaf done',
      '- [ ] other',
    ].join('\n'),
  ).tasks

  it('hides a completed leaf but keeps a completed parent with open descendants', () => {
    const visible = getVisibleTasks(tasks, true)
    expect(visible.map((task) => task.text)).toEqual(['parent', 'child open', 'other'])
  })

  it('hides the whole subtree when a completed parent has all descendants done', () => {
    const doc = parseTaskDocument('- [x] parent\n  - [x] child\n- [ ] other\n')
    const visible = getVisibleTasks(doc.tasks, true)
    expect(visible.map((task) => task.text)).toEqual(['other'])
  })

  it('counts nested tasks in progress', () => {
    expect(getProgress(tasks)).toEqual({ completed: 2, total: 5 })
  })
})

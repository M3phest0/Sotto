import { describe, expect, it } from 'vitest'
import { parseTaskDocument } from '../src/shared/taskParser'

describe('round 2 parser findings', () => {
  it('skips a fenced code block indented four spaces inside a list', () => {
    const doc = ['- [ ] 父项', '    ```', '    - [ ] 假任务', '    ```', '- [ ] 真任务', ''].join('\n')
    const parsed = parseTaskDocument(doc)
    expect(parsed.tasks.map((task) => task.text)).toEqual(['父项', '真任务'])
    expect(parsed.content.map((line) => line.text)).toEqual(['父项', '真任务'])
  })

  it('ignores task lines inside an HTML comment', () => {
    const doc = ['<!--', '- [ ] 注释里的任务', '-->', '- [ ] 真任务', ''].join('\n')
    const parsed = parseTaskDocument(doc)
    expect(parsed.tasks.map((task) => task.text)).toEqual(['真任务'])
    expect(parsed.content.map((line) => line.text)).toEqual(['真任务'])
  })

  // 正常行为：很深的缩进仍然线性解析，不爆栈。保留为回归。
  it('parses deeply nested lists without recursion errors', () => {
    const lines: string[] = []
    for (let i = 0; i < 1200; i += 1) lines.push(`${' '.repeat(i)}- [ ] 项 ${i}`)
    const parsed = parseTaskDocument(`${lines.join('\n')}\n`)
    expect(parsed.tasks).toHaveLength(1200)
    expect(parsed.tasks.at(-1)?.depth).toBe(1199)
  })
})

import { expect, test, type Page } from '@playwright/test'

const SETTINGS = { autostartAsked: true, hideCompleted: false }

async function openWidget(
  page: Page,
  doc: string,
  settings: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ({ text, values }) => {
      localStorage.clear()
      localStorage.setItem('sotto:autostart-asked', '1')
      localStorage.setItem('sotto:document', text)
      localStorage.setItem('sotto:settings', JSON.stringify(values))
    },
    { text: doc, values: { ...SETTINGS, ...settings } },
  )
  await page.goto('/')
}

test('plain text only', async ({ page }) => {
  await openWidget(page, '第一行笔记\n第二行笔记\n\n第三行笔记\n')
  await expect(page.getByTestId('widget-title')).toHaveText('Sotto')
  await expect(page.getByTestId('task-row')).toHaveCount(0)
  await expect(page.getByTestId('text-row')).toHaveCount(3)
  await expect(page.locator('.widget-progress')).toHaveText('0/0')
  await expect(page.getByTestId('widget-footer')).toHaveText('点击展开')
})

test('mixed text, tasks, non-task bullets, tabs', async ({ page }) => {
  const doc = [
    '# 标题',
    '',
    '一段说明',
    '- [ ] 任务A',
    '  任务A备注',
    '- 普通条目',
    '  - [ ] 子任务',
    '\t- [ ] tab任务',
    '',
  ].join('\n')
  await openWidget(page, doc, { compact: 10, expanded: 15 })
  await expect(page.getByTestId('widget-title')).toHaveText('标题')
  await expect(page.getByTestId('text-row')).toHaveCount(3)
  await expect(page.getByTestId('task-row')).toHaveCount(3)
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['一段说明', '任务A', '任务A备注', '普通条目', '子任务', 'tab任务'])
  const pads = await page
    .locator('.task-row')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).style.paddingLeft))
  expect(pads).toEqual(['8px', '8px', '24px', '8px', '24px', '40px'])
})

test('hide completed keeps text and open parent context', async ({ page }) => {
  const doc = [
    '# T',
    '- [x] 已完成任务',
    '- [ ] 未完成',
    '文字行',
    '- [x] 完成父项',
    '  - [ ] 未完子项',
    '  - [x] 完成子项',
    '',
  ].join('\n')
  await openWidget(page, doc, { hideCompleted: true })
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['未完成', '文字行', '完成父项', '未完子项'])
})

test('skips front matter, blockquote, code blocks, indented code', async ({ page }) => {
  const doc = ['---', 'title: x', '---', '# T', '> 引用', '```', '代码', '```', '    缩进代码', '正文', ''].join(
    '\n',
  )
  await openWidget(page, doc)
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['正文'])
})

test('CRLF and BOM', async ({ page }) => {
  await openWidget(page, '﻿# T\r\n\r\n- [ ] a\r\n文字\r\n')
  await expect(page.getByTestId('widget-title')).toHaveText('T')
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['a', '文字'])
})

test('overflow expands and reports remaining lines', async ({ page }) => {
  const doc = ['# T', '一', '二', '三', '四', '五', '六', '七', '八', ''].join('\n')
  await openWidget(page, doc, { compact: 3, expanded: 5 })
  await expect(page.getByTestId('text-row')).toHaveCount(3)
  await expect(page.getByTestId('widget-footer')).toHaveText('还有 5 条')
  await page.getByTestId('widget-card').click()
  await expect(page.getByTestId('text-row')).toHaveCount(5)
  await expect(page.getByTestId('widget-footer')).toHaveText('还有 3 条')
  await page.getByTestId('task-viewport').hover()
  await page.mouse.wheel(0, 600)
  await expect(page.getByTestId('widget-footer')).toHaveText('已到底')
  await page.waitForTimeout(350)
  await page.getByTestId('widget-card').click()
  await expect(page.getByTestId('widget-footer')).toHaveText('还有 5 条')
})

test('all completed with hideCompleted shows completion', async ({ page }) => {
  await openWidget(page, '- [x] a\n- [x] b\n', { hideCompleted: true })
  await expect(page.getByTestId('empty-state')).toHaveText('全部完成')
  await expect(page.getByTestId('widget-footer')).toHaveText('全部完成')
})

test('inline markdown renders and links stay inert', async ({ page }) => {
  await openWidget(page, '**加粗** 和 `代码` 以及 [链接](https://example.com)\n')
  const row = page.getByTestId('text-row')
  await expect(row.locator('strong')).toHaveText('加粗')
  await expect(row.locator('code')).toHaveText('代码')
  await expect(row.locator('a')).toHaveCount(0)
  await expect(row.locator('.md-link')).toHaveText('链接')
})

test('title heading is not repeated as a content row', async ({ page }) => {
  await openWidget(page, '# 唯一标题\n- [ ] a\n## 小节\n')
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['a', '小节'])
})

// 回归：注释行必须跟随被隐藏的已完成父项一起隐藏。
test('note text under a hidden completed task is hidden with its parent', async ({ page }) => {
  await openWidget(page, '- [x] 完成父项\n  隐藏备注\n- [ ] 其他\n', { hideCompleted: true })
  const texts = await page.locator('.task-row .task-text').allTextContents()
  expect(texts).toEqual(['其他'])
})

test('raw HTML is escaped', async ({ page }) => {
  await openWidget(page, '<img src=x onerror=alert(1)> 文本\n')
  const row = page.getByTestId('text-row')
  await expect(row.locator('img')).toHaveCount(0)
  await expect(row).toContainText('<img src=x onerror=alert(1)> 文本')
})

test('settings changes reach the widget through sync', async ({ context }) => {
  const widget = await context.newPage()
  await openWidget(widget, '# T\n一\n二\n三\n四\n五\n六\n', { compact: 3, expanded: 5 })
  await expect(widget.getByTestId('text-row')).toHaveCount(3)

  const editor = await context.newPage()
  await editor.goto('/editor.html')
  await editor.getByRole('button', { name: '设置' }).click()
  await editor.locator('.setting-field', { hasText: '紧凑条数' }).locator('input').fill('4')
  await expect(widget.getByTestId('text-row')).toHaveCount(4)

  await editor.locator('.setting-field', { hasText: '主题' }).locator('select').selectOption('acrylic')
  await expect(widget.getByTestId('widget')).toHaveClass(/theme-acrylic/)
})

test('editor enter mid-task splits into a new task', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] abc\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  const pos = await textarea.evaluate((el) => (el as HTMLTextAreaElement).value.indexOf('abc') + 2)
  await textarea.evaluate((el, p) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(p, p)
  }, pos)
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('- [ ] ab\n- [ ] c\n')
})

test('editor enter after an empty task line keeps the marker', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] \n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(6, 6)
  })
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('- [ ] \n- [ ] \n')
})

test('editor tab and shift+tab', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '    - [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(area.value.length - 1, area.value.length - 1)
  })
  await textarea.press('Shift+Tab')
  await expect(textarea).toHaveValue('- [ ] a\n')
  await textarea.press('End')
  await textarea.press('Tab')
  await expect(textarea).toHaveValue('- [ ] a    \n')
})

test('editor plain-text Enter is a normal newline', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '普通文本\n- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  const pos = await textarea.evaluate((el) => (el as HTMLTextAreaElement).value.indexOf('普通文本') + 4)
  await textarea.evaluate((el, p) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(p, p)
  }, pos)
  await textarea.press('Enter')
  await expect(textarea).toHaveValue('普通文本\n\n- [ ] a\n')
})

// 回归：级联勾选后 Ctrl+Z 必须一次还原整棵子树。
test('editor undo after cascade restores every child', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] 父项\n  - [ ] 子项\n- [ ] 其他\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  const parent = page.locator('.editor-task-row input').first()
  await parent.click()
  if (!(await textarea.inputValue()).includes('- [x] 父项')) await parent.click()
  await expect(textarea).toHaveValue(/- \[x\] 父项\n {2}- \[x\] 子项/)

  await textarea.press('Control+z')
  await page.waitForTimeout(300)
  const afterUndo = await textarea.inputValue()
  expect(afterUndo).toBe('- [ ] 父项\n  - [ ] 子项\n- [ ] 其他\n')
})

test('editor undo after plain typing (baseline)', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', 'abc\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(3, 3)
  })
  await textarea.press('d')
  await expect(textarea).toHaveValue('abcd\n')
  await textarea.press('Control+z')
  await page.waitForTimeout(300)
  const afterUndo = await textarea.inputValue()
  expect(afterUndo).toBe('abc\n')
})

// 注意：浏览器视口较宽时 480px 生效；原生窗口固定 384 逻辑像素，
// 实际会被 max-width: calc(100vw - 24px) 夹到 360px。见使用测试报告“宽度设置”。
test('widget applies width and font size settings in a wide viewport', async ({ page }) => {
  await openWidget(page, '# T\n- [ ] a\n', { width: 480, fontSize: 20 })
  const card = page.getByTestId('widget-card')
  await expect(card).toHaveCSS('width', '480px')
  await expect(card).toHaveCSS('font-size', '20px')
})

test('editor close confirm appears and can be cancelled', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.fill('- [ ] a\nb\n')
  await page.getByRole('button', { name: '关闭编辑窗口' }).click()
  const dialog = page.getByRole('dialog', { name: '关闭编辑窗口' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
})

test('editor ctrl+s saves immediately', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.fill('- [ ] a\n新增\n')
  await textarea.press('Control+s')
  await expect(page.getByTestId('save-state')).toHaveText('已保存')
  const stored = await page.evaluate(() => localStorage.getItem('sotto:document'))
  expect(stored).toBe('- [ ] a\n新增\n')
})

test('editor settings persist after reload', async ({ page }) => {
  await page.goto('/editor.html')
  await page.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
  })
  await page.reload()
  await page.getByRole('button', { name: '设置' }).click()
  await page.locator('.setting-field', { hasText: '字号' }).locator('input').fill('18')
  await page.waitForTimeout(300)
  await page.reload()
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.setting-field', { hasText: '字号' }).locator('input')).toHaveValue('18')
})

test('editor autosave persists typed text', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.fill('- [ ] a\n追加一行\n')
  await expect(page.getByTestId('save-state')).toHaveText('已保存', { timeout: 4000 })
  const stored = await page.evaluate(() => localStorage.getItem('sotto:document'))
  expect(stored).toBe('- [ ] a\n追加一行\n')
})

// 回归：输入后 250ms 内点击预览任务，第一次点击必须生效。
test('rapid typing then toggling a preview task applies on first click', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(area.value.length - 1, area.value.length - 1)
  })
  await textarea.press('b')
  await page.locator('.editor-task-row input').first().click()
  await expect(textarea).toHaveValue('- [x] ab\n')
})

// 回归：只有空任务时不得显示“全部完成”。
test('empty tasks only do not claim completion', async ({ page }) => {
  await openWidget(page, '- [ ] \n- [ ] \n')
  await expect(page.locator('.widget-progress')).toHaveText('0/2')
  await expect(page.getByTestId('empty-state')).toContainText('没有任务')
})

test('tab with a selection indents without deleting the text', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '  - [ ] 子项一\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  const positions = await textarea.evaluate((el) => {
    const value = (el as HTMLTextAreaElement).value
    const start = value.indexOf('子项一')
    return [start, start + '子项一'.length]
  })
  await textarea.evaluate((el, [start, end]) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(start, end)
  }, positions)
  await textarea.press('Tab')
  await expect(textarea).toHaveValue('      - [ ] 子项一\n')
})

// 用 localStorage 配额溢出模拟保存失败。
test('save and close keeps the window open when the save fails', async ({ page }) => {
  test.setTimeout(60_000)
  await page.addInitScript(() => {
    ;(window as unknown as { closeCalled: boolean }).closeCalled = false
    window.close = () => {
      ;(window as unknown as { closeCalled: boolean }).closeCalled = true
    }
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
    // 预先占满配额，下一次保存 800KB 文档时必然触发 QuotaExceededError。
    localStorage.setItem('quota-filler', 'x'.repeat(4.8 * 1024 * 1024))
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await expect(textarea).toHaveValue('- [ ] a\n')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(area, '- [ ] a\n' + 'x'.repeat(800 * 1024))
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(page.getByTestId('save-state')).toHaveText('保存中')
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: '关闭编辑窗口' }).click()
  const dialog = page.getByRole('dialog', { name: '关闭编辑窗口' })
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect(page.getByTestId('save-state')).toHaveText('保存失败')
  await expect(dialog).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { closeCalled: boolean }).closeCalled)).toBe(false)
})

test('save and close closes after a successful save', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as unknown as { closeCalled: boolean }).closeCalled = false
    window.close = () => {
      ;(window as unknown as { closeCalled: boolean }).closeCalled = true
    }
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] a\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.fill('- [ ] a\n追加\n')
  await expect(page.getByTestId('save-state')).toHaveText('保存中')
  await page.waitForTimeout(100)
  await page.getByRole('button', { name: '关闭编辑窗口' }).click()
  await page.getByRole('button', { name: '保存并关闭' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { closeCalled: boolean }).closeCalled))
    .toBe(true)
  expect(await page.evaluate(() => localStorage.getItem('sotto:document'))).toBe('- [ ] a\n追加\n')
})

test('switching files prompts before discarding unsaved edits', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] 原标题\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.fill('- [ ] 修改后\n')
  await expect(page.getByTestId('save-state')).toHaveText('保存中')

  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles({
    name: 'new.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('- [ ] 新文件\n'),
  })

  const dialog = page.getByRole('dialog', { name: '切换文件' })
  await expect(dialog).toBeVisible()
  await expect(textarea).toHaveValue('- [ ] 修改后\n')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(textarea).toHaveValue('- [ ] 修改后\n')

  await textarea.fill('- [ ] 再次修改\n')
  await expect(page.getByTestId('save-state')).toHaveText('保存中')
  await fileInput.setInputFiles({
    name: 'new.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('- [ ] 新文件\n'),
  })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '放弃并切换' }).click()
  await expect(textarea).toHaveValue('- [ ] 新文件\n')
})

test('tab indents every selected line', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', '- [ ] 一\n- [ ] 二\n')
  })
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(0, area.value.length)
  })
  await textarea.press('Tab')
  await expect(textarea).toHaveValue('    - [ ] 一\n    - [ ] 二\n')
})

import { expect, test, type Page } from '@playwright/test'

async function openWidget(
  page: Page,
  doc: string,
  settings: Record<string, unknown> = {},
  extra: Record<string, string> = {},
): Promise<void> {
  await page.addInitScript(
    ({ text, values, entries }) => {
      localStorage.clear()
      localStorage.setItem('sotto:autostart-asked', '1')
      localStorage.setItem('sotto:document', text)
      localStorage.setItem('sotto:settings', JSON.stringify(values))
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    },
    { text: doc, values: { autostartAsked: true, hideCompleted: false, ...settings }, entries: extra },
  )
  await page.goto('/')
}

async function openEditor(
  page: Page,
  doc: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await page.addInitScript(
    ({ text, entries }) => {
      localStorage.clear()
      localStorage.setItem('sotto:autostart-asked', '1')
      localStorage.setItem('sotto:document', text)
      for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, value)
    },
    { text: doc, entries: extra },
  )
  await page.goto('/editor.html')
}

test('wheel over the header scrolls the task list', async ({ page }) => {
  const doc = ['# T', ...Array.from({ length: 29 }, (_, i) => `第 ${i + 1} 行`), ''].join('\n')
  await openWidget(page, doc, { compact: 3, expanded: 10 })
  await page.getByTestId('widget-card').click()
  await page.waitForTimeout(350)
  const viewport = page.getByTestId('task-viewport')
  await page.locator('.drag-strip').hover()
  await page.mouse.wheel(0, 200)
  await page.waitForTimeout(250)
  expect(await viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
})

test('expanded card height stays within 60% of the viewport', async ({ page }) => {
  const doc = ['# T', ...Array.from({ length: 29 }, (_, i) => `第 ${i + 1} 行`), ''].join('\n')
  await openWidget(page, doc, { compact: 5, expanded: 15 })
  await page.getByTestId('widget-card').click()
  await page.waitForTimeout(350)
  const height = await page.getByTestId('widget-card').evaluate((el) => el.getBoundingClientRect().height)
  const cap = (await page.evaluate(() => innerHeight)) * 0.6
  expect(height).toBeLessThanOrEqual(cap)
})

test('acrylic card height follows its content', async ({ page }) => {
  await openWidget(page, '# T\n- [ ] a\n- [ ] b\n', { theme: 'acrylic' })
  const height = await page.getByTestId('widget-card').evaluate((el) => el.getBoundingClientRect().height)
  expect(height).toBeLessThan(400)
})

test('switching to a large file falls back to the task view', async ({ page }) => {
  await openEditor(page, '# T\n- [ ] a\n')
  await page.getByRole('button', { name: '完整预览' }).click()
  await expect(page.getByTestId('editor-full-preview')).toBeVisible()
  const big = `# Big\n\n${'x'.repeat(600 * 1024)}\n`
  await page.locator('input[type=file]').setInputFiles({
    name: 'big.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(big, 'utf-8'),
  })
  await expect(page.getByTestId('editor-full-preview')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '任务' })).toHaveClass(/is-active/)
})

test('shift-tab de-indents every selected line', async ({ page }) => {
  await openEditor(page, '    - [ ] a\n    - [ ] b\n')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(2, area.value.length - 1)
  })
  await textarea.press('Shift+Tab')
  await expect(textarea).toHaveValue('- [ ] a\n- [ ] b\n')
})

test('autosave waits for compositionend', async ({ page }) => {
  await openEditor(page, '- [ ] a\n')
  const textarea = page.locator('.editor-textarea')
  await textarea.evaluate((el) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(area.value.length - 1, area.value.length - 1)
  })
  await textarea.press('x')
  await page.waitForTimeout(100)
  await textarea.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }))
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(el, '- [ ] ax中')
  })
  await page.waitForTimeout(1200)
  expect(await page.evaluate(() => localStorage.getItem('sotto:document'))).toBe('- [ ] a\n')
  await textarea.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' }))
  })
  await page.waitForTimeout(1200)
  expect(await page.evaluate(() => localStorage.getItem('sotto:document'))).toBe('- [ ] ax中')
})

test('widget shows a missing-file state instead of an empty document', async ({ page }) => {
  await openWidget(page, '- [ ] 不应显示\n', {}, { 'sotto:mock-missing': '1' })
  await expect(page.getByTestId('empty-state')).toHaveText('文件不存在 · 点铅笔重新选择')
  await expect(page.getByTestId('widget-footer')).toContainText('文件不存在 · 请重新选择')
  await expect(page.getByTestId('task-row')).toHaveCount(0)
})

test('widget keeps cached content and warns when the file cannot be read', async ({ page }) => {
  await openWidget(page, '- [ ] 缓存任务\n', {}, { 'sotto:mock-read-error': '读取被拒绝' })
  await expect(page.getByTestId('task-row')).toHaveCount(1)
  await expect(page.getByTestId('read-error')).toContainText('读取失败')
  await expect(page.getByTestId('widget-footer')).toContainText('读取失败')
})

test('editor blocks saving and offers reselect when the file is missing', async ({ page }) => {
  await openEditor(page, '- [ ] 草稿\n', { 'sotto:mock-missing': '1' })
  await expect(page.getByRole('alert')).toContainText('文件不存在')
  await expect(page.getByRole('button', { name: '重新选择文件' })).toBeVisible()
  await expect(page.getByRole('button', { name: '保存' })).toBeDisabled()
  await expect(page.locator('.editor-textarea')).toHaveValue('- [ ] 草稿\n')
})

test('editor shows the cached content with a read-error banner', async ({ page }) => {
  await openEditor(page, '- [ ] 缓存\n', { 'sotto:mock-read-error': '读取失败：设备忙' })
  await expect(page.getByRole('alert')).toContainText('无法读取文件')
  await expect(page.getByRole('button', { name: '重试读取' })).toBeVisible()
  await expect(page.locator('.editor-textarea')).toHaveValue('- [ ] 缓存\n')
})

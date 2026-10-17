import { expect, test } from '@playwright/test'

const SAMPLE_ASKED = () => {
  localStorage.clear()
  localStorage.setItem('sotto:autostart-asked', '1')
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(SAMPLE_ASKED)
})

test('widget dark and expanded', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => document.body.classList.add('preview-desktop'))
  await expect(page.getByTestId('widget-title')).toHaveText('今日待办')
  await expect(page.getByTestId('widget-footer')).toContainText('还有 5 条')
  await expect(page.getByTestId('task-row')).toHaveCount(5)
  await page.screenshot({ path: 'docs/screenshots/widget-dark-desktop.png' })
  await page.getByTestId('widget-card').screenshot({ path: 'docs/screenshots/widget-dark-card.png' })

  await page.getByTestId('widget-title').click()
  await expect(page.getByTestId('widget-footer')).toContainText('点击收起')
  await page.getByTestId('widget-card').screenshot({ path: 'docs/screenshots/widget-expanded.png' })
})

test('widget acrylic theme', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sotto:settings',
      JSON.stringify({ theme: 'acrylic', width: 360, fontSize: 14, compact: 5, expanded: 15, autostartAsked: true }),
    )
  })
  await page.goto('/')
  await page.evaluate(() => document.body.classList.add('preview-desktop'))
  await expect(page.getByTestId('widget')).toHaveClass(/theme-acrylic/)
  await page.getByTestId('widget-card').screenshot({ path: 'docs/screenshots/widget-acrylic.png' })
})

test('first run autostart prompt', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto('/')
  await expect(page.getByTestId('first-run-dialog')).toBeVisible()
  await page.getByTestId('widget-card').screenshot({ path: 'docs/screenshots/first-run.png' })
  await page.getByTestId('autostart-disable').click()
  await expect(page.getByTestId('first-run-dialog')).toHaveCount(0)
})

test('editor task toggle updates source', async ({ page }) => {
  await page.goto('/editor.html')
  await expect(page.getByTestId('editor-task-preview')).toBeVisible()
  const textarea = page.locator('.editor-textarea')
  await expect(textarea).toHaveValue(/- \[ \] 写周报/)
  await page.locator('.editor-task-row input').first().click()
  await expect(textarea).toHaveValue(/- \[x\] 写周报/)
  await expect(page.getByTestId('save-state')).toHaveText('已保存')
  await page.screenshot({ path: 'docs/screenshots/editor.png', fullPage: true })
})

test('editor settings has eight fields', async ({ page }) => {
  await page.goto('/editor.html')
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.setting-field')).toHaveCount(8)
  await page.screenshot({ path: 'docs/screenshots/editor-settings.png', fullPage: true })
})

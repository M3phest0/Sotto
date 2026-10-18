import { expect, test } from '@playwright/test'

const DOC = `# 测试

- [ ] 父项
  - [ ] 子项一
    1. [ ] 孙项
  - [ ] 子项二
- [ ] 其他
`

test.beforeEach(async ({ page }) => {
  await page.addInitScript((text) => {
    localStorage.clear()
    localStorage.setItem('sotto:autostart-asked', '1')
    localStorage.setItem('sotto:document', text)
  }, DOC)
})

async function caretAtEndOf(page: import('@playwright/test').Page, line: string) {
  const textarea = page.locator('.editor-textarea')
  const position = await textarea.evaluate((el, needle) => {
    const value = (el as HTMLTextAreaElement).value
    const start = value.indexOf(needle)
    return start + needle.length
  }, line)
  await textarea.evaluate((el, pos) => {
    const area = el as HTMLTextAreaElement
    area.focus()
    area.setSelectionRange(pos, pos)
  }, position)
  return textarea
}

test('enter continues bullet, indentation, and ordered numbering', async ({ page }) => {
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  await expect(textarea).toHaveValue(/- \[ \] 子项一/)

  await (await caretAtEndOf(page, '  - [ ] 子项一')).press('Enter')
  await expect(textarea).toHaveValue(/子项一\n {2}- \[ \] \n {4}1\. \[ \] 孙项/)

  await (await caretAtEndOf(page, '    1. [ ] 孙项')).press('Enter')
  await expect(textarea).toHaveValue(/孙项\n {4}2\. \[ \] \n {2}- \[ \] 子项二/)
})

test('checking a parent rewrites every descendant checkbox', async ({ page }) => {
  await page.goto('/editor.html')
  const textarea = page.locator('.editor-textarea')
  const parent = page.locator('.editor-task-row input').first()

  await parent.click()
  // 首次点击可能只刷新预览；若源文本未变则再点一次。
  if (!(await textarea.inputValue()).includes('- [x] 父项')) await parent.click()

  await expect(textarea).toHaveValue(/- \[x\] 父项\n {2}- \[x\] 子项一\n {4}1\. \[x\] 孙项\n {2}- \[x\] 子项二\n- \[ \] 其他/)

  await parent.click()
  if ((await textarea.inputValue()).includes('- [x] 父项')) await parent.click()
  await expect(textarea).toHaveValue(/- \[ \] 父项\n {2}- \[ \] 子项一\n {4}1\. \[ \] 孙项\n {2}- \[ \] 子项二\n- \[ \] 其他/)
})

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block', video: 'on' })

test('quotes displayed selection into the existing draft without submitting', async ({ page }, info) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: class {
      lang = ''; interimResults = false; continuous = false
      onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null
      onend: (() => void) | null = null
      start() {
        const result = this.onresult
        Object.assign(window, { quoteSpeech: (text: string) => result?.({ results: [[{ transcript: text }]] }) })
      }
      stop() { this.onend?.() }
    } })
  })
  const text = 'Selected café 🦜\nsecond line'
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: 'quote-selection', title: 'Quote selection', messages: [
      { role: 'user', id: 1, content: text },
      { role: 'assistant', id: 2, content: 'A [reference](https://example.com/).\n\n```ts\nconst café = "🦜"\n```' },
    ],
  } } }))
  let submissions = 0
  page.on('request', (req) => { if (/\/api\/(chat\/start|chat\/steer|queue)/.test(req.url()) && req.method() === 'POST') submissions++ })
  await page.goto('/session/quote-selection')
  const box = page.locator('#msg')
  await box.fill('My question  ')
  await box.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(2, 4, 'backward'))
  const body = page.locator('[data-role="user"] .msg-body')
  await expect(body).toHaveText(text)
  const evidence = process.env.TALARIA_QUOTE_EVIDENCE
  const screenshot = async (state: string) => {
    if (!evidence) return
    mkdirSync(evidence, { recursive: true })
    await page.screenshot({ path: join(evidence, `${state}-${info.project.name}.png`) })
  }
  await screenshot('before')
  if (info.project.name === 'desktop') {
    // A real mouse selection and keyboard activation use the browser's ordinary interaction path.
    await body.dblclick({ position: { x: 30, y: 10 } })
  } else {
    // Headless Chromium exposes no OS selection handles; retain a native DOM range, then use touch on the action.
    await box.blur()
    await body.evaluate((el) => {
      const range = document.createRange(); range.selectNodeContents(el)
      const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
  }
  const selected = await page.evaluate(() => window.getSelection()!.toString())
  expect(selected.trim()).not.toBe('')
  const action = page.getByRole('button', { name: 'Quote selection', exact: true })
  await expect(action).toBeVisible()
  // Browser menus and links retain their native default behavior.
  expect(await body.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })))).toBe(true)
  await screenshot('selected')
  if (info.project.name === 'mobile') await action.tap()
  else { await action.focus(); await page.keyboard.press('Enter') }
  await expect(box).toHaveValue(`My question  \n\n${selected.replace(/\r\n?/g, '\n').split('\n').map((line) => `> ${line}`).join('\n')}\n\n`)
  expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd, el.selectionDirection])).toEqual([2, 4, 'backward'])
  expect(submissions).toBe(0)
  await screenshot('after')
  const draft = await box.inputValue()
  const code = page.locator('[data-role="assistant"] code').first()
  await box.blur()
  await code.evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  if (info.project.name === 'mobile') await action.tap()
  else await action.click()
  await expect(box).toHaveValue(`${draft}\n\n> const café = "🦜"\n\n`)
  expect(submissions).toBe(0)
  await page.getByRole('button', { name: 'reference', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Open external link?' })
  await expect(dialog).toContainText('https://example.com/')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  // Phone layouts use keyboard dictation; start the app microphone while wide, then exercise a responsive shrink.
  if (info.project.name === 'mobile') await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: 'Dictate', exact: true }).click()
  await page.evaluate(() => (window as unknown as { quoteSpeech: (text: string) => void }).quoteSpeech('spoken'))
  await expect(box).toHaveValue(`${draft}\n\n> const café = "🦜"\n\n spoken`)
  if (info.project.name === 'mobile') {
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.locator('#btnMic')).toBeHidden()
  }
  await screenshot('dictating')
  const spokenDraft = await box.inputValue()
  await box.blur()
  await code.evaluate((el) => {
    const range = document.createRange(); range.selectNodeContents(el)
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  })
  if (info.project.name === 'mobile') await action.tap()
  else await action.click()
  await page.evaluate(() => (window as unknown as { quoteSpeech: (text: string) => void }).quoteSpeech('late speech'))
  await expect(box).toHaveValue(`${spokenDraft}\n\n> const café = "🦜"\n\n`)
  await expect(page.locator('#btnMic')).toHaveAttribute('aria-pressed', 'false')
  expect(submissions).toBe(0)
  await screenshot('dictation-quoted')
})

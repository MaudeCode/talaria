import { expect, settle, test } from './fixtures'

// TAL-2086: the Settings sidebar search lists rows from every section and opens the chosen row with its control focused.
// The desktop and mobile projects run it at 1280px and in the 390px drawer.
test('Settings search finds a row on another section and focuses its control', async ({ page }, testInfo) => {
  await page.goto('/settings/appearance')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  if (await hamburger.isVisible()) await hamburger.click()
  const field = page.getByRole('combobox', { name: 'Search settings…' })
  const menu = page.getByRole('navigation', { name: 'Settings' })
  const status = page.locator('#panelSettings [role="status"]')

  await field.fill('zzz')
  await expect(menu.getByText('No settings found.')).toBeVisible()
  await expect(status).toHaveText('No settings found.')
  await expect(menu.getByRole('link', { name: 'Chat', exact: true })).toHaveCount(0)
  await field.press('Escape')
  await expect(field).toHaveValue('')
  await expect(menu.getByRole('link', { name: 'Chat', exact: true })).toBeVisible()

  await field.fill('cron')
  const results = menu.getByRole('listbox')
  const cron = results.getByRole('option', { name: /Show cron sessions/ })
  await expect(cron).toContainText('Navigation · Sessions shown')
  await expect(status).toHaveText('1 setting')
  await page.screenshot({ path: testInfo.outputPath('settings-search.png') })
  await field.press('Enter')
  await expect(page).toHaveURL(/\/settings\/navigation#settings-show_cron_sessions$/)
  await expect(page.getByRole('switch', { name: 'Show cron sessions' })).toBeFocused()
  await expect(page.locator('.sidebar.mobile-open')).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('settings-search-jump.png') })

  // Arrow keys move through the results; a click chooses too.
  if (await hamburger.isVisible()) await hamburger.click()
  await field.fill('this device')
  await expect(results.getByRole('option')).not.toHaveCount(0)
  await field.press('ArrowDown')
  await expect(results.getByRole('option').nth(1)).toHaveAttribute('aria-selected', 'true')
  await expect(field).toHaveAttribute('aria-activedescendant', 'settingsSearchResult-1')
  await results.getByRole('option', { name: /Speed/ }).click()
  await expect(page).toHaveURL(/\/settings\/speech#settingsTtsRate$/)
  await expect(page.getByRole('slider', { name: 'Speed' })).toBeFocused()
})

test('a Settings URL with a row id opens that row with its control focused', async ({ page }) => {
  await page.goto('/settings/chat#settingsSendKey')
  await settle(page)
  await expect(page.getByRole('radiogroup', { name: 'Send with' }).getByRole('radio', { checked: true })).toBeFocused()
  await page.goto('/settings/appearance#themePickerGrid')
  await settle(page)
  await expect(page.getByRole('group', { name: 'Theme' }).getByRole('button', { pressed: true })).toBeFocused()
})

// TAL-2138: a row moved to a Chat sub-page opens that sub-page; a composer control opens Chat at its toggle in the drawing.
test('Settings search opens a Chat sub-page row and a composer control in the drawing', async ({ page }) => {
  await page.goto('/settings/appearance')
  await settle(page)
  const hamburger = page.locator('#btnHamburger')
  const field = page.getByRole('combobox', { name: 'Search settings…' })
  const results = page.getByRole('navigation', { name: 'Settings' }).getByRole('listbox')
  if (await hamburger.isVisible()) await hamburger.click()
  await field.fill('event timestamps')
  await expect(results.getByRole('option', { name: /Event timestamps/ })).toContainText('Chat › Advanced · Transcript')
  await field.press('Enter')
  await expect(page).toHaveURL(/\/settings\/chat\/advanced#settings-transparent_stream_event_timestamps$/)
  await expect(page.getByRole('switch', { name: 'Event timestamps' })).toBeFocused()
  if (await hamburger.isVisible()) await hamburger.click()
  await field.fill('microphone')
  await field.press('Enter')
  await expect(page).toHaveURL(/\/settings\/chat#settings-hide_composer_mic$/)
  await expect(page.getByRole('button', { name: 'Show Microphone' })).toBeFocused()
})

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, expectNoOverflow, test } from './fixtures'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { bootTestServer } from '../../server/dist/test/harness.js'

test('Agent-home restore asks before publishing and displays the recovery action', async ({ page }, info) => {
  const sidecar = new FakeSidecar()
  sidecar.respond('backup.restore_available', () => ({ available: true }))
  sidecar.respond('backup.restore', ({ output }) => {
    writeFileSync(output, 'disposable recovery bytes', { mode: 0o600 })
    return { status: 'partial' }
  })
  const server = await bootTestServer({ sidecar, env: { TALARIA_WEB_SKIP_ONBOARDING: '1' } })
  try {
    if (process.env.TALARIA_RESTORE_SHOTS) {
      // Use synthetic host metadata in evidence published with the PR.
      await page.route('**/api/agent-backup/restore**', async (route) => {
        const response = await route.fetch()
        const status = await response.json()
        await route.fulfill({ response, json: { ...status, server: 'fixture.invalid' } })
      })
    }
    await page.goto(`${server.base}/settings/system`)
    const upload = page.getByRole('button', { name: 'Upload restore archive' })
    await expect(upload).toBeVisible()
    await upload.scrollIntoViewIfNeeded()
    if (process.env.TALARIA_RESTORE_SHOTS && info.project.name === 'desktop') {
      const shot = (name: string) => page.screenshot({ animations: 'disabled', path: resolve(process.env.TALARIA_RESTORE_SHOTS!, `${name}.png`) }).then(() => undefined)
      await shot('restore-desktop')
    }
    const picker = page.waitForEvent('filechooser')
    await upload.click()
    await (await picker).setFiles({ name: 'fixture.zip', mimeType: 'application/zip', buffer: Buffer.from('disposable archive') })
    const dialog = page.getByRole('alertdialog', { name: 'Restore Agent home' })
    await expect(dialog).toContainText('fixture.zip')
    expect(sidecar.calls.some(({ method }) => method === 'backup.restore')).toBe(false)
    if (process.env.TALARIA_RESTORE_SHOTS && info.project.name === 'desktop') {
      const shot = (name: string) => page.screenshot({ animations: 'disabled', path: resolve(process.env.TALARIA_RESTORE_SHOTS!, `${name}.png`) }).then(() => undefined)
      await shot('confirm-desktop')
      await expectNoOverflow(page, 'confirm', async (name) => {
        await expect(dialog.getByRole('button', { name: 'Restore Agent home' })).toBeInViewport()
        await shot(name)
      })
    }
    await dialog.getByRole('button', { name: 'Restore Agent home' }).click()
    await expect(page.getByText('Some data may have changed. Download the recovery backup.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Download recovery backup' })).toBeVisible()
    if (process.env.TALARIA_RESTORE_SHOTS && info.project.name === 'desktop') {
      await page.getByRole('button', { name: 'Download recovery backup' }).scrollIntoViewIfNeeded()
      await page.screenshot({ animations: 'disabled', path: resolve(process.env.TALARIA_RESTORE_SHOTS, 'restore-recovery.png') })
    }
    expect(sidecar.calls.filter(({ method }) => method === 'backup.restore')).toHaveLength(1)
  } finally {
    await server.close()
  }
})

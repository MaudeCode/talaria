import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, settle, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

const catalog = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../contracts/fixtures/skills.json'), 'utf8')) as { skills: { name: string; description: string; category: string; disabled: boolean }[] }

test('resolved duplicate skills render separately and send the selected identity', async ({ page }, testInfo) => {
  let rows = [{ ...catalog.skills[0], name: 'dup-demo' }]
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: rows } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  const toggles: unknown[] = []
  await page.route('**/api/skills/toggle', (route) => {
    const body = route.request().postDataJSON() as { name: string; enabled: boolean }
    toggles.push(body)
    rows = rows.map((row) => row.name === body.name ? { ...row, disabled: !body.enabled } : row)
    return route.fulfill({ json: { ok: true, ...body } })
  })
  await page.route('**/api/skills/content?**', (route) => {
    const name = new URL(route.request().url()).searchParams.get('name')
    expect(name).toBe('b/two')
    return route.fulfill({ json: { success: true, name: 'dup-demo', content: 'Second copy', linked_files: {} } })
  })
  await page.goto('/skills')
  await settle(page)
  await expect(page.locator('#skillsList')).toContainText('dup-demo')
  await page.screenshot({ path: testInfo.outputPath('skills-before.png') })
  rows = structuredClone(catalog.skills)
  await page.reload()
  await settle(page)
  await expect(page.locator('#skillsList')).toContainText('a/one')
  await expect(page.locator('#skillsList')).toContainText('b/two')
  await page.getByRole('switch', { name: /^a\/one$/ }).click()
  await expect(page.getByRole('switch', { name: /^a\/one$/ })).not.toBeChecked()
  await expect(page.getByRole('switch', { name: /^b\/two$/ })).toBeChecked()
  expect(toggles).toEqual([{ name: 'a/one', enabled: false }])
  await page.screenshot({ path: testInfo.outputPath('skills-after.png') })
  await page.getByRole('button', { name: /b\/two/ }).click()
  await expect(page.getByLabel('Skill content')).toHaveValue('Second copy')
})

test('project skill content is read-only while its catalog row remains visible', async ({ page }, testInfo) => {
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [{ name: 'project-skill', description: 'Trusted project instructions', category: null, disabled: false, tier: 0 }] } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  await page.route('**/api/skills/content?**', (route) => route.fulfill({ json: { success: true, name: 'project-skill', content: 'Project-owned instructions', editable: false, linked_files: {} } }))
  await page.goto('/skills')
  await settle(page)
  await page.getByRole('button', { name: /project-skill/ }).click()
  await expect(page.getByLabel('Skill content')).toHaveValue('Project-owned instructions')
  await page.screenshot({ path: testInfo.outputPath('project-detail.png') })
  await expect(page.getByLabel('Skill content')).toHaveAttribute('readonly', '')
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0)
})

const recorded = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../contracts/fixtures/sidecar/skills.json'), 'utf8')) as { 'skills.list': { result: { skills: { name: string; description: string; category: string }[] } }[] }
const longCategories = recorded['skills.list'][0]!.result.skills

// TAL-2088: a long category never squeezes the name. A phone shows the category on the description line; wider rows keep the chip.
test('skill names stay readable beside long categories', async ({ page }, testInfo) => {
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: longCategories } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  await page.goto('/skills')
  await settle(page)
  const row = (skill: { name: string }) => page.locator('#skillsList > li').filter({ has: page.getByRole('switch', { name: skill.name, exact: true }) })
  // Each name's box fits at least its first 12 characters, measured in the name's own font.
  const squeezed: string[] = []
  for (const skill of longCategories) {
    const fits = await row(skill).getByText(skill.name, { exact: true }).evaluate((el, text) => {
      const probe = document.body.appendChild(Object.assign(document.createElement('span'), { textContent: text }))
      Object.assign(probe.style, { font: getComputedStyle(el).font, position: 'absolute', whiteSpace: 'pre' })
      const needed = probe.getBoundingClientRect().width
      probe.remove()
      return el.clientWidth >= Math.floor(needed)
    }, skill.name.slice(0, 12))
    if (!fits) squeezed.push(skill.name)
  }
  expect(squeezed, 'skill names cut short of 12 characters').toEqual([])
  for (const skill of longCategories) {
    const chip = row(skill).getByText(skill.category, { exact: true })
    if (testInfo.project.name === 'mobile') {
      await expect(chip).toBeHidden()
      expect(await row(skill).getByText(skill.description).innerText()).toBe(`${skill.category} · ${skill.description}`)
    } else {
      await expect(chip).toBeVisible()
    }
  }
  await page.screenshot({ path: testInfo.outputPath(`skills-${testInfo.project.name}.png`) })
})

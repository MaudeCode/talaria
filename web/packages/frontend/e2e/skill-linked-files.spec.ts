import { expect, settle, test } from './fixtures'

// Service-worker requests bypass page routing; these fixtures own every response.
test.use({ serviceWorkers: 'block' })

const SKILL = { name: 'synthetic-skill', description: 'A skill with a reference file', category: 'testing', disabled: false }
const FILES: Record<string, string> = { 'references/guide.md': '# Guide\n\nReference body for the synthetic skill.' }

test('a skill lists its linked files and opens one', async ({ page }, testInfo) => {
  const requests: string[] = []
  await page.route('**/api/skills', (route) => route.fulfill({ json: { skills: [SKILL] } }))
  await page.route('**/api/skills/usage', (route) => route.fulfill({ json: { usage: {} } }))
  await page.route('**/api/skills/content?**', (route) => {
    const params = new URL(route.request().url()).searchParams
    const file = params.get('file')
    requests.push(`${params.get('name') ?? ''}:${file ?? ''}`)
    if (file) return route.fulfill({ json: { content: FILES[file], path: file } })
    return route.fulfill({ json: { success: true, name: SKILL.name, content: '---\nname: synthetic-skill\n---\nSkill body.', path: 'testing/synthetic-skill/SKILL.md', linked_files: { references: Object.keys(FILES) } } })
  })
  await page.goto('/skills')
  await settle(page)
  await page.getByRole('button', { name: /synthetic-skill/ }).click()

  const link = page.getByRole('button', { name: 'references/guide.md' })
  await expect(page.getByRole('heading', { name: 'Linked Files' })).toBeVisible()
  await expect(link).toBeVisible()
  await link.scrollIntoViewIfNeeded()
  await page.screenshot({ path: testInfo.outputPath('skill-linked-files.png') })

  await link.click()
  await expect(page.getByText('Reference body for the synthetic skill.')).toBeVisible()
  expect(requests).toContain('synthetic-skill:references/guide.md')
  await page.screenshot({ path: testInfo.outputPath('skill-linked-file-open.png') })

  await page.getByRole('button', { name: 'Back to synthetic-skill' }).click()
  await expect(page.getByLabel('Skill content')).toHaveValue(/Skill body\./)
})

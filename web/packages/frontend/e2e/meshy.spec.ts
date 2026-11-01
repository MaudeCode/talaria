import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MeshySidecarResult } from '@maudecode/talaria-web-contracts'
import { expect, test } from './fixtures'
import { checkerPng, texturedAnimatedGlb } from './meshy-fixture'

test.use({ serviceWorkers: 'block' })

const TASK = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const IMAGE_TASK = '0192a3b4-c5d6-7e8f-9a0b-aaaaaaaaaaaa'
const RUNNING = '0192a3b4-c5d6-7e8f-9a0b-bbbbbbbbbbbb'
const REVISION = 'c16e967d798d8dd3b1827a62673c18627f31e0ed'

/**
 * TAL-1514: the native Meshy plugin is faked at the sidecar boundary with synthetic responses and real disposable files;
 * HTTP routing, grants, byte serving, the GLB check, CSP and the built UI are real. No Meshy account is used.
 */
test('renders a Meshy model inline and in the gallery through authenticated asset routes', async ({ page }, testInfo) => {
  const { bootTestServer } = await import('../../server/dist/test/harness.js')
  const { FakeSidecar } = await import('../../server/dist/sidecar/fake.js')
  const sidecar = new FakeSidecar()
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' } })
  const shots = process.env.TAL1514_SHOTS
  const shot = async (name: string) => { await page.screenshot({ path: shots ? join(shots, `${name}-${testInfo.project.name}.png`) : testInfo.outputPath(`${name}.png`) }) }
  const root = join(server.state, 'plugin-data', 'agent-plugin-meshy-0')
  const model = join(root, 'meshy_output', TASK, 'model.glb')
  mkdirSync(join(root, 'meshy_output', TASK), { recursive: true })
  writeFileSync(model, texturedAnimatedGlb())
  const images = [1, 2].map((n) => join(root, 'saved-assets', IMAGE_TASK, `image-${String(n)}.png`))
  mkdirSync(join(root, 'saved-assets', IMAGE_TASK), { recursive: true })
  writeFileSync(images[0]!, checkerPng(96, [90, 160, 230], [30, 40, 60]))
  writeFileSync(images[1]!, checkerPng(96, [220, 200, 90], [60, 50, 30]))
  const local = [
    { path: model, name: 'model.glb', kind: 'model' as const, task_id: TASK, prompt: 'A small orange robot', modified: Date.UTC(2026, 9, 31, 12), bytes: 4096, images: [], download_incomplete: false },
    { path: images[0]!, name: 'image-1.png', kind: 'image' as const, task_id: IMAGE_TASK, prompt: 'Robot concept sheet', modified: Date.UTC(2026, 9, 31, 11), bytes: 2048, images: [images[0]!], download_incomplete: true },
  ]
  const base = { availability: 'ready' as const, message: null, balance: 1180, revision: REVISION }
  let imagesComplete = false
  sidecar.respond('plugins.dashboard_list', () => ({ supported: true, plugins: [{ name: 'meshy', label: 'Meshy', version: '0.2.0', description: '', enabled: true, panel: null, has_api: true }] }))
  sidecar.respond('plugins.meshy', (params): MeshySidecarResult => {
    switch (params.action) {
      case 'asset': return { ...base, asset: params.path === model ? { path: model, anchor: join(server.state, 'plugin-data'), mime: 'model/gltf-binary', bytes: texturedAnimatedGlb().length } : images.includes(params.path ?? '') ? { path: params.path!, anchor: join(server.state, 'plugin-data'), mime: 'image/png', bytes: 1 } : null }
      case 'card': return { ...base, local: local.filter((row) => row.path === params.path), task: { task_id: TASK, status: 'succeeded', progress: 100, terminal: true, stage: 'refine', error: null, prompt: 'A small orange robot', thumbnail_url: null, credits: 20, has_model: true, task_type: 'text-to-3d-refine' } }
      case 'overview': return { ...base, auto_rotate: true, recent: [], active: [{ task_id: RUNNING, status: 'in_progress', progress: 38, terminal: false, stage: 'preview', error: null }],
        local: imagesComplete ? [local[0]!, { ...local[1]!, images, download_incomplete: false }] : local }
      case 'details': return { ...base, balance: 1180, details: { task_id: params.task_id!, is_preview: false,
        formats: [{ format: 'glb', label: 'GLB', saved: true }, { format: 'fbx', label: 'FBX', saved: false }, { format: 'usdz', label: 'USDZ', saved: false }],
        conversions: [{ id: 'convert-stl', label: 'Convert to STL', cost: 1, affordable: true, draft: `Meshy task ${TASK}: convert it to STL using meshy_convert (1 credit).` }],
        actions: [{ id: 'remesh', label: 'Remesh', cost: 5, affordable: true, draft: `Meshy task ${TASK} ("A small orange robot"): remesh it with meshy_remesh (5 credits).` }],
        provenance: { prompt: 'A small orange robot', prompt_inherited: false, texture_prompt: 'brushed metal', style_prompt: null, negative_prompt: null, source_image: null, settings: [{ key: 'topology', value: 'quad' }, { key: 'target_polycount', value: '15000' }], seed: 1234, credits: 20, created_at: Date.UTC(2026, 9, 31, 12), parents: [], children: [], recorded: true } } }
      case 'save_images': imagesComplete = true; return { ...base, saved: ['image-1.png', 'image-2.png'], complete: true, error: null }
      default: return base
    }
  })
  const session = await server.deps.sessionStore.newSession()
  session.title = 'Robot model'
  session.messages = [
    { role: 'user', content: 'Make a small orange robot and download it.' },
    { role: 'assistant', content: `Downloaded the refined robot to ${model}.\n\n::meshy-model{path="${model}" task="${TASK}" title="Orange robot"}` },
  ]
  await server.deps.sessionStore.save(session)
  try {
    await page.goto(`${server.base}/session/${session.session_id}`)
    const figure = page.getByRole('figure', { name: 'Orange robot' })
    await expect(figure).toBeVisible()
    await expect(page.getByText('::meshy-model')).toHaveCount(0)
    await expect(figure.getByRole('button', { name: 'View in 3D' })).toBeVisible()
    await expect(page.locator('model-viewer')).toHaveCount(0)
    await shot('inline-collapsed')
    await figure.getByRole('button', { name: 'View in 3D' }).click()
    const viewer = page.locator('model-viewer')
    await expect(viewer).toHaveAttribute('aria-label', /3D model: Orange robot/)
    await expect.poll(() => viewer.evaluate((el) => (el as HTMLElement & { loaded: boolean }).loaded), { timeout: 30_000 }).toBe(true)
    // The clip is listed; reduced motion (the suite's default) keeps it paused until asked.
    await expect(figure.getByRole('button', { name: 'Play animation' })).toBeVisible()
    await viewer.focus()
    await page.keyboard.press('ArrowLeft')
    await shot('inline-viewer')
    await figure.getByRole('button', { name: 'Formats and next steps' }).click()
    await expect(figure.getByText('GLB saved')).toBeVisible()
    await expect(figure.getByRole('button', { name: 'Save FBX' })).toBeVisible()
    await shot('inline-details')
    await figure.getByRole('button', { name: 'Remesh · 5 credits' }).click()
    await expect(page.locator('#msg')).toHaveValue(/remesh it with meshy_remesh \(5 credits\)/)
    expect(sidecar.calls.filter((c) => c.method === 'chat.start')).toHaveLength(0)
    await shot('inline-draft')

    const manifests = await (await page.request.get(`${server.base}/api/extensions/manifests`)).json() as { manifests: { id: string; native_view?: string }[] }
    const gallery = manifests.manifests.find((m) => m.native_view === 'meshy_gallery')!
    await page.goto(`${server.base}/ext/${gallery.id}`)
    await expect(page.getByRole('heading', { name: 'Meshy', level: 1 })).toBeVisible()
    await expect(page.getByText(/1,?180 credits left/)).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Meshy 38% · preview' })).toBeVisible()
    await expect.poll(() => page.locator('model-viewer').evaluate((el) => (el as HTMLElement & { loaded: boolean }).loaded), { timeout: 30_000 }).toBe(true)
    await shot('gallery-model')
    await page.getByRole('button', { name: /Robot concept sheet/ }).click()
    await expect(page.getByRole('img', { name: 'Robot concept sheet, image 1' })).toBeVisible()
    await shot('gallery-images-partial')
    await page.getByRole('button', { name: 'Retry image download' }).click()
    await expect(page.getByText('Saved image-1.png, image-2.png')).toBeVisible()
    await expect(page.getByRole('img', { name: 'Robot concept sheet, image 2' })).toBeVisible()
    await shot('gallery-images-complete')
  } finally {
    // Leave the app first, so closing this server does not cut its open event streams mid-response.
    await page.goto('about:blank')
    await server.close()
  }
})

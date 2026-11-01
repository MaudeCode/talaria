import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { DisplayMedia, MeshyCard, MeshyItem } from '@maudecode/talaria-web-contracts'
import { queryWrapper } from '../../test/fixtures'

vi.mock('@google/model-viewer', () => ({}))
vi.mock('../../api/endpoints', () => ({ fetchMeshyCard: vi.fn(), fetchMeshyDetails: vi.fn(), saveMeshyFormat: vi.fn(), saveMeshyImages: vi.fn() }))
vi.mock('../composer/composerReturn', () => ({ returnToComposer: vi.fn() }))
import * as api from '../../api/endpoints'
import { returnToComposer } from '../composer/composerReturn'
import { MeshyModelCard } from './MeshyModelCard'
import { MeshyItemView } from './MeshyItemView'
import { ModelViewer } from './ModelViewer'

const TASK = '0192a3b4-c5d6-7e8f-9a0b-1c2d3e4f5a6b'
const media = { url: '', name: 'Robot', mime: 'model/gltf-binary', kind: 'model', model: { ref: 'opaque' } } as DisplayMedia
const model = { url: './api/meshy/asset?grant=g', name: 'model.glb', mime: 'model/gltf-binary', kind: 'model' as const, bytes: 2048 }
const item = (patch: Partial<MeshyItem> = {}): MeshyItem => ({ key: 'local:1', task_id: TASK, kind: 'model', title: 'Robot', prompt: 'A small robot', task_type: null, created_at: null, credits: null, thumbnail: null, model, images: [], saved: true, expired: false, download_incomplete: false, can_download: true, ...patch })
const card = (patch: Partial<MeshyCard>): MeshyCard => ({ availability: 'ready', message: null, balance: null, title: 'Robot', item: null, task: null, ...patch })
let reduced = false

beforeEach(() => {
  reduced = false
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') && reduced, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
})
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals() })

it('polls a running task as full snapshots and then shows the model without loading 3D until asked', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.mocked(api.fetchMeshyCard)
    .mockResolvedValueOnce(card({ task: { task_id: TASK, status: 'in_progress', progress: 38, terminal: false, stage: 'preview', error: null } }))
    .mockResolvedValue(card({ task: { task_id: TASK, status: 'succeeded', progress: 100, terminal: true, stage: 'preview', error: null }, item: item() }))
  render(<MeshyModelCard sessionId="s1" media={media} />, { wrapper: queryWrapper() })
  expect(await screen.findByRole('progressbar', { name: 'Meshy 38% · preview' })).toHaveAttribute('aria-valuenow', '38')
  await act(async () => { await vi.advanceTimersByTimeAsync(4100) })
  expect(await screen.findByRole('button', { name: 'View in 3D' })).toBeInTheDocument()
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  expect(document.querySelector('model-viewer')).toBeNull()
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(api.fetchMeshyCard).toHaveBeenCalledTimes(2)
  expect(api.fetchMeshyCard).toHaveBeenCalledWith('s1', 'opaque', expect.any(AbortSignal))
  vi.useRealTimers()
})

it('shows the server reason when the model is not available', async () => {
  vi.mocked(api.fetchMeshyCard).mockResolvedValue(card({ availability: 'plugin_unavailable', message: 'Install and enable the Meshy plugin.' }))
  render(<MeshyModelCard sessionId="s1" media={media} />, { wrapper: queryWrapper() })
  expect(await screen.findByText('Install and enable the Meshy plugin.')).toBeInTheDocument()
})

it('renders one keyboard-focusable viewer with animation controls, never autoplaying under reduced motion', async () => {
  reduced = true
  render(<ModelViewer asset={model} title="Robot" autoRotate />)
  const viewer = await waitFor(() => { const el = document.querySelector('model-viewer'); expect(el).not.toBeNull(); return el as HTMLElement & { availableAnimations: string[]; play: () => void; pause: () => void; animationName?: string } })
  expect(viewer).toHaveAttribute('tabindex', '0')
  expect(viewer).toHaveAttribute('camera-controls')
  expect(viewer).not.toHaveAttribute('auto-rotate')
  expect(viewer.getAttribute('src')).toContain('api/meshy/asset?grant=g')
  viewer.availableAnimations = ['walking', 'running']
  viewer.play = vi.fn()
  viewer.pause = vi.fn()
  act(() => { viewer.dispatchEvent(new Event('load')) })
  expect(viewer.play).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Play animation' }))
  expect(viewer.play).toHaveBeenCalledTimes(1)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Animation' }), 'running')
  expect(viewer.animationName).toBe('running')
  act(() => { viewer.dispatchEvent(new Event('error')) })
  expect(screen.getByRole('alert')).toHaveTextContent('The model could not be shown.')
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(document.querySelector('model-viewer')).not.toBeNull()
})

it('puts a follow-up draft in the composer only on tap, and never downloads or sends for it', async () => {
  vi.mocked(api.fetchMeshyDetails).mockResolvedValue({ availability: 'ready', message: null, balance: null, task_id: TASK, is_preview: true, provenance: null,
    formats: [{ format: 'glb', label: 'GLB', saved: true }, { format: 'fbx', label: 'FBX', saved: false }],
    actions: [{ id: 'remesh', label: 'Remesh', cost: 5, affordable: null, draft: 'Meshy task: remesh it (5 credits).' }], conversions: [] })
  const onDraft = vi.fn()
  render(<MeshyItemView item={item()} deferViewer onDraft={onDraft} />, { wrapper: queryWrapper() })
  await userEvent.click(screen.getByRole('button', { name: 'Formats and next steps' }))
  expect(await screen.findByText('GLB saved')).toBeInTheDocument()
  expect(api.fetchMeshyDetails).toHaveBeenCalledWith(TASK, model.url, expect.any(AbortSignal))
  expect(onDraft).not.toHaveBeenCalled()
  await userEvent.click(screen.getByRole('button', { name: 'Remesh · 5 credits' }))
  expect(onDraft).toHaveBeenCalledWith('Meshy task: remesh it (5 credits).')
  expect(api.saveMeshyFormat).not.toHaveBeenCalled()
  vi.mocked(api.saveMeshyFormat).mockResolvedValue({ availability: 'ready', message: null, balance: null, saved: ['model.fbx'], complete: true, error: null })
  await userEvent.click(screen.getByRole('button', { name: 'Save FBX' }))
  expect(api.saveMeshyFormat).toHaveBeenCalledWith({ task_id: TASK, format: 'fbx', beside: model.url })
  expect(await screen.findByRole('status')).toHaveTextContent('Saved model.fbx')
})

it('inline cards prepare drafts in their own session composer', async () => {
  vi.mocked(api.fetchMeshyCard).mockResolvedValue(card({ item: item() }))
  vi.mocked(api.fetchMeshyDetails).mockResolvedValue({ availability: 'ready', message: null, balance: null, task_id: TASK, is_preview: false, provenance: null, formats: [], conversions: [{ id: 'convert-fbx', label: 'Convert to FBX', cost: 1, affordable: null, draft: 'convert it' }], actions: [] })
  render(<MeshyModelCard sessionId="s1" media={media} />, { wrapper: queryWrapper() })
  await userEvent.click(await screen.findByRole('button', { name: 'Formats and next steps' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Convert to FBX · 1 credit' }))
  expect(returnToComposer).toHaveBeenCalledWith('s1', 'convert it')
})

it('reports a partial image set truthfully and offers a retry', async () => {
  const images = [{ url: './api/meshy/asset?grant=i1', name: 'image-1.png', mime: 'image/png', kind: 'image' as const, bytes: null }]
  vi.mocked(api.saveMeshyImages).mockResolvedValue({ availability: 'ready', message: null, balance: null, saved: ['image-1.png'], complete: false, error: 'Some images did not download. Retry to resume.' })
  render(<MeshyItemView item={item({ kind: 'image', model: null, images, download_incomplete: true, title: 'Concept' })} />, { wrapper: queryWrapper() })
  expect(screen.getByRole('img', { name: 'Concept, image 1' })).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Retry image download' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Some images did not download. Retry to resume. Saved image-1.png')
  expect(api.saveMeshyImages).toHaveBeenCalledWith(TASK)
})

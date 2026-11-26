import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import type { DisplayMedia } from '@maudecode/talaria-web-contracts'
import { queryWrapper } from '../../../test/fixtures'

vi.mock('../../meshy/api', () => ({ fetchMeshyCard: vi.fn() }))
import { fetchMeshyCard } from '../../meshy/api'
import { MediaTiles } from './MediaTiles'

afterEach(() => { cleanup(); vi.resetAllMocks() })

it('renders a model item in the shared 3D preview instead of a plain file link (TAL-1514)', async () => {
  vi.mocked(fetchMeshyCard).mockResolvedValue({ availability: 'plugin_unavailable', message: 'Install and enable the Meshy plugin.', balance: null, title: 'Robot model', item: null, task: null })
  const media = [{ url: '', name: 'Robot', mime: 'model/gltf-binary', kind: 'model', model: { ref: 'opaque' } }] as unknown as DisplayMedia[]
  render(<MediaTiles media={media} sessionId="synthetic" />, { wrapper: queryWrapper() })
  // The loading fallback is a figure with the same name; only the loaded card reads the server's card for this session.
  const card = (await screen.findByText('Install and enable the Meshy plugin.')).closest('figure')!
  expect(card).toHaveAccessibleName('Robot')
  expect(within(card).getByText('Robot model')).toBeInTheDocument()
  expect(fetchMeshyCard).toHaveBeenCalledWith('synthetic', 'opaque', expect.any(AbortSignal))
  expect(screen.queryByRole('link', { name: 'Robot' })).not.toBeInTheDocument()
})

it('keeps a delivered report as a link until the reply settles, then opens the sandboxed frame', () => {
  const report = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../../contracts/fixtures/delivered-html-media.json'), 'utf8')) as DisplayMedia
  const { rerender } = render(<MediaTiles media={[report]} />)
  expect(screen.getByRole('link', { name: report.name })).toBeVisible()
  expect(screen.queryByTitle(report.name)).toBeNull()

  rerender(<MediaTiles media={[report]} settled />)
  const frame = screen.getByTitle(report.name)
  expect(frame).toHaveAttribute('sandbox', 'allow-scripts')
  expect(new URL(frame.getAttribute('src') ?? '').pathname).toBe('/workspace-preview/example-grant/summary.html')
  expect(screen.queryByRole('link', { name: report.name })).toBeNull()
})

import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { DisplayMedia } from '@maudecode/talaria-web-contracts'
import { queryWrapper } from '../../../test/fixtures'
import { MediaTiles } from './MediaTiles'

afterEach(cleanup)

it('renders a model item in the shared 3D preview instead of a plain file link (TAL-1514)', () => {
  const media = [{ url: '', name: 'Robot', mime: 'model/gltf-binary', kind: 'model', model: { ref: 'opaque' } }] as unknown as DisplayMedia[]
  render(<MediaTiles media={media} sessionId="synthetic" />, { wrapper: queryWrapper() })
  expect(screen.getByRole('figure', { name: 'Robot' })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: 'Robot' })).not.toBeInTheDocument()
})

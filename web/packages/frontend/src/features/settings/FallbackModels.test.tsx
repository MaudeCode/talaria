import rawFixture from '../../../../../../contracts/fixtures/fallback-check.json'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FallbackCheck } from '@maudecode/talaria-web-contracts'

/** JSON imports widen the contract's enums; contracts `index.test.ts` parses this fixture and the server test produces it. */
const fixture = rawFixture as unknown as Record<keyof typeof rawFixture, { view: FallbackCheck }>

vi.mock('../../api/endpoints', () => ({ fetchFallbackCheck: vi.fn() }))
import * as api from '../../api/endpoints'
import { FallbackModelsGroup } from './FallbackModels'

function renderGroup(view: FallbackCheck) {
  vi.mocked(api.fetchFallbackCheck).mockResolvedValue(view)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><FallbackModelsGroup /></QueryClientProvider>)
}

afterEach(cleanup)

describe('Fallback models (TAL-2655)', () => {
  it('shows each entry in chain order with the server status and reason', async () => {
    const { entries } = fixture.mixed.view
    renderGroup(fixture.mixed.view)
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => row.dataset.fallbackStatus)).toEqual(entries.map((entry) => entry.status))
    rows.forEach((row, i) => {
      const entry = entries[i]!
      const scope = within(row)
      expect(scope.getByText(entry.model)).toBeTruthy()
      expect(scope.getByText(`${entry.provider_label} · ${{ ready: 'Ready', auth: 'Needs credentials', config: 'Not set up' }[entry.status]}`)).toBeTruthy()
      if (entry.error) expect(row.textContent).toContain(entry.error)
      else expect(row.querySelector('p')).toBeNull()
    })
  })

  it('says when the profile has no fallback chain', async () => {
    renderGroup(fixture.none.view)
    expect(await screen.findByText('No fallback models')).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })

  it('says when the Agent cannot check its fallback chain', async () => {
    renderGroup(fixture.unavailable.view)
    expect(await screen.findByText("This Agent can't check fallback models")).toBeTruthy()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})

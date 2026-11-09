import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ShowBlock } from '@maudecode/talaria-web-contracts'

vi.mock('../../../api/endpoints', () => ({ fetchShowBlock: vi.fn() }))
vi.mock('../../../lib/clipboard', () => ({ copyWithToast: vi.fn() }))
vi.mock('../../workspace/openFileRequest', () => ({ requestOpenFile: vi.fn() }))
import * as api from '../../../api/endpoints'
import { copyWithToast } from '../../../lib/clipboard'
import { requestOpenFile } from '../../workspace/openFileRequest'
import { ShowBlockResult } from './ShowBlockResult'

/** The shared fixture both clients render (TAL-1968). */
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../../contracts/fixtures/show.json'), 'utf8')) as Record<'file_image' | 'file_text' | 'chart' | 'chart_line' | 'html', ShowBlock> & { table: Extract<ShowBlock, { kind: 'table' }> }

afterEach(() => { cleanup(); vi.resetAllMocks() })

async function mount(block: ShowBlock) {
  vi.mocked(api.fetchShowBlock).mockResolvedValue(block)
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><ShowBlockResult reference={{ block_id: block.block_id, kind: block.kind, title: block.title }} /></QueryClientProvider>)
  const region = await screen.findByRole('region', { name: 'Shown' })
  expect(region.querySelector(`[data-show-block="${block.block_id}"][data-kind="${block.kind}"]`)).not.toBeNull()
  return within(region)
}

it('renders a table with the server\'s truncation note and copies the server\'s TSV from the button and the context menu', async () => {
  const card = await mount(fixture.table)
  expect(await card.findByRole('table', { name: 'Latency by region' })).toBeInTheDocument()
  expect(card.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Region', 'p50 ms', 'p99 ms'])
  expect(card.getAllByRole('row')).toHaveLength(4)
  expect(card.getByText('Showing 3 of 812 rows and 3 of 3 columns')).toBeInTheDocument()
  await userEvent.click(card.getByRole('button', { name: 'Copy table' }))
  await userEvent.pointer({ keys: '[MouseRight]', target: card.getByText('us-east') })
  await userEvent.click(within(await screen.findByRole('menu', { name: 'Latency by region' })).getByRole('menuitem', { name: 'Copy table' }))
  expect(vi.mocked(copyWithToast).mock.calls).toEqual([[fixture.table.tsv], [fixture.table.tsv]])
})

it('draws each chart series through the Insights chart with the server\'s formatted values in its values list', async () => {
  const bar = await mount(fixture.chart)
  expect(await bar.findByRole('img', { name: 'Requests per day: peak 1,850.5 at Tue' })).toBeInTheDocument()
  expect(bar.getByText('Max 1,850.5')).toBeInTheDocument()
  expect(bar.getAllByRole('row').map((row) => row.textContent)).toEqual(['Mon1,200', 'Tue1,850.5', 'Wed900'])
  cleanup()
  const line = await mount(fixture.chart_line)
  expect(await line.findByRole('img', { name: 'Error rate · API: peak 2% at Wed' })).toBeInTheDocument()
  expect(line.getByRole('img', { name: 'Error rate · Web: peak 1% at Wed' }).querySelector('polyline')).not.toBeNull()
  expect(line.getByRole('table', { name: 'Error rate · Web' })).toHaveTextContent('Tue0.25%')
})

it('frames an HTML block with scripts only, and opens its page', async () => {
  const open = vi.spyOn(window, 'open').mockReturnValue(null)
  const card = await mount(fixture.html)
  const frame = await card.findByTitle('Release checklist')
  expect(frame.tagName).toBe('IFRAME')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  expect(frame.getAttribute('src')).toMatch(/\/show-frame\/c2JfMTAwMDAwMDAwMDA1\.1794103200\.0f3c$/)
  await userEvent.click(card.getByRole('button', { name: 'Open' }))
  expect(open).toHaveBeenCalledWith(frame.getAttribute('src'), '_blank', 'noopener,noreferrer')
})

it('shows an image file inline and opens a text file on the side panel\'s Files page', async () => {
  const image = await mount(fixture.file_image)
  expect((await image.findByRole('img', { name: 'Signup funnel' })).getAttribute('src')).toMatch(/\/api\/file\/raw\?session_id=20261109_090000_caller&path=reports%2Ffunnel\.png&inline=1$/)
  cleanup()
  const text = await mount(fixture.file_text)
  expect(await text.findByText('docs/notes.md')).toBeInTheDocument()
  await userEvent.click(text.getByRole('button', { name: 'Open' }))
  expect(requestOpenFile).toHaveBeenCalledWith({ sessionId: '20261109_090000_caller', path: 'docs/notes.md' })
})

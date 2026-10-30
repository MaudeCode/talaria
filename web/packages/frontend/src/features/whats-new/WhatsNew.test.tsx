import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { WhatsNewState } from '@maudecode/talaria-web-contracts'

const routerStatus = vi.hoisted(() => ({ value: 'idle' }))
vi.mock('@tanstack/react-router', () => ({ useRouterState: ({ select }: { select: (s: { status: string }) => unknown }) => select({ status: routerStatus.value }) }))
vi.mock('../../api/endpoints', () => ({ fetchWhatsNew: vi.fn() }))
import { fetchWhatsNew } from '../../api/endpoints'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { Dialog } from '../../ui/Dialog'
import { WhatsNew, WhatsNewReplay, whatsNewScope } from './WhatsNew'

// The shared Web/App fixture the server suite composes (contracts/fixtures/whats-new.json).
const shared = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../../contracts/fixtures/whats-new.json'), 'utf8')) as { state: WhatsNewState }
const announcement = shared.state.announcement!
const eligible: WhatsNewState = { announcement, eligible: true, observation: null, acknowledgement: 'web:1.1.0' }
const quiet: WhatsNewState = { announcement, eligible: false, observation: 'web:1.1.0', acknowledgement: null }
const fetchMock = vi.mocked(fetchWhatsNew)
const SCOPE = whatsNewScope(null)
const TITLE = "What's New in Talaria Web"

let wrap: (children: ReactNode) => ReactNode
function renderShell(children: ReactNode = <WhatsNew />, user: string | null = null) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const bootstrap = { ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, user } }
  wrap = (inner) => <QueryClientProvider client={qc}><BootstrapContext.Provider value={bootstrap}>{inner}</BootstrapContext.Provider></QueryClientProvider>
  return render(wrap(children))
}

afterEach(() => { fetchMock.mockReset(); routerStatus.value = 'idle'; vi.restoreAllMocks() })

describe("What's New (TAL-1617)", () => {
  it('presents the heading, icon rows and one Continue action in reading order', async () => {
    fetchMock.mockResolvedValue(eligible)
    renderShell()
    const dialog = await screen.findByRole('dialog', { name: "What's New in Talaria Web" })
    expect(fetchMock).toHaveBeenCalledWith(null)
    const rows = within(dialog).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual(announcement.rows.map((row) => row.title + row.description))
    // Icons are decorative: a screen reader hears each title once.
    for (const row of rows) expect(row.querySelector('svg')).toHaveAttribute('aria-hidden', 'true')
    expect(within(dialog).getAllByRole('button').map((b) => b.textContent)).toEqual(['Continue'])
    const order = [within(dialog).getByRole('heading'), ...rows, within(dialog).getByRole('button')]
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Base UI moves focus into the popup once it has opened.
    await waitFor(() => { expect(dialog).toContainElement(document.activeElement as HTMLElement) })
  })

  it.each([
    ['Continue', async () => { await userEvent.click(screen.getByRole('button', { name: 'Continue' })) }],
    ['Escape', async () => { await userEvent.keyboard('{Escape}') }],
  ])('%s closes at once and records the acknowledgement', async (_name, dismiss) => {
    window.localStorage.setItem(SCOPE, 'web:1.0.0')
    fetchMock.mockResolvedValue(eligible)
    renderShell()
    await screen.findByRole('dialog')
    expect(fetchMock).toHaveBeenCalledWith('web:1.0.0')
    // Unseen content is never recorded as seen.
    expect(window.localStorage.getItem(SCOPE)).toBe('web:1.0.0')
    await dismiss()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(SCOPE)).toBe('web:1.1.0')
  })

  it('stores a quiet observation at once and presents nothing', async () => {
    fetchMock.mockResolvedValue(quiet)
    renderShell()
    await waitFor(() => { expect(window.localStorage.getItem(SCOPE)).toBe('web:1.1.0') })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('stays quiet and records nothing when the read fails or the payload is empty', async () => {
    window.localStorage.setItem(SCOPE, 'web:1.0.0')
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    const { unmount } = renderShell()
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(1) })
    expect(screen.queryByRole('dialog')).toBeNull()
    unmount()
    fetchMock.mockResolvedValueOnce({ announcement: null, eligible: false, observation: null, acknowledgement: null })
    renderShell()
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(SCOPE)).toBe('web:1.0.0')
  })

  it('waits for another dialog to close', async () => {
    fetchMock.mockResolvedValue(eligible)
    const blocking = (open: boolean) => <><Dialog open={open} onOpenChange={() => undefined} title="Blocking" /><WhatsNew /></>
    const view = renderShell(blocking(true))
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    await screen.findByRole('dialog', { name: 'Blocking' })
    expect(screen.queryByRole('dialog', { name: TITLE })).toBeNull()
    view.rerender(wrap(blocking(false)))
    await screen.findByRole('dialog', { name: TITLE })
  })

  it('waits for a pending navigation to settle', async () => {
    routerStatus.value = 'pending'
    fetchMock.mockResolvedValue(eligible)
    const view = renderShell()
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    expect(screen.queryByRole('dialog')).toBeNull()
    routerStatus.value = 'idle'
    view.rerender(wrap(<WhatsNew />))
    await screen.findByRole('dialog', { name: TITLE })
  })

  it('never interrupts a draft and returns focus to the field it left', async () => {
    fetchMock.mockResolvedValue(eligible)
    renderShell(<><textarea aria-label="Draft" defaultValue="half a thought" autoFocus /><WhatsNew /></>)
    const draft = screen.getByRole('textbox', { name: 'Draft' })
    await waitFor(() => { expect(fetchMock).toHaveBeenCalled() })
    expect(draft).toHaveFocus()
    expect(screen.queryByRole('dialog')).toBeNull()
    await userEvent.clear(draft)
    const dialog = await screen.findByRole('dialog', { name: TITLE })
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    await waitFor(() => { expect(draft).toHaveFocus() })
  })

  it('closes when another tab of this browser acknowledges it', async () => {
    window.localStorage.setItem(SCOPE, 'web:1.0.0')
    fetchMock.mockResolvedValueOnce(eligible).mockResolvedValue(quiet)
    renderShell()
    await screen.findByRole('dialog')
    act(() => {
      window.localStorage.setItem(SCOPE, 'web:1.1.0')
      window.dispatchEvent(new StorageEvent('storage', { key: SCOPE, newValue: 'web:1.1.0' }))
    })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(fetchMock).toHaveBeenLastCalledWith('web:1.1.0')
  })

  it('does not reopen an acknowledged prompt when another tab later stores a newer token', async () => {
    window.localStorage.setItem(SCOPE, 'web:1.0.0')
    fetchMock.mockResolvedValueOnce(eligible).mockResolvedValue({ announcement, eligible: false, observation: null, acknowledgement: null })
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    act(() => {
      window.localStorage.setItem(SCOPE, 'web:1.2.0')
      window.dispatchEvent(new StorageEvent('storage', { key: SCOPE, newValue: 'web:1.2.0' }))
    })
    // This tab never re-presents its own cached answer; the server decides again for the new token.
    expect(await screen.findByRole('dialog', {}, { timeout: 300 }).catch(() => null)).toBeNull()
    await waitFor(() => { expect(fetchMock).toHaveBeenLastCalledWith('web:1.2.0') })
    expect(window.localStorage.getItem(SCOPE)).toBe('web:1.2.0')
  })

  it('closes on dismissal even when the acknowledgement cannot be saved', async () => {
    window.localStorage.setItem(SCOPE, 'web:1.0.0')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
    fetchMock.mockResolvedValue(eligible)
    renderShell()
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps each signed-in user and anonymous use in its own scope', async () => {
    window.localStorage.setItem(whatsNewScope('alice'), 'web:1.0.0')
    fetchMock.mockResolvedValue(eligible)
    renderShell(<WhatsNew />, 'alice')
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(window.localStorage.getItem(whatsNewScope('alice'))).toBe('web:1.1.0')
    expect(window.localStorage.getItem(whatsNewScope('bob'))).toBeNull()
    expect(window.localStorage.getItem(SCOPE)).toBeNull()
  })

  it('replays the same dialog from Settings without recording or re-enabling the prompt', async () => {
    fetchMock.mockResolvedValue(quiet)
    renderShell(<><WhatsNewReplay /><WhatsNew /></>)
    await waitFor(() => { expect(window.localStorage.getItem(SCOPE)).toBe('web:1.1.0') })
    await userEvent.click(await screen.findByRole('button', { name: "What's New" }))
    const dialog = await screen.findByRole('dialog', { name: "What's New in Talaria Web" })
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(announcement.rows.length)
    await userEvent.click(within(dialog).getByRole('button', { name: 'Continue' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.localStorage.getItem(SCOPE)).toBe('web:1.1.0')
  })

  it('degrades to this page when browser storage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
    fetchMock.mockResolvedValue(eligible)
    // A scope no earlier test touched: the in-memory fallback lasts for the page.
    const view = renderShell(<WhatsNew />, 'private-mode')
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    view.unmount()
    renderShell(<WhatsNew />, 'private-mode')
    await waitFor(() => { expect(fetchMock).toHaveBeenCalledTimes(2) })
    // The acknowledgement this page kept answers the next read and suppresses a repeat prompt.
    expect(fetchMock).toHaveBeenLastCalledWith('web:1.1.0')
  })
})

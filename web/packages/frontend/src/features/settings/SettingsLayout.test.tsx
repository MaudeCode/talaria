import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ section: 'system' }),
  useMatchRoute: () => () => false,
  useNavigate: () => navigate,
  useLocation: ({ select }: { select: (location: { pathname: string }) => unknown }) => select({ pathname: '/settings/system' }),
  Link: ({ children, className }: { children: ReactNode; className?: string }) => <a className={className}>{children}</a>,
}))
vi.mock('../../shell/ProfileMenu', () => ({ useActiveProfileName: () => 'default' }))
import { SectionMenu } from './SettingsLayout'

const input = () => document.getElementById('settingsSearch') as HTMLInputElement
const glass = () => screen.getByRole('button', { name: 'Search' })
const isOpen = () => input().closest('.panel-search')!.hasAttribute('data-open')
const open = async () => {
  await userEvent.click(glass())
  expect(input()).toHaveFocus()
  expect(isOpen()).toBe(true)
  expect(glass()).toHaveAttribute('aria-expanded', 'true')
}
const expectClosed = () => {
  expect(isOpen()).toBe(false)
  expect(input()).toHaveValue('')
  expect(glass()).toHaveFocus()
  expect(glass()).toHaveAttribute('aria-expanded', 'false')
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('min-width'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }))
  navigate.mockReset()
})

describe('Settings search (TAL-2184)', () => {
  it('rests as one glass on the Settings head and opens the field in that row, focused', async () => {
    render(<SectionMenu />)
    const head = glass().closest('.panel-head') as HTMLElement
    expect(head).toHaveTextContent('Settings')
    expect(within(head).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Search'])
    expect(glass()).toHaveAttribute('aria-expanded', 'false')
    expect(glass()).toHaveAttribute('aria-controls', 'settingsSearch')
    expect(isOpen()).toBe(false)
    expect(input().closest('.panel-search')).toContainElement(head)
    await open()
  })

  it('finds rows as before and closes with the query cleared once a result is chosen', async () => {
    render(<SectionMenu />)
    await open()
    await userEvent.type(input(), 'update channel')
    const results = screen.getByRole('listbox')
    expect(within(results).getAllByRole('option').map((o) => o.querySelector('span')?.textContent)).toEqual(['Web update channel', 'Agent update channel'])
    expect(screen.getByRole('status')).toHaveTextContent('2 settings')
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(navigate).toHaveBeenCalledWith({ to: '/settings/$section', params: { section: 'system' }, search: {}, hash: 'settingsAgentUpdateChannel' })
    expectClosed()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('clears text on the first Escape and closes on the next', async () => {
    render(<SectionMenu />)
    await open()
    await userEvent.type(input(), 'update')
    await userEvent.keyboard('{Escape}')
    expect(input()).toHaveValue('')
    expect(isOpen()).toBe(true)
    expect(input()).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expectClosed()
  })

  it.each(['the x button', 'focus leaving'])('closes an empty field with %s and returns focus to the glass', async (dismiss) => {
    render(<SectionMenu />)
    await open()
    if (dismiss === 'focus leaving') act(() => input().blur())
    else await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expectClosed()
  })

  it('clears and closes a field with text from the x button', async () => {
    render(<SectionMenu />)
    await open()
    await userEvent.type(input(), 'update')
    act(() => input().blur())
    expect(isOpen()).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expectClosed()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LinkCheckContext, Markdown, type LinkCheck } from './Markdown'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const markdown = '[docs](https://Docs.Example.com:8443/guide) and [lookalike](https://docs.example.com.evil.test/)'
const openSpy = () => vi.spyOn(window, 'open').mockImplementation(() => null)

describe('external link confirmation (TAL-279)', () => {
  it('asks in a labelled app dialog; Cancel and Escape dismiss, Open opens a new tab', async () => {
    const open = openSpy()
    render(<Markdown text={markdown} />)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    const dialog = await screen.findByRole('dialog', { name: 'Open external link?' })
    // Without a server answer (shared transcripts) the dialog names no host it would have to derive.
    expect(dialog).toHaveTextContent('This link opens outside Talaria.')
    expect(dialog).toHaveTextContent('https://docs.example.com:8443/guide')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    await userEvent.click(screen.getByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(open).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: 'docs' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Open link' }))
    expect(open).toHaveBeenCalledWith('https://docs.example.com:8443/guide', '_blank', 'noreferrer')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('opens a link directly only when the server says so, asking with the clicked URL', async () => {
    const open = openSpy()
    const check = vi.fn((url: string) => Promise.resolve(url.includes('evil') ? { opens_directly: false, host: 'server-named.test' } : { opens_directly: true, host: 'docs.example.com' }))
    render(<LinkCheckContext value={check}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await waitFor(() => { expect(open).toHaveBeenCalledWith('https://docs.example.com:8443/guide', '_blank', 'noreferrer') })
    expect(check).toHaveBeenCalledWith('https://docs.example.com:8443/guide')
    expect(screen.queryByRole('dialog')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: 'lookalike' }))
    expect(await screen.findByRole('dialog', { name: 'Open external link?' })).toHaveTextContent('This link goes to server-named.test.')
    expect(check).toHaveBeenLastCalledWith('https://docs.example.com.evil.test/')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('warns when the server check fails or does not answer in time', async () => {
    const open = openSpy()
    const { unmount } = render(<LinkCheckContext value={() => Promise.reject(new Error('offline'))}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' })
    unmount()

    render(<LinkCheckContext value={() => new Promise<LinkCheck>(() => undefined)}><Markdown text={markdown} /></LinkCheckContext>)
    await userEvent.click(await screen.findByRole('button', { name: 'docs' }))
    await screen.findByRole('dialog', { name: 'Open external link?' }, { timeout: 2000 })
    expect(open).not.toHaveBeenCalled()
  })
})

describe('JSON code blocks (TAL-615)', () => {
  it('toggles a parsed JSON block between the raw code and a tree, and leaves other blocks raw', async () => {
    render(<Markdown text={'```json\n{"name": "talaria", "tags": ["web", "app"], "nested": {"deep": {"leaf": null}}}\n```\n\n```json\n{"broken": \n```'} />)
    const toggle = await screen.findByRole('button', { name: 'Tree' })
    expect(screen.getAllByRole('button', { name: 'Tree' })).toHaveLength(1)
    expect(document.querySelector('[data-json-tree]')).toBeNull()
    await userEvent.click(toggle)
    const tree = document.querySelector('[data-json-tree]')!
    expect(tree).toHaveTextContent('"name": "talaria"')
    expect(tree).toHaveTextContent('"web"')
    // Deep levels start folded, as in the legacy tree.
    const deep = [...tree.querySelectorAll('details')].find((node) => node.querySelector(':scope > summary')?.textContent.includes('"deep"'))
    expect(deep).not.toHaveAttribute('open')
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }))
    expect(document.querySelector('[data-json-tree]')).toBeNull()
    expect(screen.getByRole('button', { name: 'Tree' })).toBeInTheDocument()
  })
})

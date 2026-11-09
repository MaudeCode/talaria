import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onOpenTerminalRequest, takeOpenTerminalRequest } from '../../terminal/openTerminalRequest'
import { TerminalResult } from './OutboundDraftResult'

/** The recorded `terminal_open` result (TAL-1974), as the server links it on the call (`result_view.terminal`). */
const opened = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/sidecar/terminal.json'), 'utf8')) as { 'server.terminal_open': { result: { terminal_id: string; title: string; command: string } }[] })['server.terminal_open'][0]!.result
const SESSION = '20261109_090000_caller'

afterEach(() => { cleanup(); takeOpenTerminalRequest(SESSION) })

it('shows the title and the command, and Open asks this session\'s terminal pane to open and focus', async () => {
  render(<TerminalResult sessionId={SESSION} reference={{ terminal_id: opened.terminal_id, title: opened.title, command: opened.command }} />)
  const card = within(screen.getByRole('region', { name: 'Terminal' }))
  expect(card.getByText('Unit tests')).toBeInTheDocument()
  expect(card.getByText('npm test')).toBeInTheDocument()
  let heard = 0
  const stop = onOpenTerminalRequest(() => { heard += 1 })
  await userEvent.click(card.getByRole('button', { name: 'Open terminal' }))
  stop()
  expect(heard).toBe(1)
  expect(takeOpenTerminalRequest('another_session')).toBeNull()
  expect(takeOpenTerminalRequest(SESSION)).toEqual({ sessionId: SESSION })
  expect(takeOpenTerminalRequest(SESSION), 'A request is taken once').toBeNull()
})

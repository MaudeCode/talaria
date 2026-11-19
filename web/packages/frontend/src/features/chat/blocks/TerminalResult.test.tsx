import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { onOpenTerminalRequest, takeOpenTerminalRequest } from '../../terminal/openTerminalRequest'
import { BootstrapContext } from '../../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../../contracts/adapters/memory'
import { TerminalResult } from './OutboundDraftResult'

/** The recorded `terminal_open` result (TAL-1974), as the server links it on the call (`result_view.terminal`). */
const opened = (JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../../../contracts/fixtures/sidecar/terminal.json'), 'utf8')) as { 'server.terminal_open': { result: { terminal_id: string; title: string; command: string } }[] })['server.terminal_open'][0]!.result
const SESSION = '20261109_090000_caller'

const reference = { terminal_id: opened.terminal_id, title: opened.title, command: opened.command }
const renderCard = (canManageServer = true) => render(<BootstrapContext.Provider value={{ ...DEFAULT_BOOTSTRAP, auth: { ...DEFAULT_BOOTSTRAP.auth, can_manage_server: canManageServer } }}>
  <TerminalResult sessionId={SESSION} reference={reference} />
</BootstrapContext.Provider>)

afterEach(() => { cleanup(); takeOpenTerminalRequest(SESSION) })

it('shows the title and the command, and Open, from the button or the context menu, asks for its own terminal in this session\'s pane', async () => {
  renderCard()
  const card = within(screen.getByRole('region', { name: 'Terminal' }))
  expect(card.getByText('Unit tests')).toBeInTheDocument()
  expect(card.getByText('npm test')).toBeInTheDocument()
  let heard = 0
  const stop = onOpenTerminalRequest(() => { heard += 1 })
  await userEvent.click(card.getByRole('button', { name: 'Open terminal' }))
  stop()
  expect(heard).toBe(1)
  expect(takeOpenTerminalRequest('another_session')).toBeNull()
  expect(takeOpenTerminalRequest(SESSION)).toEqual({ sessionId: SESSION, terminalId: opened.terminal_id })
  expect(takeOpenTerminalRequest(SESSION), 'A request is taken once').toBeNull()
  await userEvent.pointer({ keys: '[MouseRight]', target: card.getByText('npm test') })
  await userEvent.click(within(await screen.findByRole('menu', { name: 'Unit tests' })).getByRole('menuitem', { name: 'Open terminal' }))
  expect(takeOpenTerminalRequest(SESSION)).toEqual({ sessionId: SESSION, terminalId: opened.terminal_id })
})

it('offers no Open to a session without owner authority, since the terminal pane is owner-only (TAL-2201)', async () => {
  renderCard(false)
  const card = within(screen.getByRole('region', { name: 'Terminal' }))
  expect(card.getByText('npm test')).toBeInTheDocument()
  expect(card.queryByRole('button', { name: 'Open terminal' })).toBeNull()
  await userEvent.pointer({ keys: '[MouseRight]', target: card.getByText('npm test') })
  expect(screen.queryByRole('menuitem', { name: 'Open terminal' })).toBeNull()
})

/** TAL-2380: the screen viewer watches until Take over, takes and hands back through the server, and closes its socket. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ScreenView } from '@maudecode/talaria-web-contracts'

const { sockets, leaseScreen } = vi.hoisted(() => ({ sockets: [] as { url: string; viewOnly: boolean; disconnected: boolean; target: EventTarget }[], leaseScreen: vi.fn() }))
// noVNC's client over the server's socket: records the URL it dialed, its input gate and whether it was closed.
vi.mock('@novnc/novnc', () => ({
  default: class extends EventTarget {
    viewOnly = false
    scaleViewport = false
    background = ''
    constructor(_target: HTMLElement, readonly url: string) {
      super()
      sockets.push(this as never)
      queueMicrotask(() => { this.dispatchEvent(new Event('connect')) })
    }
    disconnect() { (this as unknown as { disconnected: boolean }).disconnected = true }
  },
}))
vi.mock('../../api/endpoints', async (original) => ({ ...await original<object>(), leaseScreen }))

const { ScreenViewer } = await import('./ScreenViewer')
const running: ScreenView = { available: true, state: 'running', control: 'agent', install_command: null }

beforeEach(() => {
  sockets.length = 0
  leaseScreen.mockReset()
})

it('takes over and hands back through its own viewer, and closing ends the socket', async () => {
  const onOpenChange = vi.fn()
  const view = render(<ScreenViewer open onOpenChange={onOpenChange} screen={running} />)
  const takeOver = await screen.findByRole('button', { name: 'Take over' })
  await waitFor(() => { expect(takeOver).toBeEnabled() })
  const [socket] = sockets
  const viewId = new URL(socket!.url).searchParams.get('view_id')
  expect(new URL(socket!.url).pathname).toBe('/api/screen/ws')
  expect(socket!.viewOnly).toBe(true)

  leaseScreen.mockResolvedValueOnce({ ...running, control: 'you' })
  fireEvent.click(takeOver)
  const handBack = await screen.findByRole('button', { name: 'Hand back' })
  expect(leaseScreen).toHaveBeenLastCalledWith({ view_id: viewId, action: 'acquire' })
  expect(socket!.viewOnly).toBe(false)

  leaseScreen.mockResolvedValueOnce(running)
  fireEvent.click(handBack)
  await screen.findByRole('button', { name: 'Take over' })
  expect(leaseScreen).toHaveBeenLastCalledWith({ view_id: viewId, action: 'release' })
  expect(socket!.viewOnly).toBe(true)

  view.rerender(<ScreenViewer open={false} onOpenChange={onOpenChange} screen={running} />)
  expect(socket!.disconnected).toBe(true)
})

it('rolls a refused take-over back to watching', async () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={running} />)
  const takeOver = await screen.findByRole('button', { name: 'Take over' })
  await waitFor(() => { expect(takeOver).toBeEnabled() })
  leaseScreen.mockRejectedValueOnce(new Error('The owner refused'))
  act(() => { fireEvent.click(takeOver) })
  expect(await screen.findByRole('button', { name: 'Take over' })).toBeEnabled()
  expect(sockets[0]!.viewOnly).toBe(true)
})

it('shows the server\'s install command while the desktop packages are missing', () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={{ available: true, state: 'not_installed', control: 'agent', install_command: 'sudo apt-get install -y tigervnc-standalone-server xfce4' }} />)
  expect(screen.getByText('sudo apt-get install -y tigervnc-standalone-server xfce4')).toBeVisible()
  expect(sockets).toEqual([])
})

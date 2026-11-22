/** TAL-2380: the screen viewer watches until Take over, takes and hands back through the server, and closes its socket. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { ScreenView } from '@maudecode/talaria-web-contracts'
import { ApiError } from '../../contracts/common'

const { sockets, leaseScreen, fetchScreenView } = vi.hoisted(() => ({ sockets: [] as { url: string; viewOnly: boolean; disconnected: boolean; target: EventTarget }[], leaseScreen: vi.fn(), fetchScreenView: vi.fn() }))
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
vi.mock('../../api/endpoints', async (original) => ({ ...await original<object>(), leaseScreen, fetchScreenView }))

const { ScreenViewer } = await import('./ScreenViewer')
const running: ScreenView = { available: true, state: 'running', control: 'agent', install_command: null }

beforeEach(() => {
  sockets.length = 0
  leaseScreen.mockReset()
  fetchScreenView.mockReset()
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

it('rolls a refused take-over back to watching without asking again', async () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={running} />)
  const takeOver = await screen.findByRole('button', { name: 'Take over' })
  await waitFor(() => { expect(takeOver).toBeEnabled() })
  leaseScreen.mockRejectedValueOnce(new ApiError({ kind: 'http', status: 502, path: '/api/screen/lease', message: 'The owner refused' }))
  leaseScreen.mockRejectedValueOnce(new ApiError({ kind: 'http', status: 409, path: '/api/screen/lease', message: 'Still connecting' }))
  act(() => { fireEvent.click(takeOver) })
  await waitFor(() => { expect(fetchScreenView).toHaveBeenCalledTimes(1) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: /Take over|Hand back/ })) })
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Take over' })).toBeEnabled() })
  expect(fetchScreenView).toHaveBeenCalledTimes(1)
  expect(sockets[0]!.viewOnly).toBe(true)
})

it('settles a take-over whose answer was lost from this viewer\'s own read', async () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={running} />)
  const takeOver = await screen.findByRole('button', { name: 'Take over' })
  await waitFor(() => { expect(takeOver).toBeEnabled() })
  const viewId = new URL(sockets[0]!.url).searchParams.get('view_id')
  leaseScreen.mockRejectedValueOnce(new ApiError({ kind: 'network', path: '/api/screen/lease', message: 'Load failed' }))
  fetchScreenView.mockResolvedValueOnce({ ...running, control: 'you' })
  act(() => { fireEvent.click(takeOver) })
  // The owner applied it: this viewer keeps control instead of rolling back.
  await waitFor(() => { expect(fetchScreenView).toHaveBeenCalledWith({ view_id: viewId }) })
  expect(await screen.findByRole('button', { name: 'Hand back' })).toBeVisible()
  expect(sockets[0]!.viewOnly).toBe(false)
})

it('shows the server\'s install command while the desktop packages are missing', () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={{ available: true, state: 'not_installed', control: 'agent', install_command: 'sudo apt-get install -y tigervnc-standalone-server xfce4' }} />)
  expect(screen.getByText('sudo apt-get install -y tigervnc-standalone-server xfce4')).toBeVisible()
  expect(sockets).toEqual([])
})

it('sends overlapping take-over and hand-back in order and shows the newest choice, whatever answers last', async () => {
  render(<ScreenViewer open onOpenChange={vi.fn()} screen={running} />)
  const takeOver = await screen.findByRole('button', { name: 'Take over' })
  await waitFor(() => { expect(takeOver).toBeEnabled() })
  let answerTake: (view: ScreenView) => void = () => undefined
  leaseScreen.mockImplementationOnce(() => new Promise((resolve) => { answerTake = resolve }))
  leaseScreen.mockResolvedValueOnce({ ...running, control: 'agent' })
  leaseScreen.mockResolvedValueOnce({ ...running, control: 'you' })
  act(() => { fireEvent.click(takeOver) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Hand back' })) })
  act(() => { fireEvent.click(screen.getByRole('button', { name: 'Take over' })) })
  // The newest choice shows at once; the later requests wait for the first to settle.
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeVisible()
  await waitFor(() => { expect(leaseScreen).toHaveBeenCalledTimes(1) })
  await act(async () => { await Promise.resolve() })
  expect(leaseScreen).toHaveBeenCalledTimes(1)
  await act(async () => { answerTake({ ...running, control: 'you' }); await Promise.resolve() })
  await waitFor(() => { expect(leaseScreen).toHaveBeenCalledTimes(3) })
  expect(leaseScreen.mock.calls.map(([input]) => (input as { action: string }).action)).toEqual(['acquire', 'release', 'acquire'])
  await waitFor(() => { expect(sockets[0]!.viewOnly).toBe(false) })
  expect(screen.getByRole('button', { name: 'Hand back' })).toBeVisible()
})

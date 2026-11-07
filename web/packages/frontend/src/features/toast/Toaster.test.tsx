import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Toaster } from './Toaster'
import { dismissToast, removeToast, showRichToast, TOAST_EXIT_MS } from './toast'

describe('notification toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
  })

  it('marks a manually dismissed popup through its callback but timeout alone does not', async () => {
    const manual = vi.fn()
    const expired = vi.fn()
    showRichToast({ id: 'manual-read', title: 'Manual', text: 'Dismiss me', ttl: 0, kind: 'info', dismissible: true, actions: [], onDismiss: manual })
    showRichToast({ id: 'timeout-unread', title: 'Timeout', text: 'Let me expire', ttl: 10, kind: 'info', dismissible: true, actions: [], onDismiss: expired })
    render(<Toaster />)

    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss' })[0]!)
    expect(manual).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(20)
    expect(expired).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(TOAST_EXIT_MS)
  })

  it('uses an accessible body control and updates an existing popup without replaying its entrance', async () => {
    const frame = vi.fn((callback: FrameRequestCallback) => { callback(0); return 1 })
    vi.stubGlobal('requestAnimationFrame', frame)
    const select = vi.fn()
    act(() => showRichToast({ id: 'body-select', title: 'Notice', text: 'Open it', ttl: 0, kind: 'warning', dismissible: false, actions: [], onBodySelect: select, bodyLabel: 'Open notice' }))
    const { container } = render(<Toaster />)
    await userEvent.click(screen.getByRole('button', { name: 'Open notice' }))
    expect(select).toHaveBeenCalledOnce()
    expect(container.querySelector('[data-visible="true"]')).not.toBeNull()

    act(() => showRichToast({ id: 'body-select', title: 'Notice updated', text: 'Still open', ttl: 0, kind: 'warning', dismissible: false, actions: [], onBodySelect: select, bodyLabel: 'Open notice' }))
    expect(container.querySelector('[data-visible="true"]')).not.toBeNull()
    expect(screen.getByText('Notice updated')).toBeInTheDocument()
    expect(frame).toHaveBeenCalledOnce()
  })

  it('keeps a new lifecycle revision visible when it arrives during the prior exit', async () => {
    act(() => showRichToast({ id: 'lifecycle', revision: '1', title: 'Update', text: 'Installing', ttl: 0, kind: 'info', dismissible: true, actions: [] }))
    const { container } = render(<Toaster />)
    expect(container.querySelector('[data-visible="true"]')).not.toBeNull()

    act(() => dismissToast('lifecycle'))
    expect(container.querySelector('[data-visible="false"]')).not.toBeNull()
    act(() => showRichToast({ id: 'lifecycle', revision: '2', title: 'Update', text: 'Installed', ttl: 0, kind: 'info', dismissible: true, actions: [] }))
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(container.querySelector('[data-visible="true"]')).not.toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(TOAST_EXIT_MS))
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(container.querySelector('[data-visible="true"]')).not.toBeNull()
  })

  it('expires an unpainted transient without read side effects or a late resurrection', async () => {
    let paint: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1 })
    const read = vi.fn()
    act(() => showRichToast({ id: 'background-arrival', revision: '1', title: 'Background', text: 'Transient', ttl: 10, kind: 'info', dismissible: true, actions: [], onDismiss: read }))
    const { container } = render(<Toaster />)
    expect(container.querySelector('[data-visible="false"]')).not.toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(20))
    expect(screen.queryByText('Transient')).not.toBeInTheDocument()
    expect(read).not.toHaveBeenCalled()
    act(() => paint?.(20))
    expect(screen.queryByText('Transient')).not.toBeInTheDocument()
  })

  it.each([['error', 'border-error/60'], ['warning', 'border-warning/60'], ['info', 'border-border']] as const)('renders %s toasts as rooms whose surface layer is apart from their content', (kind, border) => {
    let paint: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { paint = callback; return 1 })
    act(() => showRichToast({ id: `room-${kind}`, text: `Room ${kind}`, ttl: 0, kind, dismissible: false, actions: [] }))
    render(<Toaster />)

    const text = screen.getByText(`Room ${kind}`)
    const room = text.closest('.notification-toast-room')
    expect(room).not.toBeNull()
    expect(room).toHaveAttribute('data-visible', 'false')
    const surface = room!.querySelector('.notification-toast-surface')
    expect(surface).toHaveClass(border)
    expect(surface).not.toContainElement(text)
    expect(text.closest('.notification-toast-content')).not.toBeNull()

    act(() => paint?.(0))
    expect(room).toHaveAttribute('data-visible', 'true')
    act(() => removeToast(`room-${kind}`))
  })

  it('keeps a dismissed toast mounted and closed for TOAST_EXIT_MS, then removes it', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1 })
    act(() => showRichToast({ id: 'exit', text: 'Leaving', ttl: 0, kind: 'info', dismissible: true, actions: [] }))
    render(<Toaster />)

    act(() => dismissToast('exit'))
    await act(() => vi.advanceTimersByTimeAsync(TOAST_EXIT_MS - 1))
    expect(screen.getByText('Leaving').closest('[data-visible]')).toHaveAttribute('data-visible', 'false')
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.queryByText('Leaving')).not.toBeInTheDocument()
  })
})

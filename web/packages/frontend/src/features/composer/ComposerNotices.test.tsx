import { describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ComposerNotices, type ComposerNotice } from './ComposerNotices'

const detailed = (text: string): ComposerNotice => ({ id: 'rich', content: 'Rich chip', detail: { title: 'Rich detail', content: <p>{text}</p> } })

function setup(initial: ComposerNotice[]) {
  const input = createRef<HTMLTextAreaElement>()
  const tree = (notices: ComposerNotice[]) => <><textarea ref={input} aria-label="Message" /><ComposerNotices notices={notices} fallbackFocus={input} /></>
  const view = render(tree(initial))
  return { ...view, input, update: (notices: ComposerNotice[]) => view.rerender(tree(notices)) }
}

describe('ComposerNotices (TAL-1078)', () => {
  it('renders no row without notices and one chip per notice, each with its own actions', async () => {
    const retry = vi.fn()
    const dismiss = vi.fn()
    const { container, update } = setup([])
    expect(container.querySelector('.composer-notices')).toBeNull()
    update([{ id: 'a', content: 'First', action: { label: 'Retry', run: retry } }, { id: 'b', tone: 'error', content: 'Second', onDismiss: dismiss }])
    const [first, second] = container.querySelectorAll<HTMLElement>('.composer-notice')
    expect(first).toHaveTextContent('First')
    expect(second).toHaveAttribute('data-tone', 'error')
    await userEvent.click(within(first!).getByRole('button', { name: 'Retry' }))
    await userEvent.click(within(second!).getByRole('button', { name: 'Dismiss' }))
    expect(retry).toHaveBeenCalledOnce()
    expect(dismiss).toHaveBeenCalledOnce()
    // A notice without detail has nothing to open.
    expect(within(first!).queryByRole('button', { name: 'First' })).toBeNull()
  })

  it('opens the current detail in a dialog and returns focus to its chip on Escape', async () => {
    const { update } = setup([detailed('Partial')])
    const chip = screen.getByRole('button', { name: 'Rich chip' })
    expect(chip).toHaveAttribute('aria-haspopup', 'dialog')
    await userEvent.click(chip)
    const dialog = await screen.findByRole('dialog', { name: 'Rich detail' })
    expect(dialog).toHaveTextContent('Partial')
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    update([detailed('Partial, then whole')])
    expect(dialog).toHaveTextContent('Partial, then whole')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(chip).toHaveFocus()
  })

  it('closes when its notice ends, focuses the composer, and does not reopen when the notice returns', async () => {
    const { update, input } = setup([detailed('Queued')])
    await userEvent.click(screen.getByRole('button', { name: 'Rich chip' }))
    await screen.findByRole('dialog', { name: 'Rich detail' })
    update([])
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(input.current).toHaveFocus())
    update([detailed('Queued again')])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('never duplicates or revives a chip re-added during its exit', async () => {
    const { container, update } = setup([{ id: 'x', content: 'Old' }])
    update([])
    expect(container.querySelector('[data-notice="x"]')).toHaveClass('is-leaving')
    update([{ id: 'x', content: 'New' }])
    expect(container.querySelectorAll('[data-notice="x"]')).toHaveLength(1)
    expect(container.querySelector('[data-notice="x"]')).toHaveTextContent('New')
    expect(container.querySelector('[data-notice="x"]')).not.toHaveClass('is-leaving')
    // The cancelled exit's timer must not remove the returned chip.
    await new Promise((r) => setTimeout(r, 260))
    expect(container.querySelector('[data-notice="x"]')).toHaveTextContent('New')
  })
})

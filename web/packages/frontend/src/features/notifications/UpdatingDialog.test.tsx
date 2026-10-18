import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateNotificationSchema, type UpdateNotification } from '../../contracts'
import { UpdatingDialog } from './UpdatingDialog'

/** TAL-953 / TAL-1138: the server's waiting gateway restart, as `/api/update-notifications` ships it. */
const waiting = UpdateNotificationSchema.parse({
  id: '00000000-0000-4000-8000-000000000003', kind: 'update', target: 'agent', phase: 'waiting_for_idle', severity: 'info',
  persistent: false, requires_acknowledgement: false,
  actions: [{ id: 'restart_gateway_now', label: 'Restart now', style: 'destructive', acknowledges: false }],
  destination: { key: 'settings.system', label: 'Open System settings' },
  title: 'Hermes Agent update', message: 'Waiting for 2 running gateway tasks to finish before restarting the gateway.',
  created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:05Z', read_at: null, acknowledged_at: null, acknowledged_action_id: null,
  verified_revision: null, verified_version: null, detail: null, unread: true, active: false, requires_interaction: false, can_dismiss: false,
  steps: [
    { id: 'install', label: 'Installing', state: 'done' },
    { id: 'web_restart', label: 'Restarting Talaria Web', state: 'done' },
    { id: 'gateway_wait', label: 'Waiting for 2 gateway tasks', state: 'active' },
    { id: 'gateway_restart', label: 'Restarting gateway', state: 'pending' },
    { id: 'agent_ready', label: 'Agent responding', state: 'pending' },
  ],
  presents_dialog: false, dialog_close: 'restart_later',
})

const dialog = (row: UpdateNotification, handlers: { onAction?: (id: string) => void; onClose?: () => void } = {}) => render(<UpdatingDialog target="agent" row={row} message={null} lost={false} reconnecting={false} checking={false} actionPending={false} onAction={handlers.onAction ?? (() => undefined)} onCheckAgain={() => undefined} onClose={handlers.onClose ?? (() => undefined)} />)

describe('UpdatingDialog', () => {
  it('lists the server steps and offers Restart now and Restart later while the gateway restart waits', async () => {
    const onAction = vi.fn()
    const onClose = vi.fn()
    dialog(waiting, { onAction, onClose })
    const steps = within(screen.getByRole('status')).getAllByRole('listitem')
    expect(steps.map((step) => step.textContent)).toEqual(['Installing', 'Restarting Talaria Web', 'Waiting for 2 gateway tasks', 'Restarting gateway', 'Agent responding'])
    expect(steps[2]).toHaveAttribute('aria-current', 'step')
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(onAction).toHaveBeenCalledWith('restart_gateway_now')
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Restart later' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('cannot be closed while the server presents the update', async () => {
    const onClose = vi.fn()
    dialog({ ...waiting, phase: 'restarting', actions: [], presents_dialog: true, dialog_close: 'none' }, { onClose })
    expect(screen.queryByRole('button')).toBeNull()
    await userEvent.keyboard('{Escape}')
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog', { name: 'Updating Hermes Agent' })).toBeVisible()
  })

  it('shows the failure under the failed step and gains Close', async () => {
    const onClose = vi.fn()
    dialog({
      ...waiting, phase: 'failed', actions: [], dialog_close: 'close', message: 'The update could not be completed.',
      detail: 'Hermes Agent was updated, but the gateway did not come back. Run `hermes gateway restart` manually.',
      steps: waiting.steps.map((step) => ({ ...step, state: step.id === 'agent_ready' ? 'failed' : 'done' })),
    }, { onClose })
    const failed = within(screen.getByRole('status')).getAllByRole('listitem').at(-1)!
    expect(failed).toHaveTextContent('Agent responding')
    expect(failed).toHaveTextContent('the gateway did not come back')
    await userEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledOnce()
  })
})

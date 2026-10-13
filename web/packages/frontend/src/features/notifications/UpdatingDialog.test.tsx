import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UpdateNotificationSchema } from '../../contracts'
import { UpdatingDialog } from './UpdatingDialog'

/** TAL-953: the server's waiting gateway restart, as `/api/update-notifications` ships it. */
const waiting = UpdateNotificationSchema.parse({
  id: '00000000-0000-4000-8000-000000000003', kind: 'update', target: 'agent', phase: 'waiting_for_idle', severity: 'info',
  persistent: false, requires_acknowledgement: false,
  actions: [{ id: 'restart_gateway_now', label: 'Restart now', style: 'destructive', acknowledges: false }],
  destination: { key: 'settings.system', label: 'Open System settings' },
  title: 'Hermes Agent update', message: 'Waiting for 2 running gateway tasks to finish before restarting the gateway.',
  created_at: '2026-10-13T12:00:00Z', updated_at: '2026-10-13T12:00:05Z', read_at: null, acknowledged_at: null, acknowledged_action_id: null,
  verified_revision: null, verified_version: null, detail: null, unread: true, active: false, requires_interaction: false, can_dismiss: false,
})

describe('UpdatingDialog', () => {
  it('shows the waiting gateway restart and performs its Restart now action', async () => {
    const onAction = vi.fn()
    render(<UpdatingDialog target="agent" row={waiting} message={null} lost={false} reconnecting={false} checking={false} actionPending={false} onAction={onAction} onCheckAgain={() => undefined} onClose={() => undefined} />)
    expect(screen.getByRole('status')).toHaveTextContent('Waiting for 2 running gateway tasks to finish before restarting the gateway.')
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(onAction).toHaveBeenCalledWith('restart_gateway_now')
  })

  it('offers no action once the server record has none', () => {
    render(<UpdatingDialog target="agent" row={{ ...waiting, phase: 'succeeded', actions: [], message: 'Hermes Agent was updated successfully.' }} message={null} lost={false} reconnecting={false} checking={false} actionPending={false} onAction={() => undefined} onCheckAgain={() => undefined} onClose={() => undefined} />)
    expect(screen.queryByRole('button', { name: 'Restart now' })).toBeNull()
  })
})

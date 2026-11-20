import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { GroupRoom } from '@maudecode/talaria-web-contracts'
import { GroupSeat } from './GroupSeat'

afterEach(cleanup)
const seat = (remote: GroupRoom['members'][number]['remote']): GroupRoom['members'][number] => ({ member_id: 'two', profile: 'lent', handle: 'two', display_name: 'Reviewer', phase: 'idle', tool: null, started_at: null, stalled: false, actions: [], lead: false, remote })

it('names a lent seat\'s computer and marks a seat its home gateway cannot reach (TAL-2073)', () => {
  const shown = (member: GroupRoom['members'][number]) => { const { container, unmount } = render(<p><GroupSeat member={member} /></p>); const text = container.textContent; const warning = container.querySelector('.text-warning')?.textContent ?? null; unmount(); return [text, warning] }
  expect(shown(seat({ computer_label: 'Studio Mac', reachability: 'offline' }))).toEqual(['Reviewer · Studio Mac · Offline', ' · Offline'])
  expect(shown(seat({ computer_label: null, reachability: 'needs_reauthorization' }))).toEqual(['Reviewer · Another computer · Needs reauthorization', ' · Needs reauthorization'])
  expect(shown(seat({ computer_label: 'Studio Mac', reachability: 'ready' }))).toEqual(['Reviewer · Studio Mac', null])
  expect(shown(seat(null))).toEqual(['Reviewer', null])
})

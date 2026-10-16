import { describe, expect, it } from 'vitest'
import { Session } from './session.js'
import { batchUpdate, recordBackgroundUpdate, withBackgroundUpdates } from './background-updates.js'

describe('parent review projection (TAL-1022)', () => {
  const setup = () => {
    const session = new Session({ session_id: 'review-fixture', messages: [] }, { workspace: '/tmp', model: null })
    recordBackgroundUpdate(session, 'review-turn', batchUpdate([{ event: { type: 'async_delegation', goals: ['Audit', 'Failed worker', 'Unknown worker'], results: [{ status: 'completed' }, { status: 'failed' }, { status: 'unknown' }] }, prompt: 'results' }]))
    session.messages = [{ role: 'user', content: 'results', _source: 'process_wakeup', _turn_id: 'review-turn' }]
    return session
  }
  const update = (session: Session, activeTurnId: string | null = null) => {
    const rows = withBackgroundUpdates(session.messages, session, { activeTurnId })
    return rows[0]!._background_update as { review_state: string; lines: { review_state: string }[] }
  }

  it('uses a live parent run and terminal proof, never just a silence marker or delivered flag', () => {
    const s = setup()
    expect(update(s).review_state).toBe('unknown')
    s.active_stream_id = 'review-turn'
    s.pending_user_source = 'process_wakeup'
    expect(update(s, 'review-turn').review_state).toBe('reviewing')
    expect(update(s).review_state).toBe('unknown')
    s.messages.push({ role: 'assistant', content: '[SILENT]', _turn_id: 'review-turn' })
    expect(update(s).review_state).toBe('unknown')
    s.messages[0]!._background_review_terminal = 'completed'
    s.active_stream_id = null
    expect(update(s).review_state).toBe('reviewed')
    expect(update(s).lines.map((l) => l.review_state)).toEqual(['reviewed', 'failed', 'unknown'])
    expect(withBackgroundUpdates(s.messages, s)[1]).toMatchObject({ _background_silent: true })
  })

  it.each(['error', 'cancelled', 'interrupted', 'tool_limit_reached', 'no_response'])('never acknowledges a parent ending %s', (terminal) => {
    const s = setup()
    s.messages.push({ role: 'assistant', content: '[SILENT]', _turn_id: 'review-turn', _terminal_state: terminal, _error: true })
    s.messages[0]!._background_review_terminal = terminal
    expect(update(s).review_state).toBe(['cancelled', 'interrupted', 'no_response'].includes(terminal) ? 'unknown' : 'failed')
  })

  it('uses exact admission receipts for Agent rows and survives bounded record pruning', () => {
    const s = setup()
    s.extra.completion_acceptances = { [JSON.stringify(['/tmp/fixture-home', 'accepted'])]: 'review-turn' }
    s.messages.push({ role: 'assistant', content: '[SILENT]', _turn_id: 'review-turn' }, { role: 'user', content: 'accepted result', _turn_id: 'agent', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'accepted' } })
    recordBackgroundUpdate(s, 'delegation:accepted', batchUpdate([{ event: { type: 'async_delegation', goal: 'Accepted goal', results: [{ status: 'completed' }] }, prompt: 'accepted' }]))
    s.active_stream_id = 'review-turn'
    s.pending_user_source = 'process_wakeup'
    expect(withBackgroundUpdates(s.messages, s, { activeTurnId: 'review-turn' })[2]!._background_update).toMatchObject({ review_state: 'reviewing' })
    s.messages[0]!._background_review_terminal = 'completed'
    // Store.save preserves the original metadata on each prompt before the bounded map ages out.
    s.messages[0]!._background_update = s.extra.background_updates && (s.extra.background_updates as Record<string, unknown>)['review-turn']
    s.extra.background_updates = {}
    expect(update(s)).toMatchObject({ review_state: 'reviewed', lines: [{ label: 'Audit', review_state: 'reviewed' }, { review_state: 'failed' }, { review_state: 'unknown' }] })
  })

  it('does not apply an admitted batch review to another pending result', () => {
    const s = setup()
    recordBackgroundUpdate(s, 'delegation:held', batchUpdate([{ event: { type: 'async_delegation', goals: ['Held result'], results: [{ status: 'completed' }] }, prompt: 'held' }]))
    s.messages[0]!._background_review_terminal = 'completed'
    s.messages.push({ role: 'assistant', content: '[SILENT]', _turn_id: 'review-turn' }, { role: 'user', content: 'held', _turn_id: 'agent-row', display_kind: 'async_delegation_complete', display_metadata: { delegation_id: 'held', delivery_state: 'delivered' } })
    const rows = withBackgroundUpdates(s.messages, s, { pendingDelegations: new Set(['held']) })
    expect(rows[0]!._background_update).toMatchObject({ review_state: 'reviewed' })
    expect(rows[2]!._background_update).toMatchObject({ review_state: 'waiting', lines: [{ review_state: 'waiting' }] })
    expect(withBackgroundUpdates(s.messages, s)[2]!._background_update).toMatchObject({ review_state: 'unknown' })
  })
})

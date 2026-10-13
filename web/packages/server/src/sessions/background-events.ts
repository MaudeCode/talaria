/** Lifecycle meaning of an Agent completion-queue event, shared by delivery and display projections. */
export function backgroundEventKind(event: Record<string, unknown>): 'completion' | 'delegation' | 'progress' | 'notice' {
  switch (event.type ?? 'completion') {
    case 'completion': return 'completion'
    case 'async_delegation': return 'delegation'
    case 'heartbeat': return 'progress'
    default: return 'notice'
  }
}

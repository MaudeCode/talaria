import { AppShell } from '../../shell/AppShell'
import { SessionListPanel } from '../sessions/SessionListPanel'
import { ChatView } from './ChatView'

export function ChatPage({ sessionId }: { sessionId: string | null }) {
  return (
    <AppShell sidebar={<SessionListPanel />}>
      {/* One ChatView per session: its queue, YOLO state and compression never carry over to the next (TAL-517). */}
      <ChatView key={sessionId ?? 'new'} sessionId={sessionId} />
    </AppShell>
  )
}

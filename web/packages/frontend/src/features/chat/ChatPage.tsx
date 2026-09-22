import { AppShell } from '../../shell/AppShell'
import { SessionListPanel } from '../sessions/SessionListPanel'
import { ChatView } from './ChatView'

export function ChatPage({ sessionId }: { sessionId: string | null }) {
  return (
    <AppShell sidebar={<SessionListPanel />}>
      <ChatView sessionId={sessionId} />
    </AppShell>
  )
}

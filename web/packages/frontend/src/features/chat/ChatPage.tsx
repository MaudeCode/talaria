import { ChatView } from './ChatView'
import { useBootstrap } from '../../app/bootstrap'
import { useChatSwitch, useSessionTitle } from '../sessions/useSessionTitle'

export function ChatPage({ sessionId }: { sessionId: string | null }) {
  const title = useSessionTitle(sessionId, useBootstrap().bot_name)
  const fromTitle = useChatSwitch(sessionId, title)
  // One ChatView per session: its queue, YOLO state and compression never carry over to the next (TAL-517).
  return <ChatView key={sessionId ?? 'new'} sessionId={sessionId} fromTitle={fromTitle} />
}

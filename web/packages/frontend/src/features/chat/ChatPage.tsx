import { ChatView } from './ChatView'

export function ChatPage({ sessionId }: { sessionId: string | null }) {
  // One ChatView per session: its queue, YOLO state and compression never carry over to the next (TAL-517).
  return <ChatView key={sessionId ?? 'new'} sessionId={sessionId} />
}

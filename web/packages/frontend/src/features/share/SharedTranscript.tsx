import type { z } from 'zod'
import type { ShareMessageSchema } from '../../contracts/chat'
import { m } from '../../paraglide/messages.js'
import { Markdown } from '../chat/render/Markdown'

type ShareMessage = z.infer<typeof ShareMessageSchema>

function roleLabel(role: string): string {
  if (role === 'user') return m.role_user()
  if (role === 'assistant') return m.role_assistant()
  return m.role_system()
}

function textOf(content: ShareMessage['content']): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const text: unknown = typeof p === 'object' && p !== null && 'text' in p ? (p as { text?: unknown }).text : undefined
        return typeof text === 'string' ? text : ''
      })
      .join('\n')
  }
  return ''
}

export function SharedTranscript({ messages }: { messages: ShareMessage[] }) {
  if (messages.length === 0) return <div className="px-4 py-10 text-center text-muted">{m.share_empty()}</div>
  return (
    <>
      {messages.map((msg, i) => (
        <article key={i} className="share-message border-t border-border-subtle py-4 first:border-t-0 first:pt-1" data-role={msg.role}>
          <div className="mb-2.5 flex items-center gap-2.5 text-[11px] font-bold uppercase tracking-wider text-muted">
            <span className={msg.role === 'user' ? 'inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-accent-bg-strong bg-accent-bg px-2 text-accent-text' : 'inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-border2 bg-surface-subtle px-2 text-text'}>{roleLabel(msg.role)}</span>
          </div>
          <div className="msg-body share-message-body">
            <Markdown text={textOf(msg.content)} />
          </div>
        </article>
      ))}
    </>
  )
}

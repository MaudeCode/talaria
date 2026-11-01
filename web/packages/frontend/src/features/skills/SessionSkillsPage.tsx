/**
 * TAL-1649: the chat panel's Skills page, the skills this conversation loaded as the server counted and ordered them.
 * A row the library still resolves opens its content in place; the open row survives count refreshes. Reading that
 * content is a library preview: it names no session, so it never counts as a use.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ErrorState, LoadingState } from '../../ui/States'
import { SkillRow } from './SkillRow'

export function SessionSkillsPage({ sessionId, active }: { sessionId: string; active: boolean }) {
  return <SessionSkills key={sessionId} sessionId={sessionId} active={active} />
}

function SessionSkills({ sessionId, active }: { sessionId: string; active: boolean }) {
  const list = useQuery({ queryKey: keys.sessions.skills(sessionId), queryFn: () => api.fetchSessionSkills(sessionId), enabled: active, staleTime: 0 })
  const [open, setOpen] = useState<string | null>(null)
  if (list.isPending) return active ? <LoadingState /> : null
  if (list.isError && !list.data) return <ErrorState error={list.error} onRetry={() => { void list.refetch() }} />
  const { skills } = list.data
  if (!skills.length) return <div className="p-3 text-xs text-muted" role="status">{m.session_skills_empty()}</div>
  const toggle = (name: string) => setOpen((current) => (current === name ? null : name))
  return (
    <ul className="flex min-h-0 flex-1 flex-col divide-y divide-border-subtle overflow-y-auto px-3" aria-label={m.tab_skills()}>
      {skills.map((s) => {
        const expanded = s.detail_available && open === s.name
        return (
          <SkillRow key={s.name} skill={s} uses={s.count} expanded={s.detail_available ? expanded : undefined} onSelect={s.detail_available ? toggle : undefined}>
            {expanded && <SkillPreview name={s.name} />}
          </SkillRow>
        )
      })}
    </ul>
  )
}

/** The skill's content as last read; a failed refresh keeps showing it. */
function SkillPreview({ name }: { name: string }) {
  const content = useQuery({ queryKey: keys.skills.content(name), queryFn: () => api.fetchSkillContent(name) })
  if (content.data && content.data.success !== false) return <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-code-bg p-3 font-mono text-[11.5px] leading-snug text-pre-text">{content.data.content ?? ''}</pre>
  if (content.data) return <div className="mt-2 text-xs text-muted" role="status">{m.session_skill_unavailable()}</div>
  if (content.isError) return <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />
  return <LoadingState />
}

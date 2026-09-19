import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

type Section = 'memory' | 'user' | 'soul' | 'project_context'
const SECTIONS: { id: Section; label: () => string; writable: boolean }[] = [
  { id: 'memory', label: () => m.memory_section_memory(), writable: true },
  { id: 'user', label: () => m.memory_section_user(), writable: true },
  { id: 'soul', label: () => m.memory_section_soul(), writable: true },
  { id: 'project_context', label: () => m.memory_section_project(), writable: false },
]

export function MemoryPage() {
  const qc = useQueryClient()
  const memory = useQuery({ queryKey: keys.memory, queryFn: () => api.fetchMemory(), staleTime: 15_000 })
  const [section, setSection] = useState<Section>('memory')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const write = useMutation({
    mutationFn: ({ target, content }: { target: 'memory' | 'user' | 'soul'; content: string }) => api.writeMemory({ target, content }),
    onSuccess: (_r, vars) => { showToast(m.memory_saved()); setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== vars.target))); void qc.invalidateQueries({ queryKey: keys.memory }) },
    onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error'),
  })
  const data = memory.data
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const serverText = data ? (section === 'project_context' ? data.project_context ?? '' : data[section]) : ''
  const text = draft[section] ?? serverText
  const path = data ? (section === 'memory' ? data.memory_path : section === 'user' ? data.user_path : section === 'soul' ? data.soul_path : data.project_context_path) : ''
  const mtime = data ? (section === 'memory' ? data.memory_mtime : section === 'user' ? data.user_mtime : section === 'soul' ? data.soul_mtime : data.project_context_mtime) : null
  return (
    <HubPage
      title={m.tab_memory()}
      toolbar={
        <div role="tablist" aria-label={m.tab_memory()} className="flex gap-1">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={section === s.id} onClick={() => setSection(s.id)} className={cn('rounded-md px-3 py-1.5 text-sm', section === s.id ? 'bg-accent-bg text-accent-text' : 'text-muted hover:bg-hover hover:text-text')}>
              {s.label()}
            </button>
          ))}
        </div>
      }
    >
      {memory.isPending && <LoadingState />}
      {memory.isError && <ErrorState error={memory.error} onRetry={() => { void memory.refetch() }} />}
      {data && (
        <div className="flex flex-col gap-3" id="memoryPanel">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
            {path && <span className="font-mono">{m.memory_path()}: {path}</span>}
            {mtime && <span>{m.logs_updated()}: {formatDate(mtime)}</span>}
            {section === 'memory' && !data.memory_path && <span className="text-warning">{m.memory_disabled_hint()}</span>}
            {section === 'user' && !data.user_path && <span className="text-warning">{m.memory_disabled_hint()}</span>}
            {section === 'project_context' && <span>{m.memory_readonly_project()}{data.project_context_workspace ? ` (${data.project_context_workspace})` : ''}</span>}
          </div>
          <textarea
            value={text}
            readOnly={!current?.writable}
            onChange={(e) => setDraft((d) => ({ ...d, [section]: e.target.value }))}
            rows={22}
            spellCheck={false}
            aria-label={current?.label()}
            className="w-full rounded-md border border-border bg-code-bg p-3 font-mono text-[12.5px] text-pre-text"
          />
          {current?.writable && (
            <div className="flex gap-2">
              <Button variant="primary" disabled={draft[section] === undefined || write.isPending} onClick={() => { const c = draft[section]; if (c !== undefined && section !== 'project_context') write.mutate({ target: section, content: c }) }}>{m.save()}</Button>
              <Button variant="ghost" disabled={draft[section] === undefined} onClick={() => setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== section)))}>{m.cancel()}</Button>
            </div>
          )}
        </div>
      )}
    </HubPage>
  )
}

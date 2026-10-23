import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { ErrorState, LoadingState, formatDate } from '../../ui/States'
import { showToast } from '../toast/toast'
import { showErrorToast } from '../toast/errorToast'
import { isApiError } from '../../contracts/common'
import { cn } from '../../ui/cn'
import { PendingWritesPanel } from '../pending-writes/PendingWritesPanel'

type Section = 'memory' | 'user' | 'soul' | 'project_context'
type Writable = Exclude<Section, 'project_context'>
/** An edit and the file revision it started from, which the save sends back (TAL-784). */
interface Draft { text: string; revision: string }
const without = <T,>(record: Record<string, T>, key: string): Record<string, T> => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
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
  const [draft, setDraft] = useState<Record<string, Draft>>({})
  // The server's message for a save it refused because the file changed since the edit started.
  const [conflict, setConflict] = useState<Record<string, string>>({})
  const write = useMutation({
    // The draft clears only once a refetch brings the new revision, so the next edit starts from it. When that refetch
    // fails the saved text stays in the editor on its old revision, and the next save meets a conflict and its reload.
    mutationFn: async ({ target, draft: d }: { target: Writable; draft: Draft }) => {
      await api.writeMemory({ section: target, content: d.text, revision: d.revision })
      return qc.refetchQueries({ queryKey: keys.memory }, { throwOnError: true }).then(() => true, () => false)
    },
    // Edits typed while the save ran stay, now on the revision the save produced.
    onSuccess: (refetched, vars) => {
      showToast(m.memory_saved())
      if (!refetched) return
      const revision = qc.getQueryData<Awaited<ReturnType<typeof api.fetchMemory>>>(keys.memory)?.[`${vars.target}_revision`]
      setDraft((d) => { const now = d[vars.target]; return !now || now.text === vars.draft.text ? without(d, vars.target) : { ...d, [vars.target]: { ...now, revision: revision ?? now.revision } } })
    },
    onError: (e, vars) => {
      if (isApiError(e) && e.code === 'memory_conflict') setConflict((c) => ({ ...c, [vars.target]: e.message }))
      else showErrorToast(e)
    },
  })
  const reload = (target: Section) => { setDraft((d) => without(d, target)); setConflict((c) => without(c, target)); void memory.refetch() }
  const data = memory.data
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]
  const serverText = data ? (section === 'project_context' ? data.project_context ?? '' : data[section]) : ''
  const text = draft[section]?.text ?? serverText
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
      <PendingWritesPanel kind="memory" />
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
            onChange={(e) => { const value = e.target.value; setDraft((d) => ({ ...d, [section]: { text: value, revision: d[section]?.revision ?? (section === 'project_context' ? '' : data[`${section}_revision`]) } })) }}
            rows={22}
            spellCheck={false}
            aria-label={current?.label()}
            className="w-full rounded-md border border-border bg-code-bg p-3 font-mono text-[12.5px] text-pre-text"
          />
          {conflict[section] && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-error">
              <span>{conflict[section]}</span>
              <Button variant="link" className="text-xs" onClick={() => reload(section)}>{m.reload()}</Button>
            </div>
          )}
          {current?.writable && (
            <div className="flex gap-2">
              <Button variant="primary" disabled={draft[section] === undefined || conflict[section] !== undefined || write.isPending} onClick={() => { const d = draft[section]; if (d !== undefined && section !== 'project_context') write.mutate({ target: section, draft: d }) }}>{m.save()}</Button>
              <Button variant="ghost" disabled={draft[section] === undefined} onClick={() => { setDraft((d) => without(d, section)); setConflict((c) => without(c, section)) }}>{m.cancel()}</Button>
            </div>
          )}
        </div>
      )}
    </HubPage>
  )
}

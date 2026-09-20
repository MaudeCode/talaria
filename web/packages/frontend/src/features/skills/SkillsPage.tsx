import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, Search } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { cn } from '../../ui/cn'

export function SkillsPage() {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const skills = useQuery({ queryKey: keys.skills.all, queryFn: () => api.fetchSkills(), staleTime: 30_000 })
  const usage = useQuery({ queryKey: keys.skills.usage, queryFn: api.fetchSkillsUsage, staleTime: 60_000 })
  const list = useMemo(() => skills.data?.skills ?? [], [skills.data])
  const categories = useMemo(() => [...new Set(list.map((s) => s.category).filter((c): c is string => !!c))].sort(), [list])
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return list.filter((s) => (!category || s.category === category) && (!q || s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q)))
  }, [list, query, category])
  const toggle = useMutation({ mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) => api.toggleSkill(name, enabled), onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.skills.all }) }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })

  if (selected) return <SkillDetail name={selected} onBack={() => setSelected(null)} />
  return (
    <HubPage
      title={m.tab_skills()}
      toolbar={
        <>
          <div className="sidebar-search hub-search">
            <Search size={14} className="sidebar-search-icon" aria-hidden="true" />
            <input id="skillsSearch" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={m.search_skills()} aria-label={m.search_skills()} />
          </div>
          {categories.length > 0 && (
            <Select value={category} onValueChange={(v) => setCategory(v)} aria-label={m.skill_category_all()}>
              <option value="">{m.skill_category_all()}</option>
              {categories.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          )}
        </>
      }
    >
      {skills.isPending && <LoadingState />}
      {skills.isError && <ErrorState error={skills.error} onRetry={() => { void skills.refetch() }} />}
      {skills.isSuccess && filtered.length === 0 && <EmptyState>{m.skills_no_skills()}</EmptyState>}
      <ul className="skills-list flex flex-col divide-y divide-border-subtle" id="skillsList">
        {filtered.map((s) => {
          const use = usage.data?.usage[s.name]?.use_count ?? 0
          return (
            <li key={s.name} className="flex items-center gap-3 py-2.5">
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(s.name)}>
                <div className={cn('truncate text-sm font-medium', s.disabled ? 'text-muted' : 'text-text')}>{s.name}</div>
                {s.description && <div className="truncate text-xs text-muted">{s.description}</div>}
              </button>
              {s.category && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">{s.category}</span>}
              {use > 0 && <span className="text-[11px] text-muted">{m.skill_uses({ n: use })}</span>}
              <label className="flex items-center gap-1 text-xs text-muted">
                <Switch checked={!s.disabled} onCheckedChange={(checked) => toggle.mutate({ name: s.name, enabled: checked })} aria-label={`${s.name}: ${s.disabled ? m.skill_disabled() : m.skill_enabled()}`} />
              </label>
            </li>
          )
        })}
      </ul>
    </HubPage>
  )
}

function SkillDetail({ name, onBack }: { name: string; onBack: () => void }) {
  const qc = useQueryClient()
  const content = useQuery({ queryKey: keys.skills.content(name), queryFn: () => api.fetchSkillContent(name) })
  const [draft, setDraft] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const save = useMutation({ mutationFn: (text: string) => api.saveSkill(name, text), onSuccess: () => { showToast(m.skill_saved()); setDraft(null); void qc.invalidateQueries({ queryKey: keys.skills.all }) }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  const del = useMutation({ mutationFn: () => api.deleteSkill(name), onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.skills.all }); onBack() }, onError: (e) => showToast(e instanceof Error ? e.message : String(e), 4000, 'error') })
  const text = draft ?? content.data?.content ?? ''
  return (
    <HubPage title={name} actions={<Button variant="ghost" onClick={onBack}><ChevronLeft size={14} aria-hidden="true" /> {m.back()}</Button>}>
      {content.isPending && <LoadingState />}
      {content.isError && <ErrorState error={content.error} onRetry={() => { void content.refetch() }} />}
      {content.isSuccess && (
        <div className="flex flex-col gap-3">
          {content.data.path && <div className="font-mono text-[11px] text-muted">{content.data.path}</div>}
          <label className="flex flex-col gap-1 text-sm">
            <span>{m.skill_content_label()}</span>
            <textarea value={text} onChange={(e) => setDraft(e.target.value)} rows={24} spellCheck={false} placeholder={m.skill_content_placeholder()} className="w-full rounded-md border border-border bg-code-bg p-3 font-mono text-[12.5px] text-pre-text" />
          </label>
          <div className="flex gap-2">
            <Button variant="primary" disabled={draft === null || save.isPending} onClick={() => { if (draft !== null) save.mutate(draft) }}>{m.save()}</Button>
            <Button variant="ghost" className="text-error" onClick={() => setConfirm(true)}>{m.delete()}</Button>
          </div>
        </div>
      )}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={m.skill_delete_confirm({ a0: name })} confirmLabel={m.delete()} cancelLabel={m.cancel()} danger onConfirm={() => del.mutate()} />
    </HubPage>
  )
}

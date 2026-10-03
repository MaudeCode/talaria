import { useState, type ReactNode } from 'react'
import { Check, ChevronLeft, ChevronRight } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { fetchAuxiliaryModels } from '../../api/endpoints'
import { useAuxiliaryModelsQuery, useModelsQuery, useSetAuxiliaryModel } from '../../app/queries'
import { Button } from '../../ui/Button'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { FieldRow, TextInput } from '../../ui/Field'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { cn } from '../../ui/cn'

type AuxTask = Awaited<ReturnType<typeof fetchAuxiliaryModels>>['tasks'][number]

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Settings > Preferences row: the server-owned auxiliary task slots open in one dialog (TAL-388). */
export function AuxiliaryModelsSetting() {
  const [open, setOpen] = useState(false)
  return (
    <FieldRow label={m.settings_label_auxiliary_models()} hint={m.settings_desc_auxiliary_models()} inline>
      <Button onClick={() => setOpen(true)}>{m.settings_auxiliary_models_manage()}</Button>
      {open && <AuxiliaryModelsDialog onClose={() => setOpen(false)} />}
    </FieldRow>
  )
}

function AuxiliaryModelsDialog({ onClose }: { onClose: () => void }) {
  const aux = useAuxiliaryModelsQuery()
  const reset = useSetAuxiliaryModel()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const task = aux.data?.tasks.find((t) => t.task === editing)
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }} title={task?.label ?? m.settings_label_auxiliary_models()} description={task?.description} className="flex max-h-[85vh] flex-col">
      {aux.isPending ? <LoadingState /> : aux.isError ? <ErrorState error={aux.error} onRetry={() => { void aux.refetch() }} /> : task ? <AuxiliaryModelPicker task={task} onDone={() => setEditing(null)} /> : (
        <>
          <ul className="-mx-2 max-h-[60vh] overflow-y-auto" aria-label={m.settings_label_auxiliary_models()}>
            {aux.data.tasks.map((t) => (
              <li key={t.task}>
                <button type="button" className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-hover" onClick={() => setEditing(t.task)}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-text">{t.label}</span>
                    <span className="block text-xs text-muted">{t.description}</span>
                    <TaskValue task={t} />
                  </span>
                  <ChevronRight size={16} className="shrink-0 text-muted" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          {reset.isError && <p role="alert" className="mt-2 text-xs text-error">{errorText(reset.error)}</p>}
          <div className="mt-3 flex justify-end">
            <Button onClick={() => setConfirmReset(true)} disabled={reset.isPending}>{m.settings_btn_reset_aux_models()}</Button>
          </div>
          <ConfirmDialog
            open={confirmReset}
            onOpenChange={setConfirmReset}
            title={m.settings_aux_reset_confirm_title()}
            description={m.settings_aux_reset_confirm_msg()}
            confirmLabel={m.settings_btn_reset_aux_models()}
            cancelLabel={m.cancel()}
            danger
            onConfirm={() => reset.mutateAsync({ task: '__reset__', model: '' }).then(() => undefined, () => undefined)}
          />
        </>
      )}
    </Dialog>
  )
}

/** "Auto · main model" or the pinned provider/model; the server flags a pinned model missing from the catalog. */
function TaskValue({ task }: { task: AuxTask }) {
  const model = [task.provider_label, task.value_label].filter(Boolean).join(' · ')
  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-text">
      <span className="truncate">{task.is_auto ? <><span className="font-medium text-accent-text">{m.auxiliary_models_auto()}</span>{model && ` · ${model}`}</> : model}</span>
      {!task.in_catalog && <span className="shrink-0 rounded border border-border px-1 text-[11px] text-muted">{m.auxiliary_models_not_in_catalog()}</span>}
    </span>
  )
}

function OptionButton({ selected, onClick, disabled, children }: { selected: boolean; onClick: () => void; disabled: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} disabled={disabled} onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-60', selected && 'bg-accent-bg text-accent-text')}>
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <Check size={14} className="shrink-0" aria-hidden="true" />}
    </button>
  )
}

/** One task's model choice: Auto, the saved off-catalog model, the catalog grouped by provider, or a typed id. */
function AuxiliaryModelPicker({ task, onDone }: { task: AuxTask; onDone: () => void }) {
  const models = useModelsQuery()
  const save = useSetAuxiliaryModel()
  const [query, setQuery] = useState('')
  const [custom, setCustom] = useState('')
  const pick = (model: string, provider?: string): void => { save.mutate({ task: task.task, model, provider: provider ?? null }, { onSuccess: onDone }) }
  const q = query.trim().toLowerCase()
  const groups = (models.data?.groups ?? [])
    .map((g) => ({ ...g, rows: [...g.models, ...(g.extra_models ?? [])].filter((mm) => !q || `${mm.label ?? ''} ${mm.id} ${g.provider}`.toLowerCase().includes(q)) }))
    .filter((g) => g.rows.length)
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div>
        <Button variant="ghost" className="-ml-2" onClick={onDone}><ChevronLeft size={14} aria-hidden="true" />{m.back()}</Button>
      </div>
      <TextInput type="search" aria-label={m.model_search_placeholder()} placeholder={m.model_search_placeholder()} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {save.isError && <p role="alert" className="text-xs text-error">{errorText(save.error)}</p>}
      <div className="-mx-2 max-h-[45vh] overflow-y-auto px-2">
        <OptionButton selected={task.is_auto} disabled={save.isPending} onClick={() => pick('', 'auto')}>
          <span className="block">{m.auxiliary_models_auto()}</span>
          <span className="block text-xs text-muted">{m.settings_aux_provider_auto()}</span>
        </OptionButton>
        {!task.in_catalog && (
          <OptionButton selected disabled={save.isPending} onClick={() => pick(task.model, task.provider)}>
            <span className="block truncate">{[task.provider_label, task.value_label].filter(Boolean).join(' · ')}</span>
            <span className="block text-xs text-muted">{m.auxiliary_models_not_in_catalog()}</span>
          </OptionButton>
        )}
        {models.isPending ? <LoadingState /> : models.isError ? <ErrorState error={models.error} onRetry={() => { void models.refetch() }} /> : groups.length === 0 ? <EmptyState>{m.model_search_no_results()}</EmptyState> : groups.map((g) => (
          <section key={g.provider_id ?? g.provider} aria-label={g.provider} className="mt-2">
            <h3 className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted">{g.provider}</h3>
            {g.rows.map((mm) => (
              <OptionButton key={mm.id} selected={mm.id === task.selected_option_id} disabled={save.isPending} onClick={() => pick(mm.id, g.provider_id)}>
                {mm.label ?? mm.id}
              </OptionButton>
            ))}
          </section>
        ))}
      </div>
      <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) pick(custom.trim()) }}>
        <label htmlFor="auxCustomModel" className="text-xs text-muted">{m.auxiliary_models_custom_label()}</label>
        <div className="flex gap-2">
          <TextInput id="auxCustomModel" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="@provider:model" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
          <Button type="submit" disabled={!custom.trim() || save.isPending}>{m.save()}</Button>
        </div>
      </form>
    </div>
  )
}

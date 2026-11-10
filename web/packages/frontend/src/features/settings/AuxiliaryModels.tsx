import { catalogGroupLabel, catalogModelSections, ModelOptionContent } from '../../lib/modelEntry'
import { Fragment, useState, type ReactNode } from 'react'
import { Check, Pencil, Plus, RotateCcw, Trash2, X } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { fetchAuxiliaryModels } from '../../api/endpoints'
import { auxResource, useAuxiliaryModelsQuery, useModelsQuery, useSetAuxiliaryModel, useSetDelegation } from '../../app/queries'
import type { DelegationSettings, DelegationRoute } from '@maudecode/talaria-web-contracts'
import { useResourceEffects, withEffects } from '../sessions/useResourceMutation'
import { BackButton, IconButton } from '../../ui/Button'
import { RowContextMenu, type RowAction } from '../../ui/Menu'
import { RowActionButtons } from '../../ui/RowActionsMenu'
import { ConfirmDialog } from '../../ui/Dialog'
import { ReasoningChip, reasoningLevelLabel } from '../composer/chips'
import { Switch, TextInput } from '../../ui/Field'
import { SectionHeader } from '../../ui/List'
import { Dot } from '../../ui/Badge'
import { SettingLink, SettingRow, SettingsGroup } from './SettingsRows'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { cn } from '../../ui/cn'

type AuxTask = Awaited<ReturnType<typeof fetchAuxiliaryModels>>['tasks'][number]
type ModelsQuery = ReturnType<typeof useModelsQuery>

/** How a slot reads once set to Auto, until the server names the model Auto resolves to. */
const AUTO = { is_auto: true, in_catalog: true, selected_option_id: null, provider_label: '', value_label: '' }
/** Reset All's overlay: every slot shows Auto and its default effort until the server's state replaces it. */
const RESET = { ...AUTO, reasoning_reset: true }

/**
 * Settings > Auxiliary Models (TAL-1285): the server-owned task slots (TAL-388), each edited inline. The task list and
 * the catalog load together and independently; a refresh or a failed refresh keeps what was already shown. TAL-2137: the
 * tasks are a Task/Model table, one line each, with the changed ones counted in the header and marked by an accent dot;
 * a row opens its editor in the table row under it.
 */
export function AuxiliaryModelsSection() {
  const aux = useAuxiliaryModelsQuery()
  const models = useModelsQuery()
  const reset = useSetAuxiliaryModel()
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const effects = useResourceEffects<DelegationSettings>()
  const tasks = withEffects(aux.data?.tasks ?? [], (t) => auxResource(t.task), effects).map((t) => 'reasoning_reset' in t ? { ...t, reasoning: { ...t.reasoning, saved: null, inherited: true } } : t)
  const delegation = effects[auxResource('delegation')]?.value ?? aux.data?.delegation
  // Counted from the shown slots, so a pick or Reset All moves the count at once (TAL-2161 moves it to a server `changed` field).
  const changed = (t: AuxTask) => !t.is_auto || !t.reasoning.inherited || (t.task === 'delegation' && !!delegation && delegation.configured !== 'default')
  const count = tasks.filter(changed).length
  // Reset All also clears a removed plugin's leftover override, which no listed task shows; a pending reset hides it at once.
  const resettable = count > 0 || (aux.data?.unlisted_overrides === true && !tasks.some((t) => 'reasoning_reset' in t))
  const title = m.settings_group_task_models()
  return (
    <SettingsGroup id="auxiliary" title={title} detail={aux.data && m.settings_task_models_changed({ n: count, total: tasks.length })}
      action={resettable ? <IconButton variant="ghost" label={m.settings_btn_reset_aux_models()} disabled={delegation?.can_edit === false} onClick={() => setConfirmReset(true)}><RotateCcw aria-hidden="true" /></IconButton> : null}>
      {aux.isError && <ErrorState error={aux.error} onRetry={() => { void aux.refetch() }} />}
      {!aux.data ? !aux.isError && <LoadingState /> : (
        <table aria-label={title} className="w-full table-fixed text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th scope="col" className="w-1/2 py-1.5 font-normal">{m.settings_task_models_task()}</th>
              <th scope="col" className="py-1.5 text-right font-normal">{m.settings_task_models_model()}</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => {
              const open = editing === t.task
              const toggle = () => setEditing(open ? null : t.task)
              return (
                <Fragment key={t.task}>
                  {/* The row takes the click; the Task cell's button is its keyboard stop and names it, and its click bubbles here. */}
                  <tr title={t.description} data-task={t.task} className="cursor-pointer border-t border-border-subtle hover:bg-hover" onClick={toggle}>
                    <td className="py-0">
                      <button type="button" aria-expanded={open} aria-controls={`aux-editor-${t.task}`} className="flex min-h-10 w-full min-w-0 items-center gap-2 text-left text-text outline-none focus-visible:outline-2 focus-visible:outline-accent">
                        <Dot state={changed(t) ? 'changed' : 'idle'} />
                        <span className="truncate">{t.label}</span>
                      </button>
                    </td>
                    <td className="py-0 pl-3 text-right">
                      {t.task === 'delegation' && delegation ? <DelegationValue state={delegation} /> : <TaskValue task={t} changed={changed(t)} />}
                    </td>
                  </tr>
                  {open && (
                    <tr id={`aux-editor-${t.task}`} data-task-editor={t.task}>
                      <td colSpan={2} className="pb-4">
                        <p className="pb-2 text-xs text-muted">{t.description}</p>
                        {t.task === 'delegation' && delegation
                          ? <DelegationEditor key={delegation.configured} task={t} state={delegation} models={models} onDone={() => setEditing(null)} />
                          : <div className="flex flex-col gap-3"><ReasoningControl task={t} /><AuxiliaryModelPicker task={t} models={models} /></div>}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      )}
      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={m.settings_aux_reset_confirm_title()}
        description={m.delegation_reset_confirm()}
        confirmLabel={m.settings_btn_reset_aux_models()}
        cancelLabel={m.cancel()}
        danger
        onConfirm={() => reset.mutate({ task: '__reset__', model: '', tasks: tasks.map((t) => t.task), shown: RESET, delegation: delegation ? { ...delegation, configured: 'default', fixed_model_active: true } : undefined })}
      />
    </SettingsGroup>
  )
}

/**
 * The Model cell: a changed slot's model in the text colour, else "Auto · model" muted; then a saved effort. The provider
 * moves to `title`; the server flags a pinned model missing from the catalog.
 */
function TaskValue({ task, changed }: { task: AuxTask; changed: boolean }) {
  const effort = task.reasoning.inherited || task.reasoning.saved === null ? null : reasoningLevelLabel(task.reasoning.saved)
  const value = [task.is_auto ? m.auxiliary_models_auto() : null, task.value_label, effort].filter(Boolean).join(' · ')
  return (
    <span className={cn('flex min-w-0 items-center justify-end gap-2', changed ? 'text-text' : 'text-muted')} title={task.provider_label || undefined}>
      <span className="truncate">{value}</span>
      {!task.in_catalog && <span className="shrink-0 text-xs text-muted">{m.auxiliary_models_not_in_catalog()}</span>}
    </span>
  )
}

/** The Delegation row's Model cell: how many routes its route mode holds, else the mode's name ("Default"); TAL-2161 moves it to the server. */
function DelegationValue({ state }: { state: DelegationSettings }) {
  const routes = state.configured === 'model_map' ? state.model_map.options ?? [] : state.configured === 'profile_routes' ? state.profile_routes.profiles ?? [] : null
  const label = routes ? m.delegation_routes_count({ count: routes.length }) : state.backends.find((b) => b.name === state.configured)?.label ?? state.configured
  return <span className="block truncate text-muted">{label}</span>
}

/** The slot's effort through the shared reasoning control, offering only the server's options for the slot's route. */
function ReasoningControl({ task }: { task: AuxTask }) {
  const save = useSetAuxiliaryModel()
  const { reasoning } = task
  if (!reasoning.options.length) return null
  return (
    <SettingRow label={m.composer_control_reasoning()}>
      <ReasoningChip value={reasoning.saved} levels={reasoning.options} defaultLabel={reasoning.default_source === 'parent' ? m.delegation_inherit() : m.reasoning_default()}
        onChange={(level) => save.mutate({ task: task.task, reasoning_effort: level, shown: { reasoning: { ...reasoning, saved: level, inherited: level === null } } })} />
    </SettingRow>
  )
}

function OptionButton({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover disabled:opacity-60', selected && 'bg-accent-bg text-accent-text')}>
      <span className="min-w-0 flex-1">{children}</span>
      {selected && <Check size={14} className="shrink-0" aria-hidden="true" />}
    </button>
  )
}

/**
 * One task's model choice: Auto, the saved off-catalog model, the catalog grouped by provider, or a typed id. Auto and
 * the typed id never wait for the catalog; the page's one catalog query is shared by every task.
 */
function AuxiliaryModelPicker({ task, models, onDone, onPick }: { task: AuxTask; models: ModelsQuery; onDone?: () => void; onPick?: (model: string, provider: string) => void }) {
  const save = useSetAuxiliaryModel()
  const [query, setQuery] = useState('')
  // The list shows the pick at once with the labels the user chose from; the server's state replaces them.
  const pick = (model: string, provider?: string, labels: { provider_label?: string; value_label?: string } = {}): void => {
    if (onPick) { onPick(model, provider ?? ''); return }
    save.mutate({ task: task.task, model, provider: provider ?? null, shown: provider === 'auto' ? AUTO : { is_auto: false, in_catalog: true, selected_option_id: model, provider_label: labels.provider_label ?? '', value_label: labels.value_label ?? model } })
    onDone?.()
  }
  const q = query.trim().toLowerCase()
  const groups = (models.data?.groups ?? [])
    .map((g) => ({ ...g, rows: g.models.filter((mm) => !q || `${mm.label ?? ''} ${mm.id} ${g.provider}`.toLowerCase().includes(q)) }))
    .filter((g) => g.rows.length)
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {onDone && <div>
        <BackButton iconOnly className="-ml-2" onClick={onDone} />
      </div>}
      <TextInput type="search" aria-label={m.model_search_placeholder()} placeholder={m.model_search_placeholder()} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="-mx-2 max-h-[45vh] overflow-y-auto px-2">
        {!onPick && <OptionButton selected={task.is_auto} onClick={() => pick('', 'auto')}>
          <span className="block">{m.auxiliary_models_auto()}</span>
          <span className="block text-xs text-muted">{m.settings_aux_provider_auto()}</span>
        </OptionButton>}
        {!onPick && !task.in_catalog && (
          <OptionButton selected onClick={() => pick(task.model, task.provider, { provider_label: task.provider_label ?? '', value_label: task.value_label ?? '' })}>
            <span className="block truncate">{[task.provider_label, task.value_label].filter(Boolean).join(' · ')}</span>
            <span className="block text-xs text-muted">{m.auxiliary_models_not_in_catalog()}</span>
          </OptionButton>
        )}
        {models.isError && <ErrorState error={models.error} onRetry={() => { void models.refetch() }} />}
        {!models.data ? !models.isError && <LoadingState /> : groups.length === 0 ? <EmptyState compact>{m.model_search_no_results()}</EmptyState> : groups.map((g) => (
          <section key={g.provider_id ?? g.provider} aria-label={catalogGroupLabel(g)} className="mt-2">
            <SectionHeader className="px-2 py-1">{catalogGroupLabel(g)}</SectionHeader>
            {catalogModelSections(g, query).map((section) => <div key={section.label}>
              {section.label && <SectionHeader className="px-2 py-1">{section.label}</SectionHeader>}
              {section.models.map((mm) => <OptionButton key={mm.id} selected={!onPick && mm.id === task.selected_option_id} onClick={() => pick(mm.id, g.provider_id, { provider_label: catalogGroupLabel(g), value_label: mm.label ?? mm.id })}><ModelOptionContent entry={mm} /></OptionButton>)}
            </div>)}
          </section>
        ))}
      </div>
      <CustomModelInput onPick={pick} />
    </div>
  )
}

/** The custom id draft is local to its input, independent of catalog search and rows. */
function CustomModelInput({ onPick }: { onPick: (model: string) => void }) {
  const [custom, setCustom] = useState('')
  return (
    <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); if (custom.trim()) onPick(custom.trim()) }}>
      <label htmlFor="auxCustomModel" className="text-xs text-muted">{m.auxiliary_models_custom_label()}</label>
      <div className="flex gap-2">
        <TextInput id="auxCustomModel" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="@provider:model" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        <IconButton type="submit" variant="default" label={m.save()} disabled={!custom.trim()}><Check aria-hidden="true" /></IconButton>
      </div>
    </form>
  )
}

/** Extends the delegation task's inline editor; the fixed-model editor remains shared. */
function DelegationEditor({ task, state, models, onDone }: { task: AuxTask; state: DelegationSettings; models: ModelsQuery; onDone: () => void }) {
  const save = useSetDelegation()
  const [section, setSection] = useState<'fixed' | 'model_map' | 'profile_routes' | null>(null)
  const [editing, setEditing] = useState<DelegationRoute | null>(null)
  const [original, setOriginal] = useState<string | null>(null)
  const block = section === 'profile_routes' ? state.profile_routes : state.model_map
  const rows = section === 'profile_routes' ? block.profiles ?? [] : block.options ?? []
  const writeRows = (next: DelegationRoute[], defaultName: string | null) => {
    if (section !== 'model_map' && section !== 'profile_routes') return
    const nextBlock = { [section === 'model_map' ? 'options' : 'profiles']: next, default: defaultName }
    save.mutate({ write: { action: 'routes', backend: section, block: nextBlock }, shown: { ...state, [section]: nextBlock } })
  }
  if (section === 'fixed') return <AuxiliaryModelPicker task={task} models={models} onDone={() => setSection(null)} />
  if (editing && section) return <DelegationRouteEditor key={original ?? 'new'} task={task} models={models} route={editing} profiles={section === 'profile_routes' ? state.profiles : null} onCancel={() => setEditing(null)} onSave={(route) => {
    const next = original === null ? [...rows, route] : rows.map((row) => row.name === original ? { ...route, original_name: original } : row)
    writeRows(next, original !== null && block.default === original ? route.name : block.default)
    setEditing(null)
  }} />
  return <div className="flex min-h-0 flex-col gap-3 [&_button]:min-h-11">
    <BackButton iconOnly className="self-start" onClick={section ? () => setSection(null) : onDone} />
    {section ? <SettingsGroup id={section} title={section === 'model_map' ? m.delegation_routes() : m.delegation_profiles()}>
      <SettingRow label={m.delegation_default()} htmlFor="delegationDefault">
        <Select id="delegationDefault" value={block.default ?? ''} onValueChange={(value) => writeRows(rows, value || null)}>
          <option value="">{m.delegation_no_default()}</option>
          {rows.map((row) => <option key={row.name} value={row.name}>{row.name}</option>)}
        </Select>
      </SettingRow>
      <ul aria-label={section === 'model_map' ? m.delegation_routes() : m.delegation_profiles()}>
        {rows.map((row) => {
          const actions = [
            { label: `${m.edit()} ${row.name}`, run: () => { setOriginal(row.name); setEditing(row) }, icon: Pencil },
            { label: `${m.delete()} ${row.name}`, run: () => writeRows(rows.filter((r) => r.name !== row.name), block.default === row.name ? null : block.default), danger: true, icon: Trash2 },
          ] satisfies RowAction[]
          return <RowContextMenu key={row.name} label={row.name} actions={actions} trigger={<li className="flex min-w-0 items-center gap-2 border-b border-border py-2">
            <div className="min-w-0 flex-1"><span className="block break-words text-sm">{row.name}</span><span className="block break-words text-xs text-muted">{row.description}</span></div>
            <RowActionButtons actions={actions} />
          </li>} />
        })}
      </ul>
      {!rows.length && <EmptyState compact>{m.delegation_empty()}</EmptyState>}
      <div><IconButton variant="default" label={m.delegation_add_route()} onClick={() => { setOriginal(null); setEditing({ name: '', description: '' }) }}><Plus aria-hidden="true" /></IconButton></div>
    </SettingsGroup> : <>
      <SettingRow label={m.delegation_mode()} hint={state.can_edit ? undefined : m.delegation_owner_required()} htmlFor="delegationMode">
        <Select id="delegationMode" value={state.configured} disabled={!state.supported || !state.can_edit} onValueChange={(backend) => save.mutate({ write: { action: 'backend', backend }, shown: { ...state, configured: backend } })}>
          {state.backends.map((backend) => <option key={backend.name} value={backend.name} disabled={!backend.available}>{backend.label}</option>)}
        </Select>
      </SettingRow>
      {state.blocked_reason && <p role="status" className="break-words text-sm text-muted">{state.blocked_reason}</p>}
      {state.supported && state.can_edit && <div><IconButton variant="default" label={m.delegation_restore()} onClick={() => save.mutate({ write: { action: 'backend', backend: 'default' }, shown: { ...state, configured: 'default' } })}><RotateCcw aria-hidden="true" /></IconButton></div>}
      {state.fixed_model_active ? <>
        <SettingLink label={m.delegation_fixed()} onClick={() => setSection('fixed')} />
        <ReasoningControl task={task} />
      </> : <p className="text-xs text-muted">{m.delegation_inactive()}</p>}
      {state.supported && state.can_edit && <div className="flex flex-col divide-y divide-border-subtle">
        <SettingLink label={m.delegation_routes()} onClick={() => setSection('model_map')} />
        <SettingLink label={m.delegation_profiles()} onClick={() => setSection('profile_routes')} />
      </div>}
    </>}
  </div>
}

/** Uses the auxiliary picker and standard field/select controls; route edits are local drafts until Save. */
function DelegationRouteEditor({ task, models, route, profiles, onCancel, onSave }: { task: AuxTask; models: ModelsQuery; route: DelegationRoute; profiles: string[] | null; onCancel: () => void; onSave: (route: DelegationRoute) => void }) {
  const [draft, setDraft] = useState(route)
  const [picking, setPicking] = useState(false)
  const [consent, setConsent] = useState(false)
  const text = (key: 'name' | 'description' | 'provider' | 'model' | 'base_url' | 'api_key' | 'reasoning_effort', label: string, type = 'text') => <SettingRow key={key} label={label} htmlFor={`route-${key}`} stacked>
    <TextInput id={`route-${key}`} type={type} value={draft[key] ?? ''} autoComplete="off" onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
  </SettingRow>
  if (picking) return <AuxiliaryModelPicker task={task} models={models} onDone={() => setPicking(false)} onPick={(model, provider) => { setDraft({ ...draft, model, provider }); setPicking(false) }} />
  return <form className="flex min-h-0 flex-col gap-2 [&_button]:min-h-11" onSubmit={(e) => { e.preventDefault(); onSave(draft) }}>
    {profiles ? <>
      <SettingRow label={m.delegation_profile()} htmlFor="route-profile"><Select id="route-profile" value={draft.name} onValueChange={(name) => setDraft({ ...draft, name })}>{profiles.map((name) => <option key={name} value={name}>{name}</option>)}</Select></SettingRow>
      <p className="text-sm text-muted">{m.delegation_profile_consent()}</p>
      <SettingRow label={m.delegation_profile_opt_in()} htmlFor="route-consent"><Switch id="route-consent" checked={consent} onCheckedChange={setConsent} /></SettingRow>
    </> : text('name', m.delegation_route_name())}
    {text('description', m.delegation_route_description())}
    {!profiles && <>
      <div><IconButton variant="default" label={m.delegation_choose_model()} onClick={() => setPicking(true)}><Pencil aria-hidden="true" /></IconButton></div>
      {text('model', m.delegation_route_model())}
      {text('provider', m.delegation_route_provider())}
      {text('base_url', m.delegation_route_endpoint())}
      {text('api_key', draft.api_key_set ? m.delegation_route_key_saved() : m.delegation_route_key(), 'password')}
      {draft.api_key_set && <SettingRow label={m.delegation_route_key_clear()} htmlFor="route-key-clear"><Switch id="route-key-clear" checked={draft.api_key_clear ?? false} onCheckedChange={(api_key_clear) => setDraft({ ...draft, api_key_clear })} /></SettingRow>}
      {text('reasoning_effort', m.delegation_route_effort())}
      <SettingRow label={m.delegation_route_tier()} htmlFor="route-tier"><Select id="route-tier" value={draft.service_tier ?? ''} onValueChange={(service_tier) => setDraft({ ...draft, service_tier })}>
        <option value="">{m.delegation_inherit()}</option><option value="normal">{m.delegation_normal()}</option><option value="fast">{m.delegation_fast()}</option><option value="ultrafast">{m.delegation_ultrafast()}</option>
      </Select></SettingRow>
    </>}
    <div className="flex justify-end gap-1 py-2"><IconButton variant="ghost" label={m.cancel()} onClick={onCancel}><X aria-hidden="true" /></IconButton><IconButton type="submit" variant="default" label={m.save()} disabled={!draft.name.trim() || !!profiles && !consent}><Check aria-hidden="true" /></IconButton></div>

  </form>
}

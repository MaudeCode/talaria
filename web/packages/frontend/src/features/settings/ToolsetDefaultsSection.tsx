import { useQuery } from '@tanstack/react-query'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { Row, RowList } from '../../ui/List'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { SettingsGroup } from './SettingsRows'
import { useResourceEffects, useResourceMutation, type ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { showToast } from '../toast/toast'

type ToolsetRow = Awaited<ReturnType<typeof api.fetchToolsetDefaults>>['toolsets'][number]
const resource = (name: string) => `toolset-default:${name}`

/**
 * TAL-2282: the toolsets every new chat in the active profile starts with. Each switch shows the choice at once and
 * saves only its own toolset; the server decides which rows are offered, available, and can be turned off.
 */
export function ToolsetDefaultsSection() {
  const effects = useResourceEffects<boolean>()
  const query = useQuery({ queryKey: keys.toolsetDefaults, queryFn: api.fetchToolsetDefaults })
  const save = useResourceMutation({
    resource: ({ name }: { name: string; on: boolean }) => resource(name),
    effect: ({ on }) => ({ value: on }),
    queryKey: keys.toolsetDefaults,
    mutationFn: ({ name, on }: { name: string; on: boolean }) => api.saveToolsetDefault(name, on),
    onError: () => showToast(m.toolset_defaults_save_failed(), 5000, 'error'),
  })
  if (query.isPending) return <LoadingState />
  if (query.isError && !query.data) return <ErrorState error={query.error} onRetry={() => { void query.refetch() }} />
  const rows = query.data.toolsets
  const toggle = (row: ToolsetRow, on: boolean) => { save.mutate({ name: row.name, on }) }
  const list = (items: ToolsetRow[], label: string) => (
    <RowList aria-label={label}>
      {items.map((row) => <ToolsetDefaultRow key={row.name} row={row} effect={effects[resource(row.name)]} onToggle={toggle} />)}
    </RowList>
  )
  const available = rows.filter((row) => row.group === 'available')
  const unavailable = rows.filter((row) => row.group !== 'available')
  return (
    <>
      <SettingsGroup id="toolset-defaults" title={m.toolset_defaults_title()}>
        {available.length ? list(available, m.toolset_defaults_title()) : <EmptyState compact>{m.toolsets_no_matches()}</EmptyState>}
      </SettingsGroup>
      {unavailable.length > 0 && <SettingsGroup id="toolset-defaults-unavailable" title={m.toolsets_not_available()}>{list(unavailable, m.toolsets_not_available())}</SettingsGroup>}
    </>
  )
}

function ToolsetDefaultRow({ row, effect, onToggle }: { row: ToolsetRow; effect: ResourceEffect<boolean> | undefined; onToggle: (row: ToolsetRow, on: boolean) => void }) {
  return (
    <Row data-toolset-default={row.name}>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-text">{row.name}</span>
            {!row.available && <span className="text-xs text-muted">{row.unavailable_reason === 'disabled' ? m.toolsets_disabled() : m.toolsets_unavailable()}</span>}
          </div>
          {row.description && <div className="text-xs text-muted">{row.description}</div>}
          {row.stripped_tools?.length ? <div className="text-xs text-muted">{m.toolsets_stripped({ tools: row.stripped_tools.join(', '), entries: row.stripped_by?.join(', ') ?? '' })}</div> : null}
        </div>
        <ResourceSwitch effect={effect} checked={row.selected} disabled={row.can_deselect !== true} onCheckedChange={(on) => onToggle(row, on)} aria-label={row.name} />
      </div>
    </Row>
  )
}

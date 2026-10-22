import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ConnectorOperationView, ConnectorToolsView, ConnectorView } from '@maudecode/talaria-web-contracts'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { isApiError } from '../../contracts'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { ConfirmDialog } from '../../ui/Dialog'
import { EmptyState, ErrorState, LoadingState } from '../../ui/States'
import { showToast } from '../toast/toast'
import { useResourceEffects, useResourceMutation } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'
import { ConnectTargets, useConnectorOperation } from './ConnectTargets'

type Rule = { enabled: boolean } | { tool: string; tool_enabled: boolean }
const ruleResource = (connector: string, rule: Rule) => JSON.stringify(['connector-rule', connector, 'tool' in rule ? rule.tool : null])

const PROBLEM: Record<NonNullable<ConnectorView['accounts'][number]['problem']>, () => string> = {
  pending: m.connectors_account_pending, failed: m.connectors_account_failed, expired: m.connectors_account_expired, revoked: m.connectors_account_revoked, inactive: m.connectors_account_inactive,
}
const FACET: Record<ConnectorToolsView['tools'][number]['facet'], () => string> = {
  read: m.connectors_facet_read, write: m.connectors_facet_write, destructive: m.connectors_facet_destructive, unclassified: m.connectors_facet_unclassified,
}

/** The member-rule write every switch on the page makes; a stale revision reloads the page's rules. */
function useRule() {
  const qc = useQueryClient()
  // Every rule shares one policy revision: writes run one at a time, each on the newest revision this tab knows.
  const chain = useRef<Promise<unknown>>(Promise.resolve())
  const confirmed = useRef<{ read: string; next: string } | null>(null)
  return useResourceMutation({
    resource: ({ connector, rule }: { connector: string; revision: string; rule: Rule }) => ruleResource(connector, rule),
    effect: ({ rule }) => ({ value: 'tool' in rule ? rule.tool_enabled : rule.enabled }),
    queryKey: keys.connectors.all,
    readKeys: () => [keys.connectors.page, ['connectors', 'tools']],
    mutationFn: ({ connector, revision, rule }: { connector: string; revision: string; rule: Rule }) => {
      // After a write whose outcome is unknown, only the server knows the current revision: read it before the next one.
      const write = chain.current.then(() => qc.getQueryData<{ policy_revision?: string | null }>(keys.connectors.page)?.policy_revision, async () => {
        confirmed.current = null
        return (await api.fetchConnectors()).policy_revision
      }).then(async (latest) => {
        // Until the page rereads, its revision is the one this tab's last confirmed write already advanced.
        const read = latest ?? revision
        const base = confirmed.current?.read === read ? confirmed.current.next : read
        const result = await api.setConnectorRule(connector, base, rule)
        confirmed.current = { read, next: result.revision }
        return result
      })
      chain.current = write
      return write
    },
    onError: (error) => showToast(isApiError(error) && error.code === 'policy_conflict' ? m.connectors_rule_conflict() : error instanceof Error && error.message ? error.message : m.connectors_failed(), 5000, 'error'),
  })
}

/** TAL-818: Nous tool-gateway apps from the server's page view: connect, disconnect, and the member rules for apps and tools. */
export function ConnectorsSection() {
  const page = useQuery({ queryKey: keys.connectors.page, queryFn: api.fetchConnectors, staleTime: 30_000 })
  const rule = useRule()
  if (page.isPending) return <LoadingState />
  if (page.isError && !page.data) return <ErrorState error={page.error} onRetry={() => { void page.refetch() }} />
  if (!page.data?.available) return <EmptyState>{m.connectors_unavailable()}</EmptyState>
  if (page.data.connectors.length === 0) return <EmptyState>{m.connectors_empty()}</EmptyState>
  const revision = page.data.policy_revision
  return (
    <>
    {page.data.rules_error && <p role="status" className="mb-2 text-xs text-error" data-connectors-rules-error>{page.data.rules_error}</p>}
    <ul className="flex flex-col divide-y divide-border-subtle" aria-label={m.settings_section_connectors_title()} data-section="connectors">
      {page.data.connectors.map((connector) => (
        <ConnectorRow key={connector.slug} connector={connector} ruleBusy={!revision}
          onRule={(next) => { if (revision) rule.mutate({ connector: connector.slug, revision, rule: next }) }} />
      ))}
    </ul>
    </>
  )
}

function ConnectorRow({ connector, ruleBusy, onRule }: { connector: ConnectorView; ruleBusy: boolean; onRule: (rule: Rule) => void }) {
  const qc = useQueryClient()
  const effects = useResourceEffects<boolean>()
  const [operation, setOperation] = useState<ConnectorOperationView | null>(null)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null)
  const connect = useMutation({
    mutationFn: () => api.connectConnector(connector.slug),
    onSuccess: setOperation,
    onError: (error) => showToast(error.message || m.connectors_failed(), 5000, 'error'),
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.removeConnectorAccount(id),
    onSuccess: () => showToast(m.connectors_disconnected_toast({ name: connector.name })),
    onError: (error) => showToast(error.message || m.connectors_failed(), 5000, 'error'),
    onSettled: () => { void qc.invalidateQueries({ queryKey: keys.connectors.page }) },
  })
  return (
    <li className="flex flex-col gap-2 py-3" data-connector={connector.slug}>
      <div className="flex items-center gap-3">
        {connector.logo_url && <img src={connector.logo_url} alt="" className="size-6 shrink-0 rounded" />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-sm">
            <span className="font-medium text-text">{connector.name}</span>
            {connector.connected && <Badge tone="border-success/50 text-success">{m.connectors_state_connected()}</Badge>}
            {connector.org_locked && <Badge tone="border-border text-muted">{m.connectors_org_locked()}</Badge>}
          </div>
          {connector.description && <div className="line-clamp-1 text-xs text-muted">{connector.description}</div>}
        </div>
        {!operation && <Button disabled={connect.isPending} onClick={() => connect.mutate()}>{connector.connected ? m.connectors_add_account() : m.connectors_connect()}</Button>}
        <ResourceSwitch effect={effects[ruleResource(connector.slug, { enabled: connector.enabled })]} checked={connector.enabled} disabled={!connector.rules_editable || ruleBusy} onCheckedChange={(enabled) => onRule({ enabled })}
          aria-label={m.connectors_enabled_aria({ name: connector.name })} />
      </div>
      {operation && <PageConnect initial={operation} name={connector.name} onDone={() => { setOperation(null); void qc.invalidateQueries({ queryKey: keys.connectors.page }) }} />}
      {connector.accounts.length > 0 && (
        <ul className="flex flex-col gap-1 pl-9" aria-label={m.connectors_accounts_aria({ name: connector.name })}>
          {connector.accounts.map((account) => (
            <li key={account.connection_id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate text-text">{account.name}</span>
              {account.problem && <span className="text-muted" title={account.status_reason ?? undefined}>{PROBLEM[account.problem]()}</span>}
              <Button variant="ghost" className="px-2 py-1 text-xs" disabled={remove.isPending} onClick={() => setRemoving({ id: account.connection_id, name: account.name })}>{m.connectors_disconnect()}</Button>
            </li>
          ))}
        </ul>
      )}
      {connector.connected && (
        <div className="pl-9">
          <button type="button" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text" aria-expanded={toolsOpen} onClick={() => setToolsOpen((open) => !open)}>
            {toolsOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            {m.connectors_tools()}{connector.tools_off > 0 && ` · ${m.connectors_tools_off({ count: String(connector.tools_off) })}`}
          </button>
          {toolsOpen && <ToolList slug={connector.slug} busy={ruleBusy} onRule={onRule} />}
        </div>
      )}
      <ConfirmDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null) }} danger
        title={m.connectors_disconnect_title({ name: removing?.name ?? '' })} description={m.connectors_disconnect_desc({ app: connector.name })}
        confirmLabel={m.connectors_disconnect()} cancelLabel={m.cancel()} onConfirm={() => { if (removing) remove.mutate(removing.id) }} />
    </li>
  )
}

/** The page's own connect: the authorization link and Skip until the server reports the account connected. */
function PageConnect({ initial, name, onDone }: { initial: ConnectorOperationView; name: string; onDone: () => void }) {
  const { view, lost, move } = useConnectorOperation(initial)
  useEffect(() => {
    if (!view.outcome && !lost) return
    if (view.outcome) showToast(view.outcome === 'connected' ? m.connectors_connected_toast({ name }) : m.connectors_not_connected_toast({ name }), 3000, view.outcome === 'connected' ? 'info' : 'error')
    onDone()
  }, [view.outcome, lost]) // eslint-disable-line react-hooks/exhaustive-deps -- once, when it settles
  return <div className="pl-9"><ConnectTargets view={view} move={move} /></div>
}

function ToolList({ slug, busy, onRule }: { slug: string; busy: boolean; onRule: (rule: Rule) => void }) {
  const effects = useResourceEffects<boolean>()
  const tools = useQuery({ queryKey: keys.connectors.tools(slug), queryFn: () => api.fetchConnectorTools(slug), staleTime: 30_000 })
  if (tools.isPending) return <LoadingState />
  if (tools.isError && !tools.data) return <ErrorState error={tools.error} onRetry={() => { void tools.refetch() }} />
  return (
    <ul className="mt-1 flex max-h-80 flex-col divide-y divide-border-subtle overflow-y-auto" aria-label={m.connectors_tools()}>
      {tools.data?.tools.map((tool) => (
        <li key={tool.slug} className="flex items-center gap-3 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5 text-sm">
              <span className="text-text">{tool.name}</span>
              <span className="text-[11px] text-muted">{FACET[tool.facet]()}</span>
              {tool.locked && <span className="text-[11px] text-muted">{m.connectors_org_locked()}</span>}
            </div>
            {tool.description && <div className="line-clamp-1 text-[11px] text-muted">{tool.description}</div>}
          </div>
          <ResourceSwitch effect={effects[ruleResource(slug, { tool: tool.slug, tool_enabled: tool.enabled })]} checked={tool.enabled} disabled={!tool.editable || busy} onCheckedChange={(on) => onRule({ tool: tool.slug, tool_enabled: on })}
            aria-label={m.connectors_tool_aria({ name: tool.name })} />
        </li>
      ))}
    </ul>
  )
}

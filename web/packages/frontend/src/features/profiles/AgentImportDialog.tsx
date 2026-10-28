import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { AgentImportResult, AgentImportSource } from '@maudecode/talaria-web-contracts'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { ConfirmDialog, Dialog } from '../../ui/Dialog'
import { FieldRow } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { ErrorState, LoadingState } from '../../ui/States'
import { getStreamContext, useStreamContext } from '../../stream/connection'
import { appUrl } from '../../lib/appRoot'

/** Extends the profile dialog flow using the shared Dialog, FieldRow, Select and confirmation controls. */
export function AgentImportDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const context = useStreamContext()
  const generation = useRef(0)
  const busy = useRef(false)
  const [agent, setAgent] = useState<AgentImportSource | ''>('')
  const [report, setReport] = useState<AgentImportResult | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [lastReceipt, setLastReceipt] = useState<string | null>(null)
  const discovery = useQuery({ queryKey: keys.agentImports, queryFn: api.discoverAgentImports, retry: false })
  const operation = useMutation({
    mutationFn: async (request: ({ action: 'preview'; source: AgentImportSource } | { action: 'apply' | 'result'; receipt: string }) & { context: object; generation: number }) => {
      if (request.action === 'preview') return api.previewAgentImport(request.source)
      if (request.action === 'result') return api.agentImportResult(request.receipt)
      try { return await api.applyAgentImport(request.receipt) } catch { return api.agentImportResult(request.receipt) }
    },
    onSuccess: (value, request) => {
      if (request.context !== getStreamContext()) return
      if (request.generation === generation.current) setReport(value)
      if (['applied', 'partial', 'unknown'].includes(value.status)) {
        for (const queryKey of [keys.profiles, keys.activeProfile, keys.settings, keys.models, keys.memory, keys.skills.all, keys.mcp.all, keys.plugins]) void qc.invalidateQueries({ queryKey })
      }
    },
    onSettled: () => { busy.current = false },
  })
  const run = (action: 'preview' | 'apply' | 'result', receipt?: string) => {
    if (busy.current) return
    const selection = action === 'preview' && agent ? { action, source: agent } : action !== 'preview' && receipt ? { action, receipt } : null
    if (!selection) return
    busy.current = true
    operation.mutate({ ...selection, context, generation: generation.current })
  }
  const close = () => { generation.current++; onClose() }
  const shown = report ?? discovery.data
  const statusLabel = (status: AgentImportResult['items'][number]['status']) => ({ imported: shown?.status === 'preview' ? m.profile_import_status_importable : m.profile_import_status_imported, skipped: m.profile_import_status_skipped, conflict: m.profile_import_status_conflict, error: m.profile_import_status_error })[status]()
  return <>
    <Dialog open onOpenChange={(open) => { if (!open) close() }} title={m.profile_import()} className="max-h-[90dvh] overflow-y-auto">
      {discovery.isPending && <LoadingState />}
      {discovery.isError && <ErrorState error={discovery.error} onRetry={() => { void discovery.refetch() }} />}
      {shown?.message && <p role="status" className="text-sm text-warning">{shown.message}</p>}
      {shown?.status === 'unavailable' && shown.catalog_required !== false && <a className="text-sm text-accent underline" href={appUrl('settings/plugins').href}>{m.profile_import_catalog()}</a>}
      {discovery.data?.status === 'available' && <>
        <FieldRow label={m.profile_import_source()} htmlFor="agent-import-source">
          <Select className="min-h-11" id="agent-import-source" value={agent} onValueChange={(value) => { generation.current++; setAgent(value as AgentImportSource); setReport(null); setLastReceipt(null); operation.reset() }}>
            <option value="">{m.profile_import_source()}</option>
            {discovery.data.sources.map((source) => <option key={source.agent} value={source.agent}>{source.label}</option>)}
          </Select>
        </FieldRow>
        {discovery.data.sources.length === 0 && <p className="text-sm text-muted">{m.profile_import_no_sources()}</p>}
      </>}
      {operation.isError && <ErrorState error={operation.error} />}
      {shown?.status === 'applied' && <p role="status">{m.profile_import_done()}</p>}
      {shown?.status === 'partial' && <p role="status">{m.profile_import_partial()}</p>}
      {shown && shown.items.length > 0 && <ul className="my-3 divide-y divide-border-subtle" aria-label={m.profile_import_preview()}>
        {shown.items.map((item, index) => <li key={index} className="flex flex-wrap justify-between gap-2 py-2 text-sm"><span>{item.label}</span><span className="text-muted">{statusLabel(item.status)}</span></li>)}
      </ul>}
      {shown && shown.stripped_secrets.length > 0 && <div className="my-3 text-sm"><h3 className="font-medium">{m.profile_import_stripped()}</h3><ul className="break-all font-mono text-xs">{shown.stripped_secrets.map((name) => <li key={name}>{name}</li>)}</ul></div>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button className="min-h-11" onClick={close}>{m.cancel()}</Button>
        {(shown?.status === 'unknown' || operation.isError) && lastReceipt ? <Button className="min-h-11" onClick={() => run('result', lastReceipt)} disabled={operation.isPending} aria-busy={operation.isPending}>{m.profile_import_check()}</Button>
          : shown?.can_apply && shown.receipt ? <Button className="min-h-11" variant="primary" disabled={operation.isPending} aria-busy={operation.isPending} onClick={() => setConfirm(true)}>{m.profile_import_apply()}</Button>
          : discovery.data?.status === 'available' && <Button className="min-h-11" variant="primary" onClick={() => run('preview')} disabled={!agent || operation.isPending} aria-busy={operation.isPending}>{m.profile_import_preview()}</Button>}
      </div>
    </Dialog>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={m.profile_import_confirm()} description={m.profile_import_confirm_body()} confirmLabel={m.profile_import_apply()} cancelLabel={m.cancel()} onConfirm={() => { if (shown?.receipt) { setLastReceipt(shown.receipt); run('apply', shown.receipt) } }} />
  </>
}

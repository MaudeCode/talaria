import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { IconButton } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { SettingRow, SettingsGroup } from '../settings/SettingsGroup'
import { EmptyState, ErrorState, LoadingState, formatBytes, formatDate } from '../../ui/States'

const FILES = ['agent', 'webui', 'gateway', 'bootstrap'] as const
const TAILS = [100, 200, 500, 1000, 2000]

export function LogsPage() {
  const [file, setFile] = useState<string>('agent')
  const [tail, setTail] = useState(200)
  const logs = useQuery({ queryKey: keys.logs(file, tail), queryFn: () => api.fetchLogs(file, tail), staleTime: 5_000, refetchInterval: 15_000 })
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => { const el = pre.current; if (el) el.scrollTop = el.scrollHeight }, [logs.data])
  const detail = logs.data?.total_bytes !== undefined ? `${m.logs_size()}: ${formatBytes(logs.data.total_bytes)}${logs.data.mtime ? ` · ${m.logs_updated()}: ${formatDate(logs.data.mtime)}` : ''}` : undefined
  return (
    <HubPage title={m.tab_logs()}>
      <div className="flex flex-col gap-5">
        <SettingsGroup id="view" title={m.view()} detail={detail} action={<IconButton label={m.refresh()} onClick={() => { void logs.refetch() }}><RefreshCw size={16} aria-hidden="true" /></IconButton>}>
          <SettingRow label={m.logs_file_label()} htmlFor="logs-file"><Select id="logs-file" value={file} onValueChange={(v) => setFile(v)}>{FILES.map((f) => <option key={f} value={f}>{f}</option>)}</Select></SettingRow>
          <SettingRow label={m.logs_tail_label()} htmlFor="logs-tail"><Select id="logs-tail" value={tail} onValueChange={(v) => setTail(Number(v))}>{TAILS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></SettingRow>
        </SettingsGroup>
        {logs.isPending && <LoadingState />}
        {logs.isError && <ErrorState error={logs.error} onRetry={() => { void logs.refetch() }} />}
        {logs.data?.lines.length === 0 && <EmptyState>{logs.data.hint ?? m.logs_empty()}</EmptyState>}
        {logs.data && logs.data.lines.length > 0 && (
          <div className="flex flex-col gap-2">
            {logs.data.truncated && <div className="text-xs text-muted">{m.logs_truncated({ n: logs.data.lines.length })}</div>}
            {/* design-system exception: the tail keeps its own scroller so it stays pinned to the newest line. */}
            <pre ref={pre} className="max-h-[70vh] overflow-auto rounded-md border border-border bg-code-bg p-3 font-mono text-xs leading-relaxed text-pre-text" aria-live="polite">{logs.data.lines.join('\n')}</pre>
          </div>
        )}
      </div>
    </HubPage>
  )
}

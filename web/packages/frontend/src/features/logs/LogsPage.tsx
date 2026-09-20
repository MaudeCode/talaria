import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { HubPage } from '../../shell/AppShell'
import { IconButton } from '../../ui/Button'
import { Select } from '../../ui/Select'
import { EmptyState, ErrorState, LoadingState, formatBytes, formatDate } from '../../ui/States'

const FILES = ['agent', 'webui', 'gateway', 'bootstrap'] as const
const TAILS = [100, 200, 500, 1000, 2000]

export function LogsPage() {
  const [file, setFile] = useState<string>('agent')
  const [tail, setTail] = useState(200)
  const logs = useQuery({ queryKey: keys.logs(file, tail), queryFn: () => api.fetchLogs(file, tail), staleTime: 5_000, refetchInterval: 15_000 })
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => { const el = pre.current; if (el) el.scrollTop = el.scrollHeight }, [logs.data])
  return (
    <HubPage
      title={m.tab_logs()}
      actions={<IconButton label={m.refresh()} onClick={() => { void logs.refetch() }}><RefreshCw size={16} aria-hidden="true" /></IconButton>}
      toolbar={
        <>
          <label className="flex items-center gap-2 text-xs text-muted">{m.logs_file_label()} <Select value={file} onValueChange={(v) => setFile(v)}>{FILES.map((f) => <option key={f} value={f}>{f}</option>)}</Select></label>
          <label className="flex items-center gap-2 text-xs text-muted">{m.logs_tail_label()} <Select value={tail} onValueChange={(v) => setTail(Number(v))}>{TAILS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></label>
          {logs.data?.total_bytes !== undefined && <span className="text-[11px] text-muted">{`${m.logs_size()}: ${formatBytes(logs.data.total_bytes)}`}{logs.data.mtime ? ` · ${m.logs_updated()}: ${formatDate(logs.data.mtime)}` : ''}</span>}
        </>
      }
    >
      {logs.isPending && <LoadingState />}
      {logs.isError && <ErrorState error={logs.error} onRetry={() => { void logs.refetch() }} />}
      {logs.data?.lines.length === 0 && <EmptyState>{logs.data.hint ?? m.logs_empty()}</EmptyState>}
      {logs.data && logs.data.lines.length > 0 && (
        <>
          {logs.data.truncated && <div className="mb-2 text-[11px] text-muted">{m.logs_truncated({ n: logs.data.lines.length })}</div>}
          <pre ref={pre} className="max-h-[70vh] overflow-auto rounded-md border border-border bg-code-bg p-3 font-mono text-[12px] leading-relaxed text-pre-text" aria-live="polite">{logs.data.lines.join('\n')}</pre>
        </>
      )}
    </HubPage>
  )
}

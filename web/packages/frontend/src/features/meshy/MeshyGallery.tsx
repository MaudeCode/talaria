import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { MeshyItem } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { appUrl } from '../../lib/appRoot'
import { readPersisted } from '../../lib/persisted'
import { cn } from '../../ui/cn'
import { HubPage } from '../../shell/AppShell'
import { EmptyState, ErrorState, formatDate, LoadingState } from '../../ui/States'
import { SessionIdSchema } from '../../contracts/session'
import { fetchMeshyOverview } from '../../api/endpoints'
import { returnToComposer } from '../composer/composerReturn'
import { MESHY_QUERY_ROOT, MeshyItemView } from './MeshyItemView'
import { MeshyTaskProgress } from './MeshyModelCard'

/** TAL-1514: recent generations and saved files beside one shared viewer, for the active profile. */
export function MeshyGallery({ title }: { title: string }) {
  const navigate = useNavigate()
  const overview = useQuery({
    queryKey: [...MESHY_QUERY_ROOT, 'overview'],
    queryFn: ({ signal }) => fetchMeshyOverview(signal),
    refetchInterval: (query) => ((query.state.data?.active.length ?? 0) > 0 ? 5000 : false),
  })
  const [selected, setSelected] = useState<string | null>(null)
  // A follow-up goes to the chat the user last had open; it is prepared there, never sent.
  const lastChat = SessionIdSchema.safeParse(readPersisted('hermes-webui-session'))
  const onDraft = lastChat.success ? (draft: string) => { returnToComposer(lastChat.data, draft); void navigate({ to: '/session/$sessionId', params: { sessionId: lastChat.data } }) } : undefined
  const data = overview.data
  const items = [...(data?.recent ?? []), ...(data?.local ?? [])]
  const current = items.find((item) => item.key === selected) ?? items[0] ?? null
  return (
    <HubPage title={title} actions={data && data.balance !== null ? <span className="text-[12px] text-muted">{m.meshy_balance({ count: data.balance })}</span> : undefined}>
      {overview.isPending && <LoadingState />}
      {overview.isError && <ErrorState error={overview.error} onRetry={() => { void overview.refetch() }} />}
      {data && (
        <div className="flex flex-col gap-5">
          {data.message && <p role={data.availability === 'ready' ? undefined : 'status'} className="text-[13px] text-muted">{data.message}</p>}
          {data.active.length > 0 && (
            <section aria-labelledby="meshy-running" className="flex flex-col gap-2">
              <h2 id="meshy-running" className="text-[13px] font-semibold text-text">{m.meshy_running()}</h2>
              <ul className="flex flex-col gap-2">{data.active.map((task) => <li key={task.task_id}><MeshyTaskProgress task={task} /></li>)}</ul>
            </section>
          )}
          {items.length === 0 && data.active.length === 0 && <EmptyState>{m.meshy_empty()}</EmptyState>}
          {items.length > 0 && (
            <div className="grid gap-6 min-[900px]:grid-cols-[minmax(14rem,20rem)_1fr]">
              <div className="flex flex-col gap-4">
                <ItemList id="meshy-recent" label={m.meshy_recent()} items={data.recent} current={current} onSelect={setSelected} />
                <ItemList id="meshy-local" label={m.meshy_local()} items={data.local} current={current} onSelect={setSelected} />
              </div>
              {current && (
                <section aria-label={current.title} className="flex min-w-0 flex-col gap-2">
                  <h2 className="text-[15px] font-semibold text-text">{current.title}</h2>
                  <MeshyItemView key={current.key} item={current} autoRotate={data.auto_rotate} onDraft={onDraft} />
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </HubPage>
  )
}

function ItemList({ id, label, items, current, onSelect }: { id: string; label: string; items: MeshyItem[]; current: MeshyItem | null; onSelect: (key: string) => void }) {
  if (items.length === 0) return null
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1">
      <h2 id={id} className="text-[13px] font-semibold text-text">{label}</h2>
      <ul className="flex flex-col divide-y divide-border">
        {items.map((item) => (
          <li key={item.key}>
            <button type="button" aria-current={item.key === current?.key ? 'true' : undefined} onClick={() => { onSelect(item.key) }}
              className={cn('flex min-h-11 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover', item.key === current?.key && 'bg-hover')}>
              {item.thumbnail ? <img src={appUrl(item.thumbnail.url.replace(/^\.\//, '')).href} alt="" className="h-9 w-9 shrink-0 rounded bg-surface object-cover" /> : <span aria-hidden="true" className="h-9 w-9 shrink-0 rounded bg-surface" />}
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-[13px] text-text">{item.title}</span>
                <span className="truncate text-[11px] text-muted">{[item.kind === 'image' ? m.meshy_kind_images() : m.meshy_kind_model(), item.created_at ? formatDate(item.created_at) : null, item.download_incomplete ? m.meshy_incomplete() : null].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

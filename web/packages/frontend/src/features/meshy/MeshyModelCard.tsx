import { useQuery } from '@tanstack/react-query'
import type { DisplayMedia, MeshyTask } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { ErrorState, LoadingState } from '../../ui/States'
import { fetchMeshyCard } from './api'
import { returnToComposer } from '../composer/composerReturn'
import { MESHY_QUERY_ROOT, MeshyItemView } from './MeshyItemView'

/** Meshy's progress, as the server's full task snapshot reports it. */
export function MeshyTaskProgress({ task }: { task: MeshyTask }) {
  if (task.status === 'failed' || task.status === 'canceled' || task.status === 'expired') return <p role="alert" className="text-[12px] text-error">{m.meshy_task_failed({ reason: task.error ?? task.status })}</p>
  const label = task.stage ? m.meshy_progress_stage({ progress: task.progress, stage: task.stage }) : m.meshy_progress({ progress: task.progress })
  return (
    <div className="flex max-w-xs flex-col gap-1 text-[12px] text-muted">
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={task.progress} className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <div className="h-full bg-accent" style={{ width: `${String(task.progress)}%` }} />
      </div>
      <span>{label}</span>
    </div>
  )
}

/**
 * TAL-1514: an inline `model` media item. The server resolves its ref in this session and polls Meshy's task until it is
 * terminal; a newer snapshot always replaces the older one, and a changed session or profile reads a new query.
 */
export function MeshyModelCard({ sessionId, media }: { sessionId: string; media: DisplayMedia }) {
  const ref = media.model?.ref ?? ''
  const card = useQuery({
    queryKey: [...MESHY_QUERY_ROOT, 'card', sessionId, ref],
    queryFn: ({ signal }) => fetchMeshyCard(sessionId, ref, signal),
    enabled: Boolean(ref),
    refetchInterval: (query) => (query.state.data?.task && !query.state.data.task.terminal && !query.state.data.item ? 4000 : false),
  })
  const data = card.data
  return (
    <figure aria-label={media.name} className="flex flex-col gap-2">
      <figcaption className="text-[13px] font-medium text-text">{data?.title ?? media.name}</figcaption>
      {card.isPending && <LoadingState compact />}
      {card.isError && <ErrorState error={card.error} onRetry={() => { void card.refetch() }} />}
      {data?.task && !data.item && <MeshyTaskProgress task={data.task} />}
      {data?.item && <MeshyItemView item={data.item} deferViewer onDraft={(draft) => { returnToComposer(sessionId, draft) }} />}
      {data && !data.item && !data.task && <p className="text-[12px] text-muted">{data.message ?? m.meshy_unavailable()}</p>}
    </figure>
  )
}

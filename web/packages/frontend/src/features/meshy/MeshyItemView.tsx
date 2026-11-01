import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MeshyDraftAction, MeshyItem, MeshySaveResult } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import { appUrl } from '../../lib/appRoot'
import { Button } from '../../ui/Button'
import { ErrorState, formatBytes, formatDate, LoadingState } from '../../ui/States'
import { fetchMeshyDetails, saveMeshyFormat, saveMeshyImages } from '../../api/endpoints'
import { ModelViewer } from './ModelViewer'

export const MESHY_QUERY_ROOT = ['meshy'] as const
const href = (url: string): string => appUrl(url.replace(/^\.\//, '')).href

/** One model or image set, inline and in the gallery. `onDraft` puts a server draft in a composer; omitted, no follow-ups show. */
export function MeshyItemView({ item, autoRotate = false, deferViewer = false, onDraft }: { item: MeshyItem; autoRotate?: boolean; deferViewer?: boolean; onDraft?: ((draft: string) => void) | undefined }) {
  const [viewing, setViewing] = useState(!deferViewer)
  const [more, setMore] = useState(false)
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: MESHY_QUERY_ROOT })
  const saveImages = useMutation({ mutationFn: () => saveMeshyImages(item.task_id ?? ''), onSettled: refresh })
  const saveModel = useMutation({ mutationFn: () => saveMeshyFormat({ task_id: item.task_id ?? '', format: 'glb' }), onSettled: refresh })
  const meta = [item.created_at ? formatDate(item.created_at) : null, item.credits !== null ? m.meshy_credits({ count: item.credits }) : null].filter(Boolean).join(' · ')
  return (
    <div className="flex flex-col gap-2">
      {item.model && (viewing
        ? <ModelViewer asset={item.model} title={item.title} autoRotate={autoRotate} />
        : (
          <div className="flex flex-col items-start gap-2">
            {item.thumbnail && <img src={href(item.thumbnail.url)} alt="" className="max-h-48 max-w-xs rounded-md bg-surface object-contain" />}
            <Button onClick={() => { setViewing(true) }}>{m.meshy_view_3d()}</Button>
          </div>
        ))}
      {!item.model && item.kind === 'model' && item.thumbnail && <img src={href(item.thumbnail.url)} alt={item.title} className="max-h-48 max-w-xs rounded-md bg-surface object-contain" />}
      {item.kind === 'image' && item.images.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label={m.meshy_images()}>
          {item.images.map((image, index) => <li key={image.url}><img src={href(image.url)} alt={m.meshy_image_n({ n: index + 1, title: item.title })} className="h-32 w-32 rounded-md bg-surface object-cover" /></li>)}
        </ul>
      )}
      {item.prompt && item.prompt !== item.title && <p className="text-[13px] text-text">{item.prompt}</p>}
      {meta && <p className="text-[12px] text-muted">{meta}</p>}
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        {item.model && <a href={href(item.model.url)} download={item.model.name} className="underline">{m.meshy_open_file({ name: item.model.name })}{item.model.bytes !== null ? ` (${formatBytes(item.model.bytes)})` : ''}</a>}
        {!item.model && item.kind === 'model' && item.can_download && item.task_id && <Button disabled={saveModel.isPending} onClick={() => { saveModel.mutate() }}>{saveModel.isPending ? m.meshy_downloading() : m.meshy_download_model()}</Button>}
        {item.kind === 'image' && item.can_download && item.task_id && (item.download_incomplete || !item.saved) && (
          <Button disabled={saveImages.isPending} onClick={() => { saveImages.mutate() }}>{saveImages.isPending ? m.meshy_downloading() : item.download_incomplete ? m.meshy_retry_images() : m.meshy_download_images()}</Button>
        )}
        {item.can_download && item.task_id && <Button variant="ghost" aria-expanded={more} onClick={() => { setMore(!more) }}>{more ? m.meshy_less() : m.meshy_more()}</Button>}
      </div>
      <SaveOutcome result={saveModel.data ?? saveImages.data} error={saveModel.error ?? saveImages.error} />
      {more && item.task_id && <MeshyDetailsView taskId={item.task_id} beside={item.model?.url} onDraft={onDraft} />}
    </div>
  )
}

function SaveOutcome({ result, error }: { result: MeshySaveResult | undefined; error: unknown }) {
  if (error) return <div role="alert" className="text-[12px] text-error">{error instanceof Error ? error.message : m.meshy_download_failed()}</div>
  if (!result) return null
  if (result.complete) return <div role="status" className="text-[12px] text-muted">{m.meshy_saved_files({ names: result.saved.join(', ') })}</div>
  return <div role="alert" className="text-[12px] text-error">{result.error ?? m.meshy_download_failed()}{result.saved.length > 0 ? ` ${m.meshy_saved_files({ names: result.saved.join(', ') })}` : ''}</div>
}

/** Formats to download (no credits), follow-up drafts and "Made from", read when opened. */
function MeshyDetailsView({ taskId, beside, onDraft }: { taskId: string; beside: string | undefined; onDraft?: ((draft: string) => void) | undefined }) {
  const qc = useQueryClient()
  const details = useQuery({ queryKey: [...MESHY_QUERY_ROOT, 'details', taskId, beside ?? null], queryFn: ({ signal }) => fetchMeshyDetails(taskId, beside, signal) })
  const save = useMutation({ mutationFn: (format: string) => saveMeshyFormat({ task_id: taskId, format, ...(beside ? { beside } : {}) }), onSettled: () => qc.invalidateQueries({ queryKey: MESHY_QUERY_ROOT }) })
  if (details.isPending) return <LoadingState compact />
  if (details.isError) return <ErrorState error={details.error} onRetry={() => { void details.refetch() }} />
  const d = details.data
  const provenance = d.provenance
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-2 text-[12px]">
      {d.message && <p className="text-muted">{d.message}</p>}
      {d.formats.length > 0 && (
        <section aria-label={m.meshy_formats()} className="flex flex-col gap-1">
          <h4 className="font-medium text-text">{m.meshy_formats()}</h4>
          <ul className="flex flex-wrap gap-2">
            {d.formats.map((f) => (
              <li key={f.format}>
                {f.saved ? <span className="text-muted">{m.meshy_format_saved({ format: f.label })}</span>
                  : <Button disabled={save.isPending} onClick={() => { save.mutate(f.format) }}>{save.isPending && save.variables === f.format ? m.meshy_downloading() : m.meshy_save_format({ format: f.label })}</Button>}
              </li>
            ))}
          </ul>
          <SaveOutcome result={save.data} error={save.error} />
        </section>
      )}
      {onDraft && (d.actions.length > 0 || d.conversions.length > 0) && (
        <section aria-label={m.meshy_next()} className="flex flex-col gap-1">
          <h4 className="font-medium text-text">{m.meshy_next()}</h4>
          <ul className="flex flex-wrap gap-2">{[...d.actions, ...d.conversions].map((action) => <li key={action.id}><DraftButton action={action} onDraft={onDraft} /></li>)}</ul>
        </section>
      )}
      {provenance && (
        <section aria-label={m.meshy_made_from()} className="flex flex-col gap-1">
          <h4 className="font-medium text-text">{m.meshy_made_from()}</h4>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
            {provenance.prompt && <><dt className="text-muted">{provenance.prompt_inherited ? m.meshy_prompt_inherited() : m.meshy_prompt()}</dt><dd>{provenance.prompt}</dd></>}
            {provenance.texture_prompt && <><dt className="text-muted">{m.meshy_texture_prompt()}</dt><dd>{provenance.texture_prompt}</dd></>}
            {provenance.style_prompt && <><dt className="text-muted">{m.meshy_style_prompt()}</dt><dd>{provenance.style_prompt}</dd></>}
            {provenance.negative_prompt && <><dt className="text-muted">{m.meshy_negative_prompt()}</dt><dd>{provenance.negative_prompt}</dd></>}
            {provenance.source_image && <><dt className="text-muted">{m.meshy_source_image()}</dt><dd>{provenance.source_image}</dd></>}
            {provenance.settings.map((s) => <div key={s.key} className="contents"><dt className="text-muted">{s.key}</dt><dd>{s.value}</dd></div>)}
            {provenance.seed !== null && <><dt className="text-muted">{m.meshy_seed()}</dt><dd>{provenance.seed}</dd></>}
            {provenance.credits !== null && <><dt className="text-muted">{m.meshy_cost()}</dt><dd>{m.meshy_credits({ count: provenance.credits })}</dd></>}
            {provenance.parents.length > 0 && <><dt className="text-muted">{m.meshy_parents()}</dt><dd>{provenance.parents.map((p) => p.tool ?? p.task_id).join(' → ')}</dd></>}
            {provenance.children.length > 0 && <><dt className="text-muted">{m.meshy_children()}</dt><dd>{provenance.children.map((p) => p.tool ?? p.task_id).join(', ')}</dd></>}
          </dl>
        </section>
      )}
    </div>
  )
}

/** Puts the server's draft in the composer. It never sends; the Agent's cost approval still applies. */
function DraftButton({ action, onDraft }: { action: MeshyDraftAction; onDraft: (draft: string) => void }) {
  const cost = action.cost === null ? '' : action.cost === 0 ? ` · ${m.meshy_free()}` : ` · ${m.meshy_credits({ count: action.cost })}`
  return <Button variant="ghost" title={m.meshy_prepare_draft()} onClick={() => { onDraft(action.draft) }} className={action.affordable === false ? 'text-muted' : undefined}>{action.label}{cost}</Button>
}

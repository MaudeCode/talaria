import { lazy, Suspense } from 'react'
import type { DisplayMedia } from '@maudecode/talaria-web-contracts'
import { appUrl } from '../../../lib/appRoot'
import { LoadingState } from '../../../ui/States'

// Loaded only when a reply shows a model, like the 3D renderer it hosts.
const MeshyModelCard = lazy(() => import('../../meshy/MeshyModelCard').then((module) => ({ default: module.MeshyModelCard })))

/**
 * TAL-186: the media a body references that is not an inline image, after the body: audio and video play in place, a
 * PDF or other file opens from its name, and a model shows in the shared 3D preview. Images render inline from the display text.
 */
export function MediaTiles({ media, sessionId }: { media: DisplayMedia[] | undefined; sessionId?: string | undefined }) {
  const tiles = (media ?? []).filter((item) => item.kind !== 'image' && (item.kind !== 'model' || (sessionId && item.model)))
  if (tiles.length === 0) return null
  return (
    <ul className="media-tiles flex flex-col gap-2">
      {tiles.map((item) => {
        // TAL-1514: a model renders in the shared 3D preview; the server resolves its ref within this session.
        if (item.kind === 'model' && sessionId) return <li key={`model:${item.model?.ref ?? ''}`}><Suspense fallback={<figure aria-label={item.name}><LoadingState compact /></figure>}><MeshyModelCard sessionId={sessionId} media={item} /></Suspense></li>
        // Relative to the app root (`./api/media?…`) or remote.
        const href = appUrl(item.url.replace(/^\.\//, '')).href
        return (
          <li key={item.url} className="attachment-chip w-fit max-w-full rounded-md border border-border bg-surface px-2 py-1 text-[12px] text-text">
            {item.kind === 'audio' ? <figure className="flex flex-col gap-1"><figcaption className="truncate">{item.name}</figcaption><audio controls preload="none" src={href} aria-label={item.name} /></figure>
              : item.kind === 'video' ? <figure className="flex flex-col gap-1"><figcaption className="truncate">{item.name}</figcaption><video controls preload="metadata" src={href} aria-label={item.name} className="max-h-64 max-w-full rounded" /></figure>
              : <a href={href} target="_blank" rel="noopener noreferrer" className="underline">{item.name}</a>}
          </li>
        )
      })}
    </ul>
  )
}

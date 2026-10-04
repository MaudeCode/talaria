import type { DisplayMedia } from '@maudecode/talaria-web-contracts'
import { appUrl } from '../../../lib/appRoot'

/**
 * TAL-186: the media a body references that is not an inline image, after the body: audio and video play in place, a
 * PDF or other file opens from its name. Images render inline from the display text.
 */
export function MediaTiles({ media }: { media: DisplayMedia[] | undefined }) {
  const tiles = (media ?? []).filter((item) => item.kind !== 'image')
  if (tiles.length === 0) return null
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {tiles.map((item) => {
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

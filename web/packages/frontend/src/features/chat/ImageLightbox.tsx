import { useEffect } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { Dialog } from '../../ui/Dialog'
import { IconButton } from '../../ui/Button'

export interface LightboxImage {
  src: string
  name: string
}

/** One message's images enlarged in a dialog; the arrow keys and buttons step through them, wrapping at the ends. */
export function ImageLightbox({ images, index, onIndexChange }: { images: LightboxImage[]; index: number | null; onIndexChange: (index: number | null) => void }) {
  const image = index === null ? undefined : images[index]
  const position = index ?? 0
  const many = images.length > 1
  const step = (by: number) => onIndexChange((position + by + images.length) % images.length)
  useEffect(() => {
    if (!image || !many) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1)
      else if (e.key === 'ArrowRight') step(1)
    }
    // Capture: the Base UI dialog popup stops keydown from bubbling past it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  return (
    <Dialog open={image !== undefined} onOpenChange={(open) => { if (!open) onIndexChange(null) }} title={image?.name ?? ''} className="w-[min(96vw,1100px)]!">
      {image && (
        <div className="flex flex-col items-center gap-3">
          <img src={image.src} alt={image.name} className="max-h-[calc(100dvh-10rem)] max-w-full rounded object-contain" />
          {many && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <IconButton label={m.image_previous()} onClick={() => step(-1)}><ChevronLeft size={16} aria-hidden="true" /></IconButton>
              <span className="tabular-nums">{position + 1} / {images.length}</span>
              <IconButton label={m.image_next()} onClick={() => step(1)}><ChevronRight size={16} aria-hidden="true" /></IconButton>
            </div>
          )}
        </div>
      )}
    </Dialog>
  )
}

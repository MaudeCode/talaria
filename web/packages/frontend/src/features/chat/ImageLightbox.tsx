import { lazy, Suspense } from 'react'
import { Dialog } from '../../ui/Dialog'

// Deferred: the zoom viewer is not a layout cost until an image is enlarged.
const LightboxViewer = lazy(() => import('./LightboxViewer').then((module) => ({ default: module.LightboxViewer })))

export interface LightboxImage {
  src: string
  name: string
}

/** One message's images enlarged in a dialog: zoom and pan, and the arrow keys and buttons step through them, wrapping at the ends. */
export function ImageLightbox({ images, index, onIndexChange }: { images: LightboxImage[]; index: number | null; onIndexChange: (index: number | null) => void }) {
  const image = index === null ? undefined : images[index]
  // Base UI dismisses only on a press that starts and ends on the backdrop, so drags and pinches over the image keep it open.
  return (
    <Dialog open={image !== undefined} onOpenChange={(open) => { if (!open) onIndexChange(null) }} title={image?.name ?? ''} className="w-[min(96vw,1100px)]!">
      {image && index !== null && <Suspense fallback={null}><LightboxViewer image={image} images={images} index={index} onIndexChange={onIndexChange} /></Suspense>}
    </Dialog>
  )
}

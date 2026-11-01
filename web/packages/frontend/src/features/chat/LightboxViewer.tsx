import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { ChevronLeft, ChevronRight, Maximize, X, ZoomIn, ZoomOut } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { inTextField } from '../../shell/useShortcuts'
import type { LightboxImage } from './ImageLightbox'
import { clampOffset, clampScale, wheelFactor, zoomAround, zoomBounds, ZOOM_STEP, type Point, type Size } from './imageZoom'

/** The view: `zoom` null follows the image's fit; the offset belongs to `src` and recentres on any other image. */
interface View { src: string; zoom: number | null; x: number; y: number }

const ORIGIN: Point = { x: 0, y: 0 }
const CONTROL = 'h-11! w-11!'

/** The enlarged image with its zoom, pan and navigation (TAL-1530), loaded only once an image is enlarged. */
export function LightboxViewer({ image, images, index, onIndexChange }: { image: LightboxImage; images: LightboxImage[]; index: number; onIndexChange: (index: number | null) => void }) {
  const many = images.length > 1
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState<Size | null>(null)
  const [natural, setNatural] = useState<(Size & { src: string }) | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [view, setView] = useState<View>({ src: image.src, zoom: null, x: 0, y: 0 })
  // Pointers that went down on the image and own the current gesture, at their last seen position.
  const pointers = useRef(new Map<number, Point>())

  const size = natural?.src === image.src && natural.w > 0 && natural.h > 0 ? natural : null
  const geometry = size && stage && stage.w > 0 && stage.h > 0 ? { image: size, stage, ...zoomBounds(size, stage) } : null
  const resolve = (v: View) => {
    if (!geometry) return { scale: 1, offset: ORIGIN }
    const scale = v.zoom === null ? geometry.fit : clampScale(v.zoom, geometry.image, geometry.stage)
    return { scale, offset: clampOffset(v.src === image.src ? v : ORIGIN, scale, geometry.image, geometry.stage) }
  }
  const { scale, offset } = resolve(view)

  /** Applies a scale factor and pan around `anchor` (stage-centre relative); every gesture step rebases on the latest view. */
  const transform = (factor: number, anchor: Point = ORIGIN, pan: Point = ORIGIN) => {
    if (!geometry) return
    setView((v) => {
      const now = resolve(v)
      const next = factor === 1 ? now.scale : clampScale(now.scale * factor, geometry.image, geometry.stage)
      const moved = zoomAround({ x: now.offset.x + pan.x, y: now.offset.y + pan.y }, now.scale, next, anchor)
      const zoom = factor === 1 ? v.zoom : next
      return { src: image.src, zoom, ...clampOffset(moved, next, geometry.image, geometry.stage) }
    })
  }
  const endGestures = () => { pointers.current.clear() }
  const fit = () => { endGestures(); setView({ src: image.src, zoom: null, x: 0, y: 0 }) }
  const step = (by: number) => {
    endGestures()
    setView((v) => ({ ...v, x: 0, y: 0 }))
    onIndexChange((index + by + images.length) % images.length)
  }
  /** A client point relative to the stage centre. */
  const fromCentre = (x: number, y: number): Point => {
    const r = stageRef.current?.getBoundingClientRect()
    return r ? { x: x - r.left - r.width / 2, y: y - r.top - r.height / 2 } : ORIGIN
  }

  // A gesture never outlives the image it started on.
  useEffect(() => { pointers.current.clear() }, [image.src])

  useEffect(() => {
    const el = stageRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      pointers.current.clear()
      setStage({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    // Not passive: the wheel zooms the image instead of scrolling or zooming the page behind the dialog.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      e.stopPropagation()
      transform(wheelFactor(e, el.clientHeight), fromCentre(e.clientX, e.clientY))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || inTextField(e.target)) return
      if (many && e.key === 'ArrowLeft') step(-1)
      else if (many && e.key === 'ArrowRight') step(1)
      else if (e.key === '+' || e.key === '=') transform(ZOOM_STEP)
      else if (e.key === '-' || e.key === '_') transform(1 / ZOOM_STEP)
      else if (e.key === 'f' || e.key === 'F') fit()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    // Capture: the Base UI dialog popup stops keydown from bubbling past it.
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (pointers.current.size >= 2) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const last = pointers.current.get(e.pointerId)
    if (!last) return
    e.stopPropagation()
    const next = { x: e.clientX, y: e.clientY }
    const other = [...pointers.current].find(([id]) => id !== e.pointerId)?.[1]
    pointers.current.set(e.pointerId, next)
    if (!other) { transform(1, ORIGIN, { x: next.x - last.x, y: next.y - last.y }); return }
    const before = Math.hypot(last.x - other.x, last.y - other.y)
    const after = Math.hypot(next.x - other.x, next.y - other.y)
    const mid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 }
    const pan = { x: (next.x - last.x) / 2, y: (next.y - last.y) / 2 }
    transform(before > 0 && after > 0 ? after / before : 1, fromCentre(mid.x, mid.y), pan)
  }
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId)
  }
  const stop = (e: SyntheticEvent) => { e.stopPropagation() }

  const onLoad = (e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    const src = img.getAttribute('src') ?? ''
    const w = img.naturalWidth
    const h = img.naturalHeight
    setNatural((prev) => prev?.src === src && prev.w === w && prev.h === h ? prev : { src, w, h })
    setFailed((prev) => prev === src ? null : prev)
  }
  const onError = (e: SyntheticEvent<HTMLImageElement>) => {
    endGestures()
    setFailed(e.currentTarget.getAttribute('src'))
  }

  const broken = failed === image.src
  const placed = geometry && !broken ? {
    width: geometry.image.w * scale,
    height: geometry.image.h * scale,
    left: geometry.stage.w / 2 + offset.x - (geometry.image.w * scale) / 2,
    top: geometry.stage.h / 2 + offset.y - (geometry.image.h * scale) / 2,
  } : null
  const pannable = placed !== null && geometry !== null && (placed.width > geometry.stage.w + 0.5 || placed.height > geometry.stage.h + 0.5)

  return (
    <div className="flex flex-col items-center gap-3">
      <div
        ref={stageRef}
        data-lightbox-stage=""
        className={`relative h-[calc(100dvh-12rem)] w-full touch-none select-none overflow-hidden ${pannable ? 'cursor-grab active:cursor-grabbing' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onLostPointerCapture={onPointerEnd}
        onTouchStart={stop}
        onTouchMove={stop}
        onTouchEnd={stop}
        onContextMenu={stop}
      >
        <img
          src={image.src}
          alt={image.name}
          draggable={false}
          onLoad={onLoad}
          onError={onError}
          style={placed ? { ...placed, maxWidth: 'none', maxHeight: 'none' } : undefined}
          className={placed ? 'absolute rounded' : `absolute inset-0 m-auto max-h-full max-w-full rounded object-contain ${broken ? 'invisible' : ''}`}
        />
        {broken && <p role="alert" className="absolute inset-0 flex items-center justify-center text-sm text-muted">{m.image_load_failed()}</p>}
      </div>
      <div className="flex flex-wrap items-center justify-center gap-1 text-sm text-muted">
        {many && <>
          <IconButton className={CONTROL} label={m.image_previous()} onClick={() => step(-1)}><ChevronLeft size={18} aria-hidden="true" /></IconButton>
          <span className="px-1 tabular-nums">{index + 1} / {images.length}</span>
          <IconButton className={CONTROL} label={m.image_next()} onClick={() => step(1)}><ChevronRight size={18} aria-hidden="true" /></IconButton>
        </>}
        <IconButton className={CONTROL} label={m.image_zoom_out()} onClick={() => transform(1 / ZOOM_STEP)}><ZoomOut size={18} aria-hidden="true" /></IconButton>
        <IconButton className={CONTROL} label={m.image_zoom_fit()} onClick={fit}><Maximize size={18} aria-hidden="true" /></IconButton>
        <IconButton className={CONTROL} label={m.image_zoom_in()} onClick={() => transform(ZOOM_STEP)}><ZoomIn size={18} aria-hidden="true" /></IconButton>
        <IconButton className={CONTROL} label={m.close()} onClick={() => onIndexChange(null)}><X size={18} aria-hidden="true" /></IconButton>
      </div>
    </div>
  )
}

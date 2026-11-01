/** Lightbox zoom geometry (TAL-1530). Offsets place the image centre relative to the stage centre, in CSS pixels. */

export interface Size { w: number; h: number }
export interface Point { x: number; y: number }

export const MAX_ZOOM = 8
/** Button and key zoom step. */
export const ZOOM_STEP = 1.25

/** Fit never upscales a small image; zoom-out reaches a quarter, or the fit if that is smaller. */
export function zoomBounds(image: Size, stage: Size) {
  const fit = Math.min(1, stage.w / image.w, stage.h / image.h)
  return { fit, min: Math.min(0.25, fit), max: MAX_ZOOM }
}

export function clampScale(scale: number, image: Size, stage: Size): number {
  const { min, max } = zoomBounds(image, stage)
  return Math.min(max, Math.max(min, scale))
}

/** An overflowing axis keeps the stage covered by image; an axis that fits stays centred. */
export function clampOffset(offset: Point, scale: number, image: Size, stage: Size): Point {
  const axis = (value: number, length: number, room: number) => {
    const slack = (length * scale - room) / 2
    return slack <= 0 ? 0 : Math.min(slack, Math.max(-slack, value))
  }
  return { x: axis(offset.x, image.w, stage.w), y: axis(offset.y, image.h, stage.h) }
}

/** The offset after scaling `from` → `to` that keeps the image point under `anchor` (stage-centre relative) in place. */
export function zoomAround(offset: Point, from: number, to: number, anchor: Point): Point {
  const k = to / from
  return { x: anchor.x - (anchor.x - offset.x) * k, y: anchor.y - (anchor.y - offset.y) * k }
}

const LINE_PX = 16
const MAX_WHEEL_PX = 300

/** Scale factor for one wheel event; line and page deltas convert to pixels, and a trackpad pinch (ctrl+wheel) is finer-grained. */
export function wheelFactor(event: { deltaY: number; deltaMode: number; ctrlKey: boolean }, pageHeight: number): number {
  const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? pageHeight : 1
  const px = Math.max(-MAX_WHEEL_PX, Math.min(MAX_WHEEL_PX, event.deltaY * unit))
  return Math.exp(-px / (event.ctrlKey ? 100 : 300))
}

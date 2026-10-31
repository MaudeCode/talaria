import type { FeedbackAttachmentType, FeedbackOptionsSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import type { VideoJob, VideoResult } from './feedbackVideo.worker'

/**
 * Feedback attachment compression (TAL-1596), mirroring the App: images are redrawn at most 2560 px on the long edge,
 * which also drops EXIF/GPS; video is re-encoded in a worker by Mediabunny. Nothing here decides a limit: every bound
 * comes from the server's `feedback.options`.
 */
export type FeedbackLimits = z.infer<typeof FeedbackOptionsSchema>['attachments']
export type Compressed =
  | { ok: true; file: File; contentType: FeedbackAttachmentType }
  | { ok: false; reason: 'too_large' | 'too_long' | 'unsupported' | 'canceled' }

export const IMAGE_LONG_EDGE = 2560
const JPEG_QUALITY = 0.85

const accepted = (limits: FeedbackLimits, type: string): type is FeedbackAttachmentType => (limits.acceptedTypes as string[]).includes(type)
const renamed = (name: string, extension: string) => `${name.replace(/\.[^./]+$/, '') || 'attachment'}.${extension}`

/** The file as picked, when it is already an accepted type within its limit (no decoder or encoder can do better). */
function original(file: File, limits: FeedbackLimits, maxBytes: number): Compressed {
  if (!accepted(limits, file.type)) return { ok: false, reason: 'unsupported' }
  return file.size <= maxBytes ? { ok: true, file, contentType: file.type } : { ok: false, reason: 'too_large' }
}

function encodeCanvas(bitmap: ImageBitmap, width: number, height: number, type: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return Promise.resolve(null)
  // JPEG has no alpha: transparent pixels would turn black.
  if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height) }
  ctx.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => { canvas.toBlob(resolve, type, type === 'image/jpeg' ? JPEG_QUALITY : undefined) })
}

/** PNG stays PNG unless it is still over the limit, then JPEG; everything else becomes JPEG 0.85. */
export async function compressImage(file: File, limits: FeedbackLimits): Promise<Compressed> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return original(file, limits, limits.maxImageBytes)
  }
  try {
    const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    let type: 'image/png' | 'image/jpeg' = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
    let blob = await encodeCanvas(bitmap, width, height, type)
    if (blob && type === 'image/png' && blob.size > limits.maxImageBytes) { type = 'image/jpeg'; blob = await encodeCanvas(bitmap, width, height, type) }
    if (blob?.type !== type || !accepted(limits, type)) return original(file, limits, limits.maxImageBytes)
    if (blob.size > limits.maxImageBytes) return { ok: false, reason: 'too_large' }
    return { ok: true, file: new File([blob], renamed(file.name, type === 'image/png' ? 'png' : 'jpg'), { type }), contentType: type }
  } finally {
    bitmap.close()
  }
}

/**
 * Decode, scale to at most 1280 px wide, drop audio and metadata, and encode in a worker so the dialog stays
 * responsive. With no usable encoder the original goes only when it already fits.
 */
export function compressVideo(file: File, limits: FeedbackLimits, signal: AbortSignal): Promise<Compressed> {
  if (signal.aborted) return Promise.resolve({ ok: false, reason: 'canceled' })
  const worker = new Worker(new URL('./feedbackVideo.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<Compressed>((resolve) => {
    const finish = (result: Compressed) => { worker.terminate(); signal.removeEventListener('abort', cancel); resolve(result) }
    const cancel = () => finish({ ok: false, reason: 'canceled' })
    signal.addEventListener('abort', cancel)
    worker.onmessage = ({ data }: MessageEvent<VideoResult>) => {
      switch (data.kind) {
        case 'done': {
          if (data.data.byteLength > limits.maxVideoBytes || !accepted(limits, data.contentType)) { finish({ ok: false, reason: 'too_large' }); return }
          const extension = data.contentType === 'video/mp4' ? 'mp4' : 'webm'
          finish({ ok: true, file: new File([data.data], renamed(file.name, extension), { type: data.contentType }), contentType: data.contentType })
          return
        }
        case 'too_long': finish({ ok: false, reason: 'too_long' }); return
        case 'unavailable': finish(original(file, limits, limits.maxVideoBytes)); return
        case 'unreadable': finish({ ok: false, reason: 'unsupported' }); return
      }
    }
    worker.onerror = (event) => { event.preventDefault(); finish({ ok: false, reason: 'unsupported' }) }
    // A page without WebCodecs encoding cannot transcode; the worker still measures the clip.
    const job: VideoJob = { file, maxBytes: limits.maxVideoBytes, maxSeconds: limits.maxVideoSeconds, encode: typeof VideoEncoder === 'function' }
    worker.postMessage(job)
  })
}

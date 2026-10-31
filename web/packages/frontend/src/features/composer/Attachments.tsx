import { useEffect, useRef, useState } from 'react'
import { X, FileText, LoaderCircle, RotateCw } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { UploadResponse } from '../../contracts'
import type { FeedbackAttachmentStagedSchema, GroupAttachmentSchema } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import { IconButton } from '../../ui/Button'
import { ImageLightbox } from '../chat/ImageLightbox'

/** `compressing` precedes the upload where the client re-encodes first (Send feedback). Each owner fills its own receipt slot. */
export interface PendingFile { key: string; file: File; status: 'compressing' | 'uploading' | 'done' | 'error'; upload?: UploadResponse | undefined; groupAttachment?: z.infer<typeof GroupAttachmentSchema> | undefined; feedback?: z.infer<typeof FeedbackAttachmentStagedSchema> | undefined; error?: string | undefined }

const isImage = (f: PendingFile) => f.file.type.startsWith('image/')
const busy = (f: PendingFile) => f.status === 'compressing' || f.status === 'uploading'
const busyLabel = (f: PendingFile) => f.status === 'compressing' ? m.attachment_compressing() : m.uploading()

/** One object URL per shown image, revoked when its file leaves the strip or the strip unmounts. */
function useObjectUrls(files: readonly File[]): ReadonlyMap<File, string> {
  const live = useRef(new Map<File, string>())
  const [urls, setUrls] = useState<ReadonlyMap<File, string>>(() => new Map())
  useEffect(() => {
    const prev = live.current
    if (files.length === prev.size && files.every((f) => prev.has(f))) return
    const next = new Map(files.map((f) => [f, prev.get(f) ?? URL.createObjectURL(f)]))
    for (const [f, url] of prev) if (!next.has(f)) URL.revokeObjectURL(url)
    live.current = next
    setUrls(next)
  }, [files])
  useEffect(() => () => { for (const url of live.current.values()) URL.revokeObjectURL(url); live.current = new Map() }, [])
  return urls
}

/**
 * The composer's pending files (TAL-1552, after the App's TAL-634). Placement `strip`: images as thumbnails in a strip
 * hanging from the card's top edge, the mirror of the control strip under it; a thumbnail opens the image, retries a
 * failed upload, and carries a remove badge. Placement `card`: other files as chips inside the card, above the text.
 * Placement `inline`: both in one wrapping row inside a form (Send feedback, TAL-1596).
 */
export function AttachmentTray({ files, placement, onRemove, onRetry }: { files: PendingFile[]; placement: 'strip' | 'card' | 'inline'; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  if (placement === 'inline') {
    if (files.length === 0) return null
    const images = files.filter(isImage)
    const others = files.filter((f) => !isImage(f))
    return (
      <div className="flex flex-wrap items-end gap-2">
        {images.length > 0 && <ImageStrip images={images} className="flex flex-wrap gap-2" onRemove={onRemove} onRetry={onRetry} />}
        {others.length > 0 && <FileChips files={others} className="flex flex-wrap gap-2" onRemove={onRemove} onRetry={onRetry} />}
      </div>
    )
  }
  const shown = files.filter((f) => isImage(f) === (placement === 'strip'))
  if (shown.length === 0) return null
  if (placement === 'strip') return <ImageStrip images={shown} className="attach-tray composer-strip composer-strip--top" onRemove={onRemove} onRetry={onRetry} />
  return <FileChips files={shown} className="attach-tray flex flex-wrap gap-2 px-3 pt-2" onRemove={onRemove} onRetry={onRetry} />
}

function FileChips({ files, className, onRemove, onRetry }: { files: PendingFile[]; className: string; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  return (
    <ul className={className} aria-label={m.attachments_label()}>
      {files.map((f) => (
        <li key={f.key} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${f.status === 'error' ? 'border-error text-error' : 'border-border text-text'}`} data-status={f.status}>
          <FileText size={12} aria-hidden="true" />
          <span className="max-w-48 truncate">{f.file.name}</span>
          {busy(f) && <span className="text-muted" role="status" aria-label={`${busyLabel(f)} ${f.file.name}`}>…</span>}
          {f.status === 'error' && f.error && <span className="sr-only">{f.error}</span>}
          {f.status === 'error' && <IconButton label={`${m.retry()} ${f.file.name}`} className="h-5 w-5" onClick={() => onRetry(f.key)}><RotateCw size={12} aria-hidden="true" /></IconButton>}
          <IconButton label={`${m.remove()} ${f.file.name}`} className="h-5 w-5" onClick={() => onRemove(f.key)}><X size={12} aria-hidden="true" /></IconButton>
        </li>
      ))}
    </ul>
  )
}

function ImageStrip({ images, className, onRemove, onRetry }: { images: PendingFile[]; className: string; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  const urls = useObjectUrls(images.map((f) => f.file))
  // The enlarged image by key: an earlier upload finishing reorders `ready` but never switches the open image.
  const [enlarged, setEnlarged] = useState<string | null>(null)
  const ready = images.flatMap((f) => { const src = urls.get(f.file); return f.status === 'done' && src ? [{ key: f.key, src, name: f.file.name }] : [] })
  const index = ready.findIndex((r) => r.key === enlarged)
  return (
    <>
      <ul className={className} aria-label={m.attachments_label()}>
        {images.map((f) => {
          const src = urls.get(f.file)
          const label = f.status === 'error' ? `${m.retry()} ${f.file.name}` : busy(f) ? `${busyLabel(f)} ${f.file.name}` : m.image_enlarge({ name: f.file.name })
          return (
            <li key={f.key} className="attach-thumb" data-status={f.status}>
              <button type="button" className="attach-thumb-image" aria-label={label} title={f.error ?? label} aria-busy={busy(f) || undefined} disabled={busy(f)}
                onClick={() => { if (f.status === 'error') onRetry(f.key); else setEnlarged(f.key) }}>
                {src && <img src={src} alt="" draggable={false} />}
                {busy(f) && <span className="attach-thumb-overlay"><LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /></span>}
                {f.status === 'error' && <span className="attach-thumb-overlay"><RotateCw size={16} aria-hidden="true" /></span>}
              </button>
              <IconButton label={`${m.remove()} ${f.file.name}`} className="attach-thumb-remove" onClick={() => onRemove(f.key)}><X size={10} strokeWidth={3} aria-hidden="true" /></IconButton>
            </li>
          )
        })}
      </ul>
      <ImageLightbox images={ready} index={index >= 0 ? index : null} onIndexChange={(i) => setEnlarged(i === null ? null : ready[i]?.key ?? null)} />
    </>
  )
}

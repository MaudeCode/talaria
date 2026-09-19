import { X, FileText, Image as ImageIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { UploadResponse } from '../../contracts'
import { IconButton } from '../../ui/Button'

export interface PendingFile { key: string; file: File; status: 'uploading' | 'done' | 'error'; upload?: UploadResponse | undefined; error?: string | undefined }

export function AttachmentTray({ files, onRemove }: { files: PendingFile[]; onRemove: (key: string) => void }) {
  if (files.length === 0) return null
  return (
    <ul className="attach-tray flex flex-wrap gap-2 px-3 pt-2" aria-label={m.attachments_label()}>
      {files.map((f) => (
        <li key={f.key} className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${f.status === 'error' ? 'border-error text-error' : 'border-border text-text'}`} data-status={f.status}>
          {f.file.type.startsWith('image/') ? <ImageIcon size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
          <span className="max-w-48 truncate">{f.file.name}</span>
          {f.status === 'uploading' && <span className="text-muted">…</span>}
          {f.status === 'error' && f.error && <span className="sr-only">{f.error}</span>}
          <IconButton label={`${m.remove()} ${f.file.name}`} className="h-5 w-5" onClick={() => onRemove(f.key)}><X size={12} aria-hidden="true" /></IconButton>
        </li>
      ))}
    </ul>
  )
}

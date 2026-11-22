/**
 * TAL-1344: images a canonical owner chat sends. The file waits in the chat's own upload inbox like any attachment; the
 * server verifies its bytes at upload and again at send, then the owner stages them through `image.attach_bytes`. The
 * owner's staged path never leaves the sidecar, and no file outside this chat's inbox reaches the owner.
 */
import { OWNER_IMAGE_LIMIT, OWNER_IMAGE_MAX_BYTES, OWNER_IMAGES_MAX_TOTAL_BYTES, OwnerImageMimeSchema, type GatewaySessionParams } from '@maudecode/talaria-web-contracts'
import { basename } from 'node:path'
import { isCompleteRaster } from '../raster-image.js'
import { resolvePathLikePython } from '../workspace/paths.js'
import { guessMime } from '../workspace/upload.js'
import { sniffImageMime } from './turn.js'
import { HttpFailure } from './service.js'
import { attachmentPrefix, blobKeyForPath, type BlobStore } from './storage/blobs.js'

export const OWNER_IMAGE_MIMES = OwnerImageMimeSchema.options
type OwnerImage = NonNullable<GatewaySessionParams['images']>[number]
const EXT: Record<string, OwnerImage['ext']> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

/** Why an owner cannot take a file; the same refusal at upload and at send. */
export const unsupported = (reason: string): HttpFailure =>
  new HttpFailure(400, 'Only a PNG, JPEG, GIF or WebP image of at most 20 MB can be sent to this chat', { code: 'owner_attachment_unsupported', reason })

/** The kind the owner stages `bytes` as: one complete image of an accepted kind, named for what it is. */
export function ownerImage(name: string, bytes: Buffer): OwnerImage['ext'] {
  if (bytes.length > OWNER_IMAGE_MAX_BYTES) throw unsupported('too_large')
  const mime = sniffImageMime(bytes)
  const ext = mime ? EXT[mime] : undefined
  if (!mime || !ext) throw unsupported('kind')
  if (guessMime(name) !== mime) throw unsupported('mismatch')
  if (!isCompleteRaster(mime, bytes)) throw unsupported('malformed')
  return ext
}

// ponytail: one process-wide budget, so concurrent sends never hold more than one message's bytes; per-user budgets if many people send images at once.
let inFlight = 0

/**
 * The images a send names, read from this chat's own inbox and verified again, in order. Sizes are checked from the
 * store before any byte is read, and the bytes stay reserved until `release`, once the owner has answered.
 */
export async function ownerImages(blobs: BlobStore, sid: string, paths: string[]): Promise<{ images: OwnerImage[]; release: () => void }> {
  if (paths.length > OWNER_IMAGE_LIMIT) throw new HttpFailure(400, `At most ${String(OWNER_IMAGE_LIMIT)} images can be sent at once`, { code: 'owner_attachment_unsupported', reason: 'too_many' })
  if (new Set(paths).size !== paths.length) throw unsupported('duplicate')
  const files: { key: string; size: number }[] = []
  for (const path of paths) {
    const key = path ? blobKeyForPath(blobs.attachmentRoot(), resolvePathLikePython(path)) : null
    // A top-level file of this chat's inbox: never another chat's file, an extracted tree or a host path.
    if (!key?.startsWith(attachmentPrefix(sid)) || key.slice(attachmentPrefix(sid).length).includes('/')) throw unsupported('not_in_chat')
    const stat = await blobs.stat(key)
    if (!stat) throw unsupported('not_found')
    if (stat.size > OWNER_IMAGE_MAX_BYTES) throw unsupported('too_large')
    files.push({ key, size: stat.size })
  }
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > OWNER_IMAGES_MAX_TOTAL_BYTES) throw unsupported('too_large_total')
  if (inFlight + total > OWNER_IMAGES_MAX_TOTAL_BYTES) throw new HttpFailure(503, 'Other images are being sent. Try again in a moment.', { code: 'owner_images_busy' })
  inFlight += total
  let released = false
  const release = (): void => { if (!released) { released = true; inFlight -= total } }
  try {
    const images: OwnerImage[] = []
    for (const { key, size } of files) {
      const stored = await blobs.get(key)
      if (!stored) throw unsupported('not_found')
      const chunks: Buffer[] = []
      let read = 0
      for await (const chunk of stored.body as AsyncIterable<Buffer>) {
        read += chunk.length
        // The stored file may have grown since its size was checked; never read past what was reserved.
        if (read > size) { stored.body.destroy(); throw unsupported('too_large') }
        chunks.push(chunk)
      }
      const bytes = Buffer.concat(chunks)
      images.push({ data_base64: bytes.toString('base64'), ext: ownerImage(basename(key), bytes) })
    }
    return { images, release }
  } catch (error) {
    release()
    throw error
  }
}

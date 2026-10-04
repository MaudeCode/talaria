/**
 * TAL-186: transcript media references. Finds `MEDIA:` tokens, bare `file://` URLs and local Markdown image
 * destinations in a message's Markdown and rewrites each one to standard Markdown pointing at its media URL, so clients
 * render the message as one document. The text is parsed as CommonMark, so code blocks (fenced or indented), code spans
 * (across lines too), HTML and escapes stay literal; a reference the resolver refuses stays as written.
 */
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import type { DisplayMedia } from '@maudecode/talaria-web-contracts'
import { INLINE_IMAGE_TYPES, mimeFor } from './media.js'

export interface MediaRefResolver {
  /** The session workspace `./` and `../` image destinations resolve against; null leaves them as text. */
  workspace: string | null
  /** The app-relative media URL for a local path as written (`~/`, absolute or relative), or null when it is not served. */
  localUrl: (path: string) => string | null
}

export interface MediaProjection {
  text: string
  media: DisplayMedia[]
}

interface Edit { start: number; end: number; text: string; media: DisplayMedia }

const TRAILING_PUNCTUATION = '.,;:!?'
const FILE_URL = 'file://'
const MEDIA = 'MEDIA:'

/** Null when the text has no reference the resolver serves. `content` is never touched; this is display text only. */
export function projectMediaRefs(markdown: string, resolver: MediaRefResolver): MediaProjection | null {
  if (!markdown.includes(MEDIA) && !markdown.includes(FILE_URL) && !markdown.includes('![')) return null
  const edits: Edit[] = []
  const visit = (node: Nodes): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    if (node.type === 'text') edits.push(...textEdits(markdown, start, end, resolver))
    else if (node.type === 'image') {
      const ref = imageDestinationRef(node.url, resolver.workspace)
      const media = ref === null ? null : mediaFor(ref, resolver)
      if (media) edits.push({ start, end, text: media.kind === 'image' ? `![${escapeLabel(node.alt || media.name)}](${media.url})` : `[${escapeLabel(node.alt || media.name)}](${media.url})`, media })
    } else if (node.type === 'link' && node.url.startsWith(MEDIA)) {
      // `[label](MEDIA:/path)`: only the destination is rewritten, so the label keeps its own Markdown.
      const media = mediaFor(node.url.slice(MEDIA.length), resolver)
      const at = media ? markdown.lastIndexOf(node.url, end) : -1
      if (media && at >= start) edits.push({ start: at, end: at + node.url.length, text: media.url, media })
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(fromMarkdown(markdown))
  if (!edits.length) return null
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  let cursor = 0
  const media: DisplayMedia[] = []
  for (const edit of edits) {
    text += markdown.slice(cursor, edit.start) + edit.text
    cursor = edit.end
    if (!media.some((m) => m.url === edit.media.url)) media.push(edit.media)
  }
  return { text: text + markdown.slice(cursor), media }
}

/** `MEDIA:` tokens and bare `file://` URLs in one text node's source span. */
function textEdits(source: string, from: number, to: number, resolver: MediaRefResolver): Edit[] {
  const edits: Edit[] = []
  let cursor = from
  while (cursor < to) {
    const isToken = source.startsWith(MEDIA, cursor)
    // A bare file URL starts its text (after a list marker, quote or emphasis delimiter) or follows whitespace;
    // `[x](file://…)` is a link and `xfile://` is prose.
    const isFileUrl = !isToken && source.startsWith(FILE_URL, cursor) && (cursor === from || /\s/.test(source[cursor - 1] ?? ''))
    if (!isToken && !isFileUrl) { cursor += 1; continue }
    const refStart = isToken ? cursor + MEDIA.length : cursor
    const refEnd = referenceEnd(source, refStart, to, isFileUrl)
    const raw = refEnd === null ? '' : source.slice(refStart, refEnd)
    const media = raw ? mediaFor(isFileUrl ? fileUrlPath(raw) : raw, resolver) : null
    if (media && refEnd !== null) {
      const label = escapeLabel(media.name)
      edits.push({ start: cursor, end: refEnd, text: media.kind === 'image' ? `![${label}](${media.url})` : `[${label}](${media.url})`, media })
      cursor = refEnd
    } else cursor = isToken ? refStart : cursor + FILE_URL.length
  }
  return edits
}

/** Where a reference ends: at whitespace or `)` `]` (and `<>"'` for a file URL), less trailing sentence punctuation. */
function referenceEnd(source: string, start: number, limit: number, fileUrl: boolean): number | null {
  let end = start
  while (end < limit && !isTerminator(source[end] ?? ' ', fileUrl)) end += 1
  while (end > start && TRAILING_PUNCTUATION.includes(source[end - 1] ?? '')) end -= 1
  const minimum = fileUrl ? start + FILE_URL.length : start
  return end > minimum ? end : null
}

function isTerminator(ch: string, fileUrl: boolean): boolean {
  return /\s/.test(ch) || ch === ')' || ch === ']' || (fileUrl && '<>"\''.includes(ch))
}

/** A Markdown image destination the server can serve: `file://`, absolute, `~/`, workspace-relative or `MEDIA:`. */
function imageDestinationRef(url: string, workspace: string | null): string | null {
  if (url.startsWith(MEDIA)) return url.slice(MEDIA.length)
  if (url.toLowerCase().startsWith(FILE_URL)) return fileUrlPath(url)
  // Destinations percent-encode spaces and punctuation; decoded once, as a file URL's path is.
  const path = safeDecode(url)
  if ((url.startsWith('/') && !url.startsWith('//')) || url.startsWith('~/')) return path
  if ((url.startsWith('./') || url.startsWith('../')) && workspace && isAbsolute(workspace)) return resolve(workspace, path)
  return null
}

/** One reference's media item: a remote `http(s)` URL as written, or a local path the resolver serves. */
function mediaFor(ref: string, resolver: MediaRefResolver): DisplayMedia | null {
  if (/^https?:\/\//i.test(ref)) {
    let pathname: string
    let host: string
    try { ({ pathname, host } = new URL(ref)) } catch { return null }
    const name = safeDecode(basename(pathname)) || host
    const mime = mimeFor(pathname)
    // Nothing tells an extensionless remote reference's kind, so it is a file: a link, never a guessed image.
    return { url: ref.replace(/[()<> ]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`), name, mime, kind: extname(pathname) ? kindFor(mime) : 'file' }
  }
  if (ref.includes('://')) return null
  const url = resolver.localUrl(ref)
  if (!url) return null
  const mime = mimeFor(ref)
  return { url, name: basename(ref) || ref, mime, kind: kindFor(mime) }
}

function kindFor(mime: string): DisplayMedia['kind'] {
  if (INLINE_IMAGE_TYPES.has(mime)) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return mime === 'application/pdf' ? 'pdf' : 'file'
}

function fileUrlPath(raw: string): string {
  try {
    const { pathname } = new URL(raw)
    if (pathname) return safeDecode(pathname)
  } catch { /* not a parseable URL */ }
  return safeDecode(raw.slice(FILE_URL.length))
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text) } catch { return text }
}

/** Link or image text that stays literal: Markdown punctuation is escaped. */
function escapeLabel(text: string): string {
  return text.replace(/[\\`*_[\]<>&!]/g, '\\$&')
}

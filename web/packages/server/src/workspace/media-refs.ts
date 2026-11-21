/**
 * TAL-186: transcript media references. Finds `MEDIA:` tokens, bare `file://` URLs and local Markdown image
 * destinations in a message's Markdown and rewrites each one to standard Markdown pointing at its media URL, so clients
 * render the message as one document. The text is parsed as CommonMark, so code blocks (fenced or indented), code spans
 * (across lines too), HTML and escapes stay literal, except a single-backtick span holding exactly one `MEDIA:` tag
 * (TAL-2029); a reference the resolver refuses stays as written. TAL-2199: a remote image, in Markdown or an HTML `<img>`,
 * becomes a link (`linkRemoteImages`), so text the agent writes never makes the browser fetch a URL by itself.
 */
import { basename, extname, isAbsolute, resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes, Parents } from 'mdast'
import { MESHY_TASK_ID_RE, type DisplayMedia } from '@maudecode/talaria-web-contracts'
import { INLINE_IMAGE_TYPES, mediaRefTarget, mediaResultRefs, mimeFor, screenshotRefs } from './media.js'

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

interface Edit { start: number; end: number; text: string; media?: DisplayMedia | undefined }

const MESHY_DIRECTIVE = '::meshy-model'
const MESHY_LINE_RE = /^[ \t]*::meshy-model\{([^{}\r\n]*)\}[ \t]*$/
const MESHY_ATTR_RE = /\s*([a-z_]+)="([^"\\\r\n]*)"\s*/y

/** TAL-1514: one `::meshy-model{…}` directive line, validated. `ref` is opaque to clients and found again server-side. */
export interface MeshyDirective { task: string | null; path: string | null; title: string | null; ref: string }

/** A directive's attributes when every one parses and it names a valid task or an absolute `.glb` path; else null. */
export function parseMeshyDirective(line: string): MeshyDirective | null {
  const body = MESHY_LINE_RE.exec(line)?.[1]
  if (body === undefined) return null
  const attrs = new Map<string, string>()
  MESHY_ATTR_RE.lastIndex = 0
  while (MESHY_ATTR_RE.lastIndex < body.length) {
    const at = MESHY_ATTR_RE.lastIndex
    const match = MESHY_ATTR_RE.exec(body)
    if (match?.index !== at || attrs.has(match[1] ?? '')) return null
    attrs.set(match[1] ?? '', match[2] ?? '')
  }
  const task = attrs.get('task') ?? null
  const path = attrs.get('path') ?? null
  if (task !== null && !MESHY_TASK_ID_RE.test(task)) return null
  // Only a self-contained binary model, named absolutely: a `.gltf` can fetch resources from anywhere.
  if (path !== null && (!path.startsWith('/') || path.includes('\0') || !path.toLowerCase().endsWith('.glb'))) return null
  if (task === null && path === null) return null
  const title = (attrs.get('title') ?? '').trim().slice(0, 120) || null
  return { task, path, title, ref: Buffer.from(JSON.stringify([task, path, title]), 'utf8').toString('base64url') }
}

/** Every valid directive in the Markdown's paragraphs, in order; code blocks and spans stay literal. */
export function meshyDirectives(markdown: string): MeshyDirective[] {
  if (!markdown.includes(MESHY_DIRECTIVE)) return []
  return directiveLines(markdown).map((line) => line.directive)
}

function directiveLines(markdown: string): { start: number; end: number; directive: MeshyDirective }[] {
  const out: { start: number; end: number; directive: MeshyDirective }[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'paragraph') {
      const start = node.position?.start.offset
      const end = node.position?.end.offset
      if (start === undefined || end === undefined) return
      let cursor = start
      for (const line of markdown.slice(start, end).split('\n')) {
        const directive = parseMeshyDirective(line)
        // The line and its line break leave the display text.
        if (directive) out.push({ start: cursor, end: Math.min(cursor + line.length + 1, markdown.length), directive })
        cursor += line.length + 1
      }
      return
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(fromMarkdown(markdown))
  return out
}

const TRAILING_PUNCTUATION = '.,;:!?'
const FILE_URL = 'file://'
const MEDIA = 'MEDIA:'

/** Null when the text has no reference the resolver serves. `content` is never touched; this is display text only. */
export function projectMediaRefs(markdown: string, resolver: MediaRefResolver): MediaProjection | null {
  if (!markdown.includes(MEDIA) && !markdown.includes(FILE_URL) && !hasImageSyntax(markdown) && !markdown.includes(MESHY_DIRECTIVE)) return null
  // TAL-2199: a remote image is a link in display text; a media tool's own result is relayed when it ships (`withResultFocusPaths`).
  const displayed = (ref: string): DisplayMedia | null => {
    const media = mediaFor(ref, resolver)
    return media?.kind === 'image' && isRemoteImageSource(media.url) ? { ...media, kind: 'file' } : media
  }
  const tree = fromMarkdown(markdown)
  const definitions = definitionsOf(tree)
  const edits: Edit[] = []
  const models: Edit[] = markdown.includes(MESHY_DIRECTIVE)
    ? directiveLines(markdown).map(({ start, end, directive }) => ({ start, end, text: '', media: { url: '', name: directive.title ?? 'Meshy model', mime: 'model/gltf-binary', kind: 'model', model: { ref: directive.ref } } }))
    : []
  const visit = (node: Nodes, parent: Parents | null): void => {
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    if (node.type === 'text') edits.push(...textEdits(markdown, start, end, displayed))
    else if (node.type === 'image') {
      const ref = imageDestinationRef(node.url, resolver.workspace)
      const media = ref === null ? null : displayed(ref)
      if (media) edits.push({ start, end, text: mediaMarkdown(media, node.alt), media })
      else edits.push(...remoteImageEdits(markdown, node, parent, definitions))
    } else if (node.type === 'link' && node.url.startsWith(MEDIA)) {
      // `[label](MEDIA:/path)`: only the destination is rewritten, so the label keeps its own Markdown.
      const media = displayed(node.url.slice(MEDIA.length))
      const at = media ? markdown.lastIndexOf(node.url, end) : -1
      if (media && at >= start) edits.push({ start: at, end: at + node.url.length, text: media.url, media })
    } else if (node.type === 'inlineCode') {
      // TAL-2029: `` `MEDIA:/path` `` is a directive, as the Agent's gateway reads it; longer or double-backtick code stays literal.
      const ref = wholeCodeTag(markdown.slice(start, end), node.value)
      const media = ref === null ? null : displayed(ref)
      if (media) edits.push({ start, end, text: mediaMarkdown(media), media })
    } else edits.push(...remoteImageEdits(markdown, node, parent, definitions))
    if ('children' in node) for (const child of node.children) visit(child, node)
  }
  visit(tree, null)
  // A directive line is replaced whole; no other reference inside it is rewritten.
  edits.splice(0, edits.length, ...edits.filter((edit) => !models.some((m) => edit.start < m.end && m.start < edit.end)), ...models)
  return edits.length ? applyEdits(markdown, edits) : null
}

function applyEdits(markdown: string, edits: Edit[]): MediaProjection {
  edits.sort((a, b) => a.start - b.start)
  let text = ''
  let cursor = 0
  const media: DisplayMedia[] = []
  for (const edit of edits) {
    text += markdown.slice(cursor, edit.start) + edit.text
    cursor = edit.end
    const item = edit.media
    if (item && !media.some((m) => m.url === item.url && m.model?.ref === item.model?.ref)) media.push(item)
  }
  return { text: text + markdown.slice(cursor), media }
}

const hasImageSyntax = (markdown: string): boolean => markdown.includes('![') || /<img/i.test(markdown)

/**
 * TAL-2199: the Markdown with every remote image as a link to it, labelled with its alt text or else its host, and nothing
 * else changed. A remote image inside a link leaves only its label, so the link keeps its own destination.
 */
export function linkRemoteImages(markdown: string): string {
  // The parser is quadratic on some unclosed image syntax: only text that could spell a remote source is parsed.
  if (!hasImageSyntax(markdown) || !spellsRemoteSource(markdown)) return markdown
  const tree = fromMarkdown(markdown)
  const definitions = definitionsOf(tree)
  const edits: Edit[] = []
  const visit = (node: Nodes, parent: Parents | null): void => {
    edits.push(...remoteImageEdits(markdown, node, parent, definitions))
    if ('children' in node) for (const child of node.children) visit(child, node)
  }
  visit(tree, null)
  return edits.length ? applyEdits(markdown, edits).text : markdown
}

/** Linear: whether a remote source could be spelled anywhere in the text, read as `isRemoteImageSource` and HTML read it. */
const spellsRemoteSource = (text: string): boolean => /https?:|\/\//i.test(decodeHtmlEntities(text).replace(/[\t\n\r]/g, '').replace(/\\/g, '/'))

/** TAL-2199: whether a browser loads this image source over the network: `http(s):` or `//host`, as the URL parser reads it. */
export function isRemoteImageSource(src: string): boolean {
  // The parser drops tabs and newlines, trims leading controls and spaces, and reads `\` as `/`.
  const url = src.replace(/[\t\n\r]/g, '').replace(/\\/g, '/')
  let at = 0
  while (at < url.length && url.charCodeAt(at) <= 0x20) at += 1
  return /^(?:https?:|\/\/)/i.test(url.slice(at))
}

function definitionsOf(tree: Nodes): Map<string, string> {
  const out = new Map<string, string>()
  const visit = (node: Nodes): void => {
    if (node.type === 'definition' && !out.has(node.identifier)) out.set(node.identifier, node.url)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return out
}

/** The edits that turn one node's remote images into links: a Markdown image or image reference, or `<img>` tags in HTML. */
function remoteImageEdits(markdown: string, node: Nodes, parent: Parents | null, definitions: Map<string, string>): Edit[] {
  const start = node.position?.start.offset
  const end = node.position?.end.offset
  if (start === undefined || end === undefined) return []
  if (node.type === 'image' || node.type === 'imageReference') {
    const url = node.type === 'image' ? node.url : definitions.get(node.identifier)
    if (url === undefined || !isRemoteImageSource(url)) return []
    const label = escapeLabel(node.alt || hostOf(url))
    const insideLink = parent?.type === 'link' || parent?.type === 'linkReference'
    return [{ start, end, text: insideLink ? label : `[${label}](${markdownDestination(url)})` }]
  }
  if (node.type !== 'html' || node.value.startsWith('<!--')) return []
  return htmlImageTags(markdown.slice(start, end)).flatMap((tag) => {
    const sources = [tag.src, ...tag.srcset].filter((src) => src !== null)
    const url = sources.find(isRemoteImageSource) ?? (sources.some(hasUnknownReference) ? sources[0] : undefined)
    if (url === undefined) return []
    return [{ start: start + tag.start, end: start + tag.end, text: `[${escapeLabel(tag.alt || hostOf(url))}](${markdownDestination(url)})` }]
  })
}

interface ImageTag { start: number; end: number; src: string | null; srcset: string[]; alt: string }

const TAG_ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** The `<img>` tags in raw HTML, each read once from its `<img` to the `>` outside quotes that ends it; linear in the text. */
function htmlImageTags(html: string): ImageTag[] {
  const tags: ImageTag[] = []
  const opener = /<img(?=[\s/>])/gi
  for (let match = opener.exec(html); match; match = opener.exec(html)) {
    let quote = ''
    let close = match.index + match[0].length
    for (; close < html.length; close += 1) {
      const ch = html[close]
      if (quote) { if (ch === quote) quote = '' } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    if (close >= html.length) break
    const attrs = new Map<string, string>()
    for (const attr of html.slice(match.index + 4, close).matchAll(TAG_ATTR_RE)) {
      const name = (attr[1] ?? '').toLowerCase()
      if (!attrs.has(name)) attrs.set(name, decodeHtmlEntities(attr[2] ?? attr[3] ?? attr[4] ?? ''))
    }
    const srcset = (attrs.get('srcset') ?? '').split(',').map((candidate) => candidate.trim().split(/\s+/)[0] ?? '').filter(Boolean)
    tags.push({ start: match.index, end: close + 1, src: attrs.get('src') ?? null, srcset, alt: (attrs.get('alt') ?? '').trim() })
    opener.lastIndex = close + 1
  }
  return tags
}

/** An entity this decoder leaves undecoded could spell a scheme, so the source counts as remote. */
const hasUnknownReference = (src: string): boolean => /&[a-z\d#]+;/i.test(src)

const NAMED_ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', colon: ':', sol: '/', bsol: '\\', tab: '\t', newline: '\n', period: '.' }

/** HTML character references in an attribute value: numeric ones and the few named ones a URL needs. */
function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);?/gi, (whole, ref: string) => {
    const lower = ref.toLowerCase()
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return NAMED_ENTITIES[lower] ?? whole
  })
}

function hostOf(url: string): string {
  try { return new URL(url.replace(/\\/g, '/'), 'https://invalid').host || url } catch { return url }
}

/** A URL as a Markdown link destination: characters that would end or break it are percent-encoded. */
function markdownDestination(url: string): string {
  return url.replace(/[()<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`)
}

/** `MEDIA:` tokens and bare `file://` URLs in one text node's source span. */
function textEdits(source: string, from: number, to: number, mediaOf: (ref: string) => DisplayMedia | null): Edit[] {
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
    const ref = raw && isFileUrl ? fileUrlPath(raw) : raw
    const media = ref ? mediaOf(ref) : null
    if (media && refEnd !== null) {
      edits.push({ start: cursor, end: refEnd, text: mediaMarkdown(media), media })
      cursor = refEnd
    } else cursor = isToken ? refStart : cursor + FILE_URL.length
  }
  return edits
}

/** A single-backtick code span holding exactly `MEDIA:<ref>`: the ref, or null for any other code. */
function wholeCodeTag(source: string, value: string): string | null {
  if (source.startsWith('``')) return null
  const tag = value.trim()
  const ref = tag.startsWith(MEDIA) ? tag.slice(MEDIA.length) : ''
  // `MEDIA:<path>` is a placeholder, not a path.
  return ref && !/[\s<>]/.test(ref) ? ref : null
}

/** A media item as Markdown: an image shows inline, anything else is a link. */
function mediaMarkdown(media: DisplayMedia, label?: string | null): string {
  const text = escapeLabel(label || media.name)
  return media.kind === 'image' ? `![${text}](${media.url})` : `[${text}](${media.url})`
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

/** A Markdown image destination the server can serve: `file://`, absolute, `~/`, workspace-relative (with or without `./`) or `MEDIA:`. */
function imageDestinationRef(url: string, workspace: string | null): string | null {
  if (url.startsWith(MEDIA)) return url.slice(MEDIA.length)
  if (url.toLowerCase().startsWith(FILE_URL)) return fileUrlPath(url)
  // Destinations percent-encode spaces and punctuation; decoded once, as a file URL's path is.
  const path = safeDecode(url)
  if ((url.startsWith('/') && !url.startsWith('//')) || url.startsWith('~/')) return path
  // TAL-2363: any other destination without a scheme (`out/chart.png`, `./`, `../`) joins the workspace.
  if (!url || /^([a-z][a-z\d+.-]*:|[/~#?])/i.test(url) || !workspace || !isAbsolute(workspace)) return null
  return resolve(workspace, path)
}

/** TAL-2325: a media tool result's local file as its `/api/media` URL; the session's id joins it where the result ships (`withResultFocusPaths`). */
function toolMediaUrl(path: string): string | null {
  try { return `./api/media?${new URLSearchParams({ path: mediaRefTarget(path) }).toString()}` } catch { return null }
}

/**
 * TAL-2325: the media a media tool's result made (`mediaResultRefs`), each as `projectMediaRefs` shows one: a remote URL
 * as written, a local absolute or `~/` path as its `/api/media` URL, which the session's media grant serves.
 */
export function toolResultMedia(data: Record<string, unknown>): DisplayMedia[] {
  return refsMedia(mediaResultRefs(data))
}

/** TAL-2328: the screenshot a browser or computer-use result saved (`screenshotRefs`), as its media item. */
export function toolScreenshotMedia(result: unknown): DisplayMedia[] {
  return refsMedia(screenshotRefs(result))
}

function refsMedia(refs: string[]): DisplayMedia[] {
  const resolver: MediaRefResolver = { workspace: null, localUrl: toolMediaUrl }
  return refs.flatMap((ref) => {
    if (!/^https?:\/\//i.test(ref) && !ref.startsWith('/') && !ref.startsWith('~/')) return []
    const media = mediaFor(ref, resolver)
    return media ? [media] : []
  })
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
    return { url: markdownDestination(ref), name, mime, kind: extname(pathname) ? kindFor(mime) : 'file' }
  }
  if (ref.includes('://')) return null
  const url = resolver.localUrl(ref)
  if (!url) return null
  const mime = mimeFor(ref)
  return { url, name: basename(ref) || ref, mime, kind: kindFor(mime) }
}

export function kindFor(mime: string): DisplayMedia['kind'] {
  if (INLINE_IMAGE_TYPES.has(mime)) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return mime === 'application/pdf' ? 'pdf' : 'file'
}

/** Hosts that name this machine; `localhost` already parses to an empty host. */
const LOCAL_FILE_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]'])

/** A file URL's local path, or null when it names another host (`file://server/share/x`) and is not this machine's file. */
function fileUrlPath(raw: string): string | null {
  try {
    const { hostname, pathname } = new URL(raw)
    if (!LOCAL_FILE_HOSTS.has(hostname)) return null
    if (pathname) return safeDecode(pathname)
  } catch { /* not a parseable URL */ }
  const rest = raw.slice(FILE_URL.length)
  return rest.startsWith('/') ? safeDecode(rest) : null
}

function safeDecode(text: string): string {
  try { return decodeURIComponent(text) } catch { return text }
}

/** Link or image text that stays literal: Markdown punctuation is escaped. */
function escapeLabel(text: string): string {
  return text.replace(/[\\`*_[\]<>&!]/g, '\\$&')
}

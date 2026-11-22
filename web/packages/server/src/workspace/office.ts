/**
 * Office previews and `.docx` saves (TAL-262), the Python server's `office_documents.py` in TypeScript.
 *
 * Every archive passes a preflight before any XML is parsed: at most 256 members, 8 MB uncompressed in total, a per-part
 * cap, a compression ratio of at most 200 and member names that stay inside the archive. Each member is inflated with
 * its declared size as the output cap, so a member that lies about its size fails its read instead of inflating past it.
 * XML is parsed with no DTD: a `<!DOCTYPE` refuses the part, and only the five predefined and numeric entities expand.
 *
 * A preview is plain text with server-side limits; hitting one sets `truncated` and makes the document read-only. Only a
 * `.docx` whose body is plain paragraphs (the allowlists below) is `editable`; saving rewrites only `word/document.xml`'s
 * body paragraphs and copies every other part byte for byte.
 */
import { extname, posix } from 'node:path'
import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { readZip, type ZipEntry } from './unzip.js'
import { zipBuffer } from './zip.js'

export type OfficeFormat = 'docx' | 'xlsx' | 'pptx'

/** A refusal the caller answers with 400: a hostile or unreadable archive, or content a save cannot store. */
export class OfficeError extends Error {}

export interface OfficePreview { path: string; size: number; content: string; lines: number; office_format: OfficeFormat; editable: boolean; edit_blocked_reason?: string; truncated?: true }

export const MAX_OFFICE_PREVIEW_CHARS = 120_000
export const MAX_DOCX_PREVIEW_BLOCKS = 2_000
const MAX_DOCX_TABLE_CELLS = 5_000
export const MAX_XLSX_PREVIEW_SHEETS = 20
export const MAX_XLSX_PREVIEW_ROWS_PER_SHEET = 500
const MAX_XLSX_PREVIEW_CELLS_PER_SHEET = 5_000
export const MAX_PPTX_PREVIEW_SLIDES = 100
const MAX_PPTX_PREVIEW_SHAPES_PER_SLIDE = 200
export const MAX_OFFICE_ARCHIVE_MEMBERS = 256
export const MAX_OFFICE_ARCHIVE_TOTAL_BYTES = 8_000_000
const MAX_OFFICE_ARCHIVE_MEMBER_BYTES = 4_000_000
export const MAX_OFFICE_COMPRESSION_RATIO = 200
const TRUNCATED_NOTICE = '[Preview truncated: Office content exceeds safe limits]'
const LIMIT_MESSAGE = 'Office preview exceeds safe archive limits'

export function officeFormat(path: string): OfficeFormat | null {
  const ext = extname(path).toLowerCase()
  return ext === '.docx' || ext === '.xlsx' || ext === '.pptx' ? (ext.slice(1) as OfficeFormat) : null
}

const readError = (format: OfficeFormat) => new OfficeError(`Unable to read ${format.toUpperCase()} preview`)

/** The smaller caps of the parts each format parses (`office_documents.py` `_archive_member_byte_limit`). */
function memberLimit(format: OfficeFormat, name: string): number {
  if (format === 'docx' && name === 'word/document.xml') return 4_000_000
  if (format === 'xlsx') {
    if (name === 'xl/sharedStrings.xml') return 4_000_000
    if (name.startsWith('xl/worksheets/')) return 2_000_000
    if (name.startsWith('xl/theme/') || name.startsWith('docProps/') || name === 'xl/workbook.xml') return 512_000
  }
  if (format === 'pptx') {
    if (name.startsWith('ppt/slides/')) return 1_000_000
    if (name.startsWith('ppt/media/')) return 2_000_000
  }
  return MAX_OFFICE_ARCHIVE_MEMBER_BYTES
}

function memberName(raw: string): string {
  const name = posix.normalize(raw.replaceAll('\\', '/')).replace(/(.)\/+$/, '$1')
  if (raw.startsWith('/') || raw.startsWith('\\') || name === '.' || name === '..' || name.startsWith('../') || name.startsWith('/')) throw new OfficeError(LIMIT_MESSAGE)
  return name
}

/** Every file member, inflated, in archive order, once the whole archive passed the limits. */
function preflight(format: OfficeFormat, bytes: Buffer): Map<string, Buffer> {
  let entries: ZipEntry[]
  try { entries = readZip(bytes).filter((entry) => !entry.isDir) } catch { throw readError(format) }
  if (entries.length > MAX_OFFICE_ARCHIVE_MEMBERS) throw new OfficeError(LIMIT_MESSAGE)
  const parts = new Map<string, Buffer>()
  let total = 0
  for (const entry of entries) {
    const name = memberName(entry.name)
    total += entry.size
    if (entry.size > memberLimit(format, name) || total > MAX_OFFICE_ARCHIVE_TOTAL_BYTES || entry.size > Math.max(entry.compressedSize, 1) * MAX_OFFICE_COMPRESSION_RATIO) throw new OfficeError(LIMIT_MESSAGE)
    try { parts.set(name, entry.readSync()) } catch { throw readError(format) }
  }
  return parts
}

// ── XML ──────────────────────────────────────────────────────────────────

/** A `preserveOrder` node: one tag key holding its children, `:@` its attributes; text nodes are `{ '#text': string }`. */
type XNode = Record<string, unknown>

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeEntity = (ref: string, name: string): string => {
  if (!name.startsWith('#')) return PREDEFINED[name] ?? ref
  const cp = name[1] === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
  if (!(cp >= 0 && cp <= 0x10ffff)) throw new Error(`invalid character reference ${ref}`)
  return String.fromCodePoint(cp)
}
/** The XML predefined and numeric entities only; DOCTYPE-declared entities are never added. */
const entityDecoder = {
  setExternalEntities: () => undefined, addInputEntities: () => undefined, reset: () => undefined, setXmlVersion: () => undefined,
  decode: (text: string) => text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, decodeEntity),
}
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', parseTagValue: false, parseAttributeValue: false, trimValues: false, entityDecoder })
// oxlint-disable-next-line typescript/no-deprecated -- the builder ships inside fast-xml-parser, the one package TAL-262 adds.
const builder = new XMLBuilder({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '', suppressEmptyNode: true, processEntities: true })

function parseXml(format: OfficeFormat, part: Buffer | undefined): XNode[] {
  if (!part) throw readError(format)
  const xml = part.toString('utf8').replace(/^\uFEFF/, '')
  if (/<!DOCTYPE/i.test(xml)) throw readError(format)
  try { return parser.parse(xml) as XNode[] } catch { throw readError(format) }
}

const tagOf = (node: XNode): string => Object.keys(node).find((key) => key !== ':@') ?? ''
const localName = (name: string): string => name.slice(name.indexOf(':') + 1)
const childrenOf = (node: XNode): XNode[] => (node[tagOf(node)] as XNode[] | undefined) ?? []
const attrsOf = (node: XNode): Record<string, string> => (node[':@'] as Record<string, string> | undefined) ?? {}
const elements = (node: XNode): XNode[] => childrenOf(node).filter((child) => tagOf(child) !== '#text')
/** Child elements by local name, whatever prefix the part binds. */
const named = (node: XNode, local: string): XNode[] => elements(node).filter((child) => localName(tagOf(child)) === local)
const first = (node: XNode | undefined, local: string): XNode | undefined => (node ? named(node, local)[0] : undefined)
const attr = (node: XNode, local: string): string | undefined => Object.entries(attrsOf(node)).find(([key]) => localName(key) === local)?.[1]
const rootOf = (doc: XNode[]): XNode | undefined => doc.find((node) => { const tag = tagOf(node); return tag !== '#text' && !tag.startsWith('?') })
/** The concatenated text of a leaf element such as `w:t`. */
const textOf = (node: XNode): string => childrenOf(node).map((child) => (typeof child['#text'] === 'string' ? child['#text'] : '')).join('')

// ── Preview text ─────────────────────────────────────────────────────────

/** `_PreviewBuilder`: appends pieces until the character budget runs out, then marks itself truncated. */
class PreviewBuilder {
  private readonly parts: string[] = []
  private length = 0
  started = false
  truncated = false
  constructor(private readonly limit = MAX_OFFICE_PREVIEW_CHARS) {}
  get remaining(): number { return Math.max(this.limit - this.length, 0) }
  get hasContent(): boolean { return this.parts.length > 0 }
  get text(): string { return this.parts.join('') }

  private piece(text: string): boolean {
    if (this.truncated) return false
    if (!text) return true
    const remaining = this.remaining
    if (remaining <= 0) { this.truncated = true; return false }
    let piece = text
    if (piece.length > remaining) { piece = piece.slice(0, remaining).trimEnd(); this.truncated = true }
    if (piece) { this.parts.push(piece); this.length += piece.length }
    return !this.truncated
  }

  startLine(): boolean { if (this.started) return this.piece('\n'); this.started = true; return true }
  startSection(): boolean { if (this.started) return this.piece('\n\n'); this.started = true; return true }
  append(text: string): boolean { this.started = true; return this.piece(text) }

  /**
   * A cell, shape or run's text; `verbatim` keeps a `.docx` run's edge whitespace, which is significant at run
   * boundaries, while other values collapse line breaks and trim.
   */
  value(raw: string, verbatim = false): boolean {
    if (this.truncated) return false
    const remaining = this.remaining
    if (remaining <= 0) { this.truncated = true; return false }
    if (!this.append(verbatim ? raw : normalized(raw, remaining))) return false
    if (raw.length > remaining) { this.truncated = true; return false }
    return true
  }

  finish(stripEdges = true): { content: string; truncated: boolean } { return finalized(this.text, this.truncated, stripEdges) }
}

const normalized = (text: string, max = Infinity): string => text.slice(0, max).replaceAll('\r', '\n').replaceAll('\n', ' ').trim()

/** A `.docx` keeps edge blank paragraphs: the editor starts from this text, so trimming would drop them on save. */
function finalized(text: string, truncatedIn: boolean, stripEdges = true): { content: string; truncated: boolean } {
  let content = stripEdges ? text.trim() : text
  let truncated = truncatedIn
  if (content.length > MAX_OFFICE_PREVIEW_CHARS) { content = content.slice(0, MAX_OFFICE_PREVIEW_CHARS).trimEnd(); truncated = true }
  if (truncated) content = content ? `${content}\n\n${TRUNCATED_NOTICE}` : TRUNCATED_NOTICE
  return { content, truncated }
}

// ── .docx ────────────────────────────────────────────────────────────────

/** python-docx's blank-template `w:sectPr` children (rsid attributes ignored): the only section an editable document has. */
const BLANK_SECTION: [string, Record<string, string>][] = [
  ['pgSz', { w: '12240', h: '15840' }],
  ['pgMar', { top: '1440', right: '1800', bottom: '1440', left: '1800', header: '720', footer: '720', gutter: '0' }],
  ['cols', { space: '720' }],
  ['docGrid', { linePitch: '360' }],
]

interface Docx { doc: XNode[]; body: XNode; w: (name: string) => string }

function readDocx(parts: Map<string, Buffer>): Docx {
  const doc = parseXml('docx', parts.get('word/document.xml'))
  const root = rootOf(doc)
  const body = first(root, 'body')
  if (!root || !body) throw readError('docx')
  const prefix = tagOf(body).includes(':') ? tagOf(body).slice(0, tagOf(body).indexOf(':') + 1) : ''
  return { doc, body, w: (name) => `${prefix}${name}` }
}

/** Run text, tabs and line breaks in document order; property elements (`w:pPr` tab stops, `w:rPr`) are not content. */
function* runContent(node: XNode, w: Docx['w']): Generator<string> {
  for (const child of elements(node)) {
    const tag = tagOf(child)
    if (tag === w('t')) yield textOf(child)
    else if (tag === w('tab')) yield '\t'
    else if (tag === w('br') || tag === w('cr')) yield '\n'
    else if (!tag.endsWith('Pr')) yield* runContent(child, w)
  }
}

function docxText(builder: PreviewBuilder, node: XNode, w: Docx['w']): boolean {
  for (const text of runContent(node, w)) if (!builder.value(text, true)) return false
  return true
}

function docxPreviewText({ body, w }: Docx): { content: string; truncated: boolean } {
  const b = new PreviewBuilder()
  let blocks = 0
  let cells = 0
  let tables = 0
  for (const child of elements(body)) {
    const tag = tagOf(child)
    if (tag === w('sectPr')) continue
    if (++blocks > MAX_DOCX_PREVIEW_BLOCKS) { b.truncated = true; break }
    if (tag === w('p')) { if (!b.startLine() || !docxText(b, child, w)) break; continue }
    if (tag !== w('tbl')) continue
    if (!b.startLine() || !b.append(`Table ${String(++tables)}`)) break
    for (const row of elements(child).filter((n) => tagOf(n) === w('tr'))) {
      if (!b.startLine()) break
      let firstCell = true
      for (const cell of elements(row).filter((n) => tagOf(n) === w('tc'))) {
        if (++cells > MAX_DOCX_TABLE_CELLS) { b.truncated = true; break }
        if (!firstCell && !b.append('\t')) break
        let firstParagraph = true
        for (const paragraph of elements(cell).filter((n) => tagOf(n) === w('p'))) {
          if ((!firstParagraph && !b.append('\n')) || !docxText(b, paragraph, w)) break
          firstParagraph = false
        }
        if (b.truncated) break
        firstCell = false
      }
      if (b.truncated) break
    }
    if (b.truncated) break
  }
  return b.finish(false)
}

function sectionIsBlank(section: XNode, w: Docx['w']): boolean {
  const children = elements(section)
  return children.length === BLANK_SECTION.length && children.every((child, i) => {
    const [name, expected] = BLANK_SECTION[i] ?? ['', {}]
    const attrs = Object.entries(attrsOf(child)).filter(([key]) => !key.startsWith('xmlns') && !localName(key).startsWith('rsid'))
    return tagOf(child) === w(name) && !elements(child).length && !textOf(child).trim()
      && attrs.length === Object.keys(expected).length && attrs.every(([key, value]) => key === w(localName(key)) && expected[localName(key)] === value)
  })
}

/** `_docx_editability`: plain `Normal` paragraphs of `w:t` runs and the blank-template section, nothing else. */
function docxBlockedReason({ body, w }: Docx): string | null {
  for (const child of elements(body)) {
    const tag = tagOf(child)
    if (tag !== w('p') && tag !== w('sectPr')) return 'docx contains unsupported structures'
    if (tag === w('sectPr') && !sectionIsBlank(child, w)) return 'docx contains unsupported section content'
  }
  for (const paragraph of elements(body).filter((n) => tagOf(n) === w('p'))) {
    for (const child of elements(paragraph)) {
      const tag = tagOf(child)
      if (tag === w('pPr') && elements(child).every((p) => tagOf(p) === w('pStyle') && attrsOf(p)[w('val')] === 'Normal')) continue
      if (tag !== w('r')) return 'docx contains unsupported paragraph structures'
      if (elements(child).some((r) => tagOf(r) !== w('t'))) return 'docx contains unsupported inline content'
    }
  }
  return null
}

// ── .xlsx ────────────────────────────────────────────────────────────────

/** Part paths a relationships part names by id, resolved against the folder `base` the relationships belong to. */
function relationships(format: OfficeFormat, parts: Map<string, Buffer>, relsPath: string, base: string, type: string): Map<string, string> {
  const out = new Map<string, string>()
  const root = rootOf(parseXml(format, parts.get(relsPath)))
  for (const rel of root ? named(root, 'Relationship') : []) {
    const target = attr(rel, 'Target')
    const id = attr(rel, 'Id')
    if (!target || !id || !(attr(rel, 'Type') ?? '').endsWith(type)) continue
    out.set(id, target.startsWith('/') ? posix.normalize(target.slice(1)) : posix.normalize(posix.join(base, target)))
  }
  return out
}

/** The relationship id attribute (`r:id`) under whatever prefix the part binds. */
const relId = (node: XNode): string | undefined => Object.entries(attrsOf(node)).find(([key]) => key.includes(':') && localName(key) === 'id')?.[1]

/**
 * The part each entry (`sheet`, `sldId`) names through its relationship id, in entry order. Unknown ids and parts an
 * earlier entry already named are skipped, so each part is parsed at most once and parsing stays within the
 * preflight's uncompressed total however many entries repeat a part.
 */
function listedParts(entries: XNode[], targets: Map<string, string>): { entry: XNode; part: string }[] {
  const seen = new Set<string>()
  return entries.flatMap((entry) => {
    const part = targets.get(relId(entry) ?? '')
    if (!part || seen.has(part)) return []
    seen.add(part)
    return [{ entry, part }]
  })
}

/** openpyxl `is_date_format`: the first section, without literals, escapes and `[...]` codes, still names a date or time part. */
export function isDateFormat(code: string): boolean {
  // One pass: a closing quote or bracket is searched for at most once per kind, so an unclosed run cannot go quadratic.
  let quoteClosed = true
  let bracketClosed = true
  for (let i = 0; i < code.length; i += 1) {
    const c = code.charAt(i)
    if (c === ';') return false
    if (c === '\\' || c === '_' || c === '*') { i += 1; continue }
    if (c === '"' && quoteClosed) {
      const end = code.indexOf('"', i + 1)
      if (end >= 0) { i = end; continue }
      quoteClosed = false
    } else if (c === '[' && bracketClosed) {
      const end = code.indexOf(']', i + 1)
      if (end >= 0) {
        if (/^(h+|m+|s+)$/i.test(code.slice(i + 1, end))) return true
        i = end
        continue
      }
      bracketClosed = false
    }
    if ('dmyhsDMYHS'.includes(c)) return true
  }
  return false
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22])

/** An Excel serial as an ISO date, time or date-time; Excel's phantom 1900-02-29 shifts serials below 60 by a day. */
export function excelSerialIso(serial: number, date1904: boolean): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const days = !date1904 && serial < 60 ? serial + 1 : serial
  const date = new Date(base + Math.round(days * 86_400) * 1000)
  if (Number.isNaN(date.getTime())) return null
  const iso = date.toISOString()
  if (serial < 1) return iso.slice(11, 19)
  if (iso.endsWith('T00:00:00.000Z')) return iso.slice(0, 10)
  return iso.slice(0, 19)
}

interface Workbook { sheets: { name: string; part: string }[]; shared: string[]; dateStyles: boolean[]; date1904: boolean }

const richText = (node: XNode): string => [...named(node, 't'), ...named(node, 'r').flatMap((run) => named(run, 't'))].map(textOf).join('')

function readWorkbook(parts: Map<string, Buffer>): Workbook {
  const workbook = rootOf(parseXml('xlsx', parts.get('xl/workbook.xml')))
  if (!workbook) throw readError('xlsx')
  const targets = relationships('xlsx', parts, 'xl/_rels/workbook.xml.rels', 'xl', '/worksheet')
  const sheets = listedParts(named(first(workbook, 'sheets') ?? {}, 'sheet'), targets).map(({ entry, part }) => ({ name: attr(entry, 'name') ?? '', part }))
  const date1904 = ['1', 'true'].includes(attr(first(workbook, 'workbookPr') ?? {}, 'date1904') ?? '')
  const sst = parts.has('xl/sharedStrings.xml') ? rootOf(parseXml('xlsx', parts.get('xl/sharedStrings.xml'))) : undefined
  // Rich-text runs concatenate; phonetic guides (`rPh`) are not part of the value.
  const shared = sst ? named(sst, 'si').map((si) => [...elements(si)].filter((n) => ['t', 'r'].includes(localName(tagOf(n)))).map((n) => (localName(tagOf(n)) === 't' ? textOf(n) : named(n, 't').map(textOf).join(''))).join('')) : []
  const styles = parts.has('xl/styles.xml') ? rootOf(parseXml('xlsx', parts.get('xl/styles.xml'))) : undefined
  // Each custom format is classified once, however many cell styles share it.
  const customDates = new Map(named(first(styles, 'numFmts') ?? {}, 'numFmt').map((fmt) => [Number(attr(fmt, 'numFmtId')), isDateFormat(attr(fmt, 'formatCode') ?? '')]))
  const dateStyles = named(first(styles, 'cellXfs') ?? {}, 'xf').map((xf) => {
    const id = Number(attr(xf, 'numFmtId') ?? 0)
    return customDates.get(id) ?? BUILTIN_DATE_FORMATS.has(id)
  })
  return { sheets, shared, dateStyles, date1904 }
}

function columnOf(ref: string | undefined, fallback: number): number {
  const letters = /^[A-Z]+/i.exec(ref ?? '')?.[0]
  if (!letters) return fallback
  let column = 0
  for (let i = 0; i < letters.length; i += 1) column = column * 26 + letters.toUpperCase().charCodeAt(i) - 64
  return column
}

function cellValue(cell: XNode, book: Workbook): string {
  const type = attr(cell, 't') ?? 'n'
  const v = textOf(first(cell, 'v') ?? {})
  if (type === 'inlineStr') return richText(first(cell, 'is') ?? {})
  if (type === 's') return book.shared[Number(v)] ?? ''
  if (type === 'b') return v === '1' || v === 'true' ? 'TRUE' : 'FALSE'
  if (type !== 'n' || v.trim() === '') return v
  const number = Number(v)
  if (Number.isNaN(number)) return v
  if (book.dateStyles[Number(attr(cell, 's') ?? 0)]) return excelSerialIso(number, book.date1904) ?? String(number)
  return String(number)
}

function xlsxPreviewText(parts: Map<string, Buffer>): { content: string; truncated: boolean } {
  const book = readWorkbook(parts)
  const b = new PreviewBuilder()
  for (const [index, sheet] of book.sheets.entries()) {
    if (index >= MAX_XLSX_PREVIEW_SHEETS) { b.truncated = true; break }
    if (!b.startSection() || !b.append(`Sheet: ${sheet.name}`)) break
    const data = first(rootOf(parseXml('xlsx', parts.get(sheet.part))), 'sheetData')
    let rowIndex = 0
    let cells = 0
    for (const row of data ? named(data, 'row') : []) {
      rowIndex = Number(attr(row, 'r') ?? rowIndex + 1) || rowIndex + 1
      if (rowIndex > MAX_XLSX_PREVIEW_ROWS_PER_SHEET) { b.truncated = true; break }
      const line = new PreviewBuilder(b.remaining - (b.started ? 1 : 0))
      // Every column up to a cell counts against the budget as it is reached, so a far-off reference (`AAAAAAA1`)
      // truncates instead of padding; each cell after the first keeps its tab, so values stay under their columns.
      let position = 0
      let hasValue = false
      const emit = (value: string): boolean => {
        if (++cells > MAX_XLSX_PREVIEW_CELLS_PER_SHEET) { b.truncated = true; return false }
        if (position++ > 0 && !line.append('\t')) return false
        if (!line.value(value)) { if (!line.truncated) b.truncated = true; return false }
        hasValue ||= value.trim() !== ''
        return true
      }
      cellsInRow: for (const cell of named(row, 'c')) {
        const column = Math.max(columnOf(attr(cell, 'r'), position + 1), position + 1)
        while (position < column - 1) if (!emit('')) break cellsInRow
        if (!emit(cellValue(cell, book))) break
      }
      // The cells that fit stay, even when the row ran out of budget.
      const stopped = b.truncated
      b.truncated = false
      if (hasValue && (!b.startLine() || !b.append(line.text.trimEnd()))) break
      if (stopped || line.truncated) { b.truncated = true; break }
    }
    if (b.truncated) break
  }
  return b.hasContent ? b.finish() : finalized('Empty workbook', b.truncated)
}

// ── .pptx ────────────────────────────────────────────────────────────────

/** python-pptx `shape.text`: paragraphs joined by line breaks, each the text of its runs, fields and breaks. */
function shapeText(shape: XNode): string {
  const body = first(shape, 'txBody')
  if (localName(tagOf(shape)) !== 'sp' || !body) return ''
  return named(body, 'p').map((p) => elements(p).map((n) => {
    const tag = localName(tagOf(n))
    return tag === 'br' ? '\n' : tag === 'r' || tag === 'fld' ? textOf(first(n, 't') ?? {}) : ''
  }).join('')).join('\n')
}

const NOT_SHAPES = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst'])

function pptxPreviewText(parts: Map<string, Buffer>): { content: string; truncated: boolean } {
  const presentation = rootOf(parseXml('pptx', parts.get('ppt/presentation.xml')))
  if (!presentation) throw readError('pptx')
  const targets = relationships('pptx', parts, 'ppt/_rels/presentation.xml.rels', 'ppt', '/slide')
  const slides = listedParts(named(first(presentation, 'sldIdLst') ?? {}, 'sldId'), targets).map(({ part }) => part)
  const b = new PreviewBuilder()
  for (const [index, part] of slides.entries()) {
    if (index >= MAX_PPTX_PREVIEW_SLIDES) { b.truncated = true; break }
    if (!b.startSection() || !b.append(`Slide ${String(index + 1)}`)) break
    const tree = first(first(rootOf(parseXml('pptx', parts.get(part))), 'cSld'), 'spTree')
    const shapes = tree ? elements(tree).filter((n) => !NOT_SHAPES.has(localName(tagOf(n)))) : []
    let hasText = false
    for (const [i, shape] of shapes.entries()) {
      if (i >= MAX_PPTX_PREVIEW_SHAPES_PER_SLIDE) { b.truncated = true; break }
      const text = shapeText(shape)
      if (!normalized(text)) continue
      if (!b.startLine() || !b.value(text)) break
      hasText = true
    }
    if (b.truncated) break
    if (!hasText && (!b.startLine() || !b.append('(empty slide)'))) break
  }
  return b.hasContent ? b.finish() : finalized('Empty presentation', b.truncated)
}

// ── Entry points ─────────────────────────────────────────────────────────

function preview(format: OfficeFormat, bytes: Buffer): Omit<OfficePreview, 'path'> {
  const parts = preflight(format, bytes)
  let text: { content: string; truncated: boolean }
  let reason: string | null
  if (format === 'docx') {
    const docx = readDocx(parts)
    text = docxPreviewText(docx)
    reason = text.truncated ? 'docx preview exceeds safe limits' : docxBlockedReason(docx)
  } else {
    text = format === 'xlsx' ? xlsxPreviewText(parts) : pptxPreviewText(parts)
    reason = `${format} preview is read-only`
  }
  const out: Omit<OfficePreview, 'path'> = { size: bytes.length, content: text.content, lines: text.content.split('\n').length, office_format: format, editable: reason === null }
  if (reason !== null) out.edit_blocked_reason = reason
  if (text.truncated) out.truncated = true
  return out
}

/** The text preview of an Office file at `path`; throws `OfficeError` for anything the preflight or parser refuses. */
export function previewOffice(path: string, bytes: Buffer): OfficePreview {
  const format = officeFormat(path)
  if (!format) throw new OfficeError(`Unsupported Office format: ${path}`)
  return { path, ...preview(format, bytes) }
}

/** Characters XML 1.0 cannot carry: C0 controls other than tab and line breaks, U+FFFE, U+FFFF and lone surrogates. */
const NOT_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/**
 * `.docx` `bytes` with its body replaced by `content`, one plain paragraph per line, before the section properties;
 * every other part is copied unchanged. Refuses a document that is not editable, content past the preview limits, and a
 * result that would no longer be editable.
 */
export async function saveDocx(bytes: Buffer, content: string): Promise<{ bytes: Buffer; preview: Omit<OfficePreview, 'path'> }> {
  const current = preview('docx', bytes)
  if (!current.editable) throw new OfficeError(current.edit_blocked_reason ?? 'DOCX document is not editable')
  const text = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  if (text.length > MAX_OFFICE_PREVIEW_CHARS) throw new OfficeError('DOCX content exceeds the editable size limit')
  const lines = text.split('\n')
  if (lines.length > MAX_DOCX_PREVIEW_BLOCKS) throw new OfficeError('DOCX content exceeds the editable paragraph limit')
  if (NOT_XML_CHARS.test(text)) throw new OfficeError('DOCX content contains characters a Word document cannot store')
  const parts = preflight('docx', bytes)
  const docx = readDocx(parts)
  const { w } = docx
  const sections = elements(docx.body).filter((n) => tagOf(n) === w('sectPr'))
  const paragraphs = lines.map((line): XNode => ({ [w('p')]: line ? [{ [w('r')]: [{ [w('t')]: [{ '#text': line }], ':@': { 'xml:space': 'preserve' } }] }] : [] }))
  docx.body[tagOf(docx.body)] = [...paragraphs, ...sections]
  parts.set('word/document.xml', Buffer.from(builder.build(docx.doc), 'utf8'))
  const saved = await zipBuffer(parts)
  const result = preview('docx', saved)
  if (!result.editable) throw new OfficeError(result.edit_blocked_reason ?? 'Saved DOCX is not editable')
  return { bytes: saved, preview: result }
}

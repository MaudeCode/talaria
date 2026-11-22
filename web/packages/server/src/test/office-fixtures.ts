/**
 * Synthetic Office packages for tests (TAL-262): each part is an inline XML string zipped in memory, so no binary
 * fixture is committed. Each builder emits only the parts its format's preview reads, plus the `.docx` parts a save must
 * carry over byte for byte.
 */
import { zipBuffer } from '../workspace/zip.js'

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

export const xmlEscape = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/** python-docx's blank-template section, the only one an editable `.docx` carries. */
export const BLANK_SECTION = '<w:sectPr w:rsidR="00FC693F" w:rsidSect="00034616"><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:header="720" w:footer="720" w:gutter="0"/><w:cols w:space="720"/><w:docGrid w:linePitch="360"/></w:sectPr>'
export const DOCX_STYLES = `${DECL}<w:styles ${W}><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`
export const DOCX_CORE = `${DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Quarterly plan</dc:title><dc:creator>Fixture author</dc:creator></cp:coreProperties>`

/** One plain paragraph per line (`<w:p/>` for an empty line), then the blank section: an editable body. */
export const plainParagraphs = (...lines: string[]): string => `${lines.map((line) => (line ? `<w:p><w:r><w:t xml:space="preserve">${xmlEscape(line)}</w:t></w:r></w:p>` : '<w:p/>')).join('')}${BLANK_SECTION}`

/** A `.docx` whose `w:body` holds `body` verbatim; `extra` adds members after the document's own. */
export function docxPackage(body: string, extra: [string, Buffer][] = []): Promise<Buffer> {
  return zipBuffer([
    ['[Content_Types].xml', Buffer.from(`${DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`)],
    ['word/document.xml', Buffer.from(`${DECL}<w:document ${W}><w:body>${body}</w:body></w:document>`)],
    ['word/styles.xml', Buffer.from(DOCX_STYLES)],
    ['docProps/core.xml', Buffer.from(DOCX_CORE)],
    ...extra,
  ])
}

export const docx = (...lines: string[]): Promise<Buffer> => docxPackage(plainParagraphs(...lines))

/** `<c>` cells by reference: a string is a shared-string index, `{ v, t?, s? }` a raw value with its type and style. */
export type XlsxCell = string | { v: string; t?: string; s?: number }

/**
 * A `.xlsx` of `sheets`, each a name and rows of cells keyed by reference (`A1`). Styles: 0 General, 1 built-in date
 * (`numFmtId` 14), 2 custom `yyyy-mm-dd`.
 */
export function xlsx(sheets: { name: string; rows: Record<string, XlsxCell>[] }[], shared: string[] = []): Promise<Buffer> {
  const sheetXml = (rows: Record<string, XlsxCell>[]) => `${DECL}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.map((cells, i) => `<row r="${String(i + 1)}">${Object.entries(cells).map(([ref, cell]) => {
    const { v, t, s } = typeof cell === 'string' ? { v: cell, t: 's', s: undefined } : cell
    return `<c r="${ref}"${t ? ` t="${t}"` : ''}${s === undefined ? '' : ` s="${String(s)}"`}><v>${xmlEscape(v)}</v></c>`
  }).join('')}</row>`).join('')}</sheetData></worksheet>`
  return zipBuffer([
    ['xl/workbook.xml', Buffer.from(`${DECL}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ${R}><sheets>${sheets.map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${String(i + 1)}" r:id="rId${String(i + 1)}"/>`).join('')}</sheets></workbook>`)],
    ['xl/_rels/workbook.xml.rels', Buffer.from(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${String(i + 1)}" Type="${REL}/worksheet" Target="worksheets/sheet${String(i + 1)}.xml"/>`).join('')}</Relationships>`)],
    ['xl/sharedStrings.xml', Buffer.from(`${DECL}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${shared.map((text) => `<si><t>${xmlEscape(text)}</t></si>`).join('')}</sst>`)],
    ['xl/styles.xml', Buffer.from(`${DECL}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>`)],
    ...sheets.map((sheet, i): [string, Buffer] => [`xl/worksheets/sheet${String(i + 1)}.xml`, Buffer.from(sheetXml(sheet.rows))]),
  ])
}

/**
 * A `.pptx` whose slides, in presentation order, hold one text shape per string. The slide parts are numbered in
 * reverse, so a preview that followed part names instead of `p:sldIdLst` shows them backwards.
 */
export function pptx(slides: string[][]): Promise<Buffer> {
  const part = (i: number) => `slide${String(slides.length - i)}.xml`
  const slideXml = (texts: string[]) => `${DECL}<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${texts.map((text) => `<p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(text)}</a:t></a:r></a:p></p:txBody></p:sp>`).join('')}</p:spTree></p:cSld></p:sld>`
  return zipBuffer([
    ['ppt/presentation.xml', Buffer.from(`${DECL}<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${R}><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${String(256 + i)}" r:id="rId${String(i + 1)}"/>`).join('')}</p:sldIdLst></p:presentation>`)],
    ['ppt/_rels/presentation.xml.rels', Buffer.from(`${DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${slides.map((_, i) => `<Relationship Id="rId${String(i + 1)}" Type="${REL}/slide" Target="slides/${part(i)}"/>`).join('')}</Relationships>`)],
    ...slides.map((texts, i): [string, Buffer] => [`ppt/slides/${part(i)}`, Buffer.from(slideXml(texts))]),
  ])
}

/** TAL-262: Office previews, the archive preflight, and the `.docx` save round trip. */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { BLANK_SECTION, DOCX_CORE, DOCX_STYLES, docx, docxPackage, plainParagraphs, pptx, xlsx } from '../test/office-fixtures.js'
import { excelSerialIso, isDateFormat, OfficeError, previewOffice, saveDocx } from './office.js'
import { readZip } from './unzip.js'
import { zipBuffer } from './zip.js'

const LIMIT = 'Office preview exceeds safe archive limits'
const UNREADABLE = 'Unable to read DOCX preview'

/** The archive with one 32-bit field of its first central-directory entry overwritten. */
function patchCentral(zip: Buffer, field: number, value: number): Buffer {
  const out = Buffer.from(zip)
  out.writeUInt32LE(value, out.readUInt32LE(out.length - 22 + 16) + field)
  return out
}

const parts = async (bytes: Buffer): Promise<Map<string, Buffer>> => new Map(await Promise.all(readZip(bytes).map(async (e): Promise<[string, Buffer]> => [e.name, await e.read()])))
/** Text that deflates about 2:1, so a size limit trips before the ratio limit. */
const incompressible = (bytes: number) => Buffer.from(randomBytes(Math.ceil(bytes / 2)).toString('hex').slice(0, bytes))

describe('office preflight', () => {
  it('refuses hostile and corrupt archives with an OfficeError before parsing', async () => {
    const valid = await docx('ok')
    expect(previewOffice('a.docx', valid).content).toBe('ok')
    const cases: [string, Buffer | Promise<Buffer>, string][] = [
      ['257 members', docxPackage(plainParagraphs('x'), Array.from({ length: 253 }, (_, i): [string, Buffer] => [`m/${String(i)}.xml`, Buffer.from('x')])), LIMIT],
      ['over 8,000,000 bytes in total', docxPackage(plainParagraphs('x'), [0, 1, 2].map((i): [string, Buffer] => [`big/${String(i)}.bin`, incompressible(2_700_000)])), LIMIT],
      ['a member over its part limit', docxPackage(plainParagraphs('x'), [['media/big.bin', incompressible(4_000_001)]]), LIMIT],
      ['a ratio over 200', docxPackage(plainParagraphs('x'), [['zeros.bin', Buffer.alloc(300_000)]]), LIMIT],
      ['a ../ member name', docxPackage(plainParagraphs('x'), [['../evil.xml', Buffer.from('x')]]), LIMIT],
      ['an absolute member name', docxPackage(plainParagraphs('x'), [['/evil.xml', Buffer.from('x')]]), LIMIT],
      ['a member that claims size 0', patchCentral(valid, 24, 0), UNREADABLE],
      ['a CRC mismatch', patchCentral(valid, 16, 0xdeadbeef), UNREADABLE],
      ['a ZIP64 offset', (() => { const z = Buffer.from(valid); z.writeUInt32LE(0xffffffff, z.length - 22 + 16); return z })(), UNREADABLE],
      ['non-zip bytes', Buffer.from('not a zip archive at all'), UNREADABLE],
    ]
    for (const [label, pending, message] of cases) {
      const bytes = await pending
      let error: unknown
      try { previewOffice('a.docx', bytes) } catch (caught) { error = caught }
      expect(error, label).toBeInstanceOf(OfficeError)
      expect((error as Error).message, label).toBe(message)
    }
  })
})

describe('docx preview', () => {
  it('previews paragraphs and tables; only plain paragraphs are editable', async () => {
    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b1</w:t></w:r></w:p><w:p><w:r><w:t>b1 second</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    const withTable = previewOffice('t.docx', await docxPackage(`<w:p><w:r><w:t>Intro</w:t></w:r></w:p>${table}${BLANK_SECTION}`))
    expect(withTable).toMatchObject({ office_format: 'docx', content: 'Intro\nTable 1\na1\tb1\nb1 second', editable: false, edit_blocked_reason: 'docx contains unsupported structures' })
    expect(previewOffice('p.docx', await docx('First', 'Second &amp; <third>'))).toMatchObject({ content: 'First\nSecond &amp; <third>', lines: 2, editable: true })
    const drawing = previewOffice('d.docx', await docxPackage(`<w:p><w:r><w:t>Logo</w:t><w:drawing/></w:r></w:p>${BLANK_SECTION}`))
    expect(drawing).toMatchObject({ content: 'Logo', editable: false, edit_blocked_reason: 'docx contains unsupported inline content' })
  })

  it('keeps run tabs and line breaks, not paragraph tab stops', async () => {
    const body = '<w:p><w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>First</w:t><w:br/><w:t>Second</w:t><w:tab/><w:t>X</w:t><w:cr/><w:t>Y</w:t></w:r></w:p>'
    expect(previewOffice('t.docx', await docxPackage(`${body}${BLANK_SECTION}`))).toMatchObject({ content: 'First\nSecond\tX\nY', editable: false })
  })

  it('truncates past 120,000 characters and is then read-only', async () => {
    const long = previewOffice('l.docx', await docx(incompressible(70_000).toString(), incompressible(70_000).toString()))
    expect(long).toMatchObject({ truncated: true, editable: false, edit_blocked_reason: 'docx preview exceeds safe limits' })
    expect(long.content.endsWith('[Preview truncated: Office content exceeds safe limits]')).toBe(true)
  })
})

describe('xlsx preview', () => {
  it('shows shared strings, booleans, numbers and date-styled serials as ISO dates', async () => {
    const book = await xlsx([{ name: 'Budget', rows: [
      { A1: '0', B1: { v: '1', t: 'b' }, C1: { v: '42.5' } },
      { A2: { v: '45306', s: 1 }, B2: { v: '45307', s: 2 }, C2: { v: '45306' }, D2: { v: '0.5', s: 3 } },
    ] }], ['Rent'])
    expect(previewOffice('b.xlsx', book)).toEqual({ path: 'b.xlsx', size: book.length, office_format: 'xlsx', content: 'Sheet: Budget\nRent\tTRUE\t42.5\n2024-01-15\t2024-01-16\t45306\t12:00:00', lines: 3, editable: false, edit_blocked_reason: 'xlsx preview is read-only' })
  })

  it('keeps the tab of each empty cell before a value, so values stay under their columns', async () => {
    const book = await xlsx([{ name: 'S', rows: [{ A1: '0', B1: '1' }, { B2: { v: '10' } }, { A3: { v: '' }, C3: { v: '7' } }] }], ['Name', 'Value'])
    expect(previewOffice('s.xlsx', book).content).toBe('Sheet: S\nName\tValue\n\t10\n\t\t7')
  })

  it('counts a far-off column reference against the cell budget instead of padding up to it', async () => {
    const book = await xlsx([{ name: 'Far', rows: [{ A1: { v: 'kept' }, AAAAAAA1: { v: 'far' } }] }])
    const preview = previewOffice('f.xlsx', book)
    expect(preview.truncated).toBe(true)
    expect(preview.content.startsWith('Sheet: Far\nkept')).toBe(true)
    expect(preview.content).not.toContain('far')
  })

  it('names date and time formats by their first section, ignoring literals, escapes and bracket codes', () => {
    const cases: [string, boolean][] = [
      ['yyyy\\-mm\\-dd', true], ['[h]:mm:ss', true], ['[$-409]mmmm d', true], ['General', false], ['0.00;[Red]-0.00', false],
      ['"days" 0', false], ['\\d0', false], ['_d0', false], ['*d0', false], ['[Red]0', false], ['0;dd', false],
      // An unclosed bracket or quote is a literal, not the start of a code that hides what follows.
      [`${'['.repeat(80_000)}0`, false], [`${'['.repeat(80_000)}d`, true], ['"unclosed d', true],
    ]
    for (const [code, date] of cases) expect(isDateFormat(code), code.slice(0, 20)).toBe(date)
  })

  it('shows serials below 1 as times, midnight included, in both date systems', () => {
    expect(excelSerialIso(0, false)).toBe('00:00:00')
    expect(excelSerialIso(0, true)).toBe('00:00:00')
    expect(excelSerialIso(0.5, false)).toBe('12:00:00')
    expect(excelSerialIso(45306, false)).toBe('2024-01-15')
    expect(excelSerialIso(45306.75, false)).toBe('2024-01-15T18:00:00')
  })

  it('stops at 20 sheets and 500 rows per sheet', async () => {
    const manySheets = previewOffice('s.xlsx', await xlsx(Array.from({ length: 21 }, (_, i) => ({ name: `S${String(i + 1)}`, rows: [{ A1: { v: String(i + 1) } }] }))))
    expect(manySheets.truncated).toBe(true)
    expect(manySheets.content).toContain('Sheet: S20\n20')
    expect(manySheets.content).not.toContain('Sheet: S21')
    const manyRows = previewOffice('r.xlsx', await xlsx([{ name: 'Rows', rows: Array.from({ length: 501 }, (_, i) => ({ A1: { v: String(i + 1) } })) }]))
    expect(manyRows.truncated).toBe(true)
    expect(manyRows.content).toContain('\n500\n')
    expect(manyRows.content).not.toContain('\n501')
  })
})

describe('pptx preview', () => {
  it('shows slide text in presentation order and stops at 100 slides', async () => {
    expect(previewOffice('d.pptx', await pptx([['Welcome', 'Agenda'], [], ['Thanks']]))).toMatchObject({ content: 'Slide 1\nWelcome\nAgenda\n\nSlide 2\n(empty slide)\n\nSlide 3\nThanks', editable: false, edit_blocked_reason: 'pptx preview is read-only' })
    const many = previewOffice('m.pptx', await pptx(Array.from({ length: 101 }, (_, i) => [`Text ${String(i + 1)}`])))
    expect(many.truncated).toBe(true)
    expect(many.content).toContain('Slide 100\nText 100')
    expect(many.content).not.toContain('Slide 101')
  })
})

describe('repeated part references', () => {
  /** The package with each listed part's text replaced (`[from, to]` pairs). */
  async function rewritten(bytes: Buffer, edits: Record<string, [string, string]>): Promise<Buffer> {
    const out = await parts(bytes)
    for (const [name, [from, to]] of Object.entries(edits)) out.set(name, Buffer.from((out.get(name)?.toString() ?? '').replace(from, to)))
    return zipBuffer(out)
  }

  it('parses a slide or worksheet part once however many entries name it', async () => {
    const rel = (id: string, target: string, type: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
    const deck = await rewritten(await pptx([['Hello']]), {
      'ppt/presentation.xml': ['<p:sldId id="256" r:id="rId1"/>', '<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId3"/>'],
      'ppt/_rels/presentation.xml.rels': ['</Relationships>', `${rel('rId2', 'slides/slide1.xml', 'slide')}${rel('rId3', '/ppt/slides/slide1.xml', 'slide')}</Relationships>`],
    })
    expect(previewOffice('d.pptx', deck).content).toBe('Slide 1\nHello')
    const book = await rewritten(await xlsx([{ name: 'S', rows: [{ A1: { v: '1' } }] }]), {
      'xl/workbook.xml': ['</sheets>', '<sheet name="Again" sheetId="2" r:id="rId2"/></sheets>'],
      'xl/_rels/workbook.xml.rels': ['</Relationships>', `${rel('rId2', 'worksheets/sheet1.xml', 'worksheet')}</Relationships>`],
    })
    expect(previewOffice('b.xlsx', book).content).toBe('Sheet: S\n1')
  })
})

describe('saveDocx', () => {
  it('round-trips an unedited preview and keeps every other part byte for byte', async () => {
    const original = await docx('', 'Title', '', 'Body\ttext  ', '')
    const before = previewOffice('a.docx', original)
    expect(before.content).toBe('\nTitle\n\nBody\ttext  \n')
    const saved = await saveDocx(original, before.content)
    expect(saved.preview).toMatchObject({ content: before.content, editable: true })
    const out = await parts(saved.bytes)
    expect(out.get('word/styles.xml')?.toString()).toBe(DOCX_STYLES)
    expect(out.get('docProps/core.xml')?.toString()).toBe(DOCX_CORE)
  })

  it('saves edited text as single-run paragraphs before the section', async () => {
    const split = await docxPackage(`<w:p><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p>${BLANK_SECTION}`)
    expect(previewOffice('s.docx', split).content).toBe('Hello world')
    const saved = await saveDocx(split, 'Hello world\r\nSecond & <line>')
    const xml = (await parts(saved.bytes)).get('word/document.xml')?.toString() ?? ''
    expect(xml).toContain('<w:body><w:p><w:r><w:t xml:space="preserve">Hello world</w:t></w:r></w:p><w:p><w:r><w:t xml:space="preserve">Second &amp; &lt;line&gt;</w:t></w:r></w:p><w:sectPr')
    expect(saved.preview.content).toBe('Hello world\nSecond & <line>')
  })

  it('refuses oversized content, unstorable characters and documents that are not editable', async () => {
    const doc = await docx('x')
    await expect(saveDocx(doc, 'x'.repeat(120_001))).rejects.toThrow('DOCX content exceeds the editable size limit')
    await expect(saveDocx(doc, '\n'.repeat(2_000))).rejects.toThrow('DOCX content exceeds the editable paragraph limit')
    await expect(saveDocx(doc, 'bell\u0007')).rejects.toThrow(OfficeError)
    await expect(saveDocx(await docxPackage(`<w:tbl/>${BLANK_SECTION}`), 'x')).rejects.toThrow('docx contains unsupported structures')
  })
})

describe('readZip', () => {
  it('reports compressed sizes and refuses ZIP64 archives', async () => {
    const zip = await zipBuffer([['zeros.bin', Buffer.alloc(10_000)]])
    const [entry] = readZip(zip)
    expect(entry?.size).toBe(10_000)
    expect(entry?.compressedSize).toBeGreaterThan(0)
    expect(entry?.compressedSize).toBeLessThan(200)
    expect(() => readZip(patchCentral(zip, 20, 0xffffffff))).toThrow('ZIP64 archives are not supported')
  })
})

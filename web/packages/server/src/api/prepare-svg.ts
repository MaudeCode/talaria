import { XMLParser, XMLValidator } from 'fast-xml-parser'

const svgNamespace = 'http://www.w3.org/2000/svg'
const xml = new XMLParser({ ignoreAttributes: false, preserveOrder: true, processEntities: false, ignorePiTags: true, trimValues: false })

/** One SVG image document. The App displays it in image mode, which disables script, navigation and external loads. */
export function prepareSvg(source: string): string | null {
  // oxlint-disable-next-line typescript/no-deprecated -- Use the validator shipped by the existing XML dependency.
  if (/<!DOCTYPE\b/i.test(source) || XMLValidator.validate(source) !== true) return null
  const xmlText = source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g, '')
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);)/.test(xmlText)) return null

  let roots: Record<string, unknown>[]
  try {
    roots = xml.parse(source) as Record<string, unknown>[]
  } catch {
    return null
  }
  if (roots.length !== 1) return null
  const root = roots[0]!
  const attributes = root[':@'] as Record<string, string> | undefined
  const name = Object.keys(root).find((key) => key !== ':@')
  if (name !== 'svg') {
    const prefix = /^([^:]+):svg$/.exec(name ?? '')?.[1]
    return prefix !== undefined && attributes?.['@_xmlns:' + prefix] === svgNamespace ? source : null
  }
  const namespace = attributes?.['@_xmlns']
  if (namespace !== undefined) return namespace === svgNamespace ? source : null
  const rootStart = /^(?:\uFEFF|[ \t\r\n]|<\?[\s\S]*?\?>|<!--[\s\S]*?-->)*<svg(?=[ \t\r\n/>])/.exec(source)?.[0]
  return rootStart === undefined ? null : rootStart + ' xmlns="' + svgNamespace + '"' + source.slice(rootStart.length)
}

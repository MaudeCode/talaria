/**
 * A small CommonMark-ish renderer for the HTML export (headings, paragraphs,
 * fenced code, inline code, emphasis, links, images, lists, blockquotes,
 * tables, rules). Output is escaped; raw HTML in the source is never emitted.
 */

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

function safeUrl(url: string): string {
  const trimmed = url.trim()
  if (/^(?:https?:|mailto:|data:image\/)/i.test(trimmed) || trimmed.startsWith('#') || trimmed.startsWith('/')) return escapeHtml(trimmed)
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return ''
  return escapeHtml(trimmed)
}

export function renderInline(text: string): string {
  let out = ''
  let rest = text
  const push = (s: string): void => { out += s }
  while (rest.length) {
    const code = /^`+/.exec(rest)
    if (code) {
      const fence = code[0]
      const end = rest.indexOf(fence, fence.length)
      if (end > 0) {
        push(`<code>${escapeHtml(rest.slice(fence.length, end).trim())}</code>`)
        rest = rest.slice(end + fence.length)
        continue
      }
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (image) {
      const src = safeUrl(image[2] ?? '')
      push(src ? `<img src="${src}" alt="${escapeHtml(image[1] ?? '')}">` : escapeHtml(image[0]))
      rest = rest.slice(image[0].length)
      continue
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      const href = safeUrl(link[2] ?? '')
      push(href ? `<a href="${href}">${renderInline(link[1] ?? '')}</a>` : renderInline(link[1] ?? ''))
      rest = rest.slice(link[0].length)
      continue
    }
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest)
    if (strong) {
      push(`<strong>${renderInline(strong[2] ?? '')}</strong>`)
      rest = rest.slice(strong[0].length)
      continue
    }
    const em = /^(\*|_)(?=\S)([^*_]*?\S)\1/.exec(rest)
    if (em) {
      push(`<em>${renderInline(em[2] ?? '')}</em>`)
      rest = rest.slice(em[0].length)
      continue
    }
    const strike = /^~~(?=\S)([\s\S]*?\S)~~/.exec(rest)
    if (strike) {
      push(`<s>${renderInline(strike[1] ?? '')}</s>`)
      rest = rest.slice(strike[0].length)
      continue
    }
    const auto = /^(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/.exec(rest)
    if (auto) {
      push(`<a href="${escapeHtml(auto[1] ?? '')}">${escapeHtml(auto[1] ?? '')}</a>`)
      rest = rest.slice(auto[0].length)
      continue
    }
    const plain = /^[^`!\[*_~h]+|^./.exec(rest)
    const chunk = plain?.[0] ?? rest[0] ?? ''
    push(escapeHtml(chunk))
    rest = rest.slice(chunk.length)
  }
  return out
}

interface ListItem { text: string; children: string[] }

export function renderMarkdown(text: string): string {
  if (!text) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out: string[] = []
  let i = 0
  const paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join('\n'))}</p>`)
      paragraph.length = 0
    }
  }
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const fence = /^\s{0,3}(```+|~~~+)\s*([^\s`]*)/.exec(line)
    if (fence) {
      flushParagraph()
      const marker = fence[1] ?? '```'
      const lang = fence[2] ?? ''
      const body: string[] = []
      i += 1
      while (i < lines.length && !(lines[i] ?? '').trim().startsWith(marker.slice(0, 3))) {
        body.push(lines[i] ?? '')
        i += 1
      }
      i += 1
      const cls = /^[A-Za-z0-9_+-]+$/.test(lang) ? ` class="language-${escapeHtml(lang)}"` : ''
      out.push(`<pre><code${cls}>${escapeHtml(body.join('\n'))}\n</code></pre>`)
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = (heading[1] ?? '#').length
      out.push(`<h${String(level)}>${renderInline(heading[2] ?? '')}</h${String(level)}>`)
      i += 1
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph()
      out.push('<hr>')
      i += 1
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      flushParagraph()
      const quote: string[] = []
      while (i < lines.length && /^\s{0,3}>/.test(lines[i] ?? '')) {
        quote.push((lines[i] ?? '').replace(/^\s{0,3}>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`)
      continue
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? '')) {
      flushParagraph()
      const cells = (row: string): string[] => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const header = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? ''))
        i += 1
      }
      out.push(`<table><thead><tr>${header.map((h) => `<th>${renderInline(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${renderInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`)
      continue
    }
    const listMatch = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (listMatch) {
      flushParagraph()
      const ordered = /\d/.test(listMatch[2] ?? '')
      const items: ListItem[] = []
      const baseIndent = (listMatch[1] ?? '').length
      while (i < lines.length) {
        const cur = lines[i] ?? ''
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(cur)
        if (m && (m[1] ?? '').length === baseIndent && /\d/.test(m[2] ?? '') === ordered) {
          items.push({ text: m[3] ?? '', children: [] })
          i += 1
          continue
        }
        if (cur.trim() === '' && (lines[i + 1] ?? '').startsWith(' '.repeat(baseIndent + 2))) { i += 1; continue }
        if (cur.startsWith(' '.repeat(baseIndent + 2)) && items.length) {
          items[items.length - 1]?.children.push(cur.slice(baseIndent + 2))
          i += 1
          continue
        }
        break
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((it) => `<li>${renderInline(it.text)}${it.children.length ? renderMarkdown(it.children.join('\n')) : ''}</li>`).join('')}</${tag}>`)
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      i += 1
      continue
    }
    paragraph.push(line)
    i += 1
  }
  flushParagraph()
  return out.join('\n')
}

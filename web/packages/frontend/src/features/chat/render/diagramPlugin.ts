import type { DiagramPlugin } from 'streamdown'
import type { TokenName } from '@maudecode/talaria-web-contracts'
import { renderAsync, type MathResolver } from 'pele/lazy'

async function loadMath(): Promise<MathResolver> {
  const [{ default: katex }] = await Promise.all([import('katex'), import('katex/dist/katex.min.css')])
  return (tex, size) => {
    const probe = document.createElement('span')
    probe.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;display:inline-block;white-space:nowrap'
    probe.style.fontSize = `${size}px`
    katex.render(tex, probe, { displayMode: true, output: 'mathml', trust: false, throwOnError: false })
    document.body.append(probe)
    try {
      const expression = probe.querySelector('math')
      if (!expression) return
      const { width, height } = expression.getBoundingClientRect()
      // MathML avoids Safari's incorrect positioning of KaTeX HTML inside SVG.
      return { html: new XMLSerializer().serializeToString(expression), width, height }
    } finally { probe.remove() }
  }
}

// Streamdown continues to own loading/error views, copy, downloads, fullscreen and pan/zoom.
export const mermaid: DiagramPlugin = {
  name: 'mermaid', type: 'diagram', language: 'mermaid',
  getMermaid(config = {}) {
    let current = config
    return {
      initialize(next) { current = next },
      async render(id, source) {
        const theme = getComputedStyle(document.documentElement)
        const { svg } = await renderAsync(source, {
          idPrefix: id,
          fontFamily: current.fontFamily ?? theme.getPropertyValue('--font-conversation').trim(),
          links: false,
          images: false,
          ...(source.includes('$$') ? { math: await loadMath() } : {}),
        })
        const root = new DOMParser().parseFromString(svg, 'image/svg+xml').querySelector('svg')
        if (!root) throw new Error('Invalid diagram SVG')
        for (const [name, token] of Object.entries({
          bg: '--bg', fg: '--text', muted: '--muted', line: '--text', surface: '--surface',
          'surface-alt': '--hover-bg', border: '--border', accent: '--accent', critical: '--error',
        } satisfies Record<string, TokenName>)) {
          // Live diagrams inherit theme changes; exported SVGs keep the color resolved at download.
          root.style.setProperty(`--pele-${name}`, `var(${token}, ${theme.getPropertyValue(token).trim()})`)
        }
        return { svg: new XMLSerializer().serializeToString(root) }
      },
    }
  },
}

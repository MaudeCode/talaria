// Dev tool: compare computed styles of the shell chrome between two running WebUI servers, e.g. a build
// of the previous commit and the working tree. Used while moving legacy rules onto Tailwind utilities.
//   node scripts/css-computed-diff.mjs <referenceBaseUrl> <candidateBaseUrl> [path] [viewportWidth]
// Both servers must run without auth (boot them like e2e/server.ts does). Prints per-selector diffs only.
import { chromium } from '@playwright/test'
const [legacy, fresh, path = '/', width = '1280'] = process.argv.slice(2)
const SELECTORS = ['.layout', '.rail', '.rail-brand', '.rail-btn', '.rail-btn.active', '.rail-btn[data-panel="tasks"]', '.sidebar', '.panel-head', '.panel-head-actions', '.panel-head-btn', '.main', '.main-view', '.chat-header', '.chat-header-text', '.chat-header-title', '.chat-context', '.chat-context-item', '.messages-shell', '.messages', '.messages-inner', '.composer-wrap', '.composer-box', '.composer-footer', '.composer-left', '.composer-right', '.app-titlebar', '.tabbar', '.tabbar-btn', '.sidebar-nav', '.side-menu', '.side-menu-item', '.side-menu-item.active', '.settings-main', '.settings-section-head', '.settings-section-title', '.settings-version-badge', '.main-view-header', '.main-view-title', '.main-view-body', '.empty-state', '.empty-hero-title', 'textarea#msg', 'body', 'html']
const PROPS = ['display', 'position', 'width', 'height', 'min-height', 'min-width', 'max-width', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'gap', 'row-gap', 'column-gap', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-color', 'border-radius', 'background-color', 'color', 'font-size', 'font-weight', 'font-family', 'line-height', 'letter-spacing', 'flex-grow', 'flex-shrink', 'flex-basis', 'flex-direction', 'align-items', 'justify-content', 'overflow-x', 'overflow-y', 'box-sizing', 'box-shadow', 'z-index', 'opacity', 'transform', 'text-transform', 'white-space', 'font-feature-settings']
async function dump(base) {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: Number(width), height: 800 }, colorScheme: 'dark' })
  await page.goto(base + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)
  const out = await page.evaluate(({ SELECTORS, PROPS }) => {
    const res = {}
    for (const sel of SELECTORS) {
      const el = document.querySelector(sel)
      if (!el) { res[sel] = null; continue }
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect()
      const o = { rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',') }
      for (const p of PROPS) o[p] = cs.getPropertyValue(p)
      res[sel] = o
    }
    return res
  }, { SELECTORS, PROPS })
  await browser.close()
  return out
}
const [a, b] = await Promise.all([dump(legacy), dump(fresh)])
for (const sel of SELECTORS) {
  if (!a[sel] && !b[sel]) continue
  if (!a[sel] || !b[sel]) { console.log(`${sel}: present legacy=${!!a[sel]} new=${!!b[sel]}`); continue }
  const diffs = Object.keys(a[sel]).filter((k) => a[sel][k] !== b[sel][k]).map((k) => `    ${k}: ${a[sel][k]}  ->  ${b[sel][k]}`)
  if (diffs.length) console.log(`${sel}\n${diffs.join('\n')}`)
}

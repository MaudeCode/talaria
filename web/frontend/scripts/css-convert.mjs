#!/usr/bin/env node
// HISTORY TOOL. Ran once at commit 003facf0 to split the legacy stylesheet into the sheets under
// src/theme/components, which have been hand-maintained on the token vocabulary since (skins.ts).
// Re-running it overwrites those sheets, so it only writes with --write; without the flag it rebuilds
// the ledger (scripts/css-ledger.json, docs/architecture/css-conversion-ledger.md) and reports.
//
// Converts the legacy Hermes WebUI stylesheet (static/style.css as carried
// forward in commit 712bd361 as frontend/src/theme/legacy.css) into Tailwind
// layers and writes a ledger that accounts for every legacy rule.
//
//   node scripts/css-convert.mjs [path/to/legacy.css]
//
// Outputs (all generated, do not hand-edit):
//   src/theme/tokens.css            every :root-level custom-property rule, in source order
//   src/theme/keyframes.css         every @keyframes (last definition of a name wins) + @font-face
//   src/theme/components/*.css      live rules per feature, wrapped in @layer legacy (base.css in @layer base).
//                                   `legacy` is ordered after Tailwind's utilities layer so theme/skin/state
//                                   overrides keep beating the structural utilities exactly as they beat the
//                                   base rules in the legacy sheet.
//   scripts/css-ledger.json         disposition of every legacy rule and selector
//   ../docs/architecture/css-conversion-ledger.md  human summary
//
// Disposition of a selector:
//   tokens     :root-level rule that only defines design tokens / root state
//   converted  the declarations now live as Tailwind utilities in JSX (listed in CONVERTED below)
//   live       every class/id token in the selector is referenced by the React sources -> emitted
//   dead       references a class/id the React app never renders -> dropped
import postcss from 'postcss'
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const front = join(here, '..')
const src = join(front, 'src')
const outDir = join(src, 'theme', 'components')

const WRITE = process.argv.includes('--write')
const legacyPath = process.argv.slice(2).find((a) => !a.startsWith('--'))
const css = legacyPath ? readFileSync(legacyPath, 'utf8') : execSync('git show 712bd361:frontend/src/theme/legacy.css', { cwd: front, encoding: 'utf8', maxBuffer: 1 << 26 })
const root = postcss.parse(css)

// ---------------------------------------------------------------------------
// Which class/id tokens does the React app render? Scan every TS/TSX source and
// the hand-written stylesheet; generated theme files are excluded on purpose.
const used = new Set()
const SKIP = /paraglide|routeTree\.gen|src\/theme\/(components|tokens\.css|keyframes\.css|legacy\.css)/
function scan(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (SKIP.test(p)) continue
    if (statSync(p).isDirectory()) scan(p)
    else if (/\.(tsx?|css)$/.test(f)) for (const m of readFileSync(p, 'utf8').matchAll(/[A-Za-z_][\w-]*/g)) used.add(m[0])
  }
}
scan(src)
// Identifiers that occur in TS for unrelated reasons but are never rendered as
// legacy class names (third-party markup the new renderer does not produce).
const NEVER_RENDERED = new Set(['token', 'language-css', 'language-yaml', 'hljs'])
// Class names the app builds from templates (AppShell `showing-${panel}`, Sidebar `has-tooltip--${side}`).
const DYNAMIC_PREFIXES = [/^showing-/, /^has-tooltip--/]
const isUsed = (t) => (used.has(t) || DYNAMIC_PREFIXES.some((re) => re.test(t))) && !NEVER_RENDERED.has(t)

// Selectors whose declarations were moved into Tailwind utilities in JSX.
// Key format: `[${at-rule context joined by ' | '}] ${selector}` (empty brackets for top-level rules).
const CONVERTED = new Set()
// Rules (or single properties of rules) that never took effect in the legacy cascade because a later rule of
// equal specificity reset them; now that the later rule is utilities, they must not win from the legacy layer.
// Syntax in css-converted.txt: `key !` drops the whole rule, `key !prop,prop` drops those properties.
const OVERRIDDEN = new Map()
for (const raw of readFileSync(join(here, 'css-converted.txt'), 'utf8').split('\n')) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) continue
  const m = line.match(/^(.*?)\s+!(.*)$/)
  if (m) OVERRIDDEN.set(m[1], m[2].split(',').map((p) => p.trim()).filter(Boolean))
  else CONVERTED.add(line)
}

// ---------------------------------------------------------------------------
// Feature file for a selector, from its first meaningful class/id token.
const FILES = [
  ['shell', /^(layout|rail|sidebar|panel|panel-head|panel-view|nav-tab|nav-action|tabbar|app-titlebar|titlebar|topbar|mobile|resize-handle|resizing|hub|main|main-view|logo|brand|has-tooltip|icon-btn|sm-btn|btn|new-chat-btn|skeleton|sessionListBoot|dashboard|sidebar-search|sidebar-nav|sidebar-header|sidebarWs|source-menu|pwa|booting|boot-ready|has-sidebar-snapshot|viewport-reflow|vscroll-measuring|bg-badge|bg-error-banner|auth-warning-badge|reconnect-btn|title-pending|has-ctx-cache|has-ring-cache|no-speech|profile-menu|profile-chip|profile-dropdown|profile-opt|chip|topbar-chips|topbar-meta|topbar-source-badge|topbar-title|empty-state|empty-hero|status-text)(-.*)?$/],
  ['sessions', /^(session|project|batch|new-flash|swipe|pinned|menu-open|is-active|has-new-run|steer)(-.*)?$/],
  ['chat', /^(chat|messages|messages-inner|messages-shell|msg|msgInner|mainChat|panelChat|scroll-to-bottom-btn|live|liveAssistantTurn|assistant|stream-fade|outline|status-card|process-wakeup|handoff|queue|compression|auto-compression|selection|selected-text|sent-selection|diff|pre-header|csv|markdown-table|img-lightbox|mermaid|media-speed|katex|code-copy-btn|code-tree-wrap|tree|excalidraw|html-preview|pdf-preview|interim|load-older|message|hermes-prose|hermes-cursor|question|answer|dot|typing|user-bubble|jump|share|shared)(-.*)?$/],
  ['tools', /^(tool|thinking|worklog|wl|tl|lf|agent-activity|transparent|as-dot|toolRunningRow|activity|goal|reasoning-title)(-.*)?$/],
  ['composer', /^(composer|cf|send-btn|cancel-btn|ctx|ctxIndicatorWrap|yolo|model|mp|saved|drop-hint|upload-bar|attach|attachment|mic|btnMic|btnSavedPrompts|btnSend|btnStop|voice|cmd|command|reasoning|reasoning-option|ws-chip|ws-dropdown|ws-opt|ws-divider|ws-manage|ws-search|ws-suggest|ws-suggestions|ws-list-container|ws-no-results|toolsets|provider-quota-chip|composerControlsChips|composerSituationalControlsChips|composerMobile|msg-input|input-wrap|slash|palette|queue-pill)(-.*)?$/],
  ['approvals', /^(approval|clarify|permission|ask)(-.*)?$/],
  ['workspace', /^(rightpanel|file|preview|breadcrumb|workspace|git-badge|checkpoint|pull-to-refresh|ptr|btnWorkspacePrefs|wsEmptyState|terminal|terminalDock|xterm|artifact)(-.*)?$/],
  ['settings', /^(mainSettings|settings|settingsMenu|side-menu|provider|providersList|plugin|pluginPageContainer|pluginsList|mainPlugin|extension|extensions|mcp|update|updateMsg|updateSummary|updateWhatsNewLinks|checkUpdatesBlock|checkUpdatesStatus|system-health|help-card|help-cards|tab-visibility|chat-activity|theme-pick-btn|skin-pick-btn|font-size-pick-btn|btnDisableAuth|btnSignOut|gateway-failover-inline|field-label|remove-tag|clear-btn|onboarding)(-.*)?$/],
  ['hubs', /^(kanban|detail|cron|cronForm|skill|skills|memory|notes|ws|ws-row|profile|profile-card|profile-help-card|insights|wiki|logs|log-line|hermes-action-grid|hermes-kanban-md|todo|todos|tasks|task|workspacesPanel|profilesPanel|panelKanban|drop-target|tenant|peak)(-.*)?$/],
  ['dialogs', /^(app-dialog|toast|card|login|notice|runtime-notice|modal|dialog|overlay|tts-enabled|tts)(-.*)?$/],
]
function fileFor(tokens) {
  const t = tokens.find((x) => x !== 'dark')
  if (!t) return 'base'
  for (const [file, re] of FILES) if (re.test(t)) return file
  return 'misc'
}

// ---------------------------------------------------------------------------
const tokenRe = /[.#]([A-Za-z_][\w-]*)/g
const norm = (s) => s.replace(/\s+/g, ' ').trim()
const isRootToken = (sel) => /^:root/.test(sel) && !/[\s>+~]/.test(sel) && !/::/.test(sel)
const buckets = new Map() // file -> array of css strings
const push = (file, text) => { const a = buckets.get(file) ?? []; a.push(text); buckets.set(file, a) }
const ledger = []
const keyframes = new Map()
let fontFace = ''
const stats = { rules: 0, selectors: 0, tokens: 0, converted: 0, overridden: 0, live: 0, dead: 0 }
const deadTokens = new Map()

function declText(rule, drop = []) {
  return rule.nodes.filter((n) => n.type === 'decl' && !drop.includes(n.prop) && !drop.some((p) => n.prop.startsWith(p + '-'))).map((d) => `${d.prop}:${d.value}${d.important ? ' !important' : ''}`).join(';')
}
function wrap(ctx, body) {
  return ctx.reduceRight((inner, at) => `${at}{${inner}}`, body)
}
function handleRule(rule, ctx) {
  stats.rules += 1
  const decls = declText(rule)
  const entry = { line: rule.source.start.line, context: ctx, selectors: [] }
  const perFile = new Map()
  for (const raw of rule.selectors) {
    const sel = norm(raw)
    stats.selectors += 1
    const toks = [...new Set([...sel.matchAll(tokenRe)].map((m) => m[1]))]
    const key = `[${ctx.join(' | ')}] ${sel}`
    let disp
    if (isRootToken(sel) && ctx.length === 0) disp = 'tokens'
    else if (CONVERTED.has(key)) disp = 'converted'
    else if (OVERRIDDEN.has(key) && OVERRIDDEN.get(key).length === 0) disp = 'overridden'
    else if (OVERRIDDEN.has(key)) {
      disp = 'live'
      const partial = declText(rule, OVERRIDDEN.get(key))
      if (partial) push(fileFor(toks), wrap(ctx, `${sel}{${partial}}`))
      stats.live += 1
      entry.selectors.push({ selector: sel, disposition: 'live', overriddenProps: OVERRIDDEN.get(key) })
      continue
    } else {
      const dead = toks.filter((t) => t !== 'dark' && !isUsed(t))
      if (dead.length) { disp = 'dead'; for (const d of dead) deadTokens.set(d, (deadTokens.get(d) ?? 0) + 1) } else disp = 'live'
    }
    stats[disp] += 1
    entry.selectors.push({ selector: sel, disposition: disp })
    if (disp === 'tokens') push('tokens', `${sel}{${decls}}`)
    else if (disp === 'live') { const f = fileFor(toks); const a = perFile.get(f) ?? []; a.push(sel); perFile.set(f, a) }
  }
  for (const [file, sels] of perFile) push(file, wrap(ctx, `${sels.join(',')}{${decls}}`))
  ledger.push(entry)
}
function walk(nodes, ctx) {
  for (const node of nodes) {
    if (node.type === 'rule') handleRule(node, ctx)
    else if (node.type === 'atrule') {
      if (/keyframes/.test(node.name)) keyframes.set(node.params, node.toString())
      else if (node.name === 'font-face') fontFace += node.toString() + '\n'
      else if (/^(media|supports|container)$/.test(node.name)) walk(node.nodes ?? [], [...ctx, `@${node.name} ${node.params}`])
      else if (node.nodes) walk(node.nodes, ctx)
    }
  }
}
walk(root.nodes, [])

// ---------------------------------------------------------------------------
const header = (what) => `/* GENERATED by scripts/css-convert.mjs from the legacy Hermes WebUI stylesheet (HWEB-100).\n   ${what}\n   Do not edit by hand; edit the generator or the component that owns the markup. */\n`
const files = []
if (WRITE) {
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
writeFileSync(join(src, 'theme', 'tokens.css'), header('Design tokens: theme axis :root / :root.dark, skin axis [data-skin], preferences [data-font-size] [data-chat-width].') + (buckets.get('tokens') ?? []).join('\n') + '\n')
writeFileSync(join(src, 'theme', 'keyframes.css'), header('Keyframes and the Inter @font-face. When the legacy sheet declared a name twice the last definition won, as it does here.') + fontFace + [...keyframes.values()].join('\n') + '\n')
for (const [file, chunks] of buckets) {
  if (file === 'tokens') continue
  const layer = file === 'base' ? 'base' : 'legacy'
  writeFileSync(join(outDir, `${file}.css`), header(`${file}: live legacy rules for this feature, in source order, in @layer ${layer}.`) + `@layer ${layer}{\n${chunks.join('\n')}\n}\n`)
  files.push(file)
}
writeFileSync(join(outDir, 'index.css'), header('Imports every generated feature sheet.') + files.sort().map((f) => `@import './${f}.css';`).join('\n') + '\n')
} else { for (const f of buckets.keys()) if (f !== 'tokens') files.push(f) }

// ---------------------------------------------------------------------------
writeFileSync(join(here, 'css-ledger.json'), JSON.stringify({ stats, rules: ledger }, null, 0))
const perFile = files.map((f) => `| ${f}.css | ${(buckets.get(f) ?? []).length} |`).join('\n')
const deadList = [...deadTokens.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `\`${t}\` (${n})`).join(', ')
const md = `# CSS conversion ledger (HWEB-100)

Generated by \`frontend/scripts/css-convert.mjs\`. Every rule of the legacy stylesheet
(\`static/style.css\`, 8323 lines) has a disposition; nothing is unaccounted for.

| Measure | Count |
|---|---|
| Legacy rules | ${stats.rules} |
| Legacy selectors | ${stats.selectors} |
| Selectors kept as design tokens (\`tokens.css\`) | ${stats.tokens} |
| Selectors converted to Tailwind utilities in JSX | ${stats.converted} |
| Selectors dropped as overridden (never took effect in the legacy cascade) | ${stats.overridden} |
| Selectors kept as live component rules | ${stats.live} |
| Selectors dropped as dead (class never rendered by the React app) | ${stats.dead} |
| Keyframes kept | ${keyframes.size} |

## Generated sheets

| File | Rule blocks |
|---|---|
| tokens.css | ${(buckets.get('tokens') ?? []).length} |
| keyframes.css | ${keyframes.size} |
${perFile}

## Dead class/id tokens

A selector is dead when it references a class or id that no React source renders.
These are legacy features that were replaced by new markup (Streamdown rendering,
Base UI menus and dialogs, Tailwind-utility chrome) or deferred per the parity matrix.

${deadList}

## After the conversion

The component sheets were subsequently moved onto the theme token vocabulary (\`frontend/src/theme/skins.ts\`):
every declaration a skin or theme rule used to override now reads a token, colour literals became palette or
semantic tokens, and all 374 skin- and theme-scoped rule overrides were deleted in favour of skin data. The
generator therefore only rewrites the sheets with \`--write\`; without the flag it refreshes this ledger.

## Rule-level detail

\`frontend/scripts/css-ledger.json\` lists every legacy rule by source line with the
disposition of each of its selectors. Re-run the generator after adding a selector to
\`frontend/scripts/css-converted.txt\` (declarations moved to utilities) or after
rendering a legacy class from a new component (it becomes live automatically).
`
writeFileSync(join(front, '..', 'docs', 'architecture', 'css-conversion-ledger.md'), md)
console.log(JSON.stringify(stats), 'files:', files.join(','), 'keyframes:', keyframes.size)
const missing = [...CONVERTED, ...OVERRIDDEN.keys()].filter((k) => !ledger.some((e) => e.selectors.some((s) => `[${e.context.join(' | ')}] ${s.selector}` === k)))
if (missing.length) { console.error('css-converted.txt keys not found in legacy CSS:\n' + missing.join('\n')); process.exit(1) }

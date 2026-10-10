/** Session export: JSON (Python `json.dumps(indent=2)`) and a self-contained HTML transcript (`api/session_export_html.py`). */
import { escapeHtml, renderMarkdown } from '../text/markdown.js'
import { str } from '../util.js'
import { normalizeAssistantDisplay } from './merge.js'

const ROLE_LABELS: Record<string, [string, string]> = { user: ['You', 'role-user'], assistant: ['Assistant', 'role-assistant'], system: ['System', 'role-system'], tool: ['Tool', 'role-tool'] }

const CSS = `
:root{--bg:#FEFCF7;--panel:#F3EEE3;--panel2:#FAF7F0;--border:#E0D8C8;
--text:#1A1610;--muted:#5C5344;--accent:#B8860B;--user:#0288A8;--assistant:#3D8B40;
--code-bg:#F5F0E5;--code-border:#E0D8C8;--code-text:#8b4513;
--badge-user-bg:rgba(2,136,168,.12);--badge-user-text:#0288A8;
--badge-assistant-bg:rgba(61,139,64,.12);--badge-assistant-text:#3D8B40;
--badge-system-bg:rgba(92,83,68,.14);--badge-system-text:#5C5344;
--badge-tool-bg:rgba(184,134,11,.14);--badge-tool-text:#8B6508;
--row-stripe:rgba(0,0,0,.02);--subtle:rgba(0,0,0,.02);}
:root.dark{--bg:#0D0D1A;--panel:#1A1A2E;--panel2:#141425;--border:#2A2A45;
--text:#FFF8DC;--muted:#C0C0C0;--accent:#FFD700;--user:#4DD0E1;--assistant:#4CAF50;
--code-bg:#1A1A2E;--code-border:#2A2A45;--code-text:#f0c27f;
--badge-user-bg:rgba(77,208,225,.16);--badge-user-text:#4DD0E1;
--badge-assistant-bg:rgba(76,175,80,.16);--badge-assistant-text:#56d364;
--badge-system-bg:rgba(192,192,192,.16);--badge-system-text:#C0C0C0;
--badge-tool-bg:rgba(255,191,0,.16);--badge-tool-text:#FFBF00;
--row-stripe:rgba(255,255,255,.025);--subtle:rgba(255,255,255,.02);}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);
font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",Roboto,Helvetica,Arial,sans-serif;}
.wrap{max-width:860px;margin:0 auto;padding:32px 20px 80px;}
header.doc-head{border-bottom:1px solid var(--border);padding-bottom:20px;margin-bottom:28px;}
header.doc-head h1{margin:0 0 10px;font-size:24px;font-weight:650;}
.meta{color:var(--muted);font-size:13px;line-height:1.9;}
.meta b{color:var(--text);font-weight:600;}
.msg{margin:0 0 22px;border:1px solid var(--border);border-radius:12px;overflow:hidden;background:var(--panel);}
.msg-head{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel2);
border-bottom:1px solid var(--border);font-size:13px;}
.badge{font-weight:650;padding:2px 10px;border-radius:999px;font-size:12px;letter-spacing:.2px;}
.role-user .badge{background:var(--badge-user-bg);color:var(--badge-user-text);}
.role-assistant .badge{background:var(--badge-assistant-bg);color:var(--badge-assistant-text);}
.role-system .badge{background:var(--badge-system-bg);color:var(--badge-system-text);}
.role-tool .badge{background:var(--badge-tool-bg);color:var(--badge-tool-text);}
.ts{color:var(--muted);margin-left:auto;font-size:12px;}
.msg-body{padding:4px 18px 8px;}
.msg-body>:first-child{margin-top:8px}.msg-body>:last-child{margin-bottom:8px}
.msg-body p{margin:10px 0;}
.msg-body h1,.msg-body h2,.msg-body h3,.msg-body h4{margin:18px 0 10px;line-height:1.3;font-weight:640;}
.msg-body h1{font-size:21px}.msg-body h2{font-size:18px}.msg-body h3{font-size:16px}
.msg-body a{color:var(--accent);text-decoration:none}.msg-body a:hover{text-decoration:underline}
.msg-body ul,.msg-body ol{padding-left:24px;margin:10px 0;}
.msg-body li{margin:4px 0;}
.msg-body code{background:var(--code-bg);border:1px solid var(--code-border);border-radius:5px;color:var(--code-text);
padding:.15em .4em;font-size:.88em;font-family:"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace;}
.msg-body pre{background:var(--code-bg);border:1px solid var(--code-border);border-radius:10px;
padding:14px 16px;overflow:auto;margin:12px 0;}
.msg-body pre code{background:none;border:0;padding:0;color:var(--text);font-size:13px;line-height:1.55;}
.msg-body blockquote{border-left:3px solid var(--border);margin:12px 0;padding:2px 16px;color:var(--muted);}
.msg-body table{border-collapse:collapse;margin:14px 0;width:100%;font-size:14px;display:block;overflow-x:auto;}
.msg-body th,.msg-body td{border:1px solid var(--border);padding:8px 12px;text-align:left;}
.msg-body th{background:var(--panel2);font-weight:640;}
.msg-body tr:nth-child(even) td{background:var(--row-stripe);}
.msg-body img{max-width:100%;border-radius:8px;}
.msg-body hr{border:0;border-top:1px solid var(--border);margin:18px 0;}
details.reasoning{margin:6px 0 4px;border:1px dashed var(--border);border-radius:8px;background:var(--subtle);}
details.reasoning summary{cursor:pointer;padding:8px 14px;color:var(--muted);font-size:13px;user-select:none;}
details.reasoning[open] summary{border-bottom:1px solid var(--border);}
details.reasoning .reasoning-body{padding:4px 16px 10px;color:var(--muted);font-size:13.5px;}
footer.doc-foot{margin-top:36px;padding-top:18px;border-top:1px solid var(--border);
color:var(--muted);font-size:12px;text-align:center;}
`

function neutralizeRemoteImages(rendered: string): string {
  if (!rendered.includes('<img')) return rendered
  return rendered.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = (/src\s*=\s*"([^"]*)"/.exec(tag) ?? /src\s*=\s*'([^']*)'/.exec(tag))?.[1] ?? ''
    if (src.startsWith('data:')) return tag
    return `<code>[image: ${src ? escapeHtml(src) : 'image'}]</code>`
  })
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const c of content) {
      if (c && typeof c === 'object' && !Array.isArray(c)) {
        const part = c as Record<string, unknown>
        if (part.type === 'text' || 'text' in part) parts.push(str(part.text))
        else if (part.type === 'image_url' || part.type === 'image') {
          let url = ''
          if (part.image_url && typeof part.image_url === 'object') url = str((part.image_url as { url?: unknown }).url)
          url = url || str(part.url)
          if (url) parts.push(url.startsWith('data:') ? `![image](${url})` : `\`[image: ${url}]\``)
        } else parts.push(`\`[${str(part.type) || 'content'}]\``)
      } else parts.push(str(c))
    }
    return parts.filter(Boolean).join('\n\n')
  }
  return str(content)
}

function fmtTs(t: unknown): string {
  const n = Number(t)
  if (!Number.isFinite(n) || t === null || t === undefined || t === '') return ''
  const d = new Date(n * 1000)
  if (Number.isNaN(d.getTime())) return ''
  const p = (v: number): string => String(v).padStart(2, '0')
  return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function paletteToCss(palette: unknown): string {
  if (!palette || typeof palette !== 'object' || Array.isArray(palette)) return ''
  const decls: string[] = []
  for (const [rawName, rawVal] of Object.entries(palette as Record<string, unknown>)) {
    const name = rawName.trim().replace(/^-+/, '')
    if (!name || !/^[A-Za-z0-9-]+$/.test(name)) continue
    const val = str(rawVal).trim()
    if (!val || !/^[#A-Za-z0-9.,%()\-\s]+$/.test(val) || val.length > 120 || /expression\s*\(/i.test(val)) continue
    decls.push(`--${name}:${val};`)
  }
  return decls.length ? `:root,:root.dark{${decls.join('')}}` : ''
}

export function renderSessionHtml(session: Record<string, unknown>, theme = 'dark', palette: unknown = null): string {
  const htmlClass = theme.toLowerCase() !== 'light' ? ' class="dark"' : ''
  const paletteCss = paletteToCss(palette)
  const title = (str(session.title) || 'Hermes Conversation').trim()
  const sid = str(session.session_id)
  const model = str(session.model)
  const provider = str(session.model_provider)
  const created = fmtTs(session.created_at)
  const updated = fmtTs(session.updated_at)
  const messages = Array.isArray(session.messages) ? session.messages : []
  const visible = messages.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === 'object' && !Array.isArray(m) && (m as { role?: unknown }).role !== 'system')
  const blocks = visible.map((m) => {
    const role = str(m.role)
    const [label, cls] = ROLE_LABELS[role] ?? [role || '?', 'role-system']
    const ts = fmtTs(m.timestamp)
    const tsHtml = ts ? `<span class="ts">${escapeHtml(ts)}</span>` : ''
    const bodyHtml = neutralizeRemoteImages(renderMarkdown(contentToText(m.content)))
    const reasoning = m.reasoning
    const reasoningHtml = typeof reasoning === 'string' && reasoning.trim() ? `<details class="reasoning"><summary>💭 Reasoning</summary><div class="reasoning-body">${neutralizeRemoteImages(renderMarkdown(reasoning))}</div></details>` : ''
    return `<section class="msg ${cls}"><div class="msg-head"><span class="badge">${escapeHtml(label)}</span>${tsHtml}</div><div class="msg-body">${reasoningHtml}${bodyHtml}</div></section>`
  })
  const meta: string[] = []
  if (sid) meta.push(`<div>Session: <b>${escapeHtml(sid)}</b></div>`)
  if (model) meta.push(`<div>Model: <b>${escapeHtml(model)}</b>${provider ? ` · ${escapeHtml(provider)}` : ''}</div>`)
  if (created || updated) meta.push(`<div>Created: <b>${escapeHtml(created)}</b> · Updated: <b>${escapeHtml(updated)}</b></div>`)
  meta.push(`<div>Messages: <b>${String(visible.length)}</b></div>`)
  const exported = fmtTs(Date.now() / 1000)
  return `<!DOCTYPE html>
<html lang="en"${htmlClass}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${CSS}${paletteCss}</style>
</head>
<body>
<div class="wrap">
<header class="doc-head">
<h1>${escapeHtml(title)}</h1>
<div class="meta">${meta.join('')}</div>
</header>
<main>
${blocks.join('')}
</main>
<footer class="doc-foot">Exported from Talaria Web on ${exported}</footer>
</div>
</body>
</html>`
}

/**
 * A Markdown transcript of the user and assistant rows the server shows on their own (`_display: 'row'`), with each
 * reply's prose and not its inline thinking; system prompts, tool rows and silent replies stay out.
 */
export function renderSessionMarkdown(session: Record<string, unknown>): string {
  const sid = str(session.session_id)
  const lines = [`# ${(str(session.title) || 'Hermes Conversation').trim()}`, '']
  if (sid) lines.push(`Session: ${sid}`)
  if (str(session.model)) lines.push(`Model: ${str(session.model)}`)
  if (str(session.workspace)) lines.push(`Workspace: ${str(session.workspace)}`)
  lines.push('')
  for (const m of Array.isArray(session.messages) ? session.messages : []) {
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    if ((m as Record<string, unknown>)._display !== 'row') continue
    const msg = normalizeAssistantDisplay(m as Record<string, unknown>)
    const role = str(msg.role)
    const label = role === 'user' || role === 'assistant' ? ROLE_LABELS[role]?.[0] : undefined
    const text = contentToText(msg.content).trim()
    if (!label || !text) continue
    lines.push(`## ${label}`, '', text, '')
  }
  return lines.join('\n')
}

/** Python `json.dumps(obj, ensure_ascii=False, indent=2)`. */
export function pythonPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

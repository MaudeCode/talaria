/**
 * Per-turn Agent configuration the Python streaming worker derived from the profile's config.yaml: the tool-call and
 * output budgets, the reasoning config, the frozen-workspace system message, and the WebUI-only ephemeral system
 * prompt (personality, surface context, progress guidance, delivery hints).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { coerceReasoningEffort, dict, isDict, personalityPrompt, type Config } from '../config/agent-config.js'
import { BACKGROUND_TURN_PROMPT } from './background-updates.js'
import { VALID_REASONING_EFFORTS } from '../providers/tables.js'
import { str } from '../util.js'

export const WEBUI_PROGRESS_PROMPT = `WebUI progress guidance:
- Match the normal Hermes messaging style, but do not let long tool-running WebUI turns appear silent.
- For long multi-step work that uses tools, emit brief user-visible progress updates as normal assistant content, not only as hidden reasoning.
- Before the first tool batch in a long task, say what you are about to inspect.
- After each meaningful batch of tool calls, say what you just confirmed and what you will check next before continuing with more tools.
- Do not run many independent tool batches back-to-back without visible assistant text between them when the task is still ongoing.
- Do not keep progress only in reasoning, thinking, or tool-result channels; those are not a substitute for visible interim updates.
- Each update should say what you are about to check, what you just confirmed, or why the next tool call is needed.
- Keep updates concise, factual, and in the user's language. One or two short sentences are enough.
- Do not reveal hidden reasoning, chain-of-thought, private scratchpads, secrets, raw logs, or long tool output.
- Password, API-key, token, and secret fields are automatically redacted by the system. Treat masked values as intentional redaction, not placeholder text or user input errors, and do not tell the user a stored credential is wrong based on a masked value alone.
- Final visible assistant replies must be clear, user-facing, and in the user's language, not private planning notes.
- Do not include terse planning fragments or scratchpad shorthand in visible assistant text. Avoid fragments like "Need script", "Need check logs", "Need inspect email", or "maybe invite"; either omit them or rewrite them as clear user-facing progress.
- For direct answers or very short tasks, skip progress updates and answer normally.`

function positiveInt(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null
  const n = typeof raw === 'number' ? Math.trunc(raw) : Number.parseInt(str(raw), 10)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Python `_process_wakeup_max_iterations`: automatic wakeup turns get a separate bounded tool-call budget. */
export function processWakeupMaxIterations(configured: number | null, source: string, env: Record<string, string | undefined>): number | null {
  if (source.trim() !== 'process_wakeup') return configured
  let cap = Number.parseInt(env.HERMES_WEBUI_PROCESS_WAKEUP_MAX_TURNS ?? '32', 10)
  if (!Number.isFinite(cap)) cap = 32
  cap = Math.max(1, Math.min(cap, 128))
  return configured && configured > 0 ? Math.min(configured, cap) : cap
}

/** Python: `agent.max_turns` (else root `max_turns`) → AIAgent `max_iterations`. */
export function maxIterationsFromConfig(config: Config): number | null {
  const agent = dict(config.agent)
  return positiveInt(agent.max_turns ?? config.max_turns)
}

/** Python: root `max_tokens`, else `agent.max_tokens`. */
export function maxTokensFromConfig(config: Config): number | null {
  return positiveInt(config.max_tokens ?? dict(config.agent).max_tokens)
}

/** Python `parse_reasoning_effort` of the coerced `agent.reasoning_effort`. */
export function reasoningConfigFromConfig(config: Config, provider: string | null, supported: string[] = []): { enabled: boolean; effort?: string } | null {
  const effort = coerceReasoningEffort(str(dict(config.agent).reasoning_effort), supported, provider ?? '')
  if (!effort) return null
  if (effort === 'none') return { enabled: false }
  return (VALID_REASONING_EFFORTS as readonly string[]).includes(effort) ? { enabled: true, effort } : null
}

/** The frozen session-creation workspace, and where the current one lives: the per-turn WebUI session context (TAL-710). */
export function workspaceSystemMessage(frozenWorkspace: string): string {
  return `Active workspace at session start: ${frozenWorkspace}\n` +
    'The current workspace is the Workspace: line of the WebUI session context for this turn: the workspace the user has selected in the web UI for this message. ' +
    'It overrides any earlier workspace mentioned in this system prompt, memory, or conversation history; [Workspace::v1: ...] tags on older messages in the history are past values. ' +
    'Use it as your default working directory for ALL file and terminal operations: write_file, read_file, search_files, terminal workdir, and patch. ' +
    'Never fall back to a hardcoded path.'
}

/** Python `_webui_surface_context_prompt`. */
function surfaceContextPrompt(ctx: { source: string; session_id: string; profile: string | null; workspace: string }): string {
  const lines = [
    'WebUI session context:',
    '- This browser session is not the same live transcript as Telegram, Discord, Slack, or other messaging surfaces.',
    '- Use durable memory, saved sessions, and available tools for cross-surface recall instead of assuming those transcripts are in this browser chat.',
    '- Do not copy or dump this browser transcript into external notes or durable memory by default.',
    '- Write to external notes or durable memory only for explicit captures, durable user preferences, decisions, blockers/open issues, runbook-worthy workflows, or other clearly reusable signals; otherwise leave notes unchanged.',
    '- When you do write or update a durable note, briefly tell the user what note/section changed so the write is reviewable.',
  ]
  for (const [key, label] of [['source', 'Source'], ['session_id', 'Session ID'], ['profile', 'Profile'], ['workspace', 'Workspace']] as const) {
    const value = str(ctx[key]).trim()
    if (value) lines.push(`- ${label}: ${value}`)
  }
  return lines.join('\n')
}

/** Python `_webui_delivery_context_prompt`: connected platforms, home channels, and scheduled-task delivery hints. */
export function deliveryContextPrompt(config: Config, hermesHome: string, homeDisplay: string): string {
  const connected = ['local (files on this machine)']
  try {
    const statePath = join(hermesHome, 'gateway_state.json')
    if (existsSync(statePath)) {
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
      const platforms = isDict(raw) ? raw.platforms : null
      if (isDict(platforms)) for (const name of Object.keys(platforms).sort()) { const p = platforms[name]; if (isDict(p) && p.state === 'connected' && name !== 'local') connected.push(`${name}: Connected ✓`) }
    }
  } catch { /* unreadable gateway state contributes nothing */ }
  const lines: string[] = [`**Connected Platforms:** ${connected.join(', ')}`]
  const homeChannels: Record<string, string> = {}
  const platformsCfg = dict(config.platforms)
  for (const [name, pdata] of Object.entries(platformsCfg)) {
    if (!isDict(pdata) || pdata.enabled === false) continue
    const home = pdata.home_channel
    if (isDict(home)) homeChannels[name] = str(home.name) || name
  }
  const sorted = Object.entries(homeChannels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  if (sorted.length) {
    lines.push('', '**Home Channels (default destinations):**')
    for (const [platform, label] of sorted) lines.push(`  - ${platform}: ${label}`)
  }
  lines.push('', '**Delivery options for scheduled tasks:**')
  lines.push('- `"origin"` → Back to this WebUI/browser session when the WebUI runtime supports origin delivery; otherwise prefer an explicit platform target.')
  lines.push(`- \`"local"\` → Save to local files only (${homeDisplay}/cron/output/)`)
  for (const [platform, label] of sorted) lines.push(`- \`"${platform}"\` → Home channel (${label})`)
  lines.push('', '*For explicit targeting, use `"platform:chat_id"` format if the user provides a specific chat ID. Do not invent private IDs.*')
  return lines.join('\n')
}

/** Python `_webui_ephemeral_system_prompt`: personality, surface context, progress guidance, delivery context. */
export function webuiEphemeralSystemPrompt(opts: { config: Config; personality: string | null; sessionId: string; profile: string | null; workspace: string; hermesHome: string; homeDisplay: string; background?: boolean }): string {
  const parts: string[] = []
  const prompt = opts.personality ? personalityPrompt(opts.config, opts.personality) : null
  if (prompt) parts.push(prompt.trim())
  parts.push(surfaceContextPrompt({ source: 'webui', session_id: opts.sessionId, profile: opts.profile, workspace: opts.workspace }))
  parts.push(WEBUI_PROGRESS_PROMPT)
  parts.push(deliveryContextPrompt(opts.config, opts.hermesHome, opts.homeDisplay))
  if (opts.background) parts.push(BACKGROUND_TURN_PROMPT)
  return parts.filter(Boolean).join('\n\n')
}

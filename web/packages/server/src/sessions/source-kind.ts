/**
 * TAL-310: the one place a session's source is classified. Every session payload ships the result as `source_kind`
 * and `is_messaging_session` (`withSessionWireFlags`), so clients render it instead of scanning source markers.
 */
import { str } from '../util.js'

type Row = Record<string, unknown>

/**
 * Every messaging platform the Agent's gateway can own a session for; the only such list in the server. The generic
 * `messaging` marker is not a platform: the gateway dedupe falls back to it for rows with no source at all.
 */
export const MESSAGING_SOURCES = new Set([
  'discord', 'email', 'imessage', 'irc', 'line', 'matrix', 'mattermost', 'signal', 'slack', 'sms', 'teams',
  'telegram', 'twilio', 'webex', 'wecom', 'wecom_callback', 'weixin', 'whatsapp',
])

export const SOURCE_KINDS = ['webui', 'cli', 'messaging', 'cron', 'webhook', 'subagent', 'claude_code', 'kanban', 'api', 'other'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

/** Interactive Agent front ends and the external-agent bridge (`isCliSessionRow`). */
const CLI_MARKERS = new Set(['acp', 'cli', 'tui', 'external_agent', 'external-agent'])

const lower = (v: unknown): string => str(v).trim().toLowerCase()

/**
 * The session's source family, first match wins:
 * 1. the first present of `session_source` / `raw_source` / `source_tag` is `webui` or `fork` (a WebUI-born session,
 *    whatever a stale `is_cli_session` says);
 * 2. `subagent` on any marker (never parent linkage alone, which forks and compression continuations share);
 * 3. `claude_code` on `source_tag` / `raw_source`;
 * 4. `messaging` as `session_source`, or the first present of `raw_source` / `source_tag` / `source` is `messaging` or a
 *    messaging platform;
 * 5. `cron` on any marker or a `cron_` session id; then `webhook`, `kanban`, `api` / `api_server` on any marker;
 * 6. `is_cli_session`, or a CLI marker (`acp`, `cli`, `tui`, `external_agent`);
 * 7. no marker at all is a WebUI session; an unrecognised marker is `other`.
 */
export function sourceKind(row: Row): SourceKind {
  const markers = [row.session_source, row.source_tag, row.raw_source, row.source_label].map(lower).filter(Boolean)
  const owner = [row.session_source, row.raw_source, row.source_tag].map(lower).find(Boolean)
  if (owner === 'webui' || owner === 'fork') return 'webui'
  if (markers.includes('subagent')) return 'subagent'
  if ([row.source_tag, row.raw_source].map(lower).includes('claude_code')) return 'claude_code'
  const platform = [row.raw_source, row.source_tag, row.source].map(lower).find(Boolean)
  if (lower(row.session_source) === 'messaging' || platform === 'messaging' || (platform && MESSAGING_SOURCES.has(platform))) return 'messaging'
  if (markers.includes('cron') || lower(row.session_id).startsWith('cron_')) return 'cron'
  if (markers.includes('webhook')) return 'webhook'
  if (markers.includes('kanban')) return 'kanban'
  if (markers.includes('api') || markers.includes('api_server')) return 'api'
  if (row.is_cli_session === true || markers.some((m) => CLI_MARKERS.has(m))) return 'cli'
  return markers.length || lower(row.source) ? 'other' : 'webui'
}

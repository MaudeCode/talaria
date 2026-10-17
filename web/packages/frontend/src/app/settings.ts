import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'
import { getStreamContext } from '../stream/connection'
import { m } from '../paraglide/messages.js'
import type { Settings } from '../contracts'

// Only ordinary presentation preferences may show unconfirmed local intent.
const immediate = new Set(`bot_name send_key sidebar_density pinned_sessions_limit hidden_tabs
  workspace_panel_open workspace_todos_tab session_jump_buttons session_endless_scroll show_titlebar_profile
  project_quick_create_buttons show_token_usage show_tps show_quota_chip show_conversation_outline
  terminal_auto_expand_on_output new_chat_on_workspace_switch notifications_enabled sound_enabled
  show_cli_sessions show_claude_code_sessions show_cron_sessions show_webhook_sessions show_kanban_sessions
  show_previous_messaging_sessions chat_activity_display_mode transparent_stream_event_timestamps
  worklog_details_expanded_default auto_scroll_follow render_user_markdown large_text_paste_as_attachment
  fade_text_effect virtualize_transcript default_message_mode show_busy_placeholder_hint
  structured_code_default_view structured_code_auto_tree_lines max_tokens auto_title_refresh_every`.split(/\s+/))
const intentKey = ['settings-intents'] as const
interface Intent { context: object; fields: Record<string, unknown> }
// ResourceIntent's single-resource lock cannot express overlapping per-field settings writes.
const owners = new WeakMap<QueryClient, ReturnType<typeof makeOwner>>()

function makeOwner(qc: QueryClient) {
  return {
    context: getStreamContext(), query: qc.getQueryCache().find({ queryKey: intentKey, exact: true }), next: 0,
    fields: new Map<string, { sequence: number; value: unknown }>(),
    writes: new Set<string>(), versions: new Map<string, number>(),
    active: new Map<number, { keys: string[]; done: Promise<void> }>(),
  }
}

function useIntent() {
  return useQuery<Intent | null>({ queryKey: intentKey, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity, structuralSharing: false })
}

export function useSettingsQuery() {
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.fetchSettings, staleTime: 30_000 })
  const intent = useIntent().data
  const data = settings.data && intent?.context === getStreamContext() ? { ...settings.data, ...intent.fields } : settings.data
  return { ...settings, data } as typeof settings
}

export function useSaveSettings() {
  const qc = useQueryClient()
  useIntent()
  return useMutation({
    mutationKey: keys.settings,
    mutationFn: async (patch: Record<string, unknown>) => {
      const currentQuery = () => qc.getQueryCache().find({ queryKey: intentKey, exact: true })
      let owner = owners.get(qc)
      if (owner?.context !== getStreamContext() || owner.query !== currentQuery()) {
        owner = makeOwner(qc)
        owners.set(qc, owner)
      }
      const state = owner
      const current = () => state.context === getStreamContext() && state.query === currentQuery()
      const publish = () => {
        if (current()) qc.setQueryData<Intent>(intentKey, { context: state.context, fields: Object.fromEntries([...state.fields].map(([key, field]) => [key, field.value])) })
      }
      const sequence = ++state.next
      const fields = Object.keys(patch)
      // Keep disjoint writes concurrent, but persist repeated edits in user order.
      const predecessors = [...state.active.values()].filter((write) => write.keys.some((key) => fields.includes(key))).map((write) => write.done)
      let release!: () => void
      const done = new Promise<void>((resolve) => { release = resolve })
      state.active.set(sequence, { keys: fields, done })
      for (const key of fields) {
        state.writes.add(key)
        if (immediate.has(key)) state.fields.set(key, { sequence, value: patch[key] })
      }
      publish()
      try {
        await qc.cancelQueries({ queryKey: keys.settings })
        await Promise.all(predecessors)
        if (!current()) throw new Error(m.error_generic())
        const data = await api.saveSettings(patch)
        if (!current()) return data
        if (typeof data.error === 'string' && data.error) throw new Error(data.error)
        if (data.ok === false) throw new Error(m.error_generic())
        qc.setQueryData<Settings>(keys.settings, (previous) => {
          const confirmed = { ...previous }
          for (const [key, value] of Object.entries(data)) {
            // Full responses can contain stale copies of other writes' fields.
            if (state.writes.has(key) && !fields.includes(key) || (state.versions.get(key) ?? 0) > sequence) continue
            confirmed[key] = value
            state.versions.set(key, sequence)
          }
          return confirmed
        })
        return data
      } finally {
        for (const key of fields) if (state.fields.get(key)?.sequence === sequence) state.fields.delete(key)
        state.active.delete(sequence)
        release()
        publish()
        if (current() && state.active.size === 0) {
          await qc.cancelQueries({ queryKey: keys.settings })
          if (current()) await qc.invalidateQueries({ queryKey: keys.settings })
        }
      }
    },
  })
}

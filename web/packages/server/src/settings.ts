/**
 * `settings.json` store: defaults, legacy-key migrations, allowlist and range
 * validation on save, and the atomic writer (Python `api/config.py`
 * `_SETTINGS_*`, `load_settings`, `save_settings`).
 *
 * `default_model` / `default_model_provider` come from the Agent config.yaml
 * and are supplied by hooks the config domain wires in; the store itself never
 * reads config.yaml.
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteText } from './fs/atomic.js'
import { resolveDefaultWorkspace, type Env } from './config.js'

export type Settings = Record<string, unknown>

export const SETTINGS_SPEECH_KEYS = new Set([
  'tts_enabled', 'tts_auto_read', 'tts_engine', 'tts_voice', 'tts_rate', 'tts_pitch',
  'voice_mode_button', 'voice_continuous', 'voice_silence_ms', 'raw_audio_mode',
])
const PERSISTED_SPEECH_KEYS_FIELD = 'persisted_speech_keys'
const LEGACY_DROP_KEYS = new Set(['assistant_language', 'bubble_layout', 'default_model', 'activity_feed_expanded_default', 'simplified_tool_calling'])
export const SETTINGS_THEME_VALUES = new Set(['light', 'dark', 'system'])
export const SETTINGS_SKIN_VALUES = new Set([
  'default', 'ares', 'mono', 'graphite', 'slate', 'poseidon', 'sisyphus', 'charizard', 'sienna', 'catppuccin', 'nous',
  'geist-contrast', 'zeus', 'verdigris', 'neon-soft', 'neon-paint',
])
const LEGACY_THEME_MAP: Record<string, [string, string]> = {
  slate: ['dark', 'slate'], solarized: ['dark', 'poseidon'], monokai: ['dark', 'sisyphus'], nord: ['dark', 'slate'], oled: ['dark', 'default'],
}

/** The `bot_name` setting as clients show it: trimmed, "Hermes" when unset or blank. */
export function displayBotName(value: unknown): string {
  return (typeof value === 'string' ? value.trim() : '') || 'Hermes'
}

export function settingsDefaults(opts: { defaultWorkspace: string; botName: string }): Settings {
  return {
    default_workspace: opts.defaultWorkspace,
    onboarding_completed: false,
    send_key: 'enter',
    show_token_usage: false,
    show_quota_chip: false,
    show_conversation_outline: false,
    show_busy_placeholder_hint: false,
    new_chat_on_workspace_switch: false,
    virtualize_transcript: false,
    virtualize_transcript_optin: false,
    show_tps: false,
    fade_text_effect: false,
    show_cli_sessions: true,
    show_claude_code_sessions: true,
    show_cron_sessions: false,
    show_webhook_sessions: false,
    show_kanban_sessions: false,
    show_previous_messaging_sessions: false,
    sync_to_insights: false,
    check_for_updates: true,
    auto_apply_updates: false,
    update_channel: 'stable',
    agent_update_channel: 'stable',
    ignore_agent_updates: false,
    whats_new_summary_enabled: false,
    tts_enabled: false,
    tts_auto_read: false,
    tts_engine: 'browser',
    tts_voice: '',
    tts_rate: 1.0,
    tts_pitch: 1.0,
    voice_mode_button: false,
    voice_continuous: false,
    voice_silence_ms: 1800,
    raw_audio_mode: false,
    theme: 'dark',
    skin: 'default',
    font_size: 'default',
    full_width_chat: false,
    chat_width: 'comfortable',
    session_jump_buttons: false,
    render_user_markdown: false,
    large_text_paste_as_attachment: true,
    project_quick_create_buttons: false,
    structured_code_default_view: 'auto',
    structured_code_auto_tree_lines: 10,
    session_endless_scroll: false,
    chat_activity_display_mode: 'compact_worklog',
    transparent_stream_event_timestamps: true,
    auto_scroll_follow: true,
    worklog_details_expanded_default: false,
    hide_composer_attach: false,
    hide_composer_saved_prompts: false,
    hide_composer_mic: false,
    show_titlebar_profile: false,
    hide_composer_voice_mode: false,
    hide_composer_yolo: false,
    hide_composer_profile: false,
    hide_composer_workspace: false,
    hide_composer_mobile_config: false,
    hide_composer_model: false,
    hide_composer_quota_chip: false,
    hide_composer_reasoning: false,
    hide_composer_toolsets: false,
    hide_composer_status: false,
    hide_composer_context: false,
    hide_composer_bg_badge: false,
    pinned_sessions_limit: 3,
    inflight_state_max_sessions: 8,
    inflight_state_max_messages: 24,
    inflight_state_max_tool_calls: 48,
    inflight_state_max_string_chars: 60000,
    inflight_state_max_json_chars: 1500000,
    hidden_tabs: [],
    tab_order: [],
    composer_control_order: [],
    language: 'en',
    bot_name: opts.botName,
    sound_enabled: false,
    rtl: false,
    notifications_enabled: false,
    show_thinking: true,
    simplified_tool_calling: true,
    terminal_auto_expand_on_output: false,
    workspace_todos_tab: false,
    api_redact_enabled: true,
    dashboard_plugins: {},
    sidebar_density: 'compact',
    auto_title_refresh_every: '0',
    default_message_mode: 'steer',
    password_hash: null,
    auth_disabled_acknowledged: false,
    provider_cost_budget: null,
  }
}

const ENUM_VALUES: Record<string, Set<string>> = {
  send_key: new Set(['enter', 'ctrl+enter', 'shift+enter']),
  sidebar_density: new Set(['compact', 'detailed']),
  update_channel: new Set(['stable', 'experimental']),
  agent_update_channel: new Set(['stable', 'experimental']),
  font_size: new Set(['small', 'default', 'large', 'xlarge']),
  chat_width: new Set(['comfortable', 'wide', 'full']),
  auto_title_refresh_every: new Set(['0', '5', '10', '20']),
  default_message_mode: new Set(['queue', 'interrupt', 'steer']),
  chat_activity_display_mode: new Set(['compact_worklog', 'transparent_stream', 'hide_all_activity']),
  structured_code_default_view: new Set(['auto', 'on', 'off']),
}
const INT_RANGES: Record<string, [number, number]> = {
  pinned_sessions_limit: [1, 99],
  inflight_state_max_sessions: [1, 25],
  inflight_state_max_messages: [1, 100],
  inflight_state_max_tool_calls: [1, 200],
  inflight_state_max_string_chars: [1000, 500000],
  inflight_state_max_json_chars: [100000, 4000000],
  structured_code_auto_tree_lines: [1, 1000],
  voice_silence_ms: [200, 60000],
}
const FLOAT_RANGES: Record<string, [number, number]> = { tts_rate: [0.5, 2.0], tts_pitch: [0.0, 2.0] }
const LANG_RE = /^[a-zA-Z]{2,10}(-[a-zA-Z0-9]{2,8})?$/
const TTS_ENGINE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const LIST_KEYS = new Set(['hidden_tabs', 'tab_order', 'composer_control_order'])

/** Python `int(v)`: ints, whole floats, and decimal strings; booleans count as 0/1. */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number.parseInt(v, 10)
  return null
}
function pyFloat(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}
/** Python truthiness for the `bool(v)` coercion. */
export function pyBool(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return Object.keys(v).length > 0
  return Boolean(v)
}

export function normalizeAppearance(theme: unknown, skin: unknown): [string, string] {
  const rawTheme = typeof theme === 'string' ? theme.trim().toLowerCase() : ''
  const rawSkin = typeof skin === 'string' ? skin.trim().toLowerCase() : ''
  let nextTheme: string
  let legacySkin: string
  const legacy = LEGACY_THEME_MAP[rawTheme]
  if (legacy) [nextTheme, legacySkin] = legacy
  else if (SETTINGS_THEME_VALUES.has(rawTheme)) [nextTheme, legacySkin] = [rawTheme, 'default']
  else [nextTheme, legacySkin] = ['dark', 'default']
  return [nextTheme, SETTINGS_SKIN_VALUES.has(rawSkin) ? rawSkin : legacySkin]
}

export function coerceProviderCostBudget(value: unknown): number | null {
  const f = pyFloat(value)
  if (f === null || !Number.isFinite(f)) return null
  const rounded = Math.round(f * 100) / 100
  if (!(rounded > 0 && rounded < 1e9)) return null
  return rounded
}

export interface SettingsHooks {
  hashPassword?: (password: string) => Promise<string>
  onPasswordChanged?: () => void
  defaultModel?: () => string
  defaultModelProvider?: () => string | undefined
}

export interface SettingsStoreOptions {
  file: string
  env: Env
  stateDir: string
  defaultWorkspace: string
  botName: string
  hooks?: SettingsHooks
  log?: (line: string) => void
}

export class SettingsStore {
  readonly file: string
  hooks: SettingsHooks
  /** Incremented on every successful save so callers can detect changes cheaply. */
  writeVersion = 0
  private readonly env: Env
  private readonly stateDir: string
  defaultWorkspace: string
  private readonly botName: string
  private cache: { key: string; raw: Settings } | null = null

  constructor(opts: SettingsStoreOptions) {
    this.file = opts.file
    this.env = opts.env
    this.stateDir = opts.stateDir
    this.defaultWorkspace = opts.defaultWorkspace
    this.botName = opts.botName
    this.hooks = opts.hooks ?? {}
  }

  defaults(): Settings {
    return settingsDefaults({ defaultWorkspace: this.defaultWorkspace, botName: this.botName })
  }

  /** Read settings.json; `strict` callers distinguish absence from an unreadable file. */
  readRaw(opts: { strict?: boolean } = {}): Settings {
    let st
    try {
      st = statSync(this.file, { bigint: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || !opts.strict) return {}
      throw error
    }
    const key = `${st.mtimeNs}:${st.size}:${st.ino}:${st.ctimeNs}`
    if (this.cache?.key === key) return structuredClone(this.cache.raw)
    let loaded: unknown
    try {
      loaded = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (error) {
      if (opts.strict) throw error
      return {}
    }
    if (typeof loaded !== 'object' || loaded === null || Array.isArray(loaded)) {
      if (opts.strict) throw new Error('settings.json must contain an object')
      return {}
    }
    this.cache = { key, raw: loaded as Settings }
    return structuredClone(loaded as Settings)
  }

  load(): Settings {
    const settings = this.defaults()
    const stored = this.readRaw()
    if (!('worklog_details_expanded_default' in stored) && 'activity_feed_expanded_default' in stored) {
      settings.worklog_details_expanded_default = pyBool(stored.activity_feed_expanded_default)
    }
    for (const [k, v] of Object.entries(stored)) {
      if (LEGACY_DROP_KEYS.has(k) || k === PERSISTED_SPEECH_KEYS_FIELD) continue
      settings[k] = v
    }
    if (!('default_message_mode' in stored) && 'busy_input_mode' in stored) settings.default_message_mode = stored.busy_input_mode
    delete settings.busy_input_mode
    const establishedKeys = Object.keys(stored).filter((k) => k !== 'show_cli_sessions' && k !== 'onboarding_completed')
    if (!('show_cli_sessions' in stored) && (pyBool(stored.onboarding_completed) || establishedKeys.length > 0)) settings.show_cli_sessions = false
    if (!pyBool(stored.virtualize_transcript_optin)) settings.virtualize_transcript = false
    const hasStoredAppearance = 'theme' in stored || 'skin' in stored
    ;[settings.theme, settings.skin] = normalizeAppearance(
      hasStoredAppearance ? stored.theme : settings.theme,
      hasStoredAppearance ? stored.skin : settings.skin,
    )
    settings.default_model = this.hooks.defaultModel?.() ?? ''
    const provider = this.hooks.defaultModelProvider?.()
    if (provider) settings.default_model_provider = provider
    return settings
  }

  private persistedSpeechKeys(stored: Settings): Set<string> {
    return new Set([...SETTINGS_SPEECH_KEYS].filter((k) => k in stored))
  }

  private payloadForWrite(settings: Settings, persistedSpeechKeys: Set<string>): Settings {
    const persisted: Settings = {}
    for (const [k, v] of Object.entries(settings)) if (k !== 'default_model' && k !== PERSISTED_SPEECH_KEYS_FIELD) persisted[k] = v
    for (const key of SETTINGS_SPEECH_KEYS) if (!persistedSpeechKeys.has(key)) Reflect.deleteProperty(persisted, key)
    return persisted
  }

  private writeSettings(persisted: Settings): void {
    mkdirSync(dirname(this.file), { recursive: true })
    atomicWriteText(this.file, JSON.stringify(persisted, null, 2))
    this.writeVersion += 1
  }

  /** Save a patch, ignoring unknown keys and invalid values. Returns the merged settings. */
  async save(input: Settings): Promise<Settings> {
    const settings: Settings = { ...input }
    // Hash before snapshotting the file: the PBKDF2 await is the only yield in this method, so once `readRaw()`
    // runs the read/merge/write below is atomic with respect to concurrent saves.
    const rawPw = settings._set_password
    delete settings._set_password
    let newPasswordHash: string | null = null
    if (typeof rawPw === 'string' && rawPw.trim()) {
      if (!this.hooks.hashPassword) throw new Error('password hashing is not wired')
      newPasswordHash = await this.hooks.hashPassword(rawPw.trim())
    }
    const raw = this.readRaw()
    const persistedSpeechKeys = this.persistedSpeechKeys(raw)
    const current = this.load()
    const appliedSpeechKeys = new Set<string>()
    const allowed = new Set(Object.keys(this.defaults()))
    for (const k of ['password_hash', 'default_model', 'simplified_tool_calling']) allowed.delete(k)
    const composerKeys = new Set([...allowed].filter((k) => k.startsWith('hide_composer_')))

    if (!('worklog_details_expanded_default' in settings) && 'activity_feed_expanded_default' in settings) {
      settings.worklog_details_expanded_default = settings.activity_feed_expanded_default
    }
    delete settings.activity_feed_expanded_default
    if (!('default_message_mode' in settings) && 'busy_input_mode' in settings) settings.default_message_mode = settings.busy_input_mode
    delete settings.busy_input_mode
    delete settings.simplified_tool_calling

    let pendingTheme = current.theme
    let pendingSkin = current.skin
    let themeExplicit = false
    let skinExplicit = false
    let passwordChanged = false
    if (newPasswordHash !== null) {
      current.password_hash = newPasswordHash
      passwordChanged = true
    }
    const clearPw = settings._clear_password
    delete settings._clear_password
    if (pyBool(clearPw)) {
      current.password_hash = null
      passwordChanged = true
    }
    const dashboardPlugins = settings.dashboard_plugins
    if (dashboardPlugins && typeof dashboardPlugins === 'object' && !Array.isArray(dashboardPlugins)) {
      const currentDash = current.dashboard_plugins
      if (currentDash && typeof currentDash === 'object' && !Array.isArray(currentDash)) {
        const merged = currentDash as Record<string, boolean>
        for (const [k, v] of Object.entries(dashboardPlugins as Record<string, unknown>)) merged[k] = pyBool(v)
        current.dashboard_plugins = merged
      }
    }
    for (const [k, rawValue] of Object.entries(settings)) {
      let v: unknown = rawValue
      if (k === 'auto_apply_updates' && typeof v !== 'boolean') continue
      if (k === 'dashboard_plugins' || !allowed.has(k)) continue
      if (k === 'theme') {
        if (typeof v === 'string' && v.trim()) { pendingTheme = v; themeExplicit = true }
        continue
      }
      if (k === 'skin') {
        if (typeof v === 'string' && v.trim()) { pendingSkin = v; skinExplicit = true }
        continue
      }
      const enumValues = ENUM_VALUES[k]
      if (enumValues && !(typeof v === 'string' && enumValues.has(v))) continue
      const intRange = INT_RANGES[k]
      if (intRange) {
        const n = pyInt(v)
        if (n === null || n < intRange[0] || n > intRange[1]) continue
        v = n
      }
      const floatRange = FLOAT_RANGES[k]
      if (floatRange) {
        const f = pyFloat(v)
        if (f === null || !Number.isFinite(f) || f < floatRange[0] || f > floatRange[1]) continue
        v = f
      }
      if (k === 'tts_engine') {
        if (typeof v !== 'string') continue
        v = v.trim()
        if (!TTS_ENGINE_RE.test(v as string)) continue
      }
      if (k === 'tts_voice' && (typeof v !== 'string' || v.length > 200 || v.includes('\0'))) continue
      if (k === 'language' && (typeof v !== 'string' || !LANG_RE.test(v))) continue
      if (LIST_KEYS.has(k)) {
        if (!Array.isArray(v)) continue
        const seen = new Set<string>()
        const cleaned: string[] = []
        for (const item of v) {
          if (typeof item !== 'string') continue
          const s = item.trim()
          if (!s || seen.has(s)) continue
          if ((k === 'hidden_tabs' || k === 'tab_order') && (s === 'chat' || s === 'settings')) continue
          if (k === 'composer_control_order' && !composerKeys.has(s)) continue
          seen.add(s)
          cleaned.push(s)
        }
        v = cleaned
      }
      if (k === 'provider_cost_budget') {
        if (v === null || v === undefined || v === '') { current[k] = null; continue }
        const budget = coerceProviderCostBudget(v)
        if (budget === null) continue
        current[k] = budget
        continue
      }
      if (typeof this.defaults()[k] === 'boolean') v = pyBool(v)
      current[k] = v
      if (SETTINGS_SPEECH_KEYS.has(k)) appliedSpeechKeys.add(k)
    }
    let skinValue = pendingSkin
    if (themeExplicit && !skinExplicit) {
      const rawTheme = typeof pendingTheme === 'string' ? pendingTheme.trim().toLowerCase() : ''
      if (!SETTINGS_THEME_VALUES.has(rawTheme)) skinValue = null
    }
    ;[current.theme, current.skin] = normalizeAppearance(pendingTheme, skinValue)
    current.default_workspace = resolveDefaultWorkspace(typeof current.default_workspace === 'string' ? current.default_workspace : null, { env: this.env, stateDir: this.stateDir })
    const effectiveSpeech = new Set([...persistedSpeechKeys, ...appliedSpeechKeys])
    this.writeSettings(this.payloadForWrite(current, effectiveSpeech))
    if (passwordChanged) this.hooks.onPasswordChanged?.()
    this.defaultWorkspace = current.default_workspace as string
    current.default_model = this.hooks.defaultModel?.() ?? ''
    return current
  }

  /**
   * Startup reconciliation (Python module-level block): a stored
   * `default_workspace` wins over discovery unless the env override is set, and
   * a stale stored value is rewritten once.
   */
  applyStartupWorkspace(): void {
    let exists = false
    try { exists = statSync(this.file).isFile() } catch { exists = false }
    if (!exists) return
    const startup = this.load()
    if (!this.env.HERMES_WEBUI_DEFAULT_WORKSPACE) {
      this.defaultWorkspace = resolveDefaultWorkspace(typeof startup.default_workspace === 'string' ? startup.default_workspace : null, { env: this.env, stateDir: this.stateDir })
    }
    delete startup.default_model
    if (startup.default_workspace !== this.defaultWorkspace) {
      startup.default_workspace = this.defaultWorkspace
      try {
        this.writeSettings(this.payloadForWrite(startup, this.persistedSpeechKeys(this.readRaw())))
      } catch {
        /* best effort, matches Python */
      }
    }
  }
}

import { replaceEqualDeep, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { keys } from '../api/queryKeys'
import { invalidateSessionQueries } from '../api/sessionQueries'
import * as api from '../api/endpoints'
import { getStreamContext, useStreamContext } from '../stream/connection'
import { isDefiniteRefusal } from '../contracts/common'
import { settleOnNextRead } from '../features/sessions/useResourceMutation'
import { m } from '../paraglide/messages.js'
import type { Settings } from '../contracts'
import { OUTSIDE_SOURCE_SETTING_KEYS } from '@maudecode/talaria-web-contracts'

// Every setting shows the user's value at once; `_`-prefixed credential commands (passwords) are write-only.
const shown = (key: string) => !key.startsWith('_')
const intentKey = ['settings-intents'] as const
/** `partial` (TAL-2136): unconfirmed keys of object settings written with `partialSetting`, shown over the confirmed object. */
interface Intent { context: object; fields: Record<string, unknown>; partial: Record<string, Record<string, unknown>> }

const PARTIAL = Symbol('partialSetting')
interface PartialSetting { [PARTIAL]: Record<string, unknown> }
const isPartial = (value: unknown): value is PartialSetting => typeof value === 'object' && value !== null && PARTIAL in value
/**
 * TAL-2136: a write of only these keys of an object setting the server merges key by key (`provider_quota_thresholds`). Each
 * key shows at once and rolls back on its own, and the request carries only these keys, never another write's unconfirmed one.
 */
export function partialSetting(fields: Record<string, unknown>): PartialSetting {
  return { [PARTIAL]: fields }
}
/** The `state.fields` entry of one key of a partial write. */
const SUB = '\u0000'
// The resource owner's single-resource lock cannot express overlapping per-field settings writes.
const owners = new WeakMap<QueryClient, ReturnType<typeof makeOwner>>()

function makeOwner(qc: QueryClient) {
  return {
    context: getStreamContext(), query: qc.getQueryCache().find({ queryKey: intentKey, exact: true }), next: 0,
    fields: new Map<string, { sequence: number; value: unknown }>(),
    writes: new Set<string>(), versions: new Map<string, number>(),
    active: new Map<number, { keys: string[]; done: Promise<void> }>(),
  }
}

function pickFields<T extends Record<string, unknown>>(data: T, fields?: readonly string[]): T {
  return fields ? Object.fromEntries(fields.filter((key) => key in data).map((key) => [key, data[key]])) as T : data
}

function useIntent(fields?: readonly string[]) {
  const context = useStreamContext()
  return useQuery<Intent | null>({
    queryKey: intentKey, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity,
    notifyOnChangeProps: fields?.length === 0 ? [] : undefined,
    // Context identity is a write fence, while unchanged selected fields retain their references.
    structuralSharing: (previous, next) => (previous as Intent | null | undefined)?.context !== (next as Intent | null)?.context ? next : replaceEqualDeep(previous, next),
    select: (intent) => {
      if (intent?.context !== context) return null
      const selected = pickFields(intent.fields, fields)
      const partial = pickFields(intent.partial, fields)
      return Object.keys(selected).length || Object.keys(partial).length ? { context: intent.context, fields: selected, partial } : null
    },
  })
}

export function useSettingsQuery(fields?: readonly string[]) {
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.fetchSettings, staleTime: 30_000, select: (data) => pickFields(data, fields) })
  const intent = useIntent(fields).data
  const confirmed = settings.data
  const merged = (key: string, keys: Record<string, unknown>) => {
    const stored = confirmed?.[key]
    return { ...(typeof stored === 'object' && stored !== null ? stored : {}), ...keys }
  }
  const overlay = confirmed && intent ? { ...confirmed, ...intent.fields, ...Object.fromEntries(Object.entries(intent.partial).map(([key, keys]) => [key, merged(key, keys)])) } : undefined
  const isError = overlay ? settings.isError : false
  const error = overlay ? settings.error : null
  const refetch = settings.refetch
  const result = overlay ? { data: overlay, isPending: false as const, isError, error, refetch } : undefined
  return result ?? settings
}

export function useSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useSettingsQuery([key]).data?.[key]
}

/** The value this tab's own unconfirmed write of `key` shows; undefined when no write of it is in flight. */
export function useSettingIntent<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useSettingIntents([key])[key]
}

/** The values this tab's own unconfirmed writes of `fields` show, by key; empty when none of them is in flight. */
export function useSettingIntents(fields: readonly string[]): Record<string, unknown> {
  return useIntent(fields).data?.fields ?? {}
}

export function useSaveSettings() {
  const qc = useQueryClient()
  // Register the owner without subscribing a write-only control to other fields' optimistic edits.
  useIntent([])
  return useMutation({
    mutationKey: keys.settings,
    mutationFn: (patch: Record<string, unknown>) => writeSettings(qc, patch),
  })
}

/** The settings the server's chat list reads: one switch per outside source and the messaging sub-option (TAL-2159), and the density that decides whether rows carry `meta` (TAL-2153). */
const SESSION_LIST_SETTINGS = new Set<string>([...OUTSIDE_SOURCE_SETTING_KEYS, 'show_previous_messaging_sessions', 'sidebar_density'])

// Module scope: React Compiler cannot lower its try/finally, so it stays outside the hook.
async function writeSettings(qc: QueryClient, patch: Record<string, unknown>) {
  const currentQuery = () => qc.getQueryCache().find({ queryKey: intentKey, exact: true })
  let owner = owners.get(qc)
  if (owner?.context !== getStreamContext() || owner.query !== currentQuery()) {
    owner = makeOwner(qc)
    owners.set(qc, owner)
  }
  const state = owner
  const current = () => state.context === getStreamContext() && state.query === currentQuery()
  const publish = () => {
    if (!current()) return
    const fields: Record<string, unknown> = {}
    const partial: Record<string, Record<string, unknown>> = {}
    for (const [path, field] of state.fields) {
      const [key = '', sub] = path.split(SUB)
      if (sub === undefined) fields[key] = field.value
      else (partial[key] ??= {})[sub] = field.value
    }
    qc.setQueryData<Intent>(intentKey, { context: state.context, fields, partial })
  }
  const sequence = ++state.next
  const fields = Object.keys(patch)
  // What the server receives (a partial write as its own keys), and the overlay entries this write owns.
  const sent = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, isPartial(value) ? value[PARTIAL] : value]))
  const paths = Object.entries(patch).flatMap(([key, value]) => isPartial(value) ? Object.keys(value[PARTIAL]).map((sub) => [key + SUB + sub, value[PARTIAL][sub]] as const) : [[key, value] as const])
  // Keep disjoint writes concurrent, but persist repeated edits in user order.
  const predecessors = [...state.active.values()].filter((write) => write.keys.some((key) => fields.includes(key))).map((write) => write.done)
  let release!: () => void
  const done = new Promise<void>((resolve) => { release = resolve })
  state.active.set(sequence, { keys: fields, done })
  for (const key of fields) state.writes.add(key)
  for (const [path, value] of paths) if (shown(path)) state.fields.set(path, { sequence, value })
  publish()
  // Settings the server reads into other payloads: once one is stored (or a reread settles an unknown outcome) those
  // queries re-read, even after the page that wrote it has closed. TAL-2149: the server opens every Worklog by
  // `worklog_details_expanded_default`; the chat list and sidebar searches read `SESSION_LIST_SETTINGS`.
  const refreshDependents = () => {
    if ('worklog_details_expanded_default' in patch) void qc.invalidateQueries({ queryKey: [...keys.sessions.all, 'detail'] })
    if (fields.some((key) => SESSION_LIST_SETTINGS.has(key))) void invalidateSessionQueries(qc)
  }
  let unknown = false
  try {
    await qc.cancelQueries({ queryKey: keys.settings })
    await Promise.all(predecessors)
    if (!current()) throw new Error(m.error_generic())
    const data = await api.saveSettings(sent)
    if (data.ok !== false && !data.error) refreshDependents()
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
  } catch (error) {
    unknown = !isDefiniteRefusal(error)
    throw error
  } finally {
    const settle = () => {
      for (const [path] of paths) if (state.fields.get(path)?.sequence === sequence) state.fields.delete(path)
      publish()
    }
    // A refusal rolls back at once; an unknown outcome keeps the shown value until a successful read decides it.
    if (!unknown) settle()
    state.active.delete(sequence)
    release()
    if (unknown && current()) {
      try {
        await qc.cancelQueries({ queryKey: keys.settings })
        await qc.query({ queryKey: keys.settings, queryFn: api.fetchSettings, staleTime: 0 })
        settle()
        refreshDependents()
      } catch {
        settleOnNextRead(qc, () => current() && paths.some(([path]) => state.fields.get(path)?.sequence === sequence), () => { settle(); refreshDependents() }, keys.settings)
      }
    } else if (current() && state.active.size === 0) {
      await qc.cancelQueries({ queryKey: keys.settings })
      if (current()) await qc.invalidateQueries({ queryKey: keys.settings })
    }
  }
}

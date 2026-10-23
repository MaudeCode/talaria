import { useMemo } from 'react'
import { replaceEqualDeep, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'
import { getStreamContext } from '../stream/connection'
import { isDefiniteRefusal } from '../contracts/common'
import { settleOnNextRead } from '../features/sessions/useResourceMutation'
import { m } from '../paraglide/messages.js'
import type { Settings } from '../contracts'

// Every setting shows the user's value at once; `_`-prefixed credential commands (passwords) are write-only.
const shown = (key: string) => !key.startsWith('_')
const intentKey = ['settings-intents'] as const
interface Intent { context: object; fields: Record<string, unknown> }
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
  return useQuery<Intent | null>({
    queryKey: intentKey, queryFn: () => null, initialData: null, enabled: false, gcTime: Infinity,
    notifyOnChangeProps: fields?.length === 0 ? [] : undefined,
    // Context identity is a write fence, while unchanged selected fields retain their references.
    structuralSharing: (previous, next) => (previous as Intent | null | undefined)?.context !== (next as Intent | null)?.context ? next : replaceEqualDeep(previous, next),
    select: (intent) => {
      if (intent?.context !== getStreamContext()) return null
      const selected = pickFields(intent.fields, fields)
      return Object.keys(selected).length ? { context: intent.context, fields: selected } : null
    },
  })
}

export function useSettingsQuery(fields?: readonly string[]) {
  const settings = useQuery({ queryKey: keys.settings, queryFn: api.fetchSettings, staleTime: 30_000, select: (data) => pickFields(data, fields) })
  const intent = useIntent(fields).data
  const confirmed = settings.data
  const overlay = useMemo(() => confirmed && intent ? { ...confirmed, ...intent.fields } : undefined, [confirmed, intent])
  const isError = overlay ? settings.isError : false
  const error = overlay ? settings.error : null
  const refetch = settings.refetch
  const result = useMemo(() => overlay ? { data: overlay, isPending: false as const, isError, error, refetch } : undefined, [overlay, isError, error, refetch])
  return result ?? settings
}

export function useSetting<K extends keyof Settings>(key: K): Settings[K] | undefined {
  return useSettingsQuery([key]).data?.[key]
}

export function useSaveSettings() {
  const qc = useQueryClient()
  // Register the owner without subscribing a write-only control to other fields' optimistic edits.
  useIntent([])
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
        if (shown(key)) state.fields.set(key, { sequence, value: patch[key] })
      }
      publish()
      let unknown = false
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
      } catch (error) {
        unknown = !isDefiniteRefusal(error)
        throw error
      } finally {
        const settle = () => {
          for (const key of fields) if (state.fields.get(key)?.sequence === sequence) state.fields.delete(key)
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
          } catch {
            settleOnNextRead(qc, () => current() && [...fields].some((key) => state.fields.get(key)?.sequence === sequence), settle, keys.settings)
          }
        } else if (current() && state.active.size === 0) {
          await qc.cancelQueries({ queryKey: keys.settings })
          if (current()) await qc.invalidateQueries({ queryKey: keys.settings })
        }
      }
    },
  })
}

import type { DelegationSettings, DelegationWrite } from '@maudecode/talaria-web-contracts'
/** Query hooks for shared server resources. Keys live in api/queryKeys.ts. */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { teardownAll } from '../stream/connection'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'
import { useResourceEffects, useResourceMutation } from '../features/sessions/useResourceMutation'
import { showErrorToast } from '../features/toast/errorToast'

export { useSettingsQuery, useSetting, useSaveSettings } from './settings'

const toastError = (e: unknown) => showErrorToast(e)
interface DefaultModel { model: string; provider?: string | null; advanced?: { service_tier: string } }

/**
 * Default model lives in config.yaml. Every reader shows the chosen model and speed at once (`useDefaultModelChoice`);
 * settings and the catalog reread to confirm it. A speed change sends the shown model, so it never undoes a model change.
 */
export function useSetDefaultModel() {
  return useResourceMutation({
    resource: () => 'default-model',
    // Auto auxiliary slots resolve to the default model, so their list rereads with it.
    queryKey: [], readKeys: () => [keys.settings, keys.models, keys.auxiliaryModels],
    effect: ({ model, provider, advanced }: DefaultModel) => ({ value: { model, provider: provider ?? null, service_tier: advanced?.service_tier } }),
    mutationFn: ({ model, provider, advanced }) => api.setDefaultModel(model, provider, advanced),
    onError: toastError,
  })
}

/** The default model and speed the user just chose, until the server's reread confirms them. */
export function useDefaultModelChoice() {
  return useResourceEffects<{ model: string; provider: string | null; service_tier?: string | undefined }>()['default-model']?.value
}

/** TAL-802: whether this profile offers live dictation. */
export function useTranscribeCapabilityQuery() {
  return useQuery({ queryKey: keys.transcribeCapability, queryFn: api.fetchTranscribeCapability, staleTime: 60_000 })
}

export function useAuxiliaryModelsQuery(enabled = true) {
  return useQuery({ queryKey: keys.auxiliaryModels, queryFn: api.fetchAuxiliaryModels, staleTime: 30_000, enabled })
}

/** One auxiliary slot's write owner; `__reset__` owns every slot. */
export const auxResource = (task: string) => `aux-model:${task}`
/** Without `model`, a write that names `reasoning_effort` changes only the slot's effort (TAL-1285). */
interface AuxWrite { task: string; model?: string; provider?: string | null; reasoning_effort?: string | null; tasks?: string[] | undefined; shown: Record<string, unknown>; delegation?: DelegationSettings | undefined }

/** Writes one auxiliary slot's model and/or effort (or resets all): the slot shows the pick at once, and the server's state replaces the list. */
export function useSetAuxiliaryModel() {
  const qc = useQueryClient()
  return useResourceMutation({
    resource: ({ task, tasks }: AuxWrite) => task === '__reset__' ? (tasks ?? []).map(auxResource) : auxResource(task),
    exclusive: true,
    queryKey: keys.auxiliaryModels, readKeys: () => [{ queryKey: keys.auxiliaryModels, exact: true }],
    effect: ({ shown, delegation }) => ({ fields: shown, value: delegation }),
    mutationFn: ({ task, model, provider, reasoning_effort }) => api.setAuxiliaryModel(task, { model, provider, reasoning_effort }),
    onSuccess: (res) => { if (res.auxiliary) qc.setQueryData(keys.auxiliaryModels, res.auxiliary) },
    onError: toastError,
  })
}

/** Backend and whole-block saves share the delegation slot's optimistic owner. */
export function useSetDelegation() {
  const qc = useQueryClient()
  return useResourceMutation({
    resource: () => auxResource('delegation'),
    exclusive: true,
    queryKey: keys.auxiliaryModels, readKeys: () => [{ queryKey: keys.auxiliaryModels, exact: true }],
    effect: ({ shown }: { write: DelegationWrite; shown: DelegationSettings }) => ({ value: shown }),
    mutationFn: ({ write }) => api.setDelegation(write),
    onSuccess: (res) => qc.setQueryData(keys.auxiliaryModels, res),
    onError: toastError,
  })
}

export function useProfilesQuery() {
  return useQuery({ queryKey: keys.profiles, queryFn: api.fetchProfiles, staleTime: 30_000 })
}

export function useActiveProfileQuery() {
  return useQuery({ queryKey: keys.activeProfile, queryFn: api.fetchActiveProfile, staleTime: 30_000 })
}

export function useModelsQuery(opts: Partial<UseQueryOptions<Awaited<ReturnType<typeof api.fetchModels>>>> = {}) {
  return useQuery({ queryKey: keys.models, queryFn: () => api.fetchModels(), staleTime: 60_000, ...opts })
}

export function useWorkspacesQuery() {
  return useQuery({ queryKey: keys.workspaces, queryFn: api.fetchWorkspaces, staleTime: 30_000 })
}

export function useDashboardStatusQuery(enabled = true) {
  return useQuery({ queryKey: keys.dashboard, queryFn: api.fetchDashboardStatus, staleTime: 60_000, enabled })
}

export function useOnboardingQuery() {
  return useQuery({ queryKey: keys.onboarding, queryFn: api.fetchOnboarding, staleTime: 0 })
}

/** Profile switch: server-side cookie change; every cached resource belongs to the previous profile. */
export function useSwitchProfile() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => api.switchProfile(name),
    onSuccess: async () => {
      teardownAll()
      qc.clear()
      await qc.invalidateQueries()
    },
  })
}

export function useToolsetsCatalogQuery(value: string[] | null, sessionId?: string) {
  return useQuery({ queryKey: keys.toolsets(sessionId, value), queryFn: () => api.fetchToolsetsCatalog(value, sessionId), gcTime: 0, retry: false })
}

/** TAL-1040: read when the fresh-chat mode menu opens, so a stopped or older owner is current. */
export function useExecutionModesQuery(enabled = true) {
  return useQuery({ queryKey: keys.executionModes, queryFn: api.fetchExecutionModes, gcTime: 0, retry: false, enabled })
}

/** Mounted only while the inspector is open. Never reuse another owner/context's details. */
export function useContextDetailQuery(sessionId: string, identity: string) {
  return useQuery({ queryKey: keys.sessions.contextDetail(sessionId, identity), queryFn: ({ signal }) => api.fetchContextDetail(sessionId, identity, signal), gcTime: 0, staleTime: 0, retry: false })
}

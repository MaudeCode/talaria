/** Query hooks for shared server resources. Keys live in api/queryKeys.ts. */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { teardownAll } from '../stream/connection'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'

export { useSettingsQuery, useSaveSettings } from './settings'

/** Default model lives in config.yaml; on success the settings and models queries are refetched so every reader agrees. */
export function useSetDefaultModel() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: ({ model, provider, advanced }: { model: string; provider?: string | null; advanced?: { service_tier: string } }) => api.setDefaultModel(model, provider, advanced), onSuccess: async () => { await Promise.all([qc.invalidateQueries({ queryKey: keys.settings }), qc.invalidateQueries({ queryKey: keys.models }), qc.invalidateQueries({ queryKey: keys.auxiliaryModels })]) } })
}

/** TAL-802: whether this profile offers live dictation. */
export function useTranscribeCapabilityQuery() {
  return useQuery({ queryKey: keys.transcribeCapability, queryFn: api.fetchTranscribeCapability, staleTime: 60_000 })
}

export function useAuxiliaryModelsQuery(enabled = true) {
  return useQuery({ queryKey: keys.auxiliaryModels, queryFn: api.fetchAuxiliaryModels, staleTime: 30_000, enabled })
}

/** Writes one auxiliary slot; the server's refreshed state replaces the cached list. */
export function useSetAuxiliaryModel() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ task, model, provider }: { task: string; model: string; provider?: string | null }) => api.setAuxiliaryModel(task, model, provider),
    onSuccess: (res) => { if (res.auxiliary) qc.setQueryData(keys.auxiliaryModels, res.auxiliary); else void qc.invalidateQueries({ queryKey: keys.auxiliaryModels }) },
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
export function useExecutionModesQuery() {
  return useQuery({ queryKey: keys.executionModes, queryFn: api.fetchExecutionModes, gcTime: 0, retry: false })
}

/** Query hooks for shared server resources. Keys live in api/queryKeys.ts. */
import { useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'

export function useSettingsQuery() {
  return useQuery({ queryKey: keys.settings, queryFn: api.fetchSettings, staleTime: 30_000 })
}

export function useSaveSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationKey: keys.settings,
    mutationFn: (patch: Record<string, unknown>) => api.saveSettings(patch),
    onSuccess: (data) => {
      if (data && typeof data === 'object' && 'bot_name' in data) qc.setQueryData(keys.settings, data)
      void qc.invalidateQueries({ queryKey: keys.settings })
    },
  })
}

/** Default model lives in config.yaml; on success the settings and models queries are refetched so every reader agrees. */
export function useSetDefaultModel() {
  const qc = useQueryClient()
  return useMutation({ mutationFn: ({ model, provider }: { model: string; provider?: string | null }) => api.setDefaultModel(model, provider), onSuccess: () => { void qc.invalidateQueries({ queryKey: keys.settings }); void qc.invalidateQueries({ queryKey: keys.models }) } })
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
      qc.clear()
      await qc.invalidateQueries()
    },
  })
}

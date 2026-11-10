import type { DelegationSettings, DelegationWrite } from '@maudecode/talaria-web-contracts'
/** Query hooks for shared server resources. Keys live in api/queryKeys.ts. */
import { keepPreviousData, useMutation, useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query'
import { useRouter } from '@tanstack/react-router'
import { teardownAll } from '../stream/connection'
import { loadBootstrap } from './bootstrap'
import { removePersisted } from '../lib/persisted'
import { keys } from '../api/queryKeys'
import * as api from '../api/endpoints'
import { useResourceEffects, useResourceMutation } from '../features/sessions/useResourceMutation'
import { showErrorToast } from '../features/toast/errorToast'
import { showToast } from '../features/toast/toast'
import { m } from '../paraglide/messages.js'

export { useSettingsQuery, useSetting, useSaveSettings, partialSetting } from './settings'

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
    queryKey: [], readKeys: () => [keys.settings, keys.models, keys.auxiliaryModels, { queryKey: keys.reasoning(null, null, null), exact: true }],
    effect: ({ model, provider, advanced }: DefaultModel) => ({ value: { model, provider: provider ?? null, service_tier: advanced?.service_tier } }),
    mutationFn: ({ model, provider, advanced }) => api.setDefaultModel(model, provider, advanced),
    onError: toastError,
  })
}

/** The default model and speed the user just chose, until the server's reread confirms them. */
export function useDefaultModelChoice() {
  return useResourceEffects<{ model: string; provider: string | null; service_tier?: string | undefined }>()['default-model']?.value
}

/** TAL-1858: one catalog entry's star; the server pairs it by `provider_id` and `bare_id`, so both are required. */
export interface ModelFavoriteWrite { id: string; provider_id: string; bare_id: string; favorite: boolean }
const favoriteResource = (id: string) => `model-favorite:${id}`

/** Stars or unstars a model: the row and Favorites show it at once, and the catalog reread confirms or rolls it back. */
export function useSetModelFavorite() {
  return useResourceMutation({
    resource: ({ id }: ModelFavoriteWrite) => favoriteResource(id),
    queryKey: keys.models, readKeys: () => [{ queryKey: keys.models, exact: true }],
    effect: ({ favorite }) => ({ value: favorite }),
    mutationFn: ({ provider_id, bare_id, favorite }) => api.setModelFavorite({ provider_id, model: bare_id, favorite }),
    onError: toastError,
  })
}

/** Whether a catalog entry shows as starred: the user's pending star, else the server's `favorite`. */
export function useModelFavoriteShown(): (entry: { id: string; favorite?: boolean | undefined }) => boolean {
  const effects = useResourceEffects<boolean>()
  return (entry) => effects[favoriteResource(entry.id)]?.value ?? entry.favorite === true
}

/** TAL-802: whether this profile offers live dictation. */
/** TAL-818: the server's connectors gate; Connectors stay hidden unless it answers true. */
export function useConnectorsAvailable() {
  return useQuery({ queryKey: keys.connectors.available, queryFn: api.fetchConnectorsAvailable, staleTime: 5 * 60_000 })
}

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

export function useProjectsQuery(enabled = true) {
  return useQuery({ queryKey: keys.projects, queryFn: () => api.fetchProjects(), staleTime: 60_000, enabled })
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

/** A profile to switch to; `botChat` opens that profile's canonical Bot Chat once switched. */
export interface ProfileSwitch { name: string; botChat?: boolean }

/**
 * Profile switch: server-side cookie change; every cached resource belongs to the previous profile. TAL-2099: the
 * switch happens in place, without a reload: an open chat (the previous profile's) gives way to `/` or the requested
 * Bot Chat, then the bootstrap and every query reload while the shell and a new chat's draft stay. The switch remounts
 * the page that started it, so the confirmation, the error and the Bot Chat navigation live here: a caller's own
 * `mutate` callbacks would not run after that remount.
 */
export function useSwitchProfile() {
  const qc = useQueryClient()
  const router = useRouter()
  return useMutation({
    mutationFn: ({ name }: ProfileSwitch) => api.switchProfile(name),
    onSuccess: async (res, { name, botChat }) => {
      teardownAll()
      // `/` restores the last chat, which is the previous profile's.
      removePersisted('hermes-webui-session')
      // The server resolves the Bot Chat in the switch's own reply (TAL-213), not from the cached listing.
      const botSession = botChat ? res.profiles.find((p) => p.name === name)?.canonical_session?.tip_session_id : undefined
      if (botSession) await router.navigate({ to: '/session/$sessionId', params: { sessionId: botSession } })
      else {
        showToast(m.profile_switched({ name }))
        if (router.state.location.pathname.startsWith('/session/')) await router.navigate({ to: '/' })
      }
      qc.getMutationCache().clear()
      // Reset, not clear: mounted readers drop the previous profile's data and refetch at once.
      await Promise.all([loadBootstrap(), qc.resetQueries()])
    },
    onError: toastError,
  })
}

export function useToolsetsCatalogQuery(value: string[] | null, sessionId: string | undefined, q: string) {
  // A toggle or a search reads the catalog again; the open menu keeps its rows meanwhile (TAL-2096, TAL-2144).
  return useQuery({ queryKey: keys.toolsets(sessionId, value, q), queryFn: () => api.fetchToolsetsCatalog(value, sessionId, q), gcTime: 0, retry: false, placeholderData: keepPreviousData })
}

/** TAL-1040: read when the fresh-chat mode menu opens, so a stopped or older owner is current. */
export function useExecutionModesQuery(enabled = true) {
  return useQuery({ queryKey: keys.executionModes, queryFn: api.fetchExecutionModes, gcTime: 0, retry: false, enabled })
}

/** Mounted only while the inspector is open, one read per opening (TAL-1672). Never reuse another owner/context's details. */
export function useContextDetailQuery(sessionId: string, identity: string) {
  return useQuery({ queryKey: keys.contextDetail(sessionId, identity), queryFn: ({ signal }) => api.fetchContextDetail(sessionId, identity, signal), gcTime: 0, staleTime: 0, retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false })
}

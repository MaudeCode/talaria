import { orpc, timeout } from '../../api/orpc'

/** TAL-1514: Meshy previews and gallery; every field and asset url comes from the server. */
export const fetchMeshyOverview = (signal?: AbortSignal) => orpc().meshy.overview(undefined, { signal: timeout(60_000, signal) })
export const fetchMeshyCard = (session_id: string, ref: string, signal?: AbortSignal) => orpc().meshy.card({ session_id, ref }, { signal: timeout(60_000, signal) })
export const fetchMeshyTask = (task_id: string, signal?: AbortSignal) => orpc().meshy.task({ task_id }, { signal: timeout(30_000, signal) })
export const fetchMeshyDetails = (task_id: string, beside: string | undefined, signal?: AbortSignal) => orpc().meshy.details({ task_id, ...(beside ? { beside } : {}) }, { signal: timeout(60_000, signal) })
export const saveMeshyFormat = (input: { task_id: string; format: string; beside?: string }) => orpc().meshy.save(input, { signal: timeout(130_000) })
export const saveMeshyImages = (task_id: string) => orpc().meshy.saveImages({ task_id }, { signal: timeout(130_000) })

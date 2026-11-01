/**
 * TAL-1514: Meshy previews and gallery over the reviewed native plugin (`plugins.meshy`). The sidecar answers with
 * bounded native rows; this module decides availability, ordering and titles, and turns every local path or signed
 * asset link into an opaque grant bound to the owner, profile home, login generation, reviewed revision and task.
 * Clients never see a host path or a signed URL. Each byte request rechecks consent and the native inventory.
 */
import { createHash } from 'node:crypto'
import { readSync } from 'node:fs'
import { basename } from 'node:path'
import type { MeshyAsset, MeshyCard, MeshyDetails, MeshyItem, MeshyOverview, MeshySaveResult, MeshySidecarResult, MeshyTask } from '@maudecode/talaria-web-contracts'
import type { z } from 'zod'
import type { MeshyNativeLocalSchema, MeshyNativeRecentSchema, MeshyNativeTaskSchema } from '@maudecode/talaria-web-contracts'
import type { RequestContext } from '../http/context.js'
import { SidecarError } from '../sidecar/client.js'
import { serveFileBytes } from '../workspace/media.js'
import type { MeshyDirective } from '../workspace/media-refs.js'
import type { AgentDashboardScope, DashboardPlugins } from './dashboard-plugins.js'

type NativeLocal = z.infer<typeof MeshyNativeLocalSchema>
type NativeRecent = z.infer<typeof MeshyNativeRecentSchema>
type NativeTask = z.infer<typeof MeshyNativeTaskSchema>
interface Params { action: 'overview' | 'card' | 'task' | 'details' | 'save' | 'save_images' | 'asset'; task_id?: string; format?: string; path?: string }
type Grant = { kind: 'local'; revision: string; path: string; mime: string } | { kind: 'remote'; revision: string; url: string }

const NAMESPACE = 'meshy-asset'
const ASSET_HOST = 'assets.meshy.ai'
/** The native viewer's own limit for one model. */
export const MESHY_MAX_MODEL_BYTES = 128 * 1024 * 1024
const MAX_REMOTE_IMAGE_BYTES = 16 * 1024 * 1024
const REMOTE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp'])
// glTF extensions whose decoders model-viewer would fetch from another origin.
const DECODER_EXTENSIONS = new Set(['KHR_draco_mesh_compression', 'KHR_texture_basisu', 'EXT_meshopt_compression'])

export class MeshyError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }
const imageMime = (path: string): string => IMAGE_MIME[path.slice(path.lastIndexOf('.')).toLowerCase()] ?? 'image/png'

/** Why a GLB would make the viewer fetch something else, or is not a whole GLB; null when it is self-contained. */
export function glbRefusal(fd: number, size: number): string | null {
  const bad = 'This file is not a viewable self-contained GLB model.'
  if (size < 20 || size > MESHY_MAX_MODEL_BYTES) return bad
  const head = Buffer.alloc(20)
  if (readSync(fd, head, 0, 20, 0) !== 20) return bad
  const jsonLength = head.readUInt32LE(12)
  if (head.toString('latin1', 0, 4) !== 'glTF' || head.readUInt32LE(4) !== 2 || head.readUInt32LE(8) !== size || head.readUInt32LE(16) !== 0x4e4f534a || jsonLength > size - 20 || jsonLength > 16 * 1024 * 1024) return bad
  const json = Buffer.alloc(jsonLength)
  if (readSync(fd, json, 0, jsonLength, 20) !== jsonLength) return bad
  let doc: unknown
  try { doc = JSON.parse(json.toString('utf8')) } catch { return bad }
  if (!doc || typeof doc !== 'object') return bad
  const gltf = doc as { buffers?: unknown; images?: unknown; extensionsRequired?: unknown; extensionsUsed?: unknown }
  for (const list of [gltf.buffers, gltf.images]) {
    if (list !== undefined && !Array.isArray(list)) return bad
    // Any `uri` (another file, a remote URL or a data URL) leaves the GLB's own binary chunk.
    if (Array.isArray(list) && list.some((entry) => !entry || typeof entry !== 'object' || 'uri' in entry)) return 'This model loads files from outside itself, so it is not shown.'
  }
  for (const list of [gltf.extensionsRequired, gltf.extensionsUsed]) {
    if (Array.isArray(list) && list.some((name) => typeof name === 'string' && DECODER_EXTENSIONS.has(name))) return 'This model needs a decoder the viewer does not load.'
  }
  return null
}

const AVAILABILITY_MESSAGES: Partial<Record<MeshySidecarResult['availability'], string>> = {
  plugin_unavailable: 'Install and enable the Meshy plugin (reviewed version) for this profile in Plugins.',
  agent_incompatible: 'This Hermes Agent cannot host the Meshy plugin. Update the Agent.',
}

export class MeshyHost {
  constructor(private readonly deps: { plugins: DashboardPlugins; fetch?: typeof fetch }) {}

  private async call(scope: AgentDashboardScope, params: Params, signal?: AbortSignal): Promise<MeshySidecarResult> {
    const slow = params.action === 'save' || params.action === 'save_images'
    try {
      return await this.deps.plugins.call(scope, (sidecar, signal) => sidecar.call('plugins.meshy', { profile_home: scope.home, ...params }, { signal, timeoutMs: slow ? 125_000 : 45_000 }), signal)
    } catch (error) {
      // An older sidecar has no such method: the Agent side cannot host this adapter.
      if (error instanceof SidecarError && (error.code === -32601 || error.condition === 'agent_incompatible')) return { availability: 'agent_incompatible', message: null, balance: null, revision: null }
      if (error instanceof SidecarError) return { availability: 'unavailable', message: 'The Agent did not answer. Try again.', balance: null, revision: null }
      throw error
    }
  }

  private status(result: MeshySidecarResult): { availability: MeshySidecarResult['availability']; message: string | null; balance: number | null } {
    return { availability: result.availability, message: result.message ?? AVAILABILITY_MESSAGES[result.availability] ?? null, balance: result.balance }
  }

  private grant(scope: AgentDashboardScope, grant: Grant): string {
    const key = grant.kind === 'local' ? `local:${grant.revision}:${grant.path}` : `remote:${grant.revision}:${grant.url}`
    return `./api/meshy/asset?grant=${encodeURIComponent(this.deps.plugins.bindGrant(NAMESPACE, scope, key, grant))}`
  }

  private localAsset(scope: AgentDashboardScope, revision: string, path: string, kind: 'model' | 'image', bytes: number | null): MeshyAsset {
    const mime = kind === 'model' ? 'model/gltf-binary' : imageMime(path)
    return { url: this.grant(scope, { kind: 'local', revision, path, mime }), name: basename(path), mime, kind, bytes }
  }

  private remoteImage(scope: AgentDashboardScope, revision: string, url: string | null, name: string): MeshyAsset | null {
    if (!url) return null
    return { url: this.grant(scope, { kind: 'remote', revision, url }), name, mime: imageMime(new URL(url).pathname), kind: 'image', bytes: null }
  }

  private localItem(scope: AgentDashboardScope, revision: string, row: NativeLocal, ready: boolean): MeshyItem {
    const images = row.kind === 'image' ? row.images.map((path) => this.localAsset(scope, revision, path, 'image', null)) : []
    return {
      key: `local:${createHash('sha256').update(row.path).digest('hex').slice(0, 16)}`, task_id: row.task_id, kind: row.kind,
      title: row.prompt ?? row.name, prompt: row.prompt, task_type: null, created_at: row.modified, credits: null,
      thumbnail: images[0] ?? null, model: row.kind === 'model' ? this.localAsset(scope, revision, row.path, 'model', row.bytes) : null, images,
      saved: true, expired: false, download_incomplete: row.download_incomplete, can_download: ready && row.task_id !== null,
    }
  }

  private recentItem(scope: AgentDashboardScope, revision: string, row: NativeRecent, ready: boolean): MeshyItem {
    const images = row.image_urls.map((url, index) => this.remoteImage(scope, revision, url, `image-${String(index + 1)}`)).filter((a): a is MeshyAsset => a !== null)
    return {
      key: `recent:${row.task_id}`, task_id: row.task_id, kind: row.kind, title: row.prompt ?? row.task_type, prompt: row.prompt, task_type: row.task_type,
      created_at: row.created_at, credits: row.credits, thumbnail: this.remoteImage(scope, revision, row.thumbnail_url, 'thumbnail') ?? images[0] ?? null,
      model: row.kind === 'model' && row.local_path ? this.localAsset(scope, revision, row.local_path, 'model', null) : null, images,
      saved: row.local_path !== null, expired: row.expired, download_incomplete: false, can_download: ready,
    }
  }

  async overview(scope: AgentDashboardScope, signal?: AbortSignal): Promise<MeshyOverview> {
    const result = await this.call(scope, { action: 'overview' }, signal)
    const revision = result.revision
    const ready = result.availability === 'ready'
    const byNewest = <T extends { created_at: number | null }>(items: T[]): T[] => [...items].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    return {
      ...this.status(result), auto_rotate: result.auto_rotate ?? true, active: result.active ?? [],
      recent: revision ? byNewest((result.recent ?? []).map((row) => this.recentItem(scope, revision, row, ready))) : [],
      local: revision ? byNewest((result.local ?? []).map((row) => this.localItem(scope, revision, row, ready || result.availability === 'missing_key'))) : [],
    }
  }

  /** A directive the caller already found in its session's assistant text. Only what the native inventory lists is shown. */
  async card(scope: AgentDashboardScope, directive: MeshyDirective, signal?: AbortSignal): Promise<MeshyCard> {
    const result = await this.call(scope, { action: 'card', ...(directive.task ? { task_id: directive.task } : {}), ...(directive.path ? { path: directive.path } : {}) }, signal)
    const revision = result.revision
    const task: NativeTask | null = result.task ?? null
    const title = directive.title ?? task?.prompt ?? 'Meshy model'
    const base = { ...this.status(result), title, task: task ? publicTask(task) : null }
    if (!revision) return { ...base, item: null }
    const ready = result.availability === 'ready'
    const rows = (result.local ?? []).filter((row) => row.kind === 'model')
    // The directive's own file first, else this task's newest saved model.
    const row = rows.find((r) => r.path === directive.path) ?? (directive.path ? undefined : rows.find((r) => r.task_id === directive.task))
    if (row) {
      const item = this.localItem(scope, revision, { ...row, prompt: row.prompt ?? task?.prompt ?? null }, ready)
      return { ...base, item: { ...item, title, thumbnail: this.remoteImage(scope, revision, task?.thumbnail_url ?? null, 'thumbnail'), credits: task?.credits ?? null, task_type: task?.task_type ?? null } }
    }
    if (directive.path && !directive.task) return { ...base, message: base.message ?? 'This model is not one the Meshy plugin saved, so it is not shown.', item: null }
    if (task?.status !== 'succeeded') return { ...base, item: null }
    return {
      ...base,
      item: {
        key: `task:${task.task_id}`, task_id: task.task_id, kind: 'model', title, prompt: task.prompt, task_type: task.task_type, created_at: null, credits: task.credits,
        thumbnail: this.remoteImage(scope, revision, task.thumbnail_url, 'thumbnail'), model: null, images: [], saved: false, expired: false, download_incomplete: false,
        can_download: ready && task.has_model,
      },
    }
  }

  async task(scope: AgentDashboardScope, taskId: string, signal?: AbortSignal): Promise<{ availability: MeshyCard['availability']; message: string | null; balance: number | null; task: MeshyTask | null }> {
    const result = await this.call(scope, { action: 'task', task_id: taskId }, signal)
    return { ...this.status(result), task: result.task ? publicTask(result.task) : null }
  }

  /** The local path behind a model grant this caller holds; anything else is refused. */
  private beside(scope: AgentDashboardScope, url: string | undefined): string | undefined {
    if (!url) return undefined
    const segment = /^\.\/api\/meshy\/asset\?grant=([^&]+)$/.exec(url)?.[1]
    const bound = segment ? this.deps.plugins.grantValue(NAMESPACE, decodeURIComponent(segment), scope) : null
    const grant = bound?.value as Grant | undefined
    if (grant?.kind !== 'local' || grant.mime !== 'model/gltf-binary') throw new MeshyError('That model is no longer available. Reload it first.', 409)
    return grant.path
  }

  async details(scope: AgentDashboardScope, taskId: string, besideUrl: string | undefined, signal?: AbortSignal): Promise<MeshyDetails> {
    const path = this.beside(scope, besideUrl)
    const result = await this.call(scope, { action: 'details', task_id: taskId, ...(path ? { path } : {}) }, signal)
    const details = result.details ?? { task_id: taskId, formats: [], conversions: [], actions: [], provenance: null, is_preview: false }
    return { ...this.status(result), ...details, task_id: taskId }
  }

  async save(scope: AgentDashboardScope, input: { task_id: string; format: string; beside?: string | undefined }): Promise<MeshySaveResult> {
    const path = this.beside(scope, input.beside)
    const result = await this.call(scope, { action: 'save', task_id: input.task_id, format: input.format, ...(path ? { path } : {}) })
    return saveResult(this.status(result), result)
  }

  async saveImages(scope: AgentDashboardScope, taskId: string): Promise<MeshySaveResult> {
    const result = await this.call(scope, { action: 'save_images', task_id: taskId })
    return saveResult(this.status(result), result)
  }

  /** `GET /api/meshy/asset?grant=`: rechecks owner, generation, consent, revision and the native listing on every request. */
  async serve(ctx: RequestContext, segment: string, caller: AgentDashboardScope, signal: AbortSignal): Promise<void> {
    const bound = this.deps.plugins.grantValue(NAMESPACE, segment, caller)
    const grant = bound?.value as Grant | undefined
    if (!bound || !grant) throw new MeshyError('not found', 404)
    const check = await this.call(bound.scope, { action: 'asset', ...(grant.kind === 'local' ? { path: grant.path } : {}) }, signal)
    if (check.revision !== grant.revision) throw new MeshyError('not found', 404)
    if (grant.kind === 'local') {
      const asset = check.asset
      if (asset?.path !== grant.path || asset.mime !== grant.mime) throw new MeshyError('not found', 404)
      await serveFileBytes(ctx, asset.path, {
        mime: asset.mime, disposition: 'inline', cacheControl: 'private, no-cache', anchorRoot: asset.anchor, denyHardLinks: true,
        inspect: asset.mime === 'model/gltf-binary' ? glbRefusal : (_fd, size) => (size > MESHY_MAX_MODEL_BYTES ? 'This file is too large to show.' : null),
      })
      return
    }
    const image = await this.remote(grant.url, signal)
    await ctx.send({ status: 200, headers: { 'Content-Type': image.type, 'Cache-Control': 'private, max-age=300', 'Content-Security-Policy': "default-src 'none'; sandbox" }, body: image.body })
  }

  /** Meshy's asset host only, over https, no redirects, an image type and a size cap: refused before bytes are relayed. */
  private async remote(url: string, signal: AbortSignal): Promise<{ type: string; body: Buffer }> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || parsed.hostname !== ASSET_HOST || parsed.port || parsed.username || parsed.password) throw new MeshyError('not found', 404)
    let response: Response
    try { response = await (this.deps.fetch ?? fetch)(url, { redirect: 'error', signal, headers: { accept: 'image/png,image/jpeg,image/webp' } }) } catch { throw new MeshyError('The image could not be fetched from Meshy.', 502) }
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
    const declared = Number(response.headers.get('content-length') ?? '0')
    if (response.status !== 200 || response.redirected || !REMOTE_IMAGE_TYPES.has(type) || declared > MAX_REMOTE_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw new MeshyError(response.status === 403 || response.status === 404 || response.status === 410 ? 'This image expired on Meshy.' : 'Meshy did not return an image.', 502)
    }
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of response.body ?? []) {
      total += (chunk as Uint8Array).byteLength
      if (total > MAX_REMOTE_IMAGE_BYTES) throw new MeshyError('The image is too large.', 502)
      chunks.push(Buffer.from(chunk as Uint8Array))
    }
    return { type, body: Buffer.concat(chunks) }
  }
}

function publicTask(task: NativeTask): MeshyTask {
  return { task_id: task.task_id, status: task.status, progress: task.progress, terminal: task.terminal, stage: task.stage, error: task.error }
}

function saveResult(status: { availability: MeshySaveResult['availability']; message: string | null; balance: number | null }, result: MeshySidecarResult): MeshySaveResult {
  const complete = result.complete === true
  return { ...status, saved: result.saved ?? [], complete, error: complete ? null : result.error ?? status.message ?? 'The download did not finish.' }
}

/**
 * Extension registry: sanitized manifests from the server, declarative skins,
 * registered TTS engines, and the lifecycle event bridge from the stream store.
 */
import { useSyncExternalStore } from 'react'
import * as api from '../api/endpoints'
import { keys } from '../api/queryKeys'
import { useQuery } from '@tanstack/react-query'
import { ExtensionManifestsSchema, type ExtensionManifest, type LifecyclePayload, type ThemeDeclaration, SKIN_TOKEN_ALIASES } from '../contracts/extension'
import { get } from '../api/client'
import { subscribe as subscribeStream, getStreamState } from '../stream/store'
import type { LiveTurn } from '../stream/reducer'

export const fetchExtensionManifests = () => get('api/extensions/manifests', ExtensionManifestsSchema, { retries: 1 })

export function useExtensionManifests(enabled = true) {
  return useQuery({ queryKey: keys.extensions.manifests, queryFn: fetchExtensionManifests, staleTime: 30_000, enabled })
}

// ── Declarative skins ────────────────────────────────────────────────────────
const skins = new Map<string, ThemeDeclaration & { extensionId: string }>()
const skinListeners = new Set<() => void>()
let skinVersion = 0
export function registerExtensionSkins(manifests: ExtensionManifest[]): void {
  skins.clear()
  for (const mf of manifests) if (mf.enabled && mf.theme) skins.set(mf.theme.key, { ...mf.theme, extensionId: mf.id })
  skinVersion += 1
  for (const l of skinListeners) l()
}
export function extensionSkin(key: string): (ThemeDeclaration & { extensionId: string }) | undefined {
  return skins.get(key)
}
export function useExtensionSkins(): (ThemeDeclaration & { extensionId: string })[] {
  useSyncExternalStore((l) => { skinListeners.add(l); return () => skinListeners.delete(l) }, () => skinVersion, () => skinVersion)
  return [...skins.values()]
}
/** Apply a validated token map to the document root (no stylesheet injection). */
export function applyExtensionSkin(decl: ThemeDeclaration | null, root: HTMLElement = document.documentElement): void {
  for (const name of Array.from(root.style)) if (name.startsWith('--') && root.dataset.extSkinTokens?.split(' ').includes(name)) root.style.removeProperty(name)
  if (!decl) { delete root.dataset.extSkinTokens; delete root.dataset.extSkin; return }
  const names: string[] = []
  for (const [rawName, value] of Object.entries(decl.tokens)) { const name = SKIN_TOKEN_ALIASES[rawName] ?? rawName; root.style.setProperty(name, value); names.push(name) }
  root.dataset.extSkinTokens = names.join(' ')
  root.dataset.extSkin = decl.key
  if (decl.scheme) root.classList.toggle('dark', decl.scheme === 'dark')
}

// ── TTS engines ──────────────────────────────────────────────────────────────
export interface TtsEngine { id: string; label: string; extensionId: string; synthesize: (text: string, opts: { voice: string | null; rate: number | null; pitch: number | null }) => Promise<ArrayBuffer> }
const engines = new Map<string, TtsEngine>()
const engineListeners = new Set<() => void>()
let engineVersion = 0
export function registerTtsEngine(engine: TtsEngine): () => void {
  engines.set(engine.id, engine)
  engineVersion += 1
  for (const l of engineListeners) l()
  return () => { if (engines.get(engine.id) === engine) { engines.delete(engine.id); engineVersion += 1; for (const l of engineListeners) l() } }
}
export function ttsEngine(id: string): TtsEngine | undefined {
  return engines.get(id)
}
export function useTtsEngines(): TtsEngine[] {
  useSyncExternalStore((l) => { engineListeners.add(l); return () => engineListeners.delete(l) }, () => engineVersion, () => engineVersion)
  return [...engines.values()]
}

// ── Lifecycle bridge ─────────────────────────────────────────────────────────
const lifecycleListeners = new Set<(e: LifecyclePayload) => void>()
const seen = new Map<string, { started: boolean; ended: boolean }>()
let bridgeStarted = false
function startBridge(): void {
  if (bridgeStarted) return
  bridgeStarted = true
  let prev: Record<string, LiveTurn> = getStreamState().turns
  subscribeStream(() => {
    const next = getStreamState().turns
    for (const [sid, turn] of Object.entries(next)) {
      const key = `${sid}:${turn.streamId}`
      const state = seen.get(key) ?? { started: false, ended: false }
      const was = prev[sid]
      if (!state.started && (turn.status === 'streaming' || turn.status === 'connecting') && (was?.streamId !== turn.streamId)) {
        state.started = true
        publish({ type: 'turn:start', sessionId: sid, streamId: turn.streamId, timestamp: Date.now() / 1000, startedAt: turn.startedAt / 1000 })
      } else if (!state.started && turn.status === 'streaming') {
        state.started = true
        publish({ type: 'turn:start', sessionId: sid, streamId: turn.streamId, timestamp: Date.now() / 1000, startedAt: turn.startedAt / 1000 })
      }
      if (!state.ended && (turn.status === 'done' || turn.status === 'error' || turn.status === 'cancelled')) {
        state.ended = true
        const type = turn.status === 'done' ? 'turn:complete' : turn.status === 'cancelled' ? 'turn:cancel' : 'turn:error'
        publish({ type, sessionId: sid, streamId: turn.streamId, timestamp: Date.now() / 1000, endedAt: (turn.doneAt ?? Date.now()) / 1000, status: turn.status })
      }
      seen.set(key, state)
    }
    if (seen.size > 200) { const first = seen.keys().next().value; if (first) seen.delete(first) }
    prev = next
  })
}
function publish(event: LifecyclePayload): void {
  for (const l of lifecycleListeners) { try { l(event) } catch { /* one listener never blocks the others */ } }
}
export function subscribeLifecycle(listener: (e: LifecyclePayload) => void): () => void {
  startBridge()
  lifecycleListeners.add(listener)
  return () => lifecycleListeners.delete(listener)
}

export const extensionAssetUrl = api.rawFileUrl

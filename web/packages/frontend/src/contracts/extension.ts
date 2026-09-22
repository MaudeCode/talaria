import { z } from 'zod'
import { TOKEN_NAMES, type TokenName } from '../theme/skins'

/**
 * Unified extension platform, protocol version 1 (HWEB-100).
 * See docs/architecture/extension-protocol-v1.md.
 */
export const EXTENSION_PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 64 * 1024
export const MAX_STORAGE_VALUE_BYTES = 32 * 1024
export const MAX_STORAGE_KEYS = 64
export const MAX_TOAST_CHARS = 200

export const ExtensionIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const CapabilitySchema = z.enum(['settings', 'storage', 'sidecar', 'lifecycle', 'theme', 'tts', 'navigate', 'toast', 'session'])
export type Capability = z.infer<typeof CapabilitySchema>

export const SettingsFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  type: z.enum(['boolean', 'string', 'number', 'integer', 'enum']),
  label: z.string().max(120),
  description: z.string().max(300).optional(),
  default: z.union([z.boolean(), z.string().max(2000), z.number()]).nullable().optional(),
  options: z.array(z.object({ value: z.string().max(120), label: z.string().max(120) })).max(50).optional(),
})
export type SettingsField = z.infer<typeof SettingsFieldSchema>

/**
 * Declarative skin: a validated token map over the theme vocabulary (src/theme/skins.ts), plus the
 * legacy protocol-v1 names, which map onto their current equivalents (SKIN_TOKEN_ALIASES).
 */
export const SKIN_TOKEN_ALIASES: Record<string, TokenName> = { '--surface2': '--surface-subtle', '--text2': '--muted', '--accent2': '--accent-hover', '--accent3': '--accent-text', '--accent-contrast': '--accent-fg', '--sidebar-text': '--text', '--user-bubble': '--user-bubble-bg', '--assistant-bubble': '--assistant-msg-bg', '--link': '--link-color' }
export const SKIN_TOKEN_NAMES = [...TOKEN_NAMES, ...Object.keys(SKIN_TOKEN_ALIASES), '--accent-rgb'] as [string, ...string[]]
export const SKIN_VALUE_RE = /^(#(?:[0-9a-fA-F]{3,8})|rg(?:b|ba)\(\s*[0-9.,%\s/]+\)|hsl(?:a)?\(\s*[0-9.,%\s/deg]+\)|[0-9]{1,3}\s*,\s*[0-9]{1,3}\s*,\s*[0-9]{1,3}|[a-zA-Z]{3,20}|[0-9.]+(?:px|em|rem|%)?)$/
export const ThemeDeclarationSchema = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  name: z.string().min(1).max(40),
  scheme: z.enum(['light', 'dark']).optional(),
  colors: z.array(z.string().regex(SKIN_VALUE_RE)).max(3).optional(),
  tokens: z.record(z.enum(SKIN_TOKEN_NAMES), z.string().regex(SKIN_VALUE_RE)).refine((t) => Object.keys(t).length > 0, 'at least one token'),
})
export type ThemeDeclaration = z.infer<typeof ThemeDeclarationSchema>

export const SidecarDeclarationSchema = z.object({ origin: z.url().max(200), health_path: z.string().max(200).optional(), consented: z.boolean().optional() })

/** Sanitized manifest as served by GET /api/extensions/manifests. */
export const ExtensionManifestSchema = z.object({
  id: ExtensionIdSchema,
  name: z.string().min(1).max(80),
  version: z.string().max(40).optional(),
  description: z.string().max(300).optional(),
  source: z.enum(['manifest', 'gallery', 'plugin']),
  enabled: z.boolean(),
  /** App-relative URL of the sandboxed panel document, or null for a headless extension. */
  panel: z.string().max(400).nullable(),
  nav: z.object({ label: z.string().min(1).max(40), icon: z.string().max(40).optional() }).nullable(),
  capabilities: z.array(CapabilitySchema).max(16),
  permissions: z.record(z.string().max(64), z.boolean()).optional(),
  settings_schema: z.array(SettingsFieldSchema).max(64),
  theme: ThemeDeclarationSchema.nullable(),
  tts: z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), label: z.string().min(1).max(60) }).nullable(),
  sidecar: SidecarDeclarationSchema.nullable(),
  /** Legacy injected-script entries cannot run; they are listed for migration only. */
  legacy_injection: z.boolean(),
  warnings: z.array(z.string().max(200)).max(16),
})
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>
export const ExtensionManifestsSchema = z.object({ protocol_version: z.literal(EXTENSION_PROTOCOL_VERSION), manifests: z.array(ExtensionManifestSchema).max(200) })

// ── Wire protocol (host <-> iframe over a dedicated MessageChannel) ─────────
const Nonce = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)

/** Host -> iframe on window.postMessage, carrying port2. */
export const HelloMessageSchema = z.object({ type: z.literal('hermes:hello'), version: z.literal(EXTENSION_PROTOCOL_VERSION), nonce: Nonce, extensionId: ExtensionIdSchema, capabilities: z.array(CapabilitySchema) })
/** iframe -> host on the port. */
export const ReadyMessageSchema = z.object({ type: z.literal('hermes:ready'), version: z.literal(EXTENSION_PROTOCOL_VERSION), nonce: Nonce, sdkVersion: z.string().max(20).optional() })

export const MethodSchema = z.enum([
  'settings.get', 'settings.set', 'settings.reset',
  'storage.get', 'storage.set', 'storage.remove', 'storage.clear', 'storage.keys',
  'sidecar.fetch',
  'lifecycle.subscribe', 'lifecycle.unsubscribe',
  'session.current',
  'theme.current',
  'toast.show',
  'navigate.session',
  'tts.register',
])
export type Method = z.infer<typeof MethodSchema>

export const METHOD_CAPABILITY: Record<Method, Capability> = {
  'settings.get': 'settings', 'settings.set': 'settings', 'settings.reset': 'settings',
  'storage.get': 'storage', 'storage.set': 'storage', 'storage.remove': 'storage', 'storage.clear': 'storage', 'storage.keys': 'storage',
  'sidecar.fetch': 'sidecar',
  'lifecycle.subscribe': 'lifecycle', 'lifecycle.unsubscribe': 'lifecycle',
  'session.current': 'session',
  'theme.current': 'theme',
  'toast.show': 'toast',
  'navigate.session': 'navigate',
  'tts.register': 'tts',
}

export const RequestMessageSchema = z.object({ type: z.literal('request'), nonce: Nonce, id: z.number().int().nonnegative().max(1e9), method: MethodSchema, params: z.unknown().optional() })
export const ResponseMessageSchema = z.object({ type: z.literal('response'), nonce: Nonce, id: z.number().int(), ok: z.boolean(), result: z.unknown().optional(), error: z.object({ code: z.string().max(64), message: z.string().max(500) }).optional() })
export const EventMessageSchema = z.object({ type: z.literal('event'), nonce: Nonce, name: z.enum(['turn:start', 'turn:complete', 'turn:error', 'turn:cancel', 'theme:changed', 'tts:synthesize']), payload: z.unknown().optional() })
/** iframe -> host reply to a host-initiated `tts:synthesize` event. */
export const TtsResultMessageSchema = z.object({ type: z.literal('tts:result'), nonce: Nonce, requestId: z.number().int(), ok: z.boolean(), error: z.string().max(300).optional() })
export const IframeMessageSchema = z.discriminatedUnion('type', [ReadyMessageSchema, RequestMessageSchema, TtsResultMessageSchema])
export const HostMessageSchema = z.discriminatedUnion('type', [ResponseMessageSchema, EventMessageSchema])

// Method params/results
export const SettingsGetParams = z.object({ key: z.string().max(64).optional() })
export const SettingsSetParams = z.object({ key: z.string().max(64), value: z.union([z.boolean(), z.string().max(2000), z.number(), z.null()]) })
export const StorageKeyParams = z.object({ key: z.string().min(1).max(128) })
export const StorageSetParams = z.object({ key: z.string().min(1).max(128), value: z.string().max(MAX_STORAGE_VALUE_BYTES) })
export const SidecarFetchParams = z.object({ path: z.string().max(1024).regex(/^[^\s]*$/), method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(), headers: z.record(z.string().max(64), z.string().max(1024)).optional(), body: z.string().max(MAX_MESSAGE_BYTES).optional() })
export const SidecarFetchResult = z.object({ status: z.number().int(), headers: z.record(z.string(), z.string()), body: z.string() })
export const LifecycleSubscribeParams = z.object({ events: z.array(z.enum(['turn:start', 'turn:complete', 'turn:error', 'turn:cancel'])).min(1).max(4) })
export const LifecyclePayloadSchema = z.object({ type: z.enum(['turn:start', 'turn:complete', 'turn:error', 'turn:cancel']), sessionId: z.string().max(128), streamId: z.string().max(128), timestamp: z.number(), startedAt: z.number().optional(), endedAt: z.number().optional(), status: z.string().max(40).optional() })
export type LifecyclePayload = z.infer<typeof LifecyclePayloadSchema>
export const ToastParams = z.object({ text: z.string().min(1).max(MAX_TOAST_CHARS), ttl: z.number().int().min(500).max(10_000).optional() })
export const NavigateSessionParams = z.object({ sessionId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/) })
export const TtsRegisterParams = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/), label: z.string().min(1).max(60) })
export const TtsSynthesizePayload = z.object({ requestId: z.number().int(), text: z.string().max(4000), voice: z.string().max(80).nullable(), rate: z.number().nullable(), pitch: z.number().nullable() })

export function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

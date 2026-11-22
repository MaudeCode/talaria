import { z } from 'zod'

/**
 * TAL-2661: an owner's full native Agent-home backup (`hermes backup`). The Agent's command archives the whole Agent root,
 * every profile included, so only a server owner signed in to the root profile, outside isolated profile mode, may run it.
 * The server keeps one backup at a time in a private directory of its own and deletes it after `retention_seconds`.
 */
export const AgentBackupScopeSchema = z.literal('agent_home')

/** Why this request cannot start a backup: a named profile is active, the server is pinned to one profile, or no Agent answers. */
export const AgentBackupUnavailableSchema = z.enum(['named_profile', 'isolated_profile', 'agent_unavailable'])

export const AgentBackupIdSchema = z.string().regex(/^[a-f0-9]{32}$/)

export const AgentBackupJobSchema = z.object({
  id: AgentBackupIdSchema,
  /** `running` until the Agent's command exits; `ready` holds an archive to download; `failed` and `cancelled` hold none. */
  state: z.enum(['running', 'ready', 'failed', 'cancelled']),
  /** While running: `starting` before the command reports, then the command's own `scanning` and `archiving` phases. */
  phase: z.enum(['starting', 'scanning', 'archiving']).nullable(),
  /** While archiving: files written so far out of `total`. */
  completed: z.number().int().nonnegative().nullable(),
  total: z.number().int().nonnegative().nullable(),
  /** Unix seconds. */
  started_at: z.number(),
  finished_at: z.number().nullable(),
  /** When ready: false when the Agent kept an archive missing some files, so the rest can still be restored. */
  complete: z.boolean().nullable(),
  file_name: z.string().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  /** When ready: the owner-only `GET /api/agent-backup/download` URL for this archive, relative to the app root. */
  download_url: z.string().nullable(),
  /** When ready: unix seconds after which the server deletes the archive. */
  expires_at: z.number().nullable(),
  /** When failed: one bounded line, the Agent's own error line where it gave one. */
  error: z.string().nullable(),
})
export type AgentBackupJob = z.infer<typeof AgentBackupJobSchema>

export const AgentBackupStatusSchema = z.object({
  scope: AgentBackupScopeSchema,
  available: z.boolean(),
  unavailable_reason: AgentBackupUnavailableSchema.nullable(),
  /** The host whose Agent home is backed up, as it names itself. */
  server: z.string(),
  /** The root profile that owns the Agent home, as this server names it. */
  profile: z.string(),
  retention_seconds: z.number().int().positive(),
  /** The current or most recent backup; null when there is none or it was deleted. */
  job: AgentBackupJobSchema.nullable(),
})
export type AgentBackupStatus = z.infer<typeof AgentBackupStatusSchema>

export const AgentBackupCreateSchema = z.object({ scope: AgentBackupScopeSchema })

/** The sidecar runs the Agent's own command for the root `profile_home`, writing `output` in a private directory the server created. */
export const AGENT_BACKUP_METHODS = {
  'backup.create': {
    params: z.object({ profile_home: z.string().min(1), scope: AgentBackupScopeSchema, output: z.string().min(1) }),
    /** `incomplete`: the command kept an archive missing some files (exit 1). `busy`: another backup holds the Agent's backup lock. */
    result: z.object({
      status: z.enum(['completed', 'incomplete', 'failed', 'busy', 'cancelled']),
      reason: z.string().optional(), returncode: z.number().int().optional(), size_bytes: z.number().int().nonnegative().optional(),
    }),
    stream: z.discriminatedUnion('event', [z.object({ event: z.literal('progress'), data: z.object({
      phase: z.enum(['scanning', 'archiving']), completed: z.number().int().nonnegative().optional(), total: z.number().int().nonnegative().optional(),
    }) })]),
  },
} as const

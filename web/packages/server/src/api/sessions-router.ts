/** Session, project, share, workspace, and file procedures. */
import { implement } from '@orpc/server'
import { sessionsContract, workspacesContract, type Attachment, type SessionDeleteRefused, type SessionsListQuery } from '@maudecode/talaria-web-contracts'
import { mkdirSync } from 'node:fs'
import { closeSync, existsSync, lstatSync, statSync } from 'node:fs'
import { writeFully } from '../fs/atomic.js'
import { basename, dirname, extname, join, relative } from 'node:path'
import { platform } from 'node:os'
import { spawn } from 'node:child_process'
import { ifNoneMatchMatches, type RequestContext } from '../http/context.js'
import { SidecarError } from '../sidecar/client.js'
import { HttpError, RawResponse, requireFields, type ApiContext } from './router.js'
import { GitWorkspaceError, WORKSPACE_BUSY_MESSAGE } from '../workspace/git.js'
import { requestSessionIdGuard } from './session-visibility.js'
import { HttpFailure, sanitizePaths } from '../sessions/service.js'
import { compressionStatusPayload } from '../sessions/compress.js'
import { titleFailureReason } from '../sessions/titles.js'
import { SessionNotFound } from '../sessions/store.js'
import { type Session } from '../sessions/session.js'
import { isBlockedSystemPath, REMOTE_WORKSPACE_UNSUPPORTED_CODE, REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE, stripSurroundingQuotes } from '../workspace/workspaces.js'
import { isWithin, resolvePathLikePython } from '../workspace/paths.js'
import { fileSourceSession, managedBuffers } from '../workspace/managed-buffers.js'
import { previewUrl, readFilePreview } from '../workspace/preview.js'
import { dirSignature, FileExistsError, listDir, makeAnchoredDir, NotFoundError, openAnchoredCreateFd, replaceAnchoredFile, PathTraversalError, renameAnchored, rmtreeAnchored, safeResolve, serializeEntriesForBrowser, unlinkAnchored, FileTooLargeError } from '../workspace/fs.js'
import { randomUUID } from 'node:crypto'
import { pyOsError, pyRepr, str } from '../util.js'
import { ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { RelayPairingError } from '../sessions/relay.js'
import { loginHash, WebPushRequestError, type WebPushRequester } from '../sessions/notify/web-push.js'
import { requestBaseUrl } from './auth-raw.js'
import { EscapeGrantExpired, type EscapeRequest } from '../workspace/escape.js'
import { ProfileError } from '../profiles/profiles.js'
import type { Settings } from '../settings.js'
import { ConfigUnavailable } from '../config/agent-config.js'

const os = implement({ ...sessionsContract, ...workspacesContract }).$context<ApiContext>().use(requestSessionIdGuard)

/** Map service failures to the Python-shaped error body. */
export function failure(error: unknown): never {
  if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
  if (error instanceof SessionNotFound) throw new HttpError(404, 'Session not found')
  if (error instanceof ConfigUnavailable) throw new HttpError(503, error.message)
  if (error instanceof ProfileError) throw new HttpError(error.status, error.message)
  throw error
}

/** Handler boundary: contract outputs are pinned loose objects (index signatures), so the concrete return type is erased here like the `as never` casts elsewhere. */
async function run<T>(fn: () => Promise<T> | T): Promise<never> {
  try {
    return (await fn()) as never
  } catch (error) {
    return failure(error)
  }
}

function queryBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback
  const raw = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true
  if (['0', 'false', 'no', 'off'].includes(raw)) return false
  return fallback
}
const queryFlag = (value: string | undefined): boolean => ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase())
function queryPositiveInt(value: string | undefined, fallback: number | null, maximum?: number): number | null {
  const n = Number.parseInt((value ?? '').trim(), 10)
  if (!Number.isFinite(n) || n < 0) return fallback
  return maximum !== undefined ? Math.min(n, maximum) : n
}

const sanitizeError = sanitizePaths

/** Python `_guard_request_session_visibility` for a body/query session id. */
async function guardVisibility(ctx: RequestContext, sid: unknown): Promise<void> {
  if (!(await ctx.deps.sessions.sessionIdVisible(sid))) throw new HttpError(404, 'Session not found')
}

/** Python `float(body["since"])` for the handoff dock: a unix time or numeric string; absent is null. */
function handoffSince(value: unknown): number | null {
  if (value === undefined || value === null) return null
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (Number.isNaN(n)) throw new HttpError(400, 'since must be a unix timestamp (number)')
  return n
}

/** The handoff dock's session id and `since`, validated in the predecessor's order. */
async function handoffInput(ctx: RequestContext, input: { session_id?: string | undefined; since?: unknown }): Promise<{ sid: string; since: number | null }> {
  requireFields(input, 'session_id')
  const sid = str(input.session_id).trim()
  if (!sid) throw new HttpError(400, 'session_id is required')
  const since = handoffSince(input.since)
  await guardVisibility(ctx, sid)
  return { sid, since }
}

function allProfilesEnabled(ctx: RequestContext, value: string | undefined): boolean {
  return queryFlag(value) && !ctx.deps.isolatedProfileMode()
}

/** Search inputs that select the sidebar rows rather than every stored session (TAL-308). */
const SIDEBAR_SEARCH_KEYS = ['project_id', 'sidebar_source', 'include_archived', 'exclude_hidden', 'show_cli_sessions', 'show_claude_code_sessions', 'show_cron_sessions', 'show_webhook_sessions', 'show_kanban_sessions'] as const

/** The `/api/sessions` row selection for a list or sidebar-search query (TAL-308 shares it). */
async function sidebarListParams(ctx: RequestContext, input: SessionsListQuery): Promise<Parameters<RequestContext['deps']['sessions']['list']>[0]> {
  return sidebarListSelection(await ctx.deps.settings.load(), input, allProfilesEnabled(ctx, input.all_profiles))
}

/** The row selection `/api/sessions` makes for `input` under `settings`; the agent's `session_list` uses it with no input (TAL-1164). */
export function sidebarListSelection(settings: Settings, input: SessionsListQuery, allProfiles: boolean): Parameters<RequestContext['deps']['sessions']['list']>[0] {
  const overrideKeys = ['show_cli_sessions', 'show_claude_code_sessions', 'show_cron_sessions', 'show_webhook_sessions', 'show_kanban_sessions'] as const
  const sidebarSourceRaw = (input.sidebar_source ?? '').trim().toLowerCase()
  return {
    allProfiles,
    includeArchived: queryFlag(input.include_archived),
    excludeHidden: queryFlag(input.exclude_hidden),
    visibleOnly: true,
    showCliSessions: queryBool(input.show_cli_sessions, Boolean(settings.show_cli_sessions)),
    showClaudeCodeSessions: queryBool(input.show_claude_code_sessions, Boolean(settings.show_claude_code_sessions)),
    showPreviousMessagingSessions: Boolean(settings.show_previous_messaging_sessions),
    showCronSessions: queryBool(input.show_cron_sessions, Boolean(settings.show_cron_sessions)),
    showWebhookSessions: queryBool(input.show_webhook_sessions, Boolean(settings.show_webhook_sessions)),
    showKanbanSessions: queryBool(input.show_kanban_sessions, Boolean(settings.show_kanban_sessions)),
    requestVisibilityOverrides: overrideKeys.some((k) => input[k] !== undefined),
    sidebarSource: sidebarSourceRaw === 'webui' || sidebarSourceRaw === 'cli' ? sidebarSourceRaw : null,
    archivedLimit: queryPositiveInt(input.archived_limit, null, 2000),
    archivedOffset: queryPositiveInt(input.archived_offset, 0, 200000) ?? 0,
  }
}

export const sessionsRouter = os.router({
  sessions: {
    references: os.sessions.references.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.sessions.referenceSearch(input.q ?? '', await sidebarListParams(ctx, {})))),
    list: os.sessions.list.handler(({ input, context: { ctx } }) => run(async () => {
      const { body, etag } = await ctx.deps.sessions.list((await sidebarListParams(ctx, input)))
      ctx.extraResponseHeaders = { etag }
      if (ifNoneMatchMatches(ctx.header('if-none-match') ?? '', etag)) ctx.notModified = true
      return body
    })),
    search: os.sessions.search.handler(({ input, context: { ctx } }) => run(async () => {
      // Python: `int(depth)` falls back to 5 when malformed.
      const depthRaw = (input.depth ?? '5').trim()
      const depth = /^[+-]?\d+$/.test(depthRaw) ? Math.max(0, Number.parseInt(depthRaw, 10)) : 5
      const opts = { content: (input.content ?? '1') === '1', depth, allProfiles: allProfilesEnabled(ctx, input.all_profiles) }
      // TAL-308: any sidebar filter answers from the sidebar's own rows; without one the store-only search stays.
      if (SIDEBAR_SEARCH_KEYS.some((k) => input[k] !== undefined)) {
        return await ctx.deps.sessions.sidebarSearch(input.q ?? '', (await sidebarListParams(ctx, input)), { ...opts, projectId: input.project_id?.trim() || null }) as { sessions: Record<string, unknown>[]; all_profiles: boolean; active_profile: string; query?: string; count?: number }
      }
      return await ctx.deps.sessions.search(input.q ?? '', opts) as { sessions: Record<string, unknown>[]; all_profiles: boolean; active_profile: string; query?: string; count?: number }
    })),
    cleanup: os.sessions.cleanup.handler(({ context: { ctx } }) => run(async () => (await ctx.deps.sessions.cleanup(false)) as { ok: true; cleaned: number })),
    cleanupZeroMessage: os.sessions.cleanupZeroMessage.handler(({ context: { ctx } }) => run(async () => (await ctx.deps.sessions.cleanup(true)) as { ok: true; cleaned: number })),
    // TAL-627: each id runs the single-session route's own guards, lock and cleanup, one at a time; a failure becomes
    // that id's result and the rest still run.
    bulk: os.sessions.bulk.handler(async ({ input, context: { ctx } }) => {
      const results = []
      for (const sid of input.session_ids) {
        try {
          await guardVisibility(ctx, sid)
          if (input.action === 'delete') {
            const { state_db_cleanup_failed } = await ctx.deps.sessions.delete(sid)
            results.push({ session_id: sid, ok: true, state_db_cleanup_failed: Boolean(state_db_cleanup_failed) })
          } else {
            await ctx.deps.sessions.archive(sid, input.action === 'archive')
            results.push({ session_id: sid, ok: true })
          }
        } catch (error) {
          const [status, message] = error instanceof HttpError ? [error.status, error.message]
            : error instanceof HttpFailure ? [error.status, error.message]
              : error instanceof SessionNotFound ? [404, 'Session not found']
                : [500, sanitizeError(error)]
          const refused = error instanceof HttpFailure ? error.extra.refused as SessionDeleteRefused | undefined : undefined
          results.push({ session_id: sid, ok: false, status, error: message, ...(refused ? { refused } : {}) })
        }
      }
      return { results }
    }),
  },
  session: {
    // No visibility guard here: `detail()` answers 409 `session_profile_mismatch` so the frontend can switch to the owning profile.
    get: os.session.get.handler(({ input, context: { ctx } }) => run(async () => {
      await ctx.deps.sessions.deps.warmModelOptions?.()
      await ctx.deps.turns.loadGoal(input.session_id.trim())
      try {
        return { session: (await ctx.deps.sessions.detail(input.session_id, input)) as { session_id: string; title: string } }
      } catch (error) {
        // Runs left on the relay by a deletion that predates `clearRelayCompletions` clear when the id is next requested.
        const sid = input.session_id.trim()
        if (error instanceof HttpFailure && error.status === 404 && (await ctx.deps.sessionStore.wasDeleted(sid))) (await ctx.deps.notifications.clearDeleted(sid, ctx.deps.activeProfile()))
        throw error
      }
    })),
    status: os.session.status.handler(({ input, context: { ctx } }) => run(async () => {
      if (!input.session_id) throw new HttpError(400, 'Missing session_id')
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.status(input.session_id)) as { session_id: string }
    })),
    contextDetail: os.session.contextDetail.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return ctx.deps.sessions.contextDetail(input.session_id, input.context_detail_key)
    })),
    usage: os.session.usage.handler(({ input, context: { ctx } }) => run(async () => {
      if (!input.session_id) throw new HttpError(400, 'Missing session_id')
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.usage(input.session_id)) as { input_tokens: number; output_tokens: number; total_tokens: number; estimated_cost: unknown; model: string | null }
    })),
    executionModes: os.session.executionModes.handler(({ context: { ctx } }) => run(async () => ctx.deps.sessions.owner!.modes(ctx.deps.activeProfile()))),
    new: os.session.new.handler(({ input, context: { ctx } }) => run(async () => {
      if (input.source_references?.length && input.execution_mode && input.execution_mode !== 'normal') throw new HttpError(400, 'Conversation references require an ordinary chat')
      if (input.execution_mode === 'ignore_config' || input.execution_mode === 'safe') {
        // The owner has no worktree flow; refuse it rather than silently start an ordinary chat.
        if (input.worktree !== undefined && input.worktree !== false) throw new HttpError(400, 'A diagnostic chat cannot start in a new worktree')
        await ctx.deps.agentConfig.read(ctx.deps.profileHome(ctx.deps.activeProfile())).catch(() => undefined)
        return { session: (await ctx.deps.sessions.createDiagnostic(input, input.execution_mode)) as { session_id: string; title: string } }
      }
      // Python: an invisible prev_session_id is ignored (the service drops it), never an error (#5420).
      const profile = input.profile || null
      // The middleware warms only the cookie profile's config; new-session defaults read the target's synchronously.
      // `profileHome` refuses a profile whose home escapes the profiles root (400) before any warm-up failure is swallowed.
      if (profile) { const home = ctx.deps.profileHome(profile); await ctx.deps.agentConfig.read(home).catch(() => undefined) }
      let worktreeSkipped: string | null = null
      const s = await ctx.deps.sessions.createWithReferences(input, async (sessionId, validateSources) => {
        let worktree: { path: string; branch: string; repo_root: string; created_at: number } | null = null
        const explicit = 'worktree' in input
        let requested = explicit ? input.worktree === true || ['1', 'true', 'yes', 'on'].includes(String(input.worktree).trim().toLowerCase()) : ctx.deps.worktreeDefault(profile)
        if (requested && !ctx.deps.workspaces.profileSupportsLocalIo(profile)) {
          if (explicit) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_CODE, { message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE })
          worktreeSkipped = REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE
          requested = false
        }
        if (requested) {
          try {
            let base = input.workspace ? (await ctx.deps.sessions.resolveNewSessionWorkspace(input, null, profile)) : null
            base ??= (await ctx.deps.workspaces.resolveTrusted((await ctx.deps.workspaces.lastWorkspace(profile)), profile))
            const repo = base
            worktree = await ctx.deps.git.holdWrite(repo, async () => {
              await validateSources?.()
              return ctx.deps.worktrees.create(repo)
            })
          } catch (error) {
            if (error instanceof HttpFailure) throw error
            if (error instanceof GitWorkspaceError) throw new HttpError(409, error.message, { code: error.code })
            // Python: `ValueError`/`TypeError` (not a repo, not a directory) → 400 or a degraded plain session; the Agent
            // helper failing (`RuntimeError`) → 500 `Failed to create worktree: ...`.
            const valueError = error instanceof SidecarError ? (error.condition === 'not_a_repo' || error.condition === 'invalid_params' || error.code === -32602) : !(error instanceof Error && 'code' in error)
            if (!valueError) throw new HttpError(500, `Failed to create worktree: ${(error as Error).message}`)
            if (explicit) throw new HttpError(400, (error as Error).message)
            worktree = null
            worktreeSkipped = (error as Error).message
          }
        }
        // A worktree has already passed source validation before allocation.
        return ctx.deps.sessions.create(input, { worktree, ...(sessionId ? { sessionId } : {}), ...(!worktree && validateSources ? { validateSources } : {}) })
      })
      const payload: Record<string, unknown> = { session: (await ctx.deps.sessions.publicSession(s)) }
      if (worktreeSkipped) payload.worktree_skipped = worktreeSkipped
      return payload as { session: { session_id: string; title: string }; worktree_skipped?: string }
    })),
    rename: os.session.rename.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      if (!input.title) throw new HttpError(400, 'Missing required field(s): title')
      return (await ctx.deps.sessions.rename(input.session_id, input.title)) as { session: { session_id: string; title: string } }
    })),
    delete: os.session.delete.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.delete(input.session_id)) as { ok: true; state_db_cleanup_failed: boolean }
    })),
    pin: os.session.pin.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return ctx.deps.sessions.pin(input.session_id, input.pinned ?? true) as Promise<{ ok: true; session: { session_id: string; title: string } }>
    })),
    archive: os.session.archive.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.archive(input.session_id, input.archived ?? true)) as { ok: true; session: { session_id: string; title: string } }
    })),
    move: os.session.move.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.move(input.session_id, input.project_id || null)) as { ok: true; session: { session_id: string; title: string } }
    })),
    duplicate: os.session.duplicate.handler(({ input, context: { ctx } }) => run(async () => {
      if (!input.session_id) throw new HttpError(400, 'session_id is required')
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.duplicate(input.session_id)) as { session: { session_id: string; title: string } }
    })),
    branch: os.session.branch.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.branch(input.session_id, input)) as { session_id: string; title: string; parent_session_id: string }
    })),
    truncate: os.session.truncate.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      // A body without `confirm_deep_truncate` is a released App's, which asked on the device before sending it.
      const hold = input.confirm_deep_truncate === undefined ? null : { confirmToken: input.confirm_deep_truncate ? input.confirm_token ?? null : null }
      return (await ctx.deps.sessions.truncate(input.session_id, input.keep_count, hold)) as { ok: true; session: { session_id: string; title: string } } | { ok: false; confirm_required: true; discard_user_turns: number; discard_messages: number; confirm_token: string }
    })),
    clear: os.session.clear.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.clear(input.session_id)) as { ok: true; session: { session_id: string; title: string } }
    })),
    retry: os.session.retry.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.retry(input.session_id)) as { ok: true; last_user_text: string; last_user_prompt: string; last_user_attachments: Attachment[]; removed_count: number } | { error: string }
    })),
    undo: os.session.undo.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.undo(input.session_id)) as { ok: true; removed_count: number; removed_preview: string } | { error: string }
    })),
    update: os.session.update.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.update(input.session_id, input)) as { session: { session_id: string; title: string } }
    })),
    toolsets: os.session.toolsets.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.setToolsets(input.session_id, input.toolsets)) as { ok: true; enabled_toolsets: string[] | null }
    })),
    yoloGet: os.session.yoloGet.handler(({ input, context: { ctx } }) => run(() => ctx.deps.sessions.yolo(input.session_id) as { yolo_enabled: boolean })),
    yoloSet: os.session.yoloSet.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id.trim()
      // Python `_enable_session_yolo_and_release_pending`: turning YOLO on releases every parked approval (`once`)
      // before the flag is committed, so a turn blocked on an approval card resumes; turning it off only flips the flag.
      if (!sid) throw new HttpError(400, 'Missing required field(s): session_id')
      if (input.enabled !== undefined && !input.enabled) {
        const disabled = await ctx.deps.turns.disableYolo(sid)
        if (typeof disabled._status === 'number' && disabled._status >= 400) { const { _status, error, ...rest } = disabled; throw new HttpError(_status, str(error), rest) }
        return disabled as { ok: true; yolo_enabled: boolean }
      }
      const released = await ctx.deps.turns.respondApproval(sid, 'once', '', true)
      return { ok: true as const, yolo_enabled: Boolean(released.yolo_enabled ?? ctx.deps.sessions.yolo(sid).yolo_enabled), ...(released.stale_cleared ? { stale_cleared: true } : {}) }
    })),
    import: os.session.import.handler(({ input, context: { ctx } }) => run(async () => (await ctx.deps.sessions.import(input)) as { ok: true; session: { session_id: string; title: string } })),
    regenerateTitle: os.session.regenerateTitle.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id
      let session: Session
      try { session = (await ctx.deps.sessionStore.get(sid)) } catch { throw new HttpError(404, 'Session not found') }
      if ((await ctx.deps.sessions.isReadOnly(session)) || (await ctx.deps.sessions.isSubagentViewOnly(sid))) throw new HttpError(403, 'Read-only imported sessions cannot regenerate titles')
      const generated = await ctx.deps.turns.generateTitle(session, { preferLatest: Boolean(input.prefer_latest) })
      if (!generated.title) {
        ctx.deps.log(`[webui] title regenerate failed for ${sid}: status=${generated.status || 'empty'}`)
        throw new HttpError(422, titleFailureReason(generated.status))
      }
      const current = await ctx.deps.sessions.persistGeneratedTitle(sid, generated.title, 'session_title_regenerate')
      return { session: (await ctx.deps.sessions.wireRow(current)), title: current.title, status: generated.status, raw_preview: generated.rawPreview.slice(0, 240) }
    })),
    recoveryAudit: os.session.recoveryAudit.handler(({ context: { ctx } }) => run(async () => (await ctx.deps.sessions.recoveryAudit()))),
    recoveryRepairSafe: os.session.recoveryRepairSafe.handler(({ context: { ctx } }) => run(async () => {
      const result = await ctx.deps.sessions.recoveryRepairSafe()
      if (!result.clean) throw new RawResponse(409, result)
      return result
    })),
    lineageReport: os.session.lineageReport.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id ?? ''
      if (!sid) throw new HttpError(400, 'session_id required')
      const report = await ctx.deps.sessions.lineageReport(sid)
      if (!report.found) throw new HttpError(404, 'Session not found')
      return report as { found: true }
    })),
    compressionRecoveryStart: os.session.compressionRecoveryStart.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id')
      const sid = str(input.session_id).trim()
      if (!sid) throw new HttpError(400, 'session_id is required')
      return (await ctx.deps.sessions.compressionRecoveryStart(sid)) as { ok: true }
    })),
    // TAL-255: the iOS `/compress` route joins or starts the session's compression job and answers with its result.
    compress: os.session.compress.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id')
      const sid = str(input.session_id).trim()
      await guardVisibility(ctx, sid)
      const job = await ctx.deps.sessions.startCompression(sid, input.focus_topic || input.topic)
      await job.done
      if (job.status === 'error') throw new HttpError(job.error_status ?? 400, job.error ?? 'Compression failed', job.error_extra)
      return job.result as { ok: true; session: { session_id: string; title: string }; summary: Record<string, unknown>; focus_topic: string | null }
    })),
    compressStart: os.session.compressStart.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id')
      const sid = str(input.session_id).trim()
      await guardVisibility(ctx, sid)
      return compressionStatusPayload(await ctx.deps.sessions.startCompression(sid, input.focus_topic || input.topic)) as { status: 'running' }
    })),
    // TAL-258: the handoff dock. Rounds decides when to offer it; the summary is generated and appended to the transcript.
    conversationRounds: os.session.conversationRounds.handler(({ input, context: { ctx } }) => run(async () => {
      const { sid, since } = (await handoffInput(ctx, input))
      return (await ctx.deps.sessions.conversationRounds(sid, since))
    })),
    handoffSummary: os.session.handoffSummary.handler(({ input, context: { ctx } }) => run(async () => {
      const { sid, since } = (await handoffInput(ctx, input))
      return (await ctx.deps.sessions.handoffSummary(sid, since))
    })),
    compressStatus: os.session.compressStatus.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id.trim()
      if (!sid) throw new HttpError(400, 'session_id is required')
      await guardVisibility(ctx, sid)
      const job = (await ctx.deps.sessions.compressionJob(sid))
      return (job ? compressionStatusPayload(job) : { ok: true, status: 'idle', session_id: sid }) as { status: 'idle' }
    })),
    draftGet: os.session.draftGet.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.readDraft(input.session_id)) as { draft: { text: string; files: unknown[] }; draft_version: string | null }
    })),
    draftSave: os.session.draftSave.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.writeDraft(input)) as { ok: true; draft: { text: string; files: unknown[] }; draft_version: string | null; unchanged?: boolean }
    })),
    anchorSceneGet: os.session.anchorSceneGet.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.readAnchorScene(input)) as { scene_ref: string; rows: unknown[]; start: number; end: number; total: number; complete: boolean }
    })),
    outboundDraft: os.session.outboundDraft.handler(({ input, context: { ctx } }) => run(() => ctx.deps.sessions.reviewOutboundDraft(input))),
    outboundDraftAct: os.session.outboundDraftAct.handler(({ input, context: { ctx } }) => run(() => ctx.deps.sessions.reviewOutboundDraft(input))),
    toolResult: os.session.toolResult.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.readToolResult(input))
    })),
    anchorSceneSave: os.session.anchorSceneSave.handler(({ input, context: { ctx } }) => run(async () => {
      await guardVisibility(ctx, input.session_id)
      return (await ctx.deps.sessions.saveAnchorScene(input)) as { ok: true; message_index: number; message_ref: string }
    })),
  },
  projects: {
    list: os.projects.list.handler(({ input, context: { ctx } }) => run(async () => {
      const activeProfile = ctx.deps.activeProfile()
      const all = (await ctx.deps.projects.load())
      const allProfiles = allProfilesEnabled(ctx, input.all_profiles)
      const scoped = allProfiles ? all : all.filter((p) => ctx.deps.profilesMatch(p.profile ?? null, activeProfile))
      return { projects: scoped, all_profiles: allProfiles, active_profile: activeProfile, other_profile_count: allProfiles || ctx.deps.isolatedProfileMode() ? 0 : all.length - scoped.length }
    })),
    create: os.projects.create.handler(({ input, context: { ctx } }) => run(async () => {
      const name = input.name.trim().slice(0, 128)
      if (!name) throw new HttpError(400, 'name required')
      const color = input.color ?? null
      if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new HttpError(400, 'Invalid color format')
      const requested = (input.profile ?? '').trim()
      if (requested && requested !== 'default' && !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(requested)) throw new HttpError(400, 'invalid profile')
      const proj = { project_id: randomUUID().replace(/-/g, '').slice(0, 12), name, color, profile: requested || ctx.deps.activeProfile() || 'default', created_at: ctx.deps.auth.now() }
      await ctx.deps.projects.mutate((projects) => { projects.push(proj) })
      ctx.deps.events.publish('project_create', { profile: proj.profile })
      return { ok: true as const, project: proj }
    })),
    rename: os.projects.rename.handler(({ input, context: { ctx } }) => run(async () => {
      const activeProfile = ctx.deps.activeProfile()
      const proj = await ctx.deps.projects.mutate((projects) => {
        const proj = projects.find((p) => p.project_id === input.project_id)
        if (!proj || !ctx.deps.profilesMatch(proj.profile ?? null, activeProfile)) throw new HttpError(404, 'Project not found')
        requireFields(input, 'project_id', 'name')
        proj.name = input.name.trim().slice(0, 128)
        if ('color' in input) {
          const color = input.color ?? null
          if (color && !/^#[0-9a-fA-F]{3,8}$/.test(color)) throw new HttpError(400, 'Invalid color format')
          proj.color = color
        }
        return proj
      })
      ctx.deps.events.publish('project_rename', { profile: activeProfile })
      return { ok: true as const, project: proj }
    })),
    delete: os.projects.delete.handler(({ input, context: { ctx } }) => run(async () => {
      const activeProfile = ctx.deps.activeProfile()
      await ctx.deps.projects.mutate((projects) => {
        const position = projects.findIndex((p) => p.project_id === input.project_id)
        const proj = projects[position]
        if (!proj || !ctx.deps.profilesMatch(proj.profile ?? null, activeProfile)) throw new HttpError(404, 'Project not found')
        projects.splice(position, 1)
      })
      await ctx.deps.sessionStore.unlinkProject(input.project_id)
      ctx.deps.events.publish('project_delete', { profile: activeProfile })
      return { ok: true as const }
    })),
  },
  talaria: {
    pair: os.talaria.pair.handler(async ({ input, context }) => {
      const { ctx } = context
      const session = await ensureTrustedAuthSession(ctx)
      const bound = str(session?.bound_profile).trim() || null
      // Owner permission authorizes publisher registration; it never widens which profile's data the caller reaches.
      const operator = await sessionCanManageServer(ctx, session)
      return relayCall(() => ctx.deps.relay.pair(input, bound ?? ctx.deps.activeProfile(), operator))
    }),
    presence: os.talaria.presence.handler(async ({ input, context }) => {
      const { ctx } = context
      return relayCall(async () => ctx.deps.relay.presence.update(input, (await notificationRequester(ctx)).profile))
    }),
    viewed: os.talaria.viewed.handler(({ input, context: { ctx } }) => run(async () => {
      await ctx.deps.notifications.markViewed(input.session_id.trim())
      return { ok: true as const }
    })),
  },
  webPush: {
    status: os.webPush.status.handler(async ({ input, context: { ctx } }) => webPushCall(async () => ctx.deps.webPush.status(input.endpoint, await notificationRequester(ctx)))),
    subscribe: os.webPush.subscribe.handler(async ({ input, context: { ctx } }) => webPushCall(async () => ({ ok: true as const, ...(await ctx.deps.webPush.subscribe(input, await notificationRequester(ctx))) }))),
    update: os.webPush.update.handler(async ({ input, context: { ctx } }) => webPushCall(async () => ({ ok: true as const, ...(await ctx.deps.webPush.update(input.endpoint, input.preferences, await notificationRequester(ctx))) }))),
    unsubscribe: os.webPush.unsubscribe.handler(async ({ input, context: { ctx } }) => webPushCall(async () => { await ctx.deps.webPush.unsubscribe(input.endpoint, await notificationRequester(ctx)); return { ok: true as const } })),
  },
  share: {
    create: os.share.create.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id.trim()
      if (!sid) throw new HttpError(400, 'session_id is required')
      return (await ctx.deps.sessions.createShare(sid)) as { ok: true; share: { token: string; url: string; title: string; message_count: number; created_at: number; updated_at: number }; session: { session_id: string; title: string } }
    })),
    revoke: os.share.revoke.handler(({ input, context: { ctx } }) => run(async () => {
      const sid = input.session_id.trim()
      if (!sid) throw new HttpError(400, 'session_id is required')
      return (await ctx.deps.sessions.revokeShare(sid)) as { ok: true; session: { session_id: string; title: string } }
    })),
    read: os.share.read.handler(({ input, context: { ctx } }) => run(async () => {
      ctx.extraResponseHeaders = { 'x-robots-tag': 'noindex, nofollow' }
      return (await ctx.deps.sessions.loadShare(input.token.trim())) as { share: { title: string; messages: Record<string, unknown>[]; message_count: number } }
    })),
  },
  workspaces: {
    list: os.workspaces.list.handler(({ context: { ctx } }) => run(async () => {
      const profile = ctx.deps.activeProfile()
      return { workspaces: (await ctx.deps.workspaces.load(profile)), last: (await ctx.deps.workspaces.lastWorkspace(profile)), terminal_remote_backend: ctx.deps.features().terminal_remote_backend }
    })),
    suggest: os.workspaces.suggest.handler(({ input, context: { ctx } }) => run(async () => ({ suggestions: (await ctx.deps.workspaces.suggest(input.prefix ?? '', 12, ctx.deps.activeProfile())), prefix: input.prefix ?? '' }))),
    add: os.workspaces.add.handler(({ input, context: { ctx } }) => run(async () => {
      const ws = ctx.deps.workspaces
      const pathStr = stripSurroundingQuotes(input.path.trim())
      const name = (input.name ?? '').trim()
      if (!pathStr) throw new HttpError(400, 'path is required')
      const profile = ctx.deps.activeProfile()
      let candidate: string
      let remote: string | null
      try {
        remote = ws.remoteTerminalWorkspaceCandidate(pathStr, profile)
        candidate = ws.resolvePath(pathStr, profile)
      } catch (error) {
        throw new HttpError(400, `Invalid path: ${sanitizeError(error)}`)
      }
      if (remote === null) {
        if (isBlockedSystemPath(candidate)) {
          const home = ws.homePath()
          if (!(home !== '/' && (candidate === home || isWithin(candidate, home)))) throw new HttpError(400, `Path points to a system directory: ${candidate}`)
        }
        if (input.create) {
          assertWorkspaceFree(ctx, candidate)
          try { mkdirSync(candidate, { recursive: true }) } catch (error) { throw new HttpError(400, `Could not create directory: ${sanitizeError(error)}`) }
        }
      }
      let p: string
      try { p = ws.validateToAdd(pathStr, profile) } catch (error) { throw new HttpError(400, (error as Error).message) }
      const list = (await ws.load(profile, { forWrite: true }))
      if (list.some((w) => w.path === p)) throw new HttpError(400, 'Workspace already in list')
      list.push({ path: p, name: name || basename(p) })
      await ws.save(list, profile)
      return { ok: true as const, workspaces: list }
    })),
    remove: os.workspaces.remove.handler(({ input, context: { ctx } }) => run(async () => {
      const pathStr = input.path.trim()
      if (!pathStr) throw new HttpError(400, 'path is required')
      const profile = ctx.deps.activeProfile()
      const list = (await ctx.deps.workspaces.load(profile, { forWrite: true })).filter((w) => w.path !== pathStr)
      await ctx.deps.workspaces.save(list, profile)
      return { ok: true as const, workspaces: list }
    })),
    rename: os.workspaces.rename.handler(({ input, context: { ctx } }) => run(async () => {
      const pathStr = input.path.trim()
      const name = input.name.trim()
      if (!pathStr || !name) throw new HttpError(400, 'path and name are required')
      const profile = ctx.deps.activeProfile()
      const list = (await ctx.deps.workspaces.load(profile, { forWrite: true }))
      const entry = list.find((w) => w.path === pathStr)
      if (!entry) throw new HttpError(404, 'Workspace not found')
      entry.name = name
      await ctx.deps.workspaces.save(list, profile)
      return { ok: true as const, workspaces: list }
    })),
    reorder: os.workspaces.reorder.handler(({ input, context: { ctx } }) => run(async () => {
      const paths = input.paths
      if (!Array.isArray(paths) || !paths.length) throw new HttpError(400, 'paths is required and must be a list')
      const profile = ctx.deps.activeProfile()
      const list = (await ctx.deps.workspaces.load(profile, { forWrite: true }))
      const byPath = new Map(list.map((w) => [w.path, w]))
      const reordered: typeof list = []
      const seen = new Set<string>()
      for (const raw of paths) {
        const p = String(raw).trim()
        const entry = byPath.get(p)
        if (entry && !seen.has(p)) { reordered.push(entry); seen.add(p) }
      }
      for (const w of list) if (!seen.has(w.path)) reordered.push(w)
      await ctx.deps.workspaces.save(reordered, profile)
      return { ok: true as const, workspaces: reordered }
    })),
  },
  files: {
    list: os.files.list.handler(({ input, context: { ctx } }) => run(async () => {
      if (input.source === 'managed') { await guardVisibility(ctx, input.session_id); return managedBuffers(ctx, input, 'list') }
      if (!input.session_id) throw new HttpError(400, 'session_id is required')
      await guardVisibility(ctx, input.session_id)
      // Python `_handle_list` resolved the workspace directly and answered 404 with the trust error; the POST file ops
      // keep `get_session_for_file_ops`' lenient fallback.
      const s = (await fileOpsSession(ctx, input.session_id, { strictWorkspace: true }))
      const rel = input.path ?? '.'
      try {
        const entries = listDir(s.workspace, rel)
        return { entries: serializeEntriesForBrowser(entries) as { name: string; path: string; type: 'dir' | 'file' | 'symlink'; workspace_sort_rank: number }[], signature: dirSignature(s.workspace, rel, entries), path: rel, workspace: s.workspace, workspace_recovered: s.recovered }
      } catch (error) {
        throw fileError(error, 404)
      }
    })),
    read: os.files.read.handler(({ input, context: { ctx } }) => run(async () => {
      if (input.source === 'managed') { await guardVisibility(ctx, input.session_id); return managedBuffers(ctx, input, 'read') }
      if (!input.session_id) throw new HttpError(400, 'session_id is required')
      await guardVisibility(ctx, input.session_id)
      const s = (await fileOpsSession(ctx, input.session_id))
      if (!input.path) throw new HttpError(400, 'path is required')
      try {
        const file = readFilePreview(s.workspace, input.path)
        return file.preview === 'html' ? { ...file, preview_url: previewUrl(ctx.deps.auth.signingKey(), s.workspace, input.path) } : file
      } catch (error) {
        throw fileError(error, 404)
      }
    })),
    save: os.files.save.handler(({ input, context: { ctx } }) => run(async () => {
      if (input.source === 'managed') { await guardVisibility(ctx, input.session_id); return managedBuffers(ctx, input, 'save') }
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        if (['.docx', '.xlsx', '.pptx'].includes(extname(input.path).toLowerCase())) throw new HttpError(400, 'Office documents cannot be saved from the Web UI')
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const target = safeResolve(root, input.path)
        if (isSymlinkAt(join(root, input.path))) throw new HttpError(400, 'Cannot save to a symlinked entry')
        if (!existsSync(target)) throw new HttpError(404, 'File not found')
        if (statSync(target).isDirectory()) throw new HttpError(400, 'Cannot save: path is a directory')
        const data = Buffer.from(input.content ?? '', 'utf8')
        replaceAnchoredFile(root, target, data)
        return { ok: true as const, path: input.path, size: data.length }
      } catch (error) {
        throw fileError(error)
      }
    })),
    create: os.files.create.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const target = safeResolve(root, input.path)
        if (existsSync(target)) throw new HttpError(400, 'File already exists')
        const data = Buffer.from(input.content ?? '', 'utf8')
        const fd = openAnchoredCreateFd(root, target)
        try { writeFully(fd, data) } finally { closeSync(fd) }
        return { ok: true as const, path: relative(resolvePathLikePython(root), target).split('\\').join('/') }
      } catch (error) {
        if (error instanceof FileExistsError) throw new HttpError(400, 'File already exists')
        throw fileError(error)
      }
    })),
    createDir: os.files.createDir.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const target = safeResolve(root, input.path)
        if (existsSync(target)) throw new HttpError(400, 'Path already exists')
        makeAnchoredDir(root, target)
        return { ok: true as const, path: relative(resolvePathLikePython(root), target).split('\\').join('/') }
      } catch (error) {
        throw fileError(error)
      }
    })),
    delete: os.files.delete.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const target = safeResolve(root, input.path)
        if (isSymlinkAt(join(root, input.path))) throw new HttpError(400, 'Cannot delete a symlinked entry')
        if (!existsSync(target)) throw new HttpError(404, 'File not found')
        if (statSync(target).isDirectory()) {
          if (!input.recursive) throw new HttpError(400, 'Set recursive=true to delete directories')
          rmtreeAnchored(root, target)
        } else unlinkAnchored(root, target)
        return { ok: true as const, path: input.path }
      } catch (error) {
        throw fileError(error)
      }
    })),
    rename: os.files.rename.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path', 'new_name')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const rootResolved = resolvePathLikePython(root)
        const source = safeResolve(root, input.path)
        if (isSymlinkAt(join(root, input.path))) throw new HttpError(400, 'Cannot rename a symlinked entry')
        if (!existsSync(source)) throw new HttpError(404, 'File not found')
        const newName = input.new_name.trim()
        if (!newName || newName.includes('/') || newName.includes('\\') || newName.includes('..')) throw new HttpError(400, 'Invalid file name')
        const dest = join(dirname(source), newName)
        if (existsSync(dest)) throw new HttpError(400, `A file named "${newName}" already exists`)
        renameAnchored(root, source, dest)
        return { ok: true as const, old_path: input.path, new_path: relative(rootResolved, dest).split('\\').join('/') }
      } catch (error) {
        if (error instanceof FileExistsError) throw new HttpError(400, `A file named "${input.new_name}" already exists`)
        throw fileError(error)
      }
    })),
    move: os.files.move.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields({ ...input, dest_dir: input.dest_dir ?? input.destination }, 'session_id', 'path', 'dest_dir')
      const destDirRaw = (input.dest_dir ?? input.destination ?? '.').trim() || '.'
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const root = s.workspace
        assertWorkspaceFree(ctx, root)
        const rootResolved = resolvePathLikePython(root)
        const source = safeResolve(root, input.path)
        if (isSymlinkAt(join(root, input.path))) throw new HttpError(400, 'Cannot move a symlinked entry')
        if (!existsSync(source)) throw new HttpError(404, 'File not found')
        if (destDirRaw.split('/').includes('..')) throw new HttpError(400, 'Invalid destination')
        const destParent = safeResolve(root, destDirRaw)
        if (!existsSync(destParent) || !statSync(destParent).isDirectory()) throw new HttpError(404, 'Destination folder not found')
        if (statSync(source).isDirectory() && isWithin(resolvePathLikePython(destParent), resolvePathLikePython(source))) throw new HttpError(400, 'Cannot move a folder into itself or its subfolder')
        const dest = join(destParent, basename(source))
        if (resolvePathLikePython(dest) === resolvePathLikePython(source)) return { ok: true as const, old_path: input.path, new_path: relative(rootResolved, source).split('\\').join('/') }
        if (existsSync(dest)) throw new HttpError(400, `A file named "${basename(source)}" already exists in that folder`)
        renameAnchored(root, source, dest)
        return { ok: true as const, old_path: input.path, new_path: relative(rootResolved, dest).split('\\').join('/') }
      } catch (error) {
        if (error instanceof FileExistsError) throw new HttpError(400, `A file named "${basename(input.path)}" already exists in that folder`)
        throw fileError(error)
      }
    })),
    reveal: os.files.reveal.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const target = safeResolve(s.workspace, input.path)
        if (!existsSync(target)) throw new HttpError(404, `File not found: ${target}`)
        const targetStr = ctx.deps.vscode().translate(target)
        const system = platform()
        if (system === 'darwin') await spawnDetached(['open', '-R', targetStr])
        else if (system === 'win32') await spawnDetached(['explorer.exe', `/select,${targetStr}`])
        else await spawnDetached(['xdg-open', dirname(targetStr)])
        return { ok: true as const, path: input.path }
      } catch (error) {
        throw fileError(error)
      }
    })),
    path: os.files.path.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        return { ok: true as const, path: safeResolve(s.workspace, input.path) }
      } catch (error) {
        throw fileError(error)
      }
    })),
    openVsCode: os.files.openVsCode.handler(({ input, context: { ctx } }) => run(async () => {
      requireFields(input, 'session_id', 'path')
      const s = (await fileOpsSession(ctx, input.session_id))
      try {
        const target = safeResolve(s.workspace, input.path)
        if (!existsSync(target)) throw new HttpError(404, `File not found: ${target}`)
        const vscode = ctx.deps.vscode()
        const cmd = vscode.command()
        if (!cmd) throw new HttpError(400, `VS Code command not found: ${pyRepr(vscode.configuredCommand)}. Install VS Code and ensure the 'code' CLI is on PATH, or set vscode.command in config.yaml to the full path.`)
        await spawnDetached([cmd, vscode.translate(target)])
        return { ok: true as const, path: input.path }
      } catch (error) {
        throw fileError(error)
      }
    })),
    escapeAuthorize: os.files.escapeAuthorize.handler(({ input, context: { ctx } }) => run(async () => {
      // A Referer alone is not a browser fetch: Python required `Origin`, which the global CSRF check has already matched.
      if (!ctx.header('origin')) throw new HttpError(403, 'browser origin required')
      if (input.token?.trim()) throw new HttpError(400, 'token must not be provided')
      const sid = (input.session_id ?? '').trim()
      const rel = (input.path ?? '').trim()
      if (!sid) throw new HttpError(400, 'session_id is required')
      if (!rel) throw new HttpError(400, 'path is required')
      const s = (await fileOpsSession(ctx, sid))
      try {
        return ctx.deps.escapeGrants.authorize(s.workspace, sid, s.profile, rel)
      } catch (error) {
        throw fileError(error, 404)
      }
    })),
    escapeList: os.files.escapeList.handler(({ input, context: { ctx } }) => run(async () => {
      const req = (await escapeRequest(ctx, input.session_id, input.token, input.path ?? '.'))
      try {
        const listing = ctx.deps.escapeGrants.list(req)
        return { ...listing, entries: serializeEntriesForBrowser(listing.entries) }
      } catch (error) {
        throw fileError(error, 404)
      }
    })),
    escapeRead: os.files.escapeRead.handler(({ input, context: { ctx } }) => run(async () => {
      const req = (await escapeRequest(ctx, input.session_id, input.token, input.path ?? ''))
      try {
        const file = ctx.deps.escapeGrants.read(req)
        // The frame loads the bytes through the same grant; the workspace preview grant would outlive and skip its re-checks.
        return file.preview === 'html' ? { ...file, preview_url: `api/escape/file/raw?${new URLSearchParams({ session_id: String(input.session_id), token: String(input.token), path: req.requestPath, inline: '1' }).toString()}` } : file
      } catch (error) {
        throw fileError(error, 404)
      }
    })),
  },
})

/** The escape routes' shared front half: required ids, the session, and the grant re-check (403 when it fails). */
export async function escapeRequest(ctx: RequestContext, sid: string | undefined, token: string | undefined, rel: string): Promise<EscapeRequest> {
  if (!sid) throw new HttpError(400, 'session_id is required')
  if (!token) throw new HttpError(400, 'token is required')
  const s = (await fileOpsSession(ctx, sid))
  try {
    return ctx.deps.escapeGrants.resolve(s.workspace, sid, s.profile, token, rel)
  } catch (error) {
    if (error instanceof EscapeGrantExpired) throw new HttpError(403, error.message)
    throw fileError(error, 404)
  }
}

function isSymlinkAt(path: string): boolean {
  try { return lstatSync(path).isSymbolicLink() } catch { return false }
}

/** Workspace writes are synchronous, so refusing while Git holds the workspace keeps the two from overlapping. */
function assertWorkspaceFree(ctx: RequestContext, path: string): void {
  if (ctx.deps.git.workspaceBusy(path)) throw new HttpError(409, WORKSPACE_BUSY_MESSAGE)
}

export function fileError(error: unknown, notFoundStatus = 400): Error {
  if (error instanceof HttpError) return error
  if (error instanceof HttpFailure) return new HttpError(error.status, error.message, error.extra)
  if (error instanceof NotFoundError || error instanceof PathTraversalError || error instanceof FileTooLargeError) return new HttpError(notFoundStatus, sanitizeError(error))
  if (error instanceof Error && 'code' in error) return new HttpError(notFoundStatus, sanitizeError(error))
  return error as Error
}

export interface FileOpsSession { workspace: string; profile: string | null; recovered: boolean; session: Session | null }

/**
 * Python `get_session_for_file_ops` + `_file_ops_session_or_error`. A session the Agent owns in the active profile's
 * `state.db` but that has no `sessions/<sid>.json` (CLI, messaging) is served as an external view bound to the active
 * workspace, as the sidebar already lists it (issue #3280).
 */
export async function fileOpsSession(ctx: RequestContext, sid: string, opts: { strictWorkspace?: boolean } = {}): Promise<FileOpsSession> {
  const { session, profile } = await fileSourceSession(ctx, sid)
  if (!session) {
    if (!ctx.deps.workspaces.profileSupportsLocalIo(profile)) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_CODE, { message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE })
    return { workspace: (await ctx.deps.workspaces.lastWorkspace(profile)), profile, recovered: false, session: null }
  }
  if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_CODE, { message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE })
  let workspace = session.workspace
  let recovered = false
  try {
    ;[workspace, recovered] = (await ctx.deps.workspaces.resolveImplicitWithRecovery(session.workspace, async (p) => (await ctx.deps.workspaces.lastWorkspace(p)), session.profile))
  } catch (error) {
    if (opts.strictWorkspace) throw new HttpError(404, error instanceof Error ? error.message : 'Workspace is not trusted')
    workspace = session.workspace
  }
  if (recovered) {
    session.workspace = workspace
    const cached = ctx.deps.sessionStore.sessions.get(sid)
    if (cached) cached.workspace = workspace
    try {
      const full = (await ctx.deps.sessionStore.load(sid))
      if (full) { full.workspace = workspace; (await ctx.deps.sessionStore.save(full, { touchUpdatedAt: false })) }
    } catch { /* recovery persistence is best effort */ }
  }
  return { workspace, profile: session.profile, recovered, session }
}

/**
 * Python `spawn_detached_app`: `Popen` raised synchronously when the launcher binary was missing, so the route answered
 * 400 instead of `{ok:true}`; Node reports that on the `error` event, awaited here before the handler answers.
 */
function spawnDetached(cmd: string[]): Promise<void> {
  const [file, ...args] = cmd
  if (!file) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' })
    child.once('error', (error: NodeJS.ErrnoException) => { reject(new HttpError(400, error.code ? pyOsError(error, file) : sanitizeError(error))) })
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

/** Alerts are scoped like presence leases: the login's bound profile, else the active one, with root as `default`. */
async function notificationRequester(ctx: RequestContext): Promise<WebPushRequester> {
  const session = await ensureTrustedAuthSession(ctx)
  const bound = str(session?.bound_profile).trim() || null
  const name = bound ?? ctx.deps.activeProfile()
  return { profile: ctx.deps.isRootProfile(name) ? 'default' : name, login: session?.token ? loginHash(session.token) : null, origin: new URL(await requestBaseUrl(ctx)).origin }
}

async function webPushCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof WebPushRequestError) throw new HttpError(error.status, error.message)
    throw error
  }
}

async function relayCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof RelayPairingError) throw new HttpError(error.status, error.message)
    throw error
  }
}

/** Git panel, rollback, worktree, and upload-receipt procedures. */
import { implement } from '@orpc/server'
import { gitContract } from '@maudecode/talaria-web-contracts'
import { HttpError, type ApiContext } from './router.js'
import { requestSessionIdGuard } from './session-visibility.js'
import type { RequestContext } from '../http/context.js'
import { cleanGeneratedCommitMessage, GitWorkspaceError, WORKSPACE_GIT_DESTRUCTIVE_ENV, type GitStatus } from '../workspace/git.js'
import { REMOTE_WORKSPACE_UNSUPPORTED_CODE, REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE } from '../workspace/workspaces.js'
import { removeWorktreeForSession, worktreeStatusForSession } from '../workspace/worktrees.js'
import { isSafeSessionId, type Session } from '../sessions/session.js'
import { sanitizeError } from '../workspace/media.js'
import { str } from '../util.js'

const os = implement(gitContract).$context<ApiContext>().use(requestSessionIdGuard)

/** Python `_git_bad`: `{error, code}` with the classified reason. */
function gitBad(error: unknown, status = 400): never {
  if (error instanceof HttpError) throw error
  if (error instanceof GitWorkspaceError) throw new HttpError(status, sanitizeError(error), { code: error.code || 'git_failed' })
  if (error instanceof Error) throw new HttpError(400, sanitizeError(error))
  throw error
}

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    return gitBad(error)
  }
}

/** Python `_git_session`: a visible session whose workspace supports local IO. */
export function gitSession(ctx: RequestContext, sid: unknown): { session: Session; workspace: string } {
  const id = str(sid)
  if (!id) throw new HttpError(400, 'session_id required')
  let session: Session
  try {
    session = ctx.deps.sessionStore.get(id, { metadataOnly: true })
  } catch {
    throw new HttpError(404, 'Session not found')
  }
  if (!ctx.deps.profilesMatch(session.profile, ctx.deps.activeProfile())) throw new HttpError(404, 'Session not found')
  if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE, { code: REMOTE_WORKSPACE_UNSUPPORTED_CODE })
  return { session, workspace: session.workspace }
}

function rejectDestructiveIfUnsafe(ctx: RequestContext, session: Session): void {
  if (!ctx.deps.git.destructiveEnabled()) throw new HttpError(403, `Destructive workspace Git operations are disabled. Set ${WORKSPACE_GIT_DESTRUCTIVE_ENV}=1 to enable them.`, { code: 'destructive_git_disabled' })
  const streamId = session.active_stream_id
  if (streamId && ctx.deps.sessions.deps.runtime.activeStreamIds.has(streamId)) throw new HttpError(409, 'A session run is active. Wait for it to finish before running this Git operation.', { code: 'active_stream' })
}

function pathsFromBody(body: { paths?: unknown; path?: unknown }): string[] {
  let raw = body.paths
  if ((raw === undefined || raw === null) && body.path) raw = [body.path]
  if (typeof raw === 'string') raw = [raw]
  if (!Array.isArray(raw)) throw new HttpError(400, 'paths must be a list')
  return raw.map((p) => str(p))
}

async function generateCommitMessage(ctx: RequestContext, session: Session, prompt: { system_prompt: string; user_prompt: string; truncated: boolean }): Promise<{ ok: true; message: string; truncated: boolean }> {
  const text = await ctx.deps.commitMessage(session, prompt.system_prompt, prompt.user_prompt)
  const message = cleanGeneratedCommitMessage(text)
  if (!message) throw new GitWorkspaceError('No commit message was generated')
  return { ok: true, message, truncated: prompt.truncated }
}

const asStatus = (s: GitStatus): GitStatus => s

export const gitRouter = os.router({
  gitInfo: os.gitInfo.handler(({ input, context: { ctx } }) => guard(() => {
    const { workspace } = gitSession(ctx, input.session_id)
    const status = ctx.deps.git.status(workspace, { useCache: true })
    if (!status.is_git) return { git: null }
    const totals = status.totals ?? { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicts: 0 }
    return { git: { branch: status.branch ?? 'HEAD', dirty: totals.changed, modified: totals.staged + totals.unstaged, untracked: totals.untracked, ahead: status.ahead ?? 0, behind: status.behind ?? 0, is_git: true as const } }
  })),
  git: {
    status: os.git.status.handler(({ input, context: { ctx } }) => guard(() => ({ git: asStatus(ctx.deps.git.status(gitSession(ctx, input.session_id).workspace, { useCache: true })) }))),
    branches: os.git.branches.handler(({ input, context: { ctx } }) => guard(() => ({ branches: ctx.deps.git.branches(gitSession(ctx, input.session_id).workspace) }))),
    diff: os.git.diff.handler(({ input, context: { ctx } }) => guard(() => {
      const { workspace } = gitSession(ctx, input.session_id)
      if (!input.path) throw new HttpError(400, 'path required')
      const kind = input.kind ?? (input.staged === '1' ? 'staged' : 'unstaged')
      return { diff: ctx.deps.git.diff(workspace, input.path, kind) }
    })),
    stage: os.git.stage.handler(({ input, context: { ctx } }) => guard(async () => {
      const paths = pathsFromBody(input)
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return { ok: true as const, git: await ctx.deps.git.stage(workspace, paths) }
    })),
    unstage: os.git.unstage.handler(({ input, context: { ctx } }) => guard(async () => {
      const paths = pathsFromBody(input)
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return { ok: true as const, git: await ctx.deps.git.unstage(workspace, paths) }
    })),
    discard: os.git.discard.handler(({ input, context: { ctx } }) => guard(async () => {
      const paths = pathsFromBody(input)
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return { ok: true as const, git: await ctx.deps.git.discard(workspace, paths, { deleteUntracked: Boolean(input.delete_untracked) }) }
    })),
    commit: os.git.commit.handler(({ input, context: { ctx } }) => guard(async () => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return ctx.deps.git.commit(workspace, input.message) as Promise<{ ok: true; commit: string; status: GitStatus }>
    })),
    commitSelected: os.git.commitSelected.handler(({ input, context: { ctx } }) => guard(async () => {
      const paths = pathsFromBody(input)
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return ctx.deps.git.commitSelected(workspace, input.message, paths) as Promise<{ ok: true; commit: string; paths: string[]; status: GitStatus }>
    })),
    commitMessage: os.git.commitMessage.handler(({ input, context: { ctx } }) => guard(() => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      return generateCommitMessage(ctx, session, ctx.deps.git.stagedCommitMessagePrompt(workspace))
    })),
    commitMessageSelected: os.git.commitMessageSelected.handler(({ input, context: { ctx } }) => guard(() => {
      const paths = pathsFromBody(input)
      const { session, workspace } = gitSession(ctx, input.session_id)
      return generateCommitMessage(ctx, session, ctx.deps.git.selectedCommitMessagePrompt(workspace, paths))
    })),
    fetch: os.git.fetch.handler(({ input, context: { ctx } }) => guard(() => ctx.deps.git.fetch(gitSession(ctx, input.session_id).workspace) as Promise<{ ok: true; message: string; status: GitStatus }>)),
    pull: os.git.pull.handler(({ input, context: { ctx } }) => guard(() => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return ctx.deps.git.pull(workspace) as Promise<{ ok: true; message: string; status: GitStatus }>
    })),
    push: os.git.push.handler(({ input, context: { ctx } }) => guard(() => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      return ctx.deps.git.push(workspace) as Promise<{ ok: true; message: string; status: GitStatus }>
    })),
    checkout: os.git.checkout.handler(({ input, context: { ctx } }) => guard(async () => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      const result = await ctx.deps.git.checkout(workspace, input.ref, input.mode, { newBranch: input.new_branch ?? null, track: Boolean(input.track), dirtyMode: input.dirty_mode ?? 'block' })
      return { ok: true as const, git: result.status, branches: result.branches, current_branch: result.current_branch, message: result.message } as never
    })),
    stashCheckout: os.git.stashCheckout.handler(({ input, context: { ctx } }) => guard(async () => {
      const { session, workspace } = gitSession(ctx, input.session_id)
      rejectDestructiveIfUnsafe(ctx, session)
      const r = await ctx.deps.git.stashAndCheckout(workspace, input.ref, input.mode, { newBranch: input.new_branch ?? null, track: Boolean(input.track) })
      return {
        ok: true as const, git: r.status, branches: r.branches, current_branch: r.current_branch, message: r.message, stash_name: r.stash_name, stashed: r.stashed,
        restored_stash: r.restored_stash, restore_failed: r.restore_failed, restore_error: r.restore_error, restore_stash: r.restore_stash,
      } as never
    })),
  },
  rollback: {
    list: os.rollback.list.handler(({ input, context: { ctx } }) => {
      if (!input.workspace) throw new HttpError(400, 'workspace query parameter is required')
      try {
        return ctx.deps.rollback.list(input.workspace) as { checkpoints: Record<string, unknown>[]; workspace: string; checkpoint_dir: string }
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
    diff: os.rollback.diff.handler(({ input, context: { ctx } }) => {
      const checkpoint = input.checkpoint ?? input.id
      if (!input.workspace || !checkpoint) throw new HttpError(400, 'workspace and checkpoint query parameters are required')
      try {
        return ctx.deps.rollback.diff(input.workspace, checkpoint) as never
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
    restore: os.rollback.restore.handler(({ input, context: { ctx } }) => {
      if (!Object.keys(input).length) throw new HttpError(400, 'request body is required')
      const checkpoint = input.checkpoint ?? input.id
      if (!input.workspace || !checkpoint) throw new HttpError(400, 'workspace and checkpoint are required')
      try {
        return ctx.deps.rollback.restore(input.workspace, checkpoint) as never
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
  },
  worktree: {
    status: os.worktree.status.handler(({ input, context: { ctx } }) => {
      if (!input.session_id) throw new HttpError(400, 'session_id is required')
      let session: Session
      try {
        session = ctx.deps.sessionStore.get(input.session_id, { metadataOnly: true })
      } catch {
        throw new HttpError(404, 'Session not found')
      }
      if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_CODE, { message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE })
      try {
        return { status: worktreeStatusForSession(session, ctx.deps.worktreeLocks) }
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
    remove: os.worktree.remove.handler(({ input, context: { ctx } }) => {
      const raw = input.session_id
      if (typeof raw !== 'string' || !raw.trim()) throw new HttpError(400, 'session_id must be a non-empty string')
      const sid = raw.trim()
      if (!isSafeSessionId(sid)) throw new HttpError(400, 'Invalid session_id')
      let session: Session
      try {
        session = ctx.deps.sessionStore.get(sid, { metadataOnly: true })
      } catch {
        throw new HttpError(404, 'Session not found')
      }
      if (!ctx.deps.workspaces.profileSupportsLocalIo(session.profile)) throw new HttpError(400, REMOTE_WORKSPACE_UNSUPPORTED_CODE, { message: REMOTE_WORKSPACE_UNSUPPORTED_MESSAGE })
      try {
        return removeWorktreeForSession(session, ctx.deps.worktreeLocks, { force: Boolean(input.force) }) as { ok: true; removed_path: string; warnings: string[] | null }
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
  },
  upload: {
    rollback: os.upload.rollback.handler(({ input, context: { ctx } }) => {
      const sessionId = str(input.session_id)
      const rawTokens = input.rollback_tokens
      if (!sessionId || !Array.isArray(rawTokens) || !rawTokens.length || rawTokens.length > 20) throw new HttpError(400, 'Invalid upload rollback request')
      const tokens = rawTokens.map((t) => str(t))
      if (tokens.some((t) => !t || t.length > 200)) throw new HttpError(400, 'Invalid upload rollback receipt')
      let session: Session
      try {
        session = ctx.deps.sessionStore.get(sessionId, { metadataOnly: true })
      } catch {
        throw new HttpError(404, 'Session not found')
      }
      if (!ctx.deps.profilesMatch(session.profile, ctx.deps.activeProfile())) throw new HttpError(404, 'Session not found')
      try {
        return ctx.deps.uploads.rollback(sessionId, tokens)
      } catch (error) {
        throw new HttpError(400, (error as Error).message)
      }
    }),
  },
})

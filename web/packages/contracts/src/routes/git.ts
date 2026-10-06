import { oc } from '@orpc/contract'
import { z } from 'zod'
import { GitInfoSchema } from '../views.js'

/** Workspace git panel, rollback checkpoints, worktrees, and upload receipts. */

const Json = z.unknown()
const Loose = z.record(z.string(), z.unknown())
const tags = ['git']

export const GitTotalsSchema = z.object({ changed: z.number().int(), staged: z.number().int(), unstaged: z.number().int(), untracked: z.number().int(), conflicts: z.number().int() })
export const GitFileSchema = z.object({
  path: z.string(), old_path: z.string().nullable(), workspace_path: z.string(), status: z.string(), staged: z.boolean(), unstaged: z.boolean(), untracked: z.boolean(),
  ignored: z.boolean(), conflict: z.boolean(), additions: z.number().int(), deletions: z.number().int(), binary: z.boolean(),
})
export const GitStatusSchema = z.object({
  is_git: z.boolean(), branch: z.string().optional(), upstream: z.string().optional(), ahead: z.number().int().optional(), behind: z.number().int().optional(),
  totals: GitTotalsSchema.optional(), files: z.array(GitFileSchema).optional(), truncated: z.boolean().optional(),
  noise_filtering: z.object({ filemode_only: z.number().int(), crlf_only: z.number().int(), active: z.boolean() }).optional(),
})
export const GitRefSchema = z.object({ name: z.string(), sha: z.string(), updated: z.number().int(), updated_relative: z.string(), author: z.string(), subject: z.string(), upstream: z.string(), ahead: z.number().int(), behind: z.number().int() })
export const GitBranchesSchema = z.object({ is_git: z.literal(true), current: z.string(), detached: z.boolean(), head: z.string(), local: z.array(GitRefSchema), remote: z.array(GitRefSchema), upstream: z.string(), ahead: z.number().int(), behind: z.number().int() })
export const GitDiffSchema = z.object({ path: z.string(), kind: z.string(), binary: z.boolean(), too_large: z.boolean(), additions: z.number().int(), deletions: z.number().int(), diff: z.string() })
/** Every git failure answers `{error, code}`; `code` is the classified reason (`not_a_repo`, `dirty_worktree`, ...). */
export const GitErrorSchema = z.object({ error: z.string(), code: z.string() })
/** One agent file checkpoint, newest first; `date_display` is the server's minute-precision rendering of `date`. */
export const CheckpointSchema = z.object({ id: z.string(), commit: z.string(), message: z.string(), date: z.string(), date_display: z.string(), files: z.number().int(), path: z.string() })

const SessionQuery = z.object({ session_id: z.string() })
const SessionBody = z.object({ session_id: z.string() })
const PathsBody = SessionBody.extend({ paths: z.union([z.array(Json), z.string()]).optional(), path: z.string().optional() })
const GitOk = z.object({ ok: z.literal(true), git: GitStatusSchema })
const RemoteResult = z.object({ ok: z.literal(true), message: z.string(), status: GitStatusSchema })
const CheckoutBody = SessionBody.extend({ ref: z.string(), mode: z.string(), new_branch: z.string().nullable().optional(), track: Json.optional(), dirty_mode: z.string().optional() })
const CheckoutResult = z.object({ ok: z.literal(true), git: GitStatusSchema, branches: GitBranchesSchema, current_branch: z.string(), message: z.string() })

export const gitContract = {
  gitInfo: oc.route({ method: 'GET', path: '/api/git-info', tags, summary: 'Lightweight branch badge for a session workspace.' }).input(SessionQuery).output(GitInfoSchema),
  git: {
    status: oc.route({ method: 'GET', path: '/api/git/status', tags }).input(SessionQuery).output(z.object({ git: GitStatusSchema })),
    branches: oc.route({ method: 'GET', path: '/api/git/branches', tags }).input(SessionQuery).output(z.object({ branches: GitBranchesSchema })),
    diff: oc.route({ method: 'GET', path: '/api/git/diff', tags }).input(SessionQuery.extend({ path: z.string().optional(), kind: z.string().optional(), staged: z.string().optional() })).output(z.object({ diff: GitDiffSchema })),
    stage: oc.route({ method: 'POST', path: '/api/git/stage', tags }).input(PathsBody).output(GitOk),
    unstage: oc.route({ method: 'POST', path: '/api/git/unstage', tags }).input(PathsBody).output(GitOk),
    discard: oc.route({ method: 'POST', path: '/api/git/discard', tags }).input(PathsBody.extend({ delete_untracked: Json.optional() })).output(GitOk),
    commit: oc.route({ method: 'POST', path: '/api/git/commit', tags }).input(SessionBody.extend({ message: z.string() })).output(z.object({ ok: z.literal(true), commit: z.string(), status: GitStatusSchema })),
    commitSelected: oc.route({ method: 'POST', path: '/api/git/commit-selected', tags }).input(PathsBody.extend({ message: z.string() })).output(z.object({ ok: z.literal(true), commit: z.string(), paths: z.array(z.string()), status: GitStatusSchema })),
    commitMessage: oc.route({ method: 'POST', path: '/api/git/commit-message', tags, summary: 'Generate a commit message for the staged diff through the auxiliary model.' }).input(SessionBody).output(z.object({ ok: z.literal(true), message: z.string(), truncated: z.boolean() })),
    commitMessageSelected: oc.route({ method: 'POST', path: '/api/git/commit-message-selected', tags }).input(PathsBody).output(z.object({ ok: z.literal(true), message: z.string(), truncated: z.boolean() })),
    fetch: oc.route({ method: 'POST', path: '/api/git/fetch', tags }).input(SessionBody).output(RemoteResult),
    pull: oc.route({ method: 'POST', path: '/api/git/pull', tags }).input(SessionBody).output(RemoteResult),
    push: oc.route({ method: 'POST', path: '/api/git/push', tags }).input(SessionBody).output(RemoteResult),
    checkout: oc.route({ method: 'POST', path: '/api/git/checkout', tags }).input(CheckoutBody).output(CheckoutResult),
    stashCheckout: oc.route({ method: 'POST', path: '/api/git/stash-checkout', tags }).input(CheckoutBody.omit({ dirty_mode: true })).output(CheckoutResult.extend({ stash_name: z.string(), stashed: z.boolean(), restored_stash: Loose.nullable(), restore_failed: z.boolean(), restore_error: z.string(), restore_stash: Loose.nullable() })),
  },
  rollback: {
    list: oc.route({ method: 'GET', path: '/api/rollback/list', tags: ['rollback'] }).input(z.object({ workspace: z.string().optional() })).output(z.object({ checkpoints: z.array(CheckpointSchema), workspace: z.string(), checkpoint_dir: z.string() })),
    diff: oc.route({ method: 'GET', path: '/api/rollback/diff', tags: ['rollback'] }).input(z.object({ workspace: z.string().optional(), checkpoint: z.string().optional(), id: z.string().optional() })).output(z.object({ checkpoint: z.string(), workspace: z.string(), diff: z.string(), files_changed: z.array(z.object({ file: z.string(), status: z.string() })), total_changes: z.number().int() })),
    restore: oc.route({ method: 'POST', path: '/api/rollback/restore', tags: ['rollback'] }).input(z.object({ workspace: z.string().optional(), checkpoint: z.string().optional(), id: z.string().optional() }).catchall(Json)).output(z.object({ ok: z.literal(true), checkpoint: z.string(), workspace: z.string(), files_restored: z.array(z.string()), files_restored_count: z.number().int(), errors: z.array(z.object({ file: z.string(), error: z.string() })) })),
  },
  worktree: {
    status: oc.route({ method: 'GET', path: '/api/session/worktree/status', tags: ['sessions'] }).input(SessionQuery).output(z.object({ status: Loose })),
    remove: oc.route({ method: 'POST', path: '/api/session/worktree/remove', tags: ['sessions'] }).input(z.object({ session_id: Json.optional(), force: Json.optional() })).output(z.object({ ok: z.literal(true), removed_path: z.string(), warnings: z.array(z.string()).nullable() })),
  },
  upload: {
    rollback: oc.route({ method: 'POST', path: '/api/upload/rollback', tags: ['files'], summary: 'Remove the successful prefix of one failed multi-file chat upload.' }).input(z.object({ session_id: Json.optional(), rollback_tokens: Json.optional() })).output(z.object({ ok: z.boolean(), rolled_back: z.number().int(), failed: z.number().int() })),
  },
}

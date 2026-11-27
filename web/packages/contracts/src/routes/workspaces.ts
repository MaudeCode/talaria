import { oc, type OpenAPI } from '@orpc/contract'
import { z } from 'zod'
import { WorkspaceEntrySchema, WorkspacesSchema, DirListingSchema, FileContentSchema, FileEntrySchema, FileSourceSchema } from '../views.js'

const Json = z.unknown()
const tags = ['workspaces']
/** The workspace list after an add, rename or remove; the agent's workspace tools return it too (TAL-1170). */
export const WorkspacesMutation = z.object({ ok: z.literal(true), workspaces: z.array(WorkspaceEntrySchema) })


const FileSource = FileSourceSchema.optional()
const SessionPath = z.object({ session_id: z.string(), path: z.string() })
const FileRevision = z.string().regex(/^[a-f0-9]{64}$/)
const FileReplacement = SessionPath.extend({
  content: z.string(),
  base_revision: FileRevision.optional().describe('Revision of the workspace file when editing started. A stale revision returns 409 with condition file_revision_conflict. Older clients may omit it.'),
})
const SavedFileRevision = FileRevision.optional().describe('Opaque revision of the committed workspace file after a conditional save.')
const FileRead = FileContentSchema.extend({ revision: FileRevision.optional().describe('Opaque revision of this editable workspace file. Send it back as base_revision when saving.') })
export const WorkspaceTextSizeErrorSchema = z.object({
  error: z.string(),
  condition: z.literal('file_too_large'),
  max_bytes: z.number().int().min(1),
  download_allowed: z.literal(true).optional().describe('Returned only when a workspace read authorizes raw download of the same file.'),
})
export type WorkspaceTextSizeError = z.infer<typeof WorkspaceTextSizeErrorSchema>
const workspaceTextSizeResponse = {
  description: 'Workspace text exceeds the UTF-8 byte limit for preview or replacement.',
  content: { 'application/json': { schema: z.toJSONSchema(WorkspaceTextSizeErrorSchema, { target: 'openapi-3.0' }) as Record<string, unknown> } },
}
const workspaceTextSizeSpec = (op: OpenAPI.OperationObject): OpenAPI.OperationObject => ({ ...op, responses: { ...op.responses, 413: workspaceTextSizeResponse } })
const OkPath = z.object({ ok: z.literal(true), path: z.string() })
/** TAL-263: `token` is the grant from `files.escapeAuthorize`; `path` is workspace-relative and must sit under the granted symlink. */
const EscapeQuery = z.object({ session_id: z.string().optional(), token: z.string().optional(), path: z.string().optional() })
const EscapeReadOnly = { escape_read_only: z.literal(true).describe('Opened through an escape grant; clients offer no edits.') }

export const workspacesContract = {
  workspaces: {
    list: oc.route({ method: 'GET', path: '/api/workspaces', tags }).output(WorkspacesSchema),
    suggest: oc.route({ method: 'GET', path: '/api/workspaces/suggest', tags }).input(z.object({ prefix: z.string().optional() })).output(z.object({
      suggestions: z.array(z.string()),
      prefix: z.string(),
      /** TAL-2141: each suggestion as the Add space browser shows it: its last folder and the input value that lists its children. */
      folders: z.array(z.object({ path: z.string(), name: z.string(), target: z.string() })).optional(),
      /** TAL-2141: the input value one folder above the prefix, for the browser's `..` row; null when the prefix is empty or the root. */
      parent: z.string().nullable().optional(),
      /** TAL-2141: the name a space added at the prefix gets when none is typed; null for an empty prefix. */
      default_name: z.string().nullable().optional(),
    })),
    add: oc.route({ method: 'POST', path: '/api/workspaces/add', tags }).input(z.object({ path: z.string(), name: z.string().optional(), create: Json.optional() })).output(WorkspacesMutation),
    remove: oc.route({ method: 'POST', path: '/api/workspaces/remove', tags }).input(z.object({ path: z.string() })).output(WorkspacesMutation),
    rename: oc.route({ method: 'POST', path: '/api/workspaces/rename', tags }).input(z.object({ path: z.string(), name: z.string() })).output(WorkspacesMutation),
    reorder: oc.route({ method: 'POST', path: '/api/workspaces/reorder', tags }).input(z.object({ paths: Json })).output(WorkspacesMutation),
  },
  files: {
    list: oc.route({ method: 'GET', path: '/api/list', tags: ['files'] }).input(z.object({ session_id: z.string(), path: z.string().optional(), source: FileSource })).output(DirListingSchema),
    read: oc.route({ method: 'GET', path: '/api/file', tags: ['files'], spec: workspaceTextSizeSpec }).input(SessionPath.extend({ source: FileSource })).output(FileRead),
    save: oc.route({ method: 'POST', path: '/api/file/save', tags: ['files'], spec: workspaceTextSizeSpec }).input(FileReplacement.extend({ source: FileSource })).output(OkPath.extend({ size: z.number().int(), source: FileSource, revision: SavedFileRevision })),
    /** TAL-262: saves an editable `.docx` preview's text as its paragraphs; `.xlsx` and `.pptx` are preview-only (400). */
    officeSave: oc.route({ method: 'POST', path: '/api/file/office-save', tags: ['files'] }).input(FileReplacement).output(FileContentSchema.extend({ ok: z.literal(true), path: z.string(), size: z.number().int(), revision: SavedFileRevision })),
    create: oc.route({ method: 'POST', path: '/api/file/create', tags: ['files'] }).input(SessionPath.extend({ content: z.string().optional() })).output(OkPath),
    createDir: oc.route({ method: 'POST', path: '/api/file/create-dir', tags: ['files'] }).input(SessionPath).output(OkPath),
    delete: oc.route({ method: 'POST', path: '/api/file/delete', tags: ['files'] }).input(SessionPath.extend({ recursive: Json.optional() })).output(OkPath),
    rename: oc.route({ method: 'POST', path: '/api/file/rename', tags: ['files'] }).input(SessionPath.extend({ new_name: z.string() })).output(z.object({ ok: z.literal(true), old_path: z.string(), new_path: z.string() })),
    move: oc.route({ method: 'POST', path: '/api/file/move', tags: ['files'] }).input(SessionPath.extend({ dest_dir: z.string().optional(), destination: z.string().optional() })).output(z.object({ ok: z.literal(true), old_path: z.string(), new_path: z.string() })),
    reveal: oc.route({ method: 'POST', path: '/api/file/reveal', tags: ['files'] }).input(SessionPath).output(OkPath),
    path: oc.route({ method: 'POST', path: '/api/file/path', tags: ['files'], summary: 'Absolute on-disk path of a workspace-relative path; the file need not exist.' }).input(SessionPath).output(OkPath),
    openVsCode: oc.route({ method: 'POST', path: '/api/file/open-vscode', tags: ['files'] }).input(SessionPath).output(OkPath),
    /**
     * TAL-263: a 300-second, read-only grant for one workspace symlink whose target sits outside the workspace. A directory
     * grant reaches the target's tree; a file grant reaches that file alone. Requires a same-origin `Origin` header; a
     * supplied `token` is refused. Any later change to the link expires the grant (403).
     */
    escapeAuthorize: oc.route({ method: 'POST', path: '/api/escape/authorize', tags: ['files'] })
      .input(z.object({ session_id: z.string().optional(), path: z.string().optional(), token: z.string().optional() }))
      .output(z.object({ token: z.string(), path: z.string(), is_dir: z.boolean(), expires_at: z.number(), expires_in: z.number().int(), read_only: z.literal(true) })),
    /** TAL-263: a granted directory listed under virtual workspace paths; nested links leaving the grant stay display-only. */
    escapeList: oc.route({ method: 'GET', path: '/api/escape/list', tags: ['files'] }).input(EscapeQuery)
      .output(DirListingSchema.extend({ path: z.string(), entries: z.array(FileEntrySchema.extend(EscapeReadOnly)), virtual_root: z.string(), read_only: z.literal(true) })),
    /** TAL-263: a granted file's content and preview kind; an `html` preview's `preview_url` frames `/api/escape/file/raw`. */
    escapeRead: oc.route({ method: 'GET', path: '/api/escape/file/read', tags: ['files'] }).input(EscapeQuery).output(FileContentSchema.extend(EscapeReadOnly)),
  },
}

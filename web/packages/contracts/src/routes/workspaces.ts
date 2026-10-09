import { oc } from '@orpc/contract'
import { z } from 'zod'
import { WorkspaceEntrySchema, WorkspacesSchema, DirListingSchema, FileContentSchema } from '../views.js'

const Json = z.unknown()
const tags = ['workspaces']
const WorkspacesMutation = z.object({ ok: z.literal(true), workspaces: z.array(WorkspaceEntrySchema) })


const SessionPath = z.object({ session_id: z.string(), path: z.string() })
const OkPath = z.object({ ok: z.literal(true), path: z.string() })

export const workspacesContract = {
  workspaces: {
    list: oc.route({ method: 'GET', path: '/api/workspaces', tags }).output(WorkspacesSchema),
    suggest: oc.route({ method: 'GET', path: '/api/workspaces/suggest', tags }).input(z.object({ prefix: z.string().optional() })).output(z.object({ suggestions: z.array(z.string()), prefix: z.string() })),
    add: oc.route({ method: 'POST', path: '/api/workspaces/add', tags }).input(z.object({ path: z.string(), name: z.string().optional(), create: Json.optional() })).output(WorkspacesMutation),
    remove: oc.route({ method: 'POST', path: '/api/workspaces/remove', tags }).input(z.object({ path: z.string() })).output(WorkspacesMutation),
    rename: oc.route({ method: 'POST', path: '/api/workspaces/rename', tags }).input(z.object({ path: z.string(), name: z.string() })).output(WorkspacesMutation),
    reorder: oc.route({ method: 'POST', path: '/api/workspaces/reorder', tags }).input(z.object({ paths: Json })).output(WorkspacesMutation),
  },
  files: {
    list: oc.route({ method: 'GET', path: '/api/list', tags: ['files'] }).input(z.object({ session_id: z.string(), path: z.string().optional() })).output(DirListingSchema),
    read: oc.route({ method: 'GET', path: '/api/file', tags: ['files'] }).input(SessionPath).output(FileContentSchema),
    save: oc.route({ method: 'POST', path: '/api/file/save', tags: ['files'] }).input(SessionPath.extend({ content: z.string().optional() })).output(OkPath.extend({ size: z.number().int() })),
    create: oc.route({ method: 'POST', path: '/api/file/create', tags: ['files'] }).input(SessionPath.extend({ content: z.string().optional() })).output(OkPath),
    createDir: oc.route({ method: 'POST', path: '/api/file/create-dir', tags: ['files'] }).input(SessionPath).output(OkPath),
    delete: oc.route({ method: 'POST', path: '/api/file/delete', tags: ['files'] }).input(SessionPath.extend({ recursive: Json.optional() })).output(OkPath),
    rename: oc.route({ method: 'POST', path: '/api/file/rename', tags: ['files'] }).input(SessionPath.extend({ new_name: z.string() })).output(z.object({ ok: z.literal(true), old_path: z.string(), new_path: z.string() })),
    move: oc.route({ method: 'POST', path: '/api/file/move', tags: ['files'] }).input(SessionPath.extend({ dest_dir: z.string().optional(), destination: z.string().optional() })).output(z.object({ ok: z.literal(true), old_path: z.string(), new_path: z.string() })),
    reveal: oc.route({ method: 'POST', path: '/api/file/reveal', tags: ['files'] }).input(SessionPath).output(OkPath),
    path: oc.route({ method: 'POST', path: '/api/file/path', tags: ['files'], summary: 'Absolute on-disk path of a workspace-relative path; the file need not exist.' }).input(SessionPath).output(OkPath),
    openVsCode: oc.route({ method: 'POST', path: '/api/file/open-vscode', tags: ['files'] }).input(SessionPath).output(OkPath),
  },
}

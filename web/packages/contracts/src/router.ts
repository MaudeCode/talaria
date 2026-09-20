import { oc } from '@orpc/contract'
import { coreContract } from './routes/core.js'
import { sessionsContract } from './routes/sessions.js'
import { workspacesContract } from './routes/workspaces.js'
import { gitContract } from './routes/git.js'
import { chatContract } from './routes/chat.js'
import { settingsContract } from './routes/settings.js'
import { toolsContract } from './routes/tools.js'
import { automationContract } from './routes/automation.js'

/**
 * The composed route contract. Domain segments are added per checkpoint
 * (docs/architecture/contract-package.md); the server implements exactly this
 * router and the OpenAPI document is generated from it.
 */
export const routeContract = oc.router({
  ...coreContract,
  ...sessionsContract,
  ...workspacesContract,
  ...gitContract,
  ...chatContract,
  ...settingsContract,
  ...toolsContract,
  ...automationContract,
})

export type RouteContract = typeof routeContract

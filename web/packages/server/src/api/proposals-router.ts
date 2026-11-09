/** TAL-1967: proposal routes. Approve applies through the route that owns the proposal's kind, as the approving owner. */
import { call, implement } from '@orpc/server'
import { proposalsContract } from '@maudecode/talaria-web-contracts'
import { HttpError, type ApiContext } from './router.js'
import { HttpFailure } from '../sessions/service.js'
import { mcpUpdateBody, type ProposalApply } from '../sessions/proposals.js'
import type { RequestContext } from '../http/context.js'
import { ensureTrustedAuthSession, sessionCanManageServer } from '../auth/gate.js'
import { toolsRouter } from './tools-router.js'
import { settingsRouter } from './settings-router.js'
import { automationRouter } from './automation-router.js'

const os = implement(proposalsContract).$context<ApiContext>()

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (error) {
    if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
    throw error
  }
}

const owner = async (ctx: RequestContext): Promise<boolean> => sessionCanManageServer(ctx, await ensureTrustedAuthSession(ctx))

/** Each kind through its own route with the approving request, so every check that route makes still applies. */
const applyThrough = (ctx: RequestContext): ProposalApply => async (proposal) => {
  const context = { context: { ctx } }
  switch (proposal.kind) {
    case 'plugin_install': {
      // The route's preview again: its consent token is single use and short lived, and the plugin must be what was reviewed.
      const name = proposal.payload.catalog_id
      const preview = await call(toolsRouter.pluginInstall, { name }, context)
      if (preview.status === 'blocked') throw new Error(preview.findings)
      if (preview.status !== 'needs_consent' || preview.findings !== proposal.review) throw new Error('The plugin changed since it was reviewed. Ask the agent for a new proposal.')
      const done = await call(toolsRouter.pluginInstall, { name, consent_token: preview.consent_token }, context)
      if (done.status !== 'installed') throw new Error(done.status === 'blocked' ? done.findings : 'The plugin asked for review again. Ask the agent for a new proposal.')
      return `Installed ${done.key}, turned off until you enable it in Plugins.`
    }
    case 'mcp_server':
      await call(toolsRouter.mcp.action, { name: proposal.payload.name, ...mcpUpdateBody(proposal.payload) }, context)
      return `Saved MCP server ${proposal.payload.name} to the profile's config.`
    case 'setting':
      await call(settingsRouter.settings.save, { [proposal.payload.key]: proposal.payload.value }, context)
      return `Set ${proposal.payload.key} to ${JSON.stringify(proposal.payload.value)}.`
    case 'cron_job': {
      const { title, schedule, prompt, context_sources } = proposal.payload
      const created = await call(automationRouter.crons.create, { name: title, schedule, prompt, ...(context_sources.length ? { context_from: context_sources } : {}) }, context)
      const id = (created as { job?: { id?: unknown } }).job?.id
      return `Scheduled ${title}${typeof id === 'string' ? ` (${id})` : ''}.`
    }
  }
}

export const proposalsRouter = os.router({ proposals: {
  get: os.proposals.get.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.proposals.get(input.proposal_id, await owner(ctx)))),
  approve: os.proposals.approve.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.proposals.approve(input.proposal_id, input.payload_hash, await owner(ctx), applyThrough(ctx)))),
  reject: os.proposals.reject.handler(({ input, context: { ctx } }) => run(async () => ctx.deps.proposals.reject(input.proposal_id, await owner(ctx)))),
} })

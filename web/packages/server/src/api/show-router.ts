/** TAL-1968: `show` block reads. */
import { implement } from '@orpc/server'
import { showContract } from '@maudecode/talaria-web-contracts'
import { HttpError, type ApiContext } from './router.js'
import { HttpFailure } from '../sessions/service.js'

const os = implement(showContract).$context<ApiContext>()

export const showRouter = os.router({ show: {
  get: os.show.get.handler(async ({ input, context: { ctx } }) => {
    try { return await ctx.deps.show.get(input.block_id) } catch (error) {
      if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
      throw error
    }
  }),
} })

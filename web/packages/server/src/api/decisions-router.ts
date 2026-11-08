/** TAL-1963: decision review routes; the store owns visibility, validation and every derived field. */
import { implement } from '@orpc/server'
import { decisionsContract } from '@maudecode/talaria-web-contracts'
import { HttpError, type ApiContext } from './router.js'
import { HttpFailure } from '../sessions/service.js'

const os = implement(decisionsContract).$context<ApiContext>()

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (error) {
    if (error instanceof HttpFailure) throw new HttpError(error.status, error.message, error.extra)
    throw error
  }
}

export const decisionsRouter = os.router({ decisions: {
  list: os.decisions.list.handler(({ context: { ctx } }) => run(() => ctx.deps.decisions.list())),
  get: os.decisions.get.handler(({ input, context: { ctx } }) => run(() => ctx.deps.decisions.get(input.review_id))),
  answer: os.decisions.answer.handler(({ input, context: { ctx } }) => run(() => ctx.deps.decisions.answer(input))),
  submit: os.decisions.submit.handler(({ input, context: { ctx } }) => run(() => ctx.deps.decisions.submit(input.review_id))),
  cancel: os.decisions.cancel.handler(({ input, context: { ctx } }) => run(() => ctx.deps.decisions.cancel(input.review_id))),
} })

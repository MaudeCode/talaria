import { oc } from '@orpc/contract'
import { z } from 'zod'
import { ShowBlockSchema } from '../show.js'

/**
 * TAL-1968: a `show` block of the request's profile. Another profile's block, or one in a session the requester may not
 * see, is 404. An `html` block's `frame_url` is minted for this answer.
 */
export const showContract = { show: {
  get: oc.route({ method: 'GET', path: '/api/show/{block_id}', tags: ['show'] }).input(z.object({ block_id: z.string() })).output(ShowBlockSchema),
} }

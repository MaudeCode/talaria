import { oc } from '@orpc/contract'
import { z } from 'zod'
import { ProposalApproveInputSchema, ProposalSchema } from '../proposals.js'

const tags = ['proposals']
const ProposalId = z.object({ proposal_id: z.string() })

/**
 * TAL-1967: proposals of the request's profile. Another profile's proposal, or one in a session the requester may not
 * see, is 404. Approve and reject are the server owner's: anyone else is 403 `not_owner`. A proposal no longer pending is
 * 409 `proposal_closed`, a pending one past `expires_at` is 409 `proposal_expired`.
 */
export const proposalsContract = { proposals: {
  get: oc.route({ method: 'GET', path: '/api/proposals/{proposal_id}', tags }).input(ProposalId).output(ProposalSchema),
  approve: oc.route({ method: 'POST', path: '/api/proposals/{proposal_id}/approve', tags, summary: 'Apply the proposal once through the route that owns its kind, then tell its session. A `payload_hash` other than the stored one is 409 `payload_changed`. A refused apply answers 200 with `status: failed` and the route\'s error in `outcome`.' })
    .input(ProposalApproveInputSchema).output(ProposalSchema),
  reject: oc.route({ method: 'POST', path: '/api/proposals/{proposal_id}/reject', tags, summary: 'Close the proposal without applying it, then tell its session.' }).input(ProposalId).output(ProposalSchema),
} }

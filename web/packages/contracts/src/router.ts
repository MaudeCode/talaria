import { oc } from '@orpc/contract'

/**
 * The composed route contract. Domain segments are added per checkpoint
 * (docs/architecture/contract-package.md); the server implements exactly this
 * router and the OpenAPI document is generated from it.
 */
export const routeContract = oc.router({})

export type RouteContract = typeof routeContract

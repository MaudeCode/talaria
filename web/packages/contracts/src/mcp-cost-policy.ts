import { z } from 'zod'

const Amount = z.number().nonnegative()
const Estimate = z.union([Amount, z.tuple([Amount, Amount]).refine(([low, high]) => low <= high, 'Minimum must not exceed maximum')])
export const McpToolCostSchema = z.union([Estimate, z.strictObject({ credits: Estimate, note: z.string().optional() })])
/** Null removes a native override; zero explicitly disables a limit or declares a free tool. */
export const McpCostPatchSchema = z.strictObject({
  tool_costs: z.record(z.string().min(1), McpToolCostSchema).nullable().optional(),
  spend_limit: Amount.nullable().optional(),
  cost_unit: z.string().max(32).refine((s) => s.trim().length > 0, 'Unit must not be blank').nullable().optional(),
}).refine((p) => Object.keys(p).length > 0, 'Choose a policy field to edit')
const Source = z.enum(['native', 'package', 'default'])
/** Native parser result, without transport inputs, credentials, spend tallies or vendor billing claims. */
export const McpCostPolicyDataSchema = z.object({
  name: z.string(), source: z.enum(['native', 'package', 'native_override']), valid: z.boolean(), can_edit: z.boolean(), error: z.string().nullable(),
  package_revision: z.string(),
  overrides: z.object({ tool_costs: z.record(z.string(), McpToolCostSchema).nullable(), spend_limit: Amount.nullable(), cost_unit: z.string().nullable() }),
  tool_costs: z.array(z.object({ name: z.string(), low: Amount, high: Amount, note: z.string() })),
  spend_limit: Amount, cost_unit: z.string(), budget_enabled: z.boolean(),
  field_sources: z.object({ tool_costs: Source, spend_limit: Source, cost_unit: Source }),
})
export const McpCostPolicySchema = McpCostPolicyDataSchema.omit({ package_revision: true }).extend({
  revision: z.string(), provenance: z.literal('declared_estimate'), reload_required: z.literal(true), runtime_state: z.literal('unknown'),
})

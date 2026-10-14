/**
 * TAL-818: the Connectors page and connect card, composed from the sidecar's raw `connectors.*` answers. The policy model
 * follows the Agent desktop's (`apps/desktop/.../connectors/data/join.ts`): the member layer is the user's own rules and
 * the one a change writes; organization and role layers lock an app or tool off.
 */
import type { ConnectorOperationView, ConnectorsPage, ConnectorToolsView, SidecarResult } from '@maudecode/talaria-web-contracts'

type Policy = SidecarResult<'connectors.policy.get'>
type Body = Policy['layers'][number]['body']
type Catalog = SidecarResult<'connectors.catalog'>['connectors']
type Accounts = SidecarResult<'connectors.accounts'>['accounts']
type Tools = SidecarResult<'connectors.tools'>
type Snapshot = SidecarResult<'connectors.operation'>

interface Rules { allowed: Set<string> | null; denied: Set<string>; tools: Record<string, string[]>; tags: { enable: string[]; disable: string[] }; revision: string }

function rulesOf(body: Body, revision: string): Rules {
  const tools = Object.fromEntries(Object.entries(body.tools ?? {}).map(([slug, rule]) => [slug, rule.disable]))
  const tags = { enable: body.tags?.enable ?? [], disable: body.tags?.disable ?? [] }
  if (body.mode === 'unrestricted') return { allowed: null, denied: new Set(), tools: {}, tags: { enable: [], disable: [] }, revision }
  if (body.mode === 'deny-all') return { allowed: new Set(), denied: new Set(), tools: {}, tags: { enable: [], disable: [] }, revision }
  if (body.mode === 'allow') return { allowed: new Set(body.connectors ?? []), denied: new Set(), tools, tags, revision }
  return { allowed: null, denied: new Set(body.disabled_connectors ?? []), tools, tags, revision }
}

const PROBLEMS = new Set(['pending', 'failed', 'expired', 'revoked', 'inactive'] as const)
type Problem = typeof PROBLEMS extends Set<infer T> ? T : never
/** An account's gateway status while it is not active; a status this server does not know reads as `inactive`. */
const accountProblem = (status: string): Problem | null => status === 'active' ? null : PROBLEMS.has(status as Problem) ? status as Problem : 'inactive'

const FACETS = new Set(['read', 'write', 'destructive', 'unclassified'] as const)
type Facet = typeof FACETS extends Set<infer T> ? T : never
const facetOf = (facet: string): Facet => FACETS.has(facet as Facet) ? facet as Facet : 'unclassified'

/** Catalog names by profile home, kept from the last catalog read so a connect card names `github` GitHub. */
const catalogNameCache = new Map<string, Record<string, string>>()
export function rememberCatalogNames(home: string, catalog: Catalog): Record<string, string> {
  const names = Object.fromEntries(catalog.map((row) => [row.slug, row.name]))
  catalogNameCache.set(home, names)
  return names
}
export const catalogNames = (home: string): Record<string, string> | undefined => catalogNameCache.get(home)

const allows = (rules: Rules, slug: string): boolean => (rules.allowed === null || rules.allowed.has(slug)) && !rules.denied.has(slug)

/** The member layer (null: none, so the rules are read-only) and every other layer. */
function layers(policy: Policy | null): { member: Rules | null; others: Rules[] } {
  const member = policy?.layers.find((layer) => layer.kind === 'member')
  return {
    member: member ? rulesOf(member.body, member.revision) : null,
    others: (policy?.layers ?? []).filter((layer) => layer.kind !== 'member').map((layer) => rulesOf(layer.body, layer.revision)),
  }
}

/** `available: false` hides the page; a missing policy (unreadable rules) shows every app on, read-only. */
export function connectorsPage(catalog: Catalog, accounts: Accounts, policy: Policy | null): ConnectorsPage {
  const { member, others } = layers(policy)
  const slugs = [...new Set([...catalog.map((row) => row.slug), ...accounts.map((row) => row.connector)])]
  const connectors = slugs.map((slug) => {
    const entry = catalog.find((row) => row.slug === slug)
    // Live accounts only (a reconnect retires the one it replaced), active first, then newest.
    const mine = accounts.filter((row) => row.connector === slug && !row.disabled)
      .sort((a, b) => Number(b.active) - Number(a.active) || b.created_at.localeCompare(a.created_at))
    const orgLocked = others.some((rules) => !allows(rules, slug))
    return {
      slug, name: entry?.name || slug, description: entry?.description ?? '', category: entry?.category ?? '', logo_url: entry?.logo_url ?? null,
      connected: mine.length > 0,
      accounts: mine.map((row) => ({ connection_id: row.connection_id, name: row.alias?.trim() || row.label, problem: accountProblem(row.status), status_reason: row.status_reason?.trim() || null, active: row.active, created_at: row.created_at })),
      // The switch shows what Hermes gets: an app another layer locks off reads off, whatever the member rule says.
      enabled: (member === null || allows(member, slug)) && !orgLocked,
      org_locked: orgLocked,
      rules_editable: member !== null && !orgLocked,
      tools_off: member?.tools[slug]?.length ?? 0,
    }
  })
  return { available: true, connectors, policy_revision: member?.revision ?? null }
}

export function connectorTools(listing: Tools, policy: Policy | null): ConnectorToolsView {
  const { member, others } = layers(policy)
  const slug = listing.connector
  const off = new Set(member?.tools[slug] ?? [])
  // The Agent refuses a tool rule for an app the member rules keep off (`compose_tools_write`), and another layer's lock wins.
  const appEditable = member !== null && allows(member, slug) && others.every((rules) => allows(rules, slug))
  const locked = (tool: Tools['tools'][number]): boolean => others.some((rules) =>
    (rules.tools[slug] ?? []).includes(tool.slug)
    || rules.tags.disable.some((tag) => tool.hints.includes(tag))
    || (rules.tags.enable.length > 0 && !rules.tags.enable.some((tag) => tool.hints.includes(tag))))
  return {
    connector: slug, policy_revision: member?.revision ?? null,
    tools: listing.tools.map((tool) => {
      const isLocked = locked(tool)
      return { slug: tool.slug, name: tool.name, description: tool.description, facet: facetOf(tool.facet), deprecated: tool.deprecated, enabled: !off.has(tool.slug) && !isLocked, locked: isLocked, editable: appEditable && !isLocked }
    }),
  }
}

const SKIPPABLE = new Set(['pending', 'initiated', 'failed', 'expired'])

/** `google_calendar` → `Google Calendar`: the title of a target the catalog does not name (an MCP server, or before a catalog read). */
export const connectorTitle = (slug: string): string => slug.split(/[_\s-]+/).filter(Boolean).map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' ') || slug

/**
 * The moves the user may make on each target now (the Agent's transition table, `tools/connectors/contract.py`): skip any
 * unresolved target, retry a failed or expired one, approve an MCP install the card holds. A settled operation is frozen.
 * Only a chat card continues: the model is waiting on it.
 */
export function connectorOperation(snapshot: Snapshot, names: Record<string, string> = {}): ConnectorOperationView {
  const open = !snapshot.settled
  return {
    op_id: snapshot.op_id, settled: snapshot.settled, tool_call_id: snapshot.tool_call_id,
    outcome: open ? null : snapshot.targets.every((target) => target.state === 'connected') ? 'connected' : 'not_connected',
    can_continue: open && snapshot.owner === 'session',
    targets: snapshot.targets.map((target) => {
      const local = target.kind !== 'connector'
      const actions: ('skip' | 'retry' | 'approve')[] = []
      if (open && local && target.state === 'pending') actions.push('approve')
      if (open && (target.state === 'failed' || target.state === 'expired')) actions.push('retry')
      if (open && SKIPPABLE.has(target.state)) actions.push('skip')
      return {
        name: target.name, title: names[target.name] ?? connectorTitle(target.name), kind: target.kind, state: target.state, detail: target.detail,
        // Only an https authorization link reaches a client; anything else is dropped rather than rendered as a link.
        connect_url: open && target.state === 'initiated' && /^https:\/\//i.test(target.connect_url ?? '') ? target.connect_url! : null,
        actions,
        // An approval (or a failed install's retry) sends the credentials the install still needs.
        env_fields: open && local && (target.state === 'pending' || target.state === 'failed') ? target.required_env.map((field) => ({ name: field.name, label: field.prompt.trim() || field.name, required: field.required, secret: field.secret })) : [],
      }
    }),
  }
}

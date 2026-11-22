/**
 * The canonical slash-command catalog (TAL-314). Clients hold only handlers and localized wording; which commands exist,
 * their aliases, display order, and which client can run each come from here through `GET /api/commands`.
 */
import type { Command, CommandClient, CommandDecision } from '@maudecode/talaria-web-contracts'
import type { SidecarResult } from '@maudecode/talaria-web-contracts/sidecar'

type AgentCommand = SidecarResult<'commands.registry'>['commands'][number]

const ALL: CommandClient[] = ['web', 'ios']
const client = (name: string, description: string, extra: Partial<Command> = {}): Command => ({ name, description, aliases: [], handler: 'client', clients: ALL, exec: false, ...extra })
const webOnly = (unsupported_message: string): Partial<Command> => ({ clients: ['web'], unsupported_message })

/** Commands a client handles itself, in display order. Every entry outside a client's `clients` carries `unsupported_message`. */
export const CLIENT_COMMANDS: readonly Command[] = [
  client('help', 'Show available commands'),
  client('new', 'Start a new conversation'),
  client('clear', 'Clear this conversation'),
  client('stop', 'Stop the running response'),
  client('interrupt', 'Interrupt and send', { args_hint: '<message>' }),
  client('queue', 'Queue a follow-up', { args_hint: '<message>' }),
  client('steer', 'Steer the running response', { args_hint: '<message>' }),
  client('model', 'Switch the conversation model', { args_hint: '<id>' }),
  client('workspace', 'Switch workspace', { args_hint: '<path>' }),
  client('terminal', 'Toggle the workspace terminal', webOnly('Terminal is not available in the mobile app.')),
  client('title', 'Rename this conversation', { args_hint: '<text>' }),
  client('retry', 'Retry the last turn'),
  client('undo', 'Undo the last turn'),
  client('compress', 'Compress the context', { aliases: ['compact'] }),
  client('usage', 'Show token usage', webOnly('Token usage is not available in the mobile app.')),
  client('theme', 'Switch theme', { args_hint: '<light|dark|system>', ...webOnly('Theme switching is not available from mobile slash commands.') }),
  client('yolo', 'Toggle YOLO mode (skip approvals)', webOnly('YOLO mode is not available in the mobile app.')),
  client('branch', 'Branch the conversation', { aliases: ['fork'] }),
  client('voice', 'Toggle voice mode', webOnly('Voice commands are not available in the mobile app.')),
  client('reasoning', 'Set reasoning effort', { args_hint: '[show|hide|<level>]' }),
  client('personality', 'Set the personality', { args_hint: '[name]' }),
  client('goal', 'Set or show the goal', { args_hint: '[text]' }),
  client('status', 'Show session status'),
  client('btw', 'Side question without affecting the run', { args_hint: '<question>' }),
  client('background', 'Run in the background', { args_hint: '<message>', aliases: ['bg'] }),
  client('skills', 'List skills'),
  client('use', 'Use a skill', { args_hint: '<skill>', ...webOnly('Use `/skills [query]` to search skills.') }),
]

/** Agent commands `POST /api/commands/exec` runs on the chat's session itself rather than through the sidecar's `commands.exec` (TAL-902). */
export const SESSION_EXEC_COMMANDS: ReadonlySet<string> = new Set(['refine'])

/** What a client shows for an Agent prompt built-in this Agent cannot expand (TAL-817); the turn path refuses it with the same text. */
export const unsupportedPromptMessage = (name: string): string => `/${name} is not available in Talaria yet.`

/** The other `_`/`-` spellings of `name` (all `_`, all `-`), the equivalence the Agent's slash resolvers apply. */
const separatorVariants = (name: string): string[] => [...new Set([name.replace(/-/g, '_'), name.replace(/_/g, '-')])].filter((v) => v !== name)

/**
 * The client table followed by the Agent registry. An Agent command whose name is already a client name or alias is
 * dropped, and client-claimed aliases are removed from the rest, so every typed name resolves to one entry.
 * Gateway-only commands never reach a client; commands without an execution or prompt-expansion path stay listed
 * for no client. An expandable prompt built-in is `handler: 'prompt'`: chat start sends the Agent's expansion (TAL-817).
 *
 * TAL-1577: a command `commands.exec` runs also answers to its other `_`/`-` spelling, published in `aliases` (`generated`
 * maps each such alias to its command). Names are reserved as the sidecar dispatches them: Agent commands before plugins
 * (`commands.exec` tries the Agent's own commands and aliases first). Within each tier every literal name comes before
 * explicit aliases, so a registered `plugin_review` stays its own command beside `plugin-review`; generated aliases come
 * last, each in registry order. Reservation ignores case, as clients and the sidecar match typed names.
 */
function buildCatalog(agent: readonly AgentCommand[]): { commands: Command[]; generated: Map<string, string> } {
  const claimed = new Set(CLIENT_COMMANDS.flatMap((c) => [c.name, ...c.aliases]).map((n) => n.toLowerCase()))
  const claim = (names: readonly string[]) => names.filter((n) => {
    const key = n.toLowerCase()
    if (claimed.has(key)) return false
    claimed.add(key)
    return true
  })
  const aliases = new Map<AgentCommand, string[]>()
  for (const plugin of [false, true]) {
    const tier = agent.filter((c) => !c.gateway_only && (c.category === 'Plugin') === plugin && claim([c.name]).length > 0)
    for (const c of tier) aliases.set(c, claim(c.aliases))
  }
  const rows = agent.filter((c) => aliases.has(c)).map((c): Command => {
    const exec = c.exec || SESSION_EXEC_COMMANDS.has(c.name)
    const unsupported = c.cli_only || !exec && c.prompt === null ? `/${c.name} runs only in the Hermes CLI.` : c.prompt === 'unsupported' ? unsupportedPromptMessage(c.name) : null
    return { ...c, aliases: aliases.get(c) ?? [], exec, handler: c.prompt === 'expand' ? 'prompt' : 'agent', clients: unsupported === null ? ALL : [], ...(unsupported === null ? {} : { unsupported_message: unsupported }) }
  })
  const generated = new Map<string, string>()
  for (const row of rows) {
    if (!row.exec || row.clients.length === 0) continue
    const added = claim(separatorVariants(row.name))
    for (const a of added) generated.set(a.toLowerCase(), row.name)
    row.aliases = [...row.aliases, ...added]
  }
  return { commands: [...CLIENT_COMMANDS, ...rows], generated }
}

/** TAL-2201: client commands that open an owner-only surface; no client runs them for a session without owner authority. */
const OWNER_COMMANDS = new Set(['terminal'])
const OWNER_ONLY_MESSAGE = 'Only the server owner can open the terminal.'
/**
 * TAL-1338: the category of a native owner's registered quick commands. A quick command runs a shell or another command on the
 * owner's host outside the Agent's approval flow, so only the server owner runs one.
 */
export const QUICK_COMMAND_CATEGORY = 'User commands'
export const QUICK_COMMAND_OWNER_MESSAGE = 'Only the server owner can run quick commands.'

export const commandCatalog = (agent: readonly AgentCommand[], owner = true): Command[] => buildCatalog(agent).commands
  .map((command) => owner ? command
    : OWNER_COMMANDS.has(command.name) ? { ...command, clients: [], unsupported_message: OWNER_ONLY_MESSAGE }
    : command.handler === 'agent' && command.category === QUICK_COMMAND_CATEGORY ? { ...command, clients: [], unsupported_message: QUICK_COMMAND_OWNER_MESSAGE }
    : command)

/** The most rows a prefix query returns (TAL-2314), applied after ranking so a late exact name is kept. */
const SUGGESTION_LIMIT = 40

/**
 * TAL-2314: the slash-command palette's rows for a typed `prefix`. Entries `client` runs (without one, entries some client
 * runs) whose name or alias starts with `prefix`, ignoring case, each once in catalog order, except that the entry whose
 * name or alias equals `prefix` leads. A typed name belongs to one entry, reserved as the catalog reserves it (TAL-1577),
 * so a literal separator spelling keeps its own command.
 */
export function suggestCommands(catalog: readonly Command[], prefix: string, client?: CommandClient): Command[] {
  const p = prefix.toLowerCase()
  const names = (c: Command) => [c.name, ...c.aliases].map((n) => n.toLowerCase())
  const matches = catalog.filter((c) => (client ? c.clients.includes(client) : c.clients.length > 0) && names(c).some((n) => n.startsWith(p)))
  const exact = matches.filter((c) => names(c).includes(p))
  return [...exact, ...matches.filter((c) => !exact.includes(c))].slice(0, SUGGESTION_LIMIT)
}

/** What admission and classification answer for a command token when the Agent registry cannot be read. */
export const COMMAND_REGISTRY_UNAVAILABLE = 'Slash commands are unavailable because the Agent command registry could not be loaded.'

/** The command token in `text`: `/name` followed by whitespace or the end, so `/tmp/x.js explain` has none (TAL-1926). */
export function commandToken(text: string): { name: string; args: string } | null {
  const [, name, rest = ''] = /^\/([a-zA-Z][\w-]*)(?=\s|$)\s*([\s\S]*)$/.exec(text.trimStart()) ?? []
  return name === undefined ? null : { name: name.toLowerCase(), args: rest.trim() }
}

/**
 * TAL-1927: the one decision for submitted text, shared by chat admission and `POST /api/commands/classify`. The token's
 * name matches an entry's name or alias case-insensitively. `client` is the requester's client; without one, as at
 * admission, only an entry no client runs is unsupported. `agent` null means the registry is unavailable: a token only
 * the client table can answer gets its decision, any other returns null so the caller fails closed.
 */
export function classifyCommand(text: string, agent: readonly AgentCommand[] | null, { owner = true, client }: { owner?: boolean; client?: CommandClient } = {}): CommandDecision | null {
  const token = commandToken(text)
  if (!token) return { kind: 'text' }
  const entry = commandCatalog(agent ?? [], owner).find((c) => [c.name, ...c.aliases].some((n) => n.toLowerCase() === token.name))
  if (!entry) return agent === null ? null : { kind: 'text' }
  if (client ? !entry.clients.includes(client) : entry.clients.length === 0) return { kind: 'unsupported', name: entry.name, message: entry.unsupported_message ?? unsupportedPromptMessage(entry.name) }
  const kind = entry.exec ? 'exec' : entry.handler === 'client' ? 'client' : entry.handler === 'prompt' ? 'prompt' : null
  return kind ? { kind, name: entry.name, args: token.args } : { kind: 'text' }
}

/**
 * `command` with a generated separator alias (TAL-1577) replaced by its command's name, which is what the sidecar
 * looks up; everything after the name stays byte for byte. Any other name, explicit aliases included, passes unchanged.
 */
export function canonicalExecCommand(command: string, agent: readonly AgentCommand[]): string {
  const generated = buildCatalog(agent).generated
  return command.replace(/^(\/?)(\S+)/, (typed, slash: string, name: string) => {
    const canonical = generated.get(name.toLowerCase())
    return canonical === undefined ? typed : `${slash}${canonical}`
  })
}

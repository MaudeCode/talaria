/**
 * The canonical slash-command catalog (TAL-314). Clients hold only handlers and localized wording; which commands exist,
 * their aliases, display order, and which client can run each come from here through `GET /api/commands`.
 */
import type { Command, CommandClient, SidecarResult } from '@maudecode/talaria-web-contracts'

type AgentCommand = SidecarResult<'commands.registry'>['commands'][number]

const ALL: CommandClient[] = ['web', 'ios']
const client = (name: string, description: string, extra: Partial<Command> = {}): Command => ({ name, description, aliases: [], handler: 'client', clients: ALL, ...extra })
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
  client('reasoning', 'Set reasoning effort', { args_hint: '<level>' }),
  client('personality', 'Set the personality', { args_hint: '<name>' }),
  client('goal', 'Set or show the goal', { args_hint: '<text>' }),
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
 * Gateway-only commands never reach a client; CLI-only ones and prompt built-ins the sidecar cannot expand stay listed
 * for no client. An expandable prompt built-in is `handler: 'prompt'`: chat start sends the Agent's expansion (TAL-817).
 *
 * TAL-1577: a command `commands.exec` runs also answers to its other `_`/`-` spelling, published in `aliases` (`generated`
 * maps each such alias to its command). Every literal name is reserved first, then explicit aliases, then generated
 * ones, each in registry order, so a registered `plugin_review` stays its own command beside `plugin-review`.
 */
function buildCatalog(agent: readonly AgentCommand[]): { commands: Command[]; generated: Map<string, string> } {
  const claimed = new Set(CLIENT_COMMANDS.flatMap((c) => [c.name, ...c.aliases]))
  const listed = agent.filter((c) => {
    if (c.gateway_only || claimed.has(c.name)) return false
    claimed.add(c.name)
    return true
  })
  const claim = (names: readonly string[]) => names.filter((a) => {
    if (claimed.has(a)) return false
    claimed.add(a)
    return true
  })
  const rows = listed.map((c): Command => {
    const unsupported = c.cli_only ? `/${c.name} runs only in the Hermes CLI.` : c.prompt === 'unsupported' ? unsupportedPromptMessage(c.name) : null
    return { ...c, aliases: claim(c.aliases), exec: c.exec || SESSION_EXEC_COMMANDS.has(c.name), handler: c.prompt === 'expand' ? 'prompt' : 'agent', clients: unsupported === null ? ALL : [], ...(unsupported === null ? {} : { unsupported_message: unsupported }) }
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

export const commandCatalog = (agent: readonly AgentCommand[]): Command[] => buildCatalog(agent).commands

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

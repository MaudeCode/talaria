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

/**
 * The client table followed by the Agent registry. An Agent command whose name is already a client name or alias is
 * dropped, and client-claimed aliases are removed from the rest, so every typed name resolves to one entry.
 * Gateway-only commands never reach a client; CLI-only ones stay listed for no client.
 */
export function commandCatalog(agent: readonly AgentCommand[]): Command[] {
  const claimed = new Set(CLIENT_COMMANDS.flatMap((c) => [c.name, ...c.aliases]))
  const rows = agent.flatMap((c): Command[] => {
    if (c.gateway_only || claimed.has(c.name)) return []
    claimed.add(c.name)
    const aliases = c.aliases.filter((a) => !claimed.has(a))
    for (const a of aliases) claimed.add(a)
    return [{ ...c, aliases, handler: 'agent', clients: c.cli_only ? [] : ALL, ...(c.cli_only ? { unsupported_message: `/${c.name} runs only in the Hermes CLI.` } : {}) }]
  })
  return [...CLIENT_COMMANDS, ...rows]
}

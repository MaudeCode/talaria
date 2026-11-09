/**
 * TAL-1974: the `harness` toolset's `terminal_open` and `terminal_read`. The agent starts the calling session's Web host
 * PTY, the terminal the user watches in the session's terminal pane, types one command into it, and reads its output in
 * slices of the SSE backlog. Every later keystroke is the user's: the agent gets no input and no close.
 */
import { TERMINAL_READ_MAX_LINES, type SidecarServerParams, type SidecarServerResultInput } from '@maudecode/talaria-web-contracts'
import type { AppDeps } from '../http/context.js'
import { HttpFailure } from '../sessions/service.js'
import { WORKSPACE_BUSY_MESSAGE } from '../workspace/git.js'
import type { TerminalSession } from './terminal.js'

/** The longest command `/api/terminal/input` takes in one write, and so the longest `terminal_open` types. */
const COMMAND_MAX = 8192
/** A C0 or C1 control character other than tab: a second line, an interrupt or an escape the user never typed. */
const CONTROL = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/

/** A refusal of the shared start path; `/api/terminal/start` answers its status and message, the agent its condition. */
export class TerminalStartRefused extends HttpFailure {
  constructor(status: number, readonly condition: string, message: string) { super(status, message) }
}

/**
 * The Web host PTY of a stored session in its trusted workspace, unless a Git operation holds the workspace: the one start
 * path of `/api/terminal/start` and `terminal_open`. `restart` replaces a live terminal; without it a live one is kept, or
 * with `refuseLive` refused as `limit_reached`, checked in the same tick as the start so two opens never share one.
 */
export async function startSessionTerminal(deps: Pick<AppDeps, 'workspaces' | 'git' | 'terminals'>, session: { session_id: string; workspace: string; profile: string | null }, opts: { rows?: unknown; cols?: unknown; restart?: boolean; refuseLive?: boolean } = {}): Promise<TerminalSession> {
  let cwd: string
  // Python answered `resolve_trusted_workspace`'s ValueError text unsanitised.
  try { cwd = await deps.workspaces.resolveTrusted(session.workspace, session.profile) } catch (error) { throw new TerminalStartRefused(400, 'workspace_untrusted', (error as Error).message) }
  if (deps.git.workspaceBusy(cwd)) throw new TerminalStartRefused(409, 'workspace_busy', WORKSPACE_BUSY_MESSAGE)
  if (opts.refuseLive && deps.terminals.get(session.session_id)?.isAlive) throw new TerminalStartRefused(409, 'limit_reached', 'This session already has a live terminal; the user closes it from the terminal pane.')
  return deps.terminals.start(session.session_id, cwd, opts)
}

/** The width the agent's terminal starts at, before any pane sets its own. */
const AGENT_COLS = 160
/** How long the shell's startup output stays quiet before the command is typed, and the longest the open waits for it. */
const PROMPT_QUIET_MS = 150
const PROMPT_WAIT_MS = 3_000

/** Resolves once the shell printed its startup output (its prompt last) and went quiet, once it closed, or after the cap. */
function shellReady(term: TerminalSession): Promise<void> {
  return new Promise((resolve) => {
    let quiet: NodeJS.Timeout | undefined
    let stop: (() => void) | null = null
    let done = false
    const finish = (): void => { done = true; clearTimeout(quiet); clearTimeout(cap); stop?.(); resolve() }
    const cap = setTimeout(finish, PROMPT_WAIT_MS)
    stop = term.subscribe(null, (item) => {
      if (item.event !== 'output') { finish(); return }
      clearTimeout(quiet)
      quiet = setTimeout(finish, PROMPT_QUIET_MS)
    })
    if (done) stop()
  })
}

interface Caller { session_id: string; profile?: string | null; workspace?: string | null }
const refuse = (status: number, condition: string, message: string): HttpFailure => new HttpFailure(status, message, { code: condition })

export async function terminalOpen(deps: AppDeps, caller: Caller, params: Omit<SidecarServerParams<'server.terminal_open'>, 'caller_session_id'>): Promise<SidecarServerResultInput<'server.terminal_open'>> {
  const command = params.command?.trim() ? params.command.trim() : null
  if (command !== null && command.length > COMMAND_MAX) throw refuse(400, 'command_too_long', `command is ${String(command.length)} characters; at most ${String(COMMAND_MAX)}`)
  if (command !== null && CONTROL.test(command)) throw refuse(400, 'invalid_command', 'command must be one line without control characters')
  const profile = caller.profile ?? null
  if (!deps.workspaces.profileSupportsLocalIo(profile)) throw refuse(400, 'remote_terminal_backend_unsupported', 'Embedded terminal is only supported for local terminal backends.')
  let term: TerminalSession
  try {
    // Wide, so the shell's line editor keeps a long command on one line; the pane resizes it to fit once the user opens it.
    term = await startSessionTerminal(deps, { session_id: caller.session_id, workspace: caller.workspace ?? '', profile }, { cols: AGENT_COLS, refuseLive: true })
  } catch (error) {
    if (error instanceof TerminalStartRefused) throw refuse(error.status, error.condition, error.message)
    throw refuse(500, 'terminal_unavailable', (error as Error).message)
  }
  // Typed once, as the user's Enter would send it, after the prompt: earlier, the terminal echoes it and the shell's
  // line editor draws it again once it starts reading.
  if (command !== null) { await shellReady(term); if (term.isAlive) term.proc.write(`${command}\r`) }
  const title = params.title?.trim() || command || 'Terminal'
  return { terminal_id: term.id, url: `/session/${encodeURIComponent(caller.session_id)}`, title, command }
}

export function terminalRead(deps: AppDeps, caller: Caller, params: Omit<SidecarServerParams<'server.terminal_read'>, 'caller_session_id'>): SidecarServerResultInput<'server.terminal_read'> {
  // Terminals are keyed by session, so another session's terminal, a replaced one or a retired one never matches.
  const term = deps.terminals.get(caller.session_id)
  if (term?.id !== params.terminal_id) throw refuse(404, 'terminal_not_found', `no terminal ${params.terminal_id} in this session`)
  const slice = term.read(params.after_event_id ?? 0, Math.min(params.max_lines ?? TERMINAL_READ_MAX_LINES, TERMINAL_READ_MAX_LINES))
  return { terminal_id: term.id, ...slice, running: term.isAlive, exit_code: term.closed ? term.exitCode : null }
}

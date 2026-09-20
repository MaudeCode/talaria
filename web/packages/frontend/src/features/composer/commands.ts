/**
 * Slash command registry (ported from static/commands.js). Local commands act
 * in the browser; everything else is sent through `/api/commands/exec` when
 * the server lists it, or delivered as a normal message.
 */
import type { Command } from '../../contracts'

export interface LocalCommand { name: string; args?: string; desc: string; aliases?: string[] }

export const LOCAL_COMMANDS: LocalCommand[] = [
  { name: 'help', desc: 'Show available commands' },
  { name: 'new', desc: 'Start a new conversation' },
  { name: 'clear', desc: 'Clear this conversation' },
  { name: 'stop', desc: 'Stop the running response' },
  { name: 'interrupt', args: '<message>', desc: 'Interrupt and send' },
  { name: 'queue', args: '<message>', desc: 'Queue a follow-up' },
  { name: 'steer', args: '<message>', desc: 'Steer the running response' },
  { name: 'model', args: '<id>', desc: 'Switch the conversation model' },
  { name: 'workspace', args: '<path>', desc: 'Switch workspace' },
  { name: 'terminal', desc: 'Toggle the workspace terminal' },
  { name: 'title', args: '<text>', desc: 'Rename this conversation' },
  { name: 'retry', desc: 'Retry the last turn' },
  { name: 'undo', desc: 'Undo the last turn' },
  { name: 'compress', aliases: ['compact'], desc: 'Compress the context' },
  { name: 'usage', desc: 'Show token usage' },
  { name: 'theme', args: '<light|dark|system>', desc: 'Switch theme' },
  { name: 'yolo', desc: 'Toggle YOLO mode (skip approvals)' },
  { name: 'branch', desc: 'Branch the conversation' },
  { name: 'voice', desc: 'Toggle voice mode' },
  { name: 'reasoning', args: '<level>', desc: 'Set reasoning effort' },
  { name: 'personality', args: '<name>', desc: 'Set the personality' },
  { name: 'goal', args: '<text>', desc: 'Set or show the goal' },
  { name: 'status', desc: 'Show session status' },
  { name: 'btw', args: '<question>', desc: 'Side question without affecting the run' },
  { name: 'background', args: '<message>', desc: 'Run in the background' },
  { name: 'skills', desc: 'List skills' },
  { name: 'use', args: '<skill>', desc: 'Use a skill' },
]

export interface ParsedCommand { name: string; args: string; raw: string }

export function parseCommand(text: string): ParsedCommand | null {
  const t = text.trimStart()
  if (!t.startsWith('/')) return null
  const mm = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(t)
  if (!mm) return null
  return { name: (mm[1] ?? '').toLowerCase(), args: (mm[2] ?? '').trim(), raw: t }
}

export interface CommandSuggestion { name: string; desc: string; args?: string | undefined; source: 'local' | 'server'; category?: string | undefined }

/** Merge local and server commands, dedupe by name, filter by prefix. */
export function suggestCommands(prefix: string, server: Command[]): CommandSuggestion[] {
  const p = prefix.toLowerCase()
  const seen = new Set<string>()
  const out: CommandSuggestion[] = []
  for (const c of LOCAL_COMMANDS) {
    const names = [c.name, ...(c.aliases ?? [])]
    if (names.some((n) => n.startsWith(p)) && !seen.has(c.name)) { seen.add(c.name); out.push({ name: c.name, desc: c.desc, args: c.args, source: 'local' }) }
  }
  for (const c of server) {
    if (c.cli_only || seen.has(c.name)) continue
    const names = [c.name, ...(c.aliases ?? [])]
    if (names.some((n) => n.toLowerCase().startsWith(p))) { seen.add(c.name); out.push({ name: c.name, desc: c.description ?? '', args: c.args_hint, source: 'server', category: c.category }) }
  }
  return out.slice(0, 40)
}

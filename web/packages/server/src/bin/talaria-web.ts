#!/usr/bin/env node
/**
 * `talaria-web`: the commands in `cli/main.ts`, plus
 *   talaria-web self-check   load the `serve` module graph and node-pty's native binding, then exit (TAL-1012)
 * The graph loads dynamically so a broken package reports its error here instead of crashing on a static import.
 * The updater runs `self-check` on a candidate before swapping it in; it binds no port, starts no sidecar, and touches no state.
 */
import { createRequire } from 'node:module'

const [command] = process.argv.slice(2)
try {
  const { main } = await import('../cli/main.js')
  if (command === 'self-check') createRequire(import.meta.url)('node-pty')
  else process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  console.error(`[${command === 'self-check' ? 'self-check' : 'bootstrap'}] ERROR: ${(error as Error).message}`)
  process.exitCode = 1
}

#!/usr/bin/env bash

# Sourced by the container before shell setup reads Web settings. The server owns alias policy.
_talaria_config="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)/packages/server/dist/config.js"
_talaria_env=$(node --input-type=module - "$_talaria_config" <<'NODE'
import { pathToFileURL } from 'node:url'
const { migrateLegacyWebEnv } = await import(pathToFileURL(process.argv[2]).href)
const before = { ...process.env }
migrateLegacyWebEnv(process.env, (line) => { console.error(line) })
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
for (const [key, value] of Object.entries(process.env)) {
  if (before[key] !== value) console.log(`export ${quote(`${key}=${value}`)}`)
}
for (const key of Object.keys(before)) {
  if (process.env[key] === undefined) console.log(`unset ${quote(key)}`)
}
NODE
) || return 1
eval "$_talaria_env" || return 1
unset _talaria_config _talaria_env

#!/usr/bin/env node
/** `talaria-web-mcp`: MCP stdio server exposing Talaria Web project and session management (Python `mcp_server.py`). */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createTalariaMcpServer } from '../mcp/server.js'
import { migrateLegacyWebEnv } from '../config.js'

migrateLegacyWebEnv(process.env, (line) => { console.error(line) })
const args = process.argv.slice(2)
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? (args[profileIndex + 1] ?? null) : null
const host = process.env.TALARIA_WEB_HOST ?? '127.0.0.1'
const port = process.env.TALARIA_WEB_PORT ?? '8787'
const server = createTalariaMcpServer({ baseUrl: `http://${host}:${port}`, password: (process.env.TALARIA_WEB_PASSWORD ?? '').trim() || null, profile })
await server.connect(new StdioServerTransport())

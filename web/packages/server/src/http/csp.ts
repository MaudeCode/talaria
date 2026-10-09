/** Content-Security-Policy builders (Python `api/helpers.py`). */
import type { Env } from '../config.js'

export const CSP_CONNECT_BASE =
  "'self' http://127.0.0.1:* http://localhost:* http://ipc.localhost https://127.0.0.1:* https://localhost:* ws://127.0.0.1:* ws://localhost:*"
const CSP_FRAME_BASE = "'self'"
const EXTRA_CONNECT_RE = /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9._~-]+(?::(\d{1,5}|\*))?$/
const EXTRA_FRAME_RE = /^https?:\/\/(?:\*\.)?[A-Za-z0-9._~-]+(?::(\d{1,5}|\*))?$/
export const CSP_REPORT_TO = '{"group":"csp-endpoint","max_age":10886400,"endpoints":[{"url":"/api/csp-report"}]}'

function validSource(re: RegExp, source: string): boolean {
  const m = re.exec(source)
  if (!m) return false
  const port = m[1]
  if (!port || port === '*') return true
  const n = Number(port)
  return n >= 1 && n <= 65535
}

function extraSources(raw: string | undefined, re: RegExp, warn: () => void): string {
  const value = (raw ?? '').trim()
  if (!value) return ''
  const sources = value.split(/\s+/)
  if (!sources.length || sources.some((s) => !validSource(re, s))) {
    warn()
    return ''
  }
  return ' ' + sources.join(' ')
}

export interface CspExtras { connect: string; frame: string }

export function cspExtras(env: Env, warn: (line: string) => void = () => undefined): CspExtras {
  return {
    connect: extraSources(env.HERMES_WEBUI_CSP_CONNECT_EXTRA, EXTRA_CONNECT_RE, () => { warn('Ignoring invalid HERMES_WEBUI_CSP_CONNECT_EXTRA value') }),
    frame: extraSources(env.HERMES_WEBUI_CSP_FRAME_EXTRA, EXTRA_FRAME_RE, () => { warn('Ignoring invalid HERMES_WEBUI_CSP_FRAME_EXTRA value') }),
  }
}

/** `frameAncestors: "'self'"` is only for a sandboxed document the app frames itself (an extension or plugin panel). */
export function buildCspEnforcedPolicy(extras: CspExtras, frameAncestors = "'none'"): string {
  return (
    "default-src 'self' https://*.cloudflareaccess.com; " +
    "object-src 'none'; " +
    `frame-ancestors ${frameAncestors}; ` +
    "script-src 'self' https://static.cloudflareinsights.com; " +
    "worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: https: blob:; " +
    "font-src 'self' data:; " +
    "media-src 'self' data: blob:; " +
    `connect-src ${CSP_CONNECT_BASE}${extras.connect}; ` +
    `frame-src ${CSP_FRAME_BASE}${extras.frame}; ` +
    "manifest-src 'self' https://*.cloudflareaccess.com; " +
    "base-uri 'self'; form-action 'self'"
  )
}

export function buildCspReportOnlyPolicy(extras: CspExtras): string {
  return buildCspEnforcedPolicy(extras) + '; report-uri /api/csp-report; report-to csp-endpoint'
}

import { describe, expect, it } from 'vitest'
import { classifyLine, classifyLog, MAX_MATCHES } from './log-lines.js'

const TAIL = [
  '2026-11-08 12:01:03,101 INFO gateway: connected to telegram',
  '2026-11-08 12:01:07,202 WARNING agent.providers: quota read took 4.2s',
  '2026-11-08 12:03:40,303 ERROR tools.mcp: server "linear" failed to connect: 401',
  'Traceback (most recent call last):',
  '  File "mcp/client.py", line 88, in connect',
  'ConnectionError: 401',
  '2026-11-08 12:04:02,404 cron: job "Dependency audit" queued',
  '2026-11-08 12:04:19,505 WARNING plugins: web-exa missing EXA_API_KEY',
]

describe('classifyLine', () => {
  it.each([
    ['CRITICAL', 'error'], ['FATAL', 'error'], ['ERROR', 'error'], ['error', 'error'],
    ['WARNING', 'warning'], ['WARN', 'warning'], ['Warn', 'warning'],
    ['INFO', 'info'], ['DEBUG', 'debug'], ['TRACE', 'debug'],
  ])('reads %s as %s', (token, level) => {
    expect(classifyLine(`2026-11-08 12:00:00,000 ${token} name: message`, null)).toEqual({ time: '2026-11-08 12:00:00,000', level, text: 'name: message' })
  })

  it.each([
    'ErrorBoundary rendered',
    'ERROR-rate held steady',
    'logger: INFO is the default',
    'logger: No error occurred',
    '- logger - ERROR rate held steady',
    '[ERROR text without a closing bracket',
  ])('preserves timestamped message text without a severity header: %s', (text) => {
    expect(classifyLine(`12:00:00 ${text}`, 'warning')).toEqual({ time: '12:00:00', level: null, text })
  })

  it('drops a bracketed token and the colon after it', () => {
    expect(classifyLine('[2026-11-08T12:00:00Z] [ERROR] boot failed', null)).toEqual({ time: '2026-11-08T12:00:00Z', level: 'error', text: 'boot failed' })
    expect(classifyLine('[bootstrap] ERROR: port in use', null)).toEqual({ time: null, level: 'error', text: '[bootstrap] port in use' })
    expect(classifyLine('12:00:00 [sidecar] [DEBUG]:  INFO  remains in the message', null)).toEqual({ time: '12:00:00', level: 'debug', text: '[sidecar] INFO  remains in the message' })
    expect(classifyLine('[ERROR] WARNING comes from the message', null)).toEqual({ time: null, level: 'error', text: 'WARNING comes from the message' })
    expect(classifyLine('[sidecar] [ERROR] [worker] WARNING comes from the message', null)).toEqual({ time: null, level: 'error', text: '[sidecar] [worker] WARNING comes from the message' })
  })

  it('reads the severity field of an Agent verbose header', () => {
    expect(classifyLine('12:00:00 - agent.turn - DEBUG [session_01] - No error occurred', null)).toEqual({
      time: '12:00:00', level: 'debug', text: 'agent.turn [session_01]: No error occurred',
    })
  })

  it('gives a timestamped line without a token no level, and an untimed one the previous level', () => {
    expect(classifyLine('12:00:00 plain', 'error')).toEqual({ time: '12:00:00', level: null, text: 'plain' })
    expect(classifyLine('  continuation', 'warning')).toEqual({ time: null, level: 'warning', text: '  continuation' })
    expect(classifyLine('no timestamp at all', null)).toEqual({ time: null, level: null, text: 'no timestamp at all' })
  })
})

describe('classifyLog', () => {
  it('classifies a tail, a traceback inheriting error, and counts before filtering', () => {
    const { entries, counts, matched } = classifyLog(TAIL)
    expect(entries.map((e) => e.level)).toEqual(['info', 'warning', 'error', 'error', 'error', 'error', null, 'warning'])
    expect(entries[3]).toEqual({ time: null, level: 'error', text: 'Traceback (most recent call last):' })
    expect(counts).toEqual({ error: 4, warning: 2, lines: 8 })
    expect(matched).toBe(8)
  })

  it('marks a count for attention only while the tail holds one', () => {
    expect(classifyLog(TAIL).count_tones).toEqual({ error: 'error', warning: 'warning' })
    expect(classifyLog(TAIL.slice(0, 1)).count_tones).toEqual({ error: null, warning: null })
  })

  it('starts a new record at a [tag] prefix, so the Web log\'s unlevelled records inherit nothing', () => {
    const web = ['[webui] WARNING: slow sidecar start', '[webui] run-journal retention archived 3 runs', '[updates] checked origin/main', '  indented continuation']
    expect(classifyLog(web).entries.map((e) => e.level)).toEqual(['warning', null, null, null])
    expect(classifyLog(web, { level: 'warning' }).matched).toBe(1)
    expect(classifyLog(web).counts).toMatchObject({ warning: 1 })
  })

  it('keeps ordinary severity words searchable without counting their records as errors', () => {
    const text = '[webui] No error occurred'
    const continuation = '    retry(error)'
    const web = ['[webui] ERROR: connection failed', continuation, text]
    const errors = classifyLog(web, { level: 'error' })
    expect(classifyLog(web, { q: 'error' }).entries).toContainEqual({ time: null, level: null, text, matches: [[11, 16]] })
    expect(errors.entries).toEqual([
      { time: null, level: 'error', text: '[webui] connection failed' },
      { time: null, level: 'error', text: continuation },
    ])
    expect(errors).toMatchObject({ matched: 2, counts: { error: 2, warning: 0, lines: 3 } })
  })

  it('keeps forwarded sidecar severity headers in the warning filter and counts', () => {
    const lines = [
      '[sidecar] [sidecar] ERROR talaria_sidecar: startup failed',
      '[sidecar] [sidecar] WARNING talaria_sidecar: retrying',
      '[sidecar] [sidecar] No error occurred',
    ]
    expect(classifyLog(lines, { level: 'warning' })).toMatchObject({
      entries: [
        { level: 'error', text: '[sidecar] [sidecar] talaria_sidecar: startup failed' },
        { level: 'warning', text: '[sidecar] [sidecar] talaria_sidecar: retrying' },
      ],
      counts: { error: 1, warning: 1, lines: 3 },
      matched: 2,
    })
  })

  it('keeps errors and their continuation lines for level error, warnings too for level warning', () => {
    const errors = classifyLog(TAIL, { level: 'error' })
    expect(errors.entries.map((e) => e.text)).toEqual(['tools.mcp: server "linear" failed to connect: 401', 'Traceback (most recent call last):', '  File "mcp/client.py", line 88, in connect', 'ConnectionError: 401'])
    expect(errors).toMatchObject({ matched: 4, counts: { error: 4, warning: 2, lines: 8 } })
    expect(classifyLog(TAIL, { level: 'warning' }).entries.map((e) => e.level)).toEqual(['warning', 'error', 'error', 'error', 'error', 'warning'])
  })

  it('keeps lines containing q case-insensitively, with its offsets in text', () => {
    const { entries, matched, counts } = classifyLog(TAIL, { q: 'MCP' })
    expect(entries).toEqual([
      { time: '2026-11-08 12:03:40,303', level: 'error', text: 'tools.mcp: server "linear" failed to connect: 401', matches: [[6, 9]] },
      { time: null, level: 'error', text: '  File "mcp/client.py", line 88, in connect', matches: [[8, 11]] },
    ])
    expect(matched).toBe(2)
    expect(counts.lines).toBe(8)
    expect(classifyLog(TAIL, { q: 'mcp', level: 'warning' }).matched).toBe(2)
    expect(classifyLog(TAIL, { q: 'telegram', level: 'error' }).matched).toBe(0)
  })

  it('stops marking matches at MAX_MATCHES while still listing every matching line', () => {
    const { entries, matched } = classifyLog(['a'.repeat(MAX_MATCHES + 5), 'a again'], { q: 'a' })
    expect(matched).toBe(2)
    expect(entries.reduce((n, e) => n + (e.matches?.length ?? 0), 0)).toBe(MAX_MATCHES)
    expect(entries[1]?.matches).toEqual([])
  })

  it('treats a blank q as no search', () => {
    expect(classifyLog(TAIL, { q: '  ' }).entries.every((e) => e.matches === undefined)).toBe(true)
    expect(classifyLog(TAIL, { q: '  ' }).matched).toBe(8)
  })
})

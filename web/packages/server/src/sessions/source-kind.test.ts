import { describe, expect, it } from 'vitest'
import { withSessionWireFlags } from './list.js'
import { sourceKind } from './source-kind.js'

describe('sourceKind (TAL-310)', () => {
  it.each([
    [{}, 'webui'],
    [{ session_source: 'fork' }, 'webui'],
    [{ session_source: 'cli', is_cli_session: true }, 'cli'],
    [{ raw_source: 'tui' }, 'cli'],
    [{ is_cli_session: true }, 'cli'],
    [{ raw_source: 'signal' }, 'messaging'],
    [{ source_tag: 'whatsapp' }, 'messaging'],
    [{ raw_source: 'weixin' }, 'messaging'],
    [{ raw_source: 'wecom_callback' }, 'messaging'],
    [{ session_source: 'messaging', raw_source: 'gateway' }, 'messaging'],
    [{ session_id: 'cron_job_1' }, 'cron'],
    [{ source_label: 'Cron' }, 'cron'],
    [{ source_tag: 'webhook' }, 'webhook'],
    [{ source_tag: 'kanban' }, 'kanban'],
    [{ session_source: 'api', raw_source: 'api_server' }, 'api'],
    [{ source_tag: 'subagent' }, 'subagent'],
    [{ source_tag: 'claude_code', session_source: 'external_agent', is_cli_session: true }, 'claude_code'],
    [{ source_tag: 'tool' }, 'other'],
  ])('%j is %s', (row, kind) => {
    expect(sourceKind(row)).toBe(kind)
  })

  it('lets an explicit WebUI marker win over a stale is_cli_session', () => {
    expect(sourceKind({ session_source: 'webui', is_cli_session: true })).toBe('webui')
  })

  it('never calls a row a subagent from parent linkage alone', () => {
    expect(sourceKind({ parent_session_id: 'parent', relationship_type: 'child_session' })).toBe('webui')
  })

  it('files a scheduled run under cron even when its id is the only marker', () => {
    expect(sourceKind({ session_id: 'cron_abc_20260101_000000', is_cli_session: true })).toBe('cron')
  })
})

describe('withSessionWireFlags source fields (TAL-310)', () => {
  const wire = (row: Record<string, unknown>) => withSessionWireFlags({ session_id: 's', ...row }, new Set())

  it('derives is_cli_session from the kind', () => {
    expect(wire({ raw_source: 'tui' })).toMatchObject({ source_kind: 'cli', is_cli_session: true })
    expect(wire({ source_tag: 'claude_code', session_source: 'external_agent' })).toMatchObject({ source_kind: 'claude_code', is_cli_session: true })
    expect(wire({ session_source: 'webui', is_cli_session: true })).toMatchObject({ source_kind: 'webui', is_cli_session: false })
    expect(wire({ raw_source: 'signal', is_cli_session: true })).toMatchObject({ source_kind: 'messaging', is_messaging_session: true, is_cli_session: false })
  })

  it('locks a row read-only whenever it is filed as a subagent', () => {
    expect(wire({ source_tag: 'cli', raw_source: 'subagent' })).toMatchObject({ source_kind: 'subagent', read_only: true, can_pin: false, is_cli_session: false })
  })

  it('files a scheduled run that delivers to a messaging channel as cron', () => {
    expect(wire({ session_id: 'cron_job_1', raw_source: 'telegram' })).toMatchObject({ source_kind: 'cron', is_messaging_session: false })
  })
})

import { describe, expect, it } from 'vitest'
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

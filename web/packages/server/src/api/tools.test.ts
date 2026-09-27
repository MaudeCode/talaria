/*
 * Regression ports (TAL-245): behaviour previously guarded by the Python cases in
 *   web/tests/test_issue1013_handoff_dock.py
 *   web/tests/test_issue1096_copy_buttons.py
 *   web/tests/test_issue1144_session_time_sync.py
 *   web/tests/test_issue1217_transcript_compaction.py
 *   web/tests/test_issue1431_toolsets_chip_responsive.py
 *   web/tests/test_issue1436_context_indicator_load_path.py
 *   web/tests/test_issue1438_fence_anchoring.py
 *   web/tests/test_issue1446_glued_heading_lift.py
 *   web/tests/test_issue1560_password_env_var_lock.py
 *   web/tests/test_issue1579_whats_new_link_404.py
 *   web/tests/test_issue1617_tps_message_header.py
 *   web/tests/test_issue1623_sse_heartbeat_alignment.py
 *   web/tests/test_issue1625_local_server_model_id_preservation.py
 *   web/tests/test_issue1680_codex_spark.py
 *   web/tests/test_issue1765_codex_quota.py
 *   web/tests/test_issue1800_file_html_interactions.py
 *   web/tests/test_issue1823_kanban_not_found.py
 *   web/tests/test_issue1867_upload_size_preflight.py
 *   web/tests/test_issue1879_cross_container_gateway_liveness.py
 *   web/tests/test_issue1880_profile_scoped_skills.py
 *   web/tests/test_issue1896_context_length_fallback_args.py
 *   web/tests/test_issue1897_profile_switch_agent_cache.py
 *   web/tests/test_issue1908_docker_hardening.py
 *   web/tests/test_issue1909_csp_report_only.py
 *   web/tests/test_issue1909_csrf_token.py
 *   web/tests/test_issue1910_login_attempt_persistence.py
 *   web/tests/test_issue1955_worktree_sessions.py
 *   web/tests/test_issue1955_worktree_ui_static.py
 *   web/tests/test_issue1968_mcp_profile_discovery.py
 *   web/tests/test_issue2057_worktree_ui_static.py
 *   web/tests/test_issue2157_sessions_list_stale_stream_state.py
 *   web/tests/test_issue2211_workspace_panel_reopen.py
 *   web/tests/test_issue2237_docker_chown_git_objects.py
 *   web/tests/test_issue2472_fork_from_here_messaging.py
 *   web/tests/test_issue2508_session_pin_cap.py
 *   web/tests/test_issue2513_custom_provider_remote_models.py
 *   web/tests/test_issue2540_models_endpoint_error.py
 *   web/tests/test_issue2542_anonymous_custom_endpoint.py
 *   web/tests/test_issue2572_csrf_diagnostics.py
 *   web/tests/test_issue2655_frontend.py
 *   web/tests/test_issue2661_2629_frontend.py
 *   web/tests/test_issue2698_isolated_hermes_home.py
 *   web/tests/test_issue2768_workspace_links.py
 *   web/tests/test_issue2785_gateway_cron_guidance.py
 *   web/tests/test_issue2823_large_markdown_preview.py
 *   web/tests/test_issue2841_show_cron_sessions_toggle.py
 *   web/tests/test_issue2914_truncation_watermark.py
 *   web/tests/test_issue2929_settings_max_tokens.py
 *   web/tests/test_issue2965_streaming_sessiondb_profile_home.py
 *   web/tests/test_issue3012_3006_docker_docs.py
 *   web/tests/test_issue3019_cron_project_sessions.py
 *   web/tests/test_issue3023_safe_session_id_validators.py
 *   web/tests/test_issue3066_disabled_read_profile.py
 *   web/tests/test_issue3066_profile_skill_disabled_state.py
 *   web/tests/test_issue3103_sse_no_connection_close.py
 *   web/tests/test_issue3225_rename_sync.py
 *   web/tests/test_issue3238_orphaned_cli_sidecar_prune.py
 *   web/tests/test_issue3283_profiles_config_import_order.py
 *   web/tests/test_issue3340_persistent_state_toasts.py
 *   web/tests/test_issue3402_workspace_tree_move.py
 *   web/tests/test_issue3405_profile_provider_resolution.py
 *   web/tests/test_issue3429_uri_scheme_model_ids.py
 *   web/tests/test_issue3460_cron_session_unread.py
 *   web/tests/test_issue3510_elevenlabs_tts.py
 *   web/tests/test_issue357.py
 *   web/tests/test_issue3571_saved_prompts.py
 *   web/tests/test_issue3582_tts_content_length.py
 *   web/tests/test_issue3587_intermediate_reasoning.py
 *   web/tests/test_issue3595_activity_default_expanded.py
 *   web/tests/test_issue3717_context_length_provider_overrides.py
 *   web/tests/test_issue3718_live_models_custom_probe.py
 *   web/tests/test_issue3797_kanban_cli_parity.py
 *   web/tests/test_issue3800_compaction_summary_length.py
 *   web/tests/test_issue3825_oidc_auth.py
 *   web/tests/test_issue3831_watermark_clear.py
 *   web/tests/test_issue3929_credential_pool_classification.py
 *   web/tests/test_issue3947_tasks_cross_profile_visibility.py
 *   web/tests/test_issue3959_model_suffix_dedup.py
 *   web/tests/test_issue3987_imported_session_titles.py
 *   web/tests/test_issue3994_materialize_session.py
 *   web/tests/test_issue4006_auto_scroll_follow_default.py
 *   web/tests/test_issue4053_external_skill_categories.py
 *   web/tests/test_issue4067_import_cli_cross_profile_guard.py
 *   web/tests/test_issue4164_bound_non_git_project_context_walk.py
 *   web/tests/test_issue4183_regenerate_materialize.py
 *   web/tests/test_issue4300_gateway_approval_notice.py
 *   web/tests/test_issue4346_vscroll_footer_jitter.py
 *   web/tests/test_issue4346_vscroll_recycled_anchor_jumpback.py
 *   web/tests/test_issue4385_cron_archive_reappears.py
 *   web/tests/test_issue4465_builtin_personalities.py
 *   web/tests/test_issue4470_kanban_task_editor_fields.py
 *   web/tests/test_issue4490_presession_toolsets.py
 *   web/tests/test_issue4536_service_tier.py
 *   web/tests/test_issue4685_post_compression_context_metering.py
 *   web/tests/test_issue470.py
 *   web/tests/test_issue4714_claude_code_visibility_toggle.py
 *   web/tests/test_issue4729_reasoning_sse_coalesce.py
 *   web/tests/test_issue4749_steer_reason_and_recovery.py
 *   web/tests/test_issue4759_parallel_sidebar_boot_fetch.py
 *   web/tests/test_issue4766_sidebar_source_pushdown.py
 *   web/tests/test_issue4768_cron_module_missing.py
 *   web/tests/test_issue477.py
 *   web/tests/test_issue4775_sidebar_hidden_zero_message_pushdown.py
 *   web/tests/test_issue4836_manual_compression_recovery.py
 *   web/tests/test_issue4842_cli_sessions_streaming_freeze.py
 *   web/tests/test_issue484_json_tree_viewer.py
 *   web/tests/test_issue486_487.py
 *   web/tests/test_issue487b.py
 *   web/tests/test_issue492_workspace_reorder.py
 *   web/tests/test_issue4982_openai_tts.py
 *   web/tests/test_issue4985_orphaned_webui_zero_message.py
 *   web/tests/test_issue5127_process_wakeup_bare_model.py
 *   web/tests/test_issue5130_cron_profile_snapshot.py
 *   web/tests/test_issue5204_redactor_memoization_contract.py
 *   web/tests/test_issue5269_gateway_approval_docs.py
 *   web/tests/test_issue5270_cli_webui_continuity.py
 *   web/tests/test_issue5311_opencode_go_static_models.py
 *   web/tests/test_issue5334_verification_stop_leak.py
 *   web/tests/test_issue5339_restart_stale_user_dedup.py
 *   web/tests/test_issue5345_clarify_toast_and_interrupt_provenance.py
 *   web/tests/test_issue538_mcp_management.py
 *   web/tests/test_issue5420_profile_switch_session_new.py
 *   web/tests/test_issue5532_clear_truncation_watermark.py
 *   web/tests/test_issue5532_session_clear_state_db_replay.py
 *   web/tests/test_issue5572_messaging_clear_semantics.py
 *   web/tests/test_issue5578_login_next_nesting.py
 *   web/tests/test_issue5686_completed_output_text.py
 *   web/tests/test_issue569_579.py
 *   web/tests/test_issue5731_session_model_provider_repair.py
 *   web/tests/test_issue5749_transparent_stream_prefix_dedupe.py
 *   web/tests/test_issue5940_terminal_error_surfaced.py
 *   web/tests/test_issue5941_errored_turn_response_visible.py
 *   web/tests/test_issue6006_ttft_instrumentation.py
 *   web/tests/test_issue6022_worktree_config_default.py
 *   web/tests/test_issue6066_workspace_sort.py
 *   web/tests/test_issue6066_workspace_sort_api_payload.py
 *   web/tests/test_issue6066_workspace_sort_layout.py
 *   web/tests/test_issue609.py
 *   web/tests/test_issue616.py
 *   web/tests/test_issue6174_public_share_media_embed.py
 *   web/tests/test_issue617_cron_profile_selector.py
 *   web/tests/test_issue634.py
 *   web/tests/test_issue646.py
 *   web/tests/test_issue6481_verification_evidence_phantom.py
 *   web/tests/test_issue6498_memory_config_gates.py
 *   web/tests/test_issue6571_identical_retry_settlement.py
 *   web/tests/test_issue6722_provider_qualified_model_leak.py
 *   web/tests/test_issue673.py
 *   web/tests/test_issue6751_api_content_agent_replay.py
 *   web/tests/test_issue6757_redaction_and_runner_sse_fixes.py
 *   web/tests/test_issue6853_docker_agents_context.py
 *   web/tests/test_issue6892_sync_title_coverage.py
 *   web/tests/test_issue6964_title_dedup.py
 *   web/tests/test_issue697_mcp_tool_inventory.py
 *   web/tests/test_issue716_agent_heartbeat.py
 *   web/tests/test_issue7228_model_picker_search.py
 *   web/tests/test_issue7426_skill_not_found_listing_truncation.py
 * (issues #357, #470, #477, #484, #486, #487, #492, #538, #569, #609, #616, #617, #634, #646, #673, #697, #716, #1013, #1096, #1144, #1217, #1431, #1436, #1438, #1446, #1560, #1579, #1617, #1623, #1625, #1680, #1765, #1800, #1823, #1867, #1879, #1880, #1896, #1897, #1908, #1909, #1910, #1955, #1968, #2057, #2157, #2211, #2237, #2472, #2508, #2513, #2540, #2542, #2572, #2655, #2661, #2698, #2768, #2785, #2823, #2841, #2914, #2929, #2965, #3012, #3019, #3023, #3066, #3103, #3225, #3238, #3283, #3340, #3402, #3405, #3429, #3460, #3510, #3571, #3582, #3587, #3595, #3717, #3718, #3797, #3800, #3825, #3831, #3929, #3947, #3959, #3987, #3994, #4006, #4053, #4067, #4164, #4183, #4300, #4346, #4385, #4465, #4470, #4490, #4536, #4685, #4714, #4729, #4749, #4759, #4766, #4768, #4775, #4836, #4842, #4982, #4985, #5127, #5130, #5204, #5269, #5270, #5311, #5334, #5339, #5345, #5420, #5532, #5572, #5578, #5686, #5731, #5749, #5940, #5941, #6006, #6022, #6066, #6174, #6481, #6498, #6571, #6722, #6751, #6757, #6853, #6892, #6964, #7228, #7426) is covered here; see docs/architecture/regression-port-ledger.md.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FakeSidecar } from '../sidecar/fake.js'
import { bootTestServer, type TestServer } from '../test/harness.js'
import { sanitizeClientEvent, updateNotificationOwner, WindowLimiter } from './tools-router.js'
import type { SessionInfo } from '../auth/store.js'
import { buildInsights } from '../tools/insights.js'
import { serverSummary, maskSecrets } from '../tools/mcp.js'
import { readProjectContext } from '../tools/memory.js'
import { toggleName, walkSkillFiles } from '../tools/skills.js'
import { UpdateService, type UpdateServiceDeps } from '../tools/updates.js'

type Json = Record<string, unknown>
const post = (s: TestServer, path: string, body: unknown, method = 'POST'): Promise<Response> => s.get(path, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const json = async (res: Response): Promise<Json> => (await res.json()) as Json

describe('skills, memory, prompts, commands, mcp, health, updates, diagnostics', () => {
  let s: TestServer
  let sidecar: FakeSidecar
  const configs = new Map<string, Json>()
  const fetched: string[] = []
  beforeAll(async () => {
    sidecar = new FakeSidecar()
    const fakeFetch: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      fetched.push(url)
      if (url.endsWith('/api/status')) return Promise.resolve(new Response(JSON.stringify({ version: '9.9.9', app: 'hermes-dashboard' }), { status: 200, headers: { 'content-type': 'application/json' } }))
      if (url.includes('/audio/speech') && typeof init?.body === 'string' && init.body.includes('"input":"big"')) return Promise.resolve(new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(1024 * 1024)) } }), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
      if (url.includes('/audio/speech')) return Promise.resolve(new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }))
      return Promise.resolve(new Response('nope', { status: 404 }))
    }
    s = await bootTestServer({ sidecar, deps: (deps) => {
      deps.fetch = fakeFetch
      deps.dnsLookup = () => Promise.resolve([{ address: '104.18.7.192', family: 4 }])
      deps.pinnedFetch = (url, init) => fakeFetch(url, init)
      // The test server's web root is this checkout; point the updater at an npm-style install so no fetch reaches GitHub or origin.
      const original = deps.updates
      deps.updates = new UpdateService({ ...(original as unknown as { deps: UpdateServiceDeps }).deps, webRoot: join(deps.config.stateDir, 'not-a-checkout'), agentDir: () => null })
    } })
    sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: existsSync(join(params.profile_home, 'config.yaml')), config: configs.get(params.profile_home) ?? {} }))
    sidecar.respond('config.set', (params) => { configs.set(params.profile_home, params.config); writeFileSync(join(params.profile_home, 'config.yaml'), `# ${String(Math.random())}\n`); return { ok: true as const, path: join(params.profile_home, 'config.yaml') } })
    writeFileSync(join(s.state, 'config.yaml'), '# seed\n')
    configs.set(s.state, { mcp_servers: { joplin: { url: 'https://notes.example/mcp', headers: { Authorization: 'Bearer secret' } }, local: { command: 'npx', args: ['server'], enabled: false }, broken: 'oops' }, webui: { dashboard: { enabled: 'auto' } }, tts: { openai: { voice: 'nova' } } })
  })
  afterAll(() => s.close())

  it('lists skills from the Agent, reads usage counters, and saves/toggles/deletes local skills', async () => {
    sidecar.respond('skills.list', (params) => ({ success: true, skills: [{ name: 'alpha', description: 'A', category: params.category ?? null, disabled: false }, { name: 'beta', description: 'B', category: null, disabled: true }], categories: [], count: 2 }))
    let res = await s.get('/api/skills?category=tools')
    expect(res.status).toBe(200)
    expect(((await json(res)).skills as Json[]).map((r) => r.name)).toEqual(['alpha', 'beta'])
    mkdirSync(join(s.state, 'skills'), { recursive: true })
    writeFileSync(join(s.state, 'skills', '.usage.json'), JSON.stringify({ alpha: { use_count: 2, view_count: '1', last_used: 'x' }, weird: 'nope' }))
    res = await s.get('/api/skills/usage')
    const usage = await json(res)
    expect(usage.total_invocations).toBe(3)
    expect(usage.unique_skills_used).toBe(1)
    expect((usage.usage as Json).alpha).toMatchObject({ use_count: 2, view_count: 1, patch_count: 0, last_used: 'x' })
    expect(usage.skill_names).toEqual(['alpha', 'beta'])
    res = await post(s, '/api/skills/save', { name: 'My Skill', content: '---\nname: my-skill\n---\n# hi', category: 'custom' })
    expect(res.status).toBe(200)
    const saved = await json(res)
    expect(saved.name).toBe('my-skill')
    expect(readFileSync(String(saved.path), 'utf8')).toContain('# hi')
    expect(walkSkillFiles(join(s.state, 'skills'))).toEqual([join(s.state, 'skills', 'custom', 'my-skill', 'SKILL.md')])
    res = await post(s, '/api/skills/save', { name: '../escape', content: 'x' })
    expect(res.status).toBe(400)
    sidecar.respond('skills.find', (params) => ({ found: params.name === 'my-skill', skill_dir: params.name === 'my-skill' ? join(s.state, 'skills', 'custom', 'my-skill') : null, skill_md: null }))
    res = await post(s, '/api/skills/toggle', { name: 'my-skill', enabled: false })
    expect(await json(res)).toEqual({ ok: true, name: 'my-skill', enabled: false })
    expect((configs.get(s.state)?.skills as Json).disabled).toEqual(['my-skill'])
    res = await post(s, '/api/skills/toggle', { name: 'my-skill', enabled: true })
    expect((configs.get(s.state)?.skills as Json).disabled).toEqual([])
    res = await post(s, '/api/skills/toggle', { name: 'ghost', enabled: true })
    expect(res.status).toBe(404)
    writeFileSync(join(s.state, 'skills', 'custom', 'my-skill', 'notes.md'), 'linked')
    res = await s.get('/api/skills/content?name=my-skill&file=notes.md')
    expect(await json(res)).toEqual({ content: 'linked', path: 'notes.md' })
    res = await s.get('/api/skills/content?name=my-skill&file=../../.usage.json')
    expect(res.status).toBe(400)
    res = await post(s, '/api/skills/delete', { name: 'my-skill' })
    expect(await json(res)).toEqual({ ok: true, name: 'my-skill' })
    expect(existsSync(join(s.state, 'skills', 'custom', 'my-skill'))).toBe(false)
    res = await post(s, '/api/skills/delete', { name: 'my-skill' })
    expect(res.status).toBe(404)
    // A category directory that is a symlink out of the skills root is never followed by the delete.
    const outside = join(s.state, 'outside-skills')
    mkdirSync(join(outside, 'victim-skill'), { recursive: true })
    writeFileSync(join(outside, 'victim-skill', 'SKILL.md'), '# victim')
    symlinkSync(outside, join(s.state, 'skills', 'linked-category'))
    res = await post(s, '/api/skills/delete', { name: 'victim-skill' })
    expect(res.status).toBe(404)
    expect(existsSync(join(outside, 'victim-skill', 'SKILL.md'))).toBe(true)
  })

  it('reads and writes memory files, honours config flags, and reports project context [py:test_issue4164_bound_non_git_project_context_walk.py::test_non_git_workspace_still_reads_in_workspace_context]', async () => {
    const ws = join(s.state, 'workspace')
    mkdirSync(ws, { recursive: true })
    writeFileSync(join(ws, 'AGENTS.md'), '---\ntitle: x\n---\n\n# Rules\nsk-live-1234567890abcdefghij')
    writeFileSync(join(ws, 'CLAUDE.md'), 'shadowed')
    let res = await s.get(`/api/memory?workspace=${encodeURIComponent(ws)}`)
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.memory).toBe('')
    expect(body.soul_path).toBe(join(s.state, 'SOUL.md'))
    expect(body.project_context_name).toBe('AGENTS.md')
    expect(body.project_context).toContain('# Rules')
    expect(body.project_context).not.toContain('---')
    expect(body.project_context).not.toContain('sk-live-1234567890abcdefghij')
    expect((body.project_context_shadowed as Json[])[0]).toMatchObject({ name: 'CLAUDE.md', shadowed_by: 'AGENTS.md' })
    expect(body.external_notes_enabled).toBe(false)
    res = await post(s, '/api/memory/write', { target: 'memory', content: '# remembered' })
    expect(await json(res)).toEqual({ ok: true, section: 'memory', path: join(s.state, 'memories', 'MEMORY.md') })
    res = await post(s, '/api/memory/write', { section: 'soul', content: 'soul text' })
    expect(res.status).toBe(200)
    res = await post(s, '/api/memory/write', { section: 'nope', content: 'x' })
    expect(res.status).toBe(400)
    // A symlinked USER.md is refused by the open itself (O_NOFOLLOW), not only by the pre-check, and its target is untouched.
    writeFileSync(join(s.state, 'victim.txt'), 'untouched')
    symlinkSync(join(s.state, 'victim.txt'), join(s.state, 'memories', 'USER.md'))
    res = await post(s, '/api/memory/write', { section: 'user', content: 'overwrite' })
    expect(res.status).toBe(400)
    expect(readFileSync(join(s.state, 'victim.txt'), 'utf8')).toBe('untouched')
    res = await s.get('/api/memory')
    body = await json(res)
    expect(body.memory).toBe('# remembered')
    expect(body.soul).toBe('soul text')
    expect(typeof body.memory_mtime).toBe('number')
    configs.set(s.state, { ...configs.get(s.state), memory: { memory_enabled: false } })
    writeFileSync(join(s.state, 'config.yaml'), '# bump\n')
    res = await post(s, '/api/memory/write', { section: 'memory', content: 'x' })
    expect(res.status).toBe(403)
    res = await s.get('/api/memory')
    expect((await json(res)).memory_path).toBe('')
    configs.set(s.state, { ...configs.get(s.state), memory: {} })
    writeFileSync(join(s.state, 'config.yaml'), '# bump2\n')
  })

  it('saved prompts round-trip with limits', async () => {
    let res = await s.get('/api/prompts')
    expect(await json(res)).toEqual({ prompts: [] })
    res = await post(s, '/api/prompts', { text: '  hello world  ' })
    expect(res.status).toBe(200)
    const created = (await json(res)).prompt as Json
    expect(created.label).toBe('hello world')
    expect(String(created.id)).toHaveLength(12)
    res = await post(s, '/api/prompts', { text: 'x'.repeat(8001) })
    expect(res.status).toBe(400)
    res = await post(s, '/api/prompts', {})
    expect(res.status).toBe(400)
    res = await s.get('/api/prompts')
    expect(((await json(res)).prompts as Json[]).map((p) => p.id)).toEqual([created.id])
    res = await post(s, '/api/prompts', { id: created.id }, 'DELETE')
    expect(await json(res)).toEqual({ ok: true })
    res = await s.get('/api/prompts')
    expect(await json(res)).toEqual({ prompts: [] })
  })

  it('commands list and exec go through the sidecar with error mapping', async () => {
    let res = await s.get('/api/commands')
    expect(res.status).toBe(200)
    const commands = (await json(res)).commands as Json[]
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.every((c) => c.gateway_only === false)).toBe(true)
    res = await post(s, '/api/commands/exec', { command: '/reload-skills' })
    expect((await json(res)).output).toContain('Reloaded skills')
    res = await post(s, '/api/commands/exec', { command: '' })
    expect(res.status).toBe(400)
    sidecar.respond('commands.exec', () => { throw Object.assign(new Error('unknown command'), { name: 'SidecarError' }) })
    const { SidecarError } = await import('../sidecar/client.js')
    sidecar.respond('commands.exec', () => { throw new SidecarError('unknown command', { condition: 'command_not_found' }) })
    res = await post(s, '/api/commands/exec', { command: '/nope' })
    expect(res.status).toBe(404)
  })

  it('MCP inventory masks secrets and actions edit config.yaml', async () => {
    let res = await s.get('/api/mcp/servers')
    expect(res.status).toBe(200)
    let body = await json(res)
    const servers = body.servers as Json[]
    expect(servers.map((r) => r.name)).toEqual(['joplin', 'local', 'broken'])
    expect(servers[0]).toMatchObject({ transport: 'http', enabled: true, active: false, status: 'configured', health: 'unknown', headers: { Authorization: '••••••' } })
    expect(servers[1]).toMatchObject({ transport: 'stdio', enabled: false, status: 'disabled', health: 'not_checked' })
    expect(servers[2]).toMatchObject({ transport: 'invalid', status: 'invalid_config' })
    expect(body.toggle_supported).toBe(true)
    res = await s.get('/api/mcp/tools')
    body = await json(res)
    expect(body).toMatchObject({ tools: [], total: 0, source: 'none', unavailable_servers: ['joplin'] })
    res = await post(s, '/api/mcp/servers/local', { enabled: true })
    expect(await json(res)).toEqual({ ok: true, name: 'local', enabled: true })
    res = await post(s, '/api/mcp/servers/new-one', { url: 'https://x.example/mcp', headers: { 'X-Token': 'abc' }, timeout: '30' })
    expect(res.status).toBe(200)
    expect((await json(res)).server).toMatchObject({ name: 'new-one', transport: 'http', headers: { 'X-Token': '••••••' }, timeout: 30 })
    res = await post(s, '/api/mcp/servers/new-one', { url: 'https://x.example/mcp', headers: { 'X-Token': '••••••' } }, 'PUT')
    expect(res.status).toBe(200)
    expect(((configs.get(s.state)?.mcp_servers as Json)['new-one'] as Json).headers).toEqual({ 'X-Token': 'abc' })
    res = await post(s, '/api/mcp/servers/new-one', { enabled: false }, 'PATCH')
    expect(await json(res)).toEqual({ ok: true, name: 'new-one', enabled: false })
    res = await post(s, '/api/mcp/servers/new-one', {}, 'DELETE')
    expect(await json(res)).toEqual({ ok: true, deleted: 'new-one' })
    res = await post(s, '/api/mcp/servers/new-one', { delete: true })
    expect(res.status).toBe(404)
    res = await post(s, '/api/mcp/servers/x', { nothing: true })
    expect(res.status).toBe(400)
  })

  it('notes drawer stays disabled by default', async () => {
    let res = await s.get('/api/notes/sources')
    expect(await json(res)).toMatchObject({ enabled: false, source: 'disabled', sources: [] })
    res = await s.get('/api/notes/search?q=x')
    expect(res.status).toBe(404)
  })

  it('insights, logs, health, dashboard, plugins, and updates answer their shapes', async () => {
    let res = await s.get('/api/insights?days=7')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(body.period_days).toBe(7)
    expect((body.daily_tokens as Json[]).length).toBe(7)
    expect((body.activity_by_day as Json[]).length).toBe(7)
    res = await s.get('/api/logs?file=agent&tail=100')
    body = await json(res)
    expect(body).toMatchObject({ file: 'agent', tail: 100, lines: [], truncated: false, total_bytes: 0 })
    mkdirSync(join(s.state, 'logs'), { recursive: true })
    writeFileSync(join(s.state, 'logs', 'errors.log'), 'a\nb\nc\n')
    res = await s.get('/api/logs?file=errors&tail=7')
    body = await json(res)
    expect(body).toMatchObject({ tail: 200, lines: ['a', 'b', 'c'], total_bytes: 6, hint: '' })
    res = await s.get('/api/logs?file=../etc/passwd')
    expect(res.status).toBe(400)
    res = await s.get('/api/system/health')
    body = await json(res)
    expect(body.available).toBe(true)
    expect(typeof (body.memory as Json).percent).toBe('number')
    // Python `_webui_runtime_payload` sections.
    expect(body.webui_runtime).toMatchObject({ sessions: { available: true }, streams: { available: true, active: 0, subscriber_dropped_events: 0 }, session_list_cache: { available: false }, models_cache: { available: true } })
    expect(typeof ((body.webui_runtime as Json).sessions as Json).cap).toBe('number')
    res = await s.get('/api/health/agent')
    body = await json(res)
    expect(body.alive).toBeNull()
    expect(body.gateway_chat).toMatchObject({ enabled: false, backend: 'local' })
    res = await s.get('/api/dashboard/status')
    body = await json(res)
    expect(body).toMatchObject({ running: true, enabled: 'auto', version: '9.9.9', host: '127.0.0.1', port: 9119 })
    expect(fetched.some((u) => u === 'http://127.0.0.1:9119/api/status')).toBe(true)
    sidecar.respond('plugins.list', () => ({ plugins: [{ name: 'p', key: 'memory/p', version: '1', description: '', enabled: false, kind: 'exclusive', activation: 'exclusive', hooks: [], is_active_provider: false }], supported_hooks: ['pre_tool_call'] }))
    res = await s.get('/api/plugins')
    body = await json(res)
    expect(body.empty).toBe(false)
    expect((body.plugins as Json[])[0]).toMatchObject({ key: 'memory/p' })
    // GET answers the cache without network or git work; POST runs the check (an npm install has no checkout to fast-forward).
    res = await s.get('/api/updates/check')
    body = await json(res)
    expect(body).toMatchObject({ webui: null, agent: null, cached: true, channel: 'stable' })
    res = await post(s, '/api/updates/check', { force: true })
    body = await json(res)
    expect((body.webui as Json)).toMatchObject({ name: 'webui', manual_update: true, no_git: true, current_version: 'web-v0.0.0-test' })
    expect((body.agent as Json)).toMatchObject({ name: 'agent', behind: null, no_git: true })
    expect((await json(await s.get('/api/updates/check'))).cached).toBe(true)
    res = await post(s, '/api/updates/apply', { target: 'webui' })
    body = await json(res)
    expect(body).toMatchObject({ ok: false, manual_update: true })
    res = await post(s, '/api/updates/apply', { target: 'agent' })
    body = await json(res)
    expect(body).toMatchObject({ ok: false, message: 'Not a git repository' })
    expect(typeof body.notification_id).toBe('string')
    res = await post(s, '/api/updates/apply', { target: 'x' })
    expect(res.status).toBe(400)
    res = await post(s, '/api/updates/summary', { updates: { webui: { behind: 2 } } })
    body = await json(res)
    expect(body.generated_by).toBe('fallback')
    expect(body.summary).toContain('WebUI has 2 update(s) available.')
    res = await post(s, '/api/settings', { check_for_updates: false })
    expect(res.status).toBe(200)
    res = await s.get('/api/updates/check')
    expect(await json(res)).toEqual({ disabled: true })
    res = await post(s, '/api/updates/check', { force: true })
    expect((await json(res)).channel).toBe('stable')
    res = await s.get('/api/transcribe/capability')
    expect(await json(res)).toEqual({ ok: true, available: false, provider: 'none' })
  })

  it('shutdown and restart are operator-gated and restart maps sidecar outcomes', async () => {
    sidecar.respond('gateway.restart', () => ({ status: 'busy', message: 'Restart already in progress. Please wait a moment and try again.' }))
    let res = await post(s, '/api/health/restart', {})
    expect(res.status).toBe(429)
    sidecar.respond('gateway.restart', () => ({ status: 'completed', message: 'ok' }))
    res = await post(s, '/api/health/restart', {})
    expect(await json(res)).toEqual({ ok: true, message: 'Gateway service restarted successfully' })
    const original = s.deps.requestShutdown
    let requested = false
    s.deps.requestShutdown = () => { requested = true }
    res = await post(s, '/api/shutdown', {})
    expect(await json(res)).toEqual({ status: 'shutting_down' })
    expect(requested).toBe(true)
    s.deps.requestShutdown = original
  })

  it('owns update notification lifecycle through typed HTTP routes', async () => {
    let res = await s.get('/api/update-notifications')
    expect(res.status).toBe(200)
    let body = await json(res)
    expect(typeof body.unread_count).toBe('number')
    expect(typeof body.clearable_count).toBe('number')
    expect(typeof body.can_clear).toBe('boolean')
    expect(typeof body.scope_id).toBe('string')

    res = await post(s, '/api/updates/apply', { target: 'webui' })
    const applied = await json(res)
    expect(applied.ok).toBe(false)
    const notificationID = String(applied.notification_id)
    expect(notificationID).toMatch(/^[0-9a-f-]{36}$/)

    body = await json(await s.get('/api/update-notifications'))
    const notification = (body.notifications as Json[]).find((row) => row.id === notificationID)
    expect(notification).toMatchObject({ kind: 'update', target: 'webui', phase: 'failed', read_at: null, destination: { key: 'settings.system' } })

    res = await post(s, `/api/update-notifications/${notificationID}/read`, { read: true })
    const readNotification = await json(res)
    expect(readNotification.id).toBe(notificationID)
    expect(typeof readNotification.read_at).toBe('string')
    res = await post(s, '/api/update-notifications/clear', { clear: true })
    body = await json(res)
    expect((body.notifications as Json[]).some((row) => row.id === notificationID)).toBe(false)
    expect(body.clearable_count).toBe(0)
    expect(body.can_clear).toBe(false)
  })

  it('compares a Web tab build and keeps its refresh notice tab-scoped until the reloaded build is verified', async () => {
    const oldBuild = 'a'.repeat(64)
    const newBuild = 'b'.repeat(64)
    const originalBuildId = s.deps.spa.buildId.bind(s.deps.spa)
    let current: string | null = newBuild
    s.deps.spa.buildId = () => current
    try {
      const list = async (query: string) => json(await s.get(`/api/update-notifications${query}`))
      const res = await s.get('/api/update-notifications?tab_id=tab-aaaaaaaa&loaded_build=' + oldBuild)
      expect(res.status).toBe(200)
      expect(res.headers.get('cache-control')).toBe('no-store')
      let body = await json(res)
      const id = String((body.frontend_build as Json).notification_id)
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: oldBuild, refresh_required: true, notification_id: id })
      expect((body.notifications as Json[]).filter((row) => row.kind === 'web_refresh')).toMatchObject([{ id, requires_interaction: true, can_dismiss: false, actions: [{ id: 'reload', acknowledges: false }] }])

      body = await list('')
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: null, refresh_required: false, notification_id: null })
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
      body = await list('?tab_id=tab-bbbbbbbb&loaded_build=' + newBuild)
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
      expect((await s.get(`/api/update-notifications?tab_id=x&loaded_build=${oldBuild}`)).status).toBe(400)

      expect((await post(s, `/api/update-notifications/${id}/read`, { read: true })).status).toBe(404)
      expect(await json(await post(s, `/api/update-notifications/${id}/read`, { read: true, tab_id: 'tab-aaaaaaaa' }))).toMatchObject({ unread: false, requires_interaction: true })
      expect((await post(s, `/api/update-notifications/${id}/dismiss`, { dismiss: true, tab_id: 'tab-aaaaaaaa' })).status).toBe(409)
      body = await json(await post(s, '/api/update-notifications/clear', { clear: true, tab_id: 'tab-aaaaaaaa', loaded_build: oldBuild }))
      expect((body.notifications as Json[]).map((row) => row.id)).toContain(id)
      expect(body.frontend_build).toMatchObject({ refresh_required: true, notification_id: id })
      expect(await json(await post(s, `/api/update-notifications/${id}/actions/reload`, { perform: true, tab_id: 'tab-aaaaaaaa' }))).toMatchObject({ requires_interaction: true })

      current = null
      body = await list('?tab_id=tab-aaaaaaaa&loaded_build=' + newBuild)
      expect(body.frontend_build).toMatchObject({ current_build: null, refresh_required: false })
      expect((body.notifications as Json[]).map((row) => row.id)).toContain(id)

      current = newBuild
      body = await list('?tab_id=tab-aaaaaaaa&loaded_build=' + newBuild)
      expect(body.frontend_build).toEqual({ current_build: newBuild, loaded_build: newBuild, refresh_required: false, notification_id: null })
      expect((body.notifications as Json[]).some((row) => row.id === id)).toBe(false)
    } finally {
      s.deps.spa.buildId = originalBuildId
    }
  })

  it('deduplicates concurrent update requests onto one server lifecycle record', async () => {
    const originalApply = s.deps.updates.apply.bind(s.deps.updates)
    let finish!: () => void
    const gate = new Promise<void>((resolve) => { finish = resolve })
    let calls = 0
    s.deps.updates.apply = async () => { calls += 1; await gate; return { ok: false, message: 'fixture failure' } }
    try {
      const first = post(s, '/api/updates/apply', { target: 'webui' })
      for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(calls).toBe(1)
      const cleared = await json(await post(s, '/api/update-notifications/clear', { clear: true }))
      expect(cleared.notifications).toEqual([])
      const duplicate = await json(await post(s, '/api/updates/apply', { target: 'webui' }))
      expect(duplicate).toMatchObject({ ok: false, status: 'already_in_progress' })
      expect(typeof duplicate.notification_id).toBe('string')
      expect(calls).toBe(1)
      finish()
      const completed = await json(await first)
      expect(completed.notification_id).toBe(duplicate.notification_id)
      const listed = await json(await s.get('/api/update-notifications'))
      expect((listed.notifications as Json[]).filter((row) => row.id === completed.notification_id)).toHaveLength(0)
    } finally {
      finish()
      s.deps.updates.apply = originalApply
    }
  })

  it('transcribe proxies multipart audio to the sidecar; tts proxies openai and rate limits [py:test_issue2931_edge_tts_endpoint.py::test_tts_requires_text] [py:test_issue2931_edge_tts_endpoint.py::test_tts_rate_limits_second_immediate_request] [py:test_issue4982_openai_tts.py::test_openai_tts_no_key_returns_503]', async () => {
    sidecar.respond('stt.transcribe', (params) => ({ transcript: `heard ${String(Buffer.from(params.audio_b64, 'base64').length)} bytes${params.suffix ?? ''}` }))
    const boundary = 'abc'
    const body = [`--${boundary}`, 'Content-Disposition: form-data; name="file"; filename="clip.webm"', 'Content-Type: audio/webm', '', 'audio-bytes', `--${boundary}--`, ''].join('\r\n')
    let res = await s.get('/api/transcribe', { method: 'POST', body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ ok: true, transcript: 'heard 11 bytes.webm' })
    res = await s.get('/api/transcribe', { method: 'POST', body: '--x--', headers: { 'content-type': 'multipart/form-data; boundary=x' } })
    expect(res.status).toBe(400)
    res = await post(s, '/api/tts', { text: 'hi', engine: 'openai' })
    expect(res.status).toBe(503)
    writeFileSync(join(s.state, '.env'), 'OPENAI_API_KEY=sk-test-1234\n')
    chmodSync(join(s.state, '.env'), 0o600)
    // An unbounded upstream body is cut off at the 16 MiB cap instead of being buffered.
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'big', engine: 'openai' })
    expect(res.status).toBe(502)
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'hi', engine: 'openai' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/mpeg')
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe('ID3fake-mp3')
    res = await post(s, '/api/tts', { text: 'again', engine: 'openai' })
    expect(res.status).toBe(429)
    res = await post(s, '/api/tts', { text: '', engine: 'openai' })
    expect(res.status).toBe(400)
    s.deps.ttsLimiter = new WindowLimiter(2, 1)
    res = await post(s, '/api/tts', { text: 'x', engine: 'edge' })
    expect(res.status).toBe(503) // Edge TTS is a decided removal; the matrix documents the 503
  })

  it('client events are sanitised and csp reports are accepted without auth', async () => {
    let res = await post(s, '/api/client-events/log', { event: 'sse_closed', url_path: 'https://evil/x?token=1', reason: 'r'.repeat(500), cookie: 'secret' })
    expect(await json(res)).toEqual({ ok: true, event: 'sse_closed' })
    expect(sanitizeClientEvent({ event: 'e', url_path: 'https://evil/x?token=1', reason: 'r'.repeat(500), cookie: 'x' })).toEqual({ event: 'e', url_path: '/x', reason: 'r'.repeat(160) })
    expect(sanitizeClientEvent('nope')).toEqual({ event: 'unknown' })
    expect(sanitizeClientEvent({ event: 'net', ready_state: 2, online: 'no' })).toEqual({ event: 'net', ready_state: 2, online: false })
    expect(sanitizeClientEvent({ event: 'net', ready_state: true, online: 'maybe' })).toEqual({ event: 'net' })
    res = await s.get('/api/csp-report', { method: 'POST', body: JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src' } }), headers: { 'content-type': 'application/csp-report' } })
    expect(res.status).toBe(204)
    expect(s.logs.some((l) => l.includes('[csp-report]') && l.includes('script-src'))).toBe(true)
  })
})

describe('tools helpers', () => {
  it('keys OIDC notifications by stable issuer and subject without cross-owner sharing', () => {
    const session = (token: string, issuer: string, subject: string, boundProfile = 'work'): SessionInfo => ({
      token, expiry: 2_000_000_000, auth_type: 'oidc', username: 'shared@example.test', bound_profile: boundProfile,
      oidc_issuer: issuer, oidc_subject: subject,
    })
    const first = updateNotificationOwner(session('token-a', 'https://issuer.example', 'principal-a'))
    expect(updateNotificationOwner(session('token-b', 'https://issuer.example', 'principal-a'))).toBe(first)
    expect(updateNotificationOwner(session('token-c', 'https://issuer.example', 'principal-a', 'personal'))).toBe(first)
    expect(updateNotificationOwner(session('token-d', 'https://issuer.example', 'principal-b'))).not.toBe(first)
    expect(updateNotificationOwner(session('token-e', 'https://other-issuer.example', 'principal-a'))).not.toBe(first)
    expect(updateNotificationOwner(session('token-f', 'https://issuer.example', 'principal-a '))).not.toBe(first)
    expect(first.length).toBeLessThanOrEqual(256)

    const legacy = (token: string): SessionInfo => ({ token, expiry: 2_000_000_000, auth_type: 'oidc', username: 'shared@example.test', bound_profile: 'work' })
    expect(updateNotificationOwner(legacy('legacy-a'))).not.toBe(updateNotificationOwner(legacy('legacy-b')))
  })

  it('window limiter, toggle list, mcp summary, project context', () => {
    let t = 0
    const limiter = new WindowLimiter(60, 2, () => t)
    expect(limiter.limited('a')).toBe(false)
    expect(limiter.limited('a')).toBe(false)
    expect(limiter.limited('a')).toBe(true)
    t = 61
    expect(limiter.limited('a')).toBe(false)
    expect(toggleName('a, b', 'b', true)).toEqual(['a'])
    expect(toggleName(['a'], 'b', false)).toEqual(['a', 'b'])
    expect(maskSecrets({ API_KEY: 'x', nested: { token: 'y', ok: 'z' } })).toEqual({ API_KEY: '••••••', nested: { token: '••••••', ok: 'z' } })
    expect(serverSummary('s', { command: 'run', env: { SECRET: 'x' } }, { connected: true, tools: [1, 2] })).toMatchObject({ transport: 'stdio', active: true, status: 'active', tool_count: 2, env: { SECRET: '••••••' } })
    expect(readProjectContext(null)).toMatchObject({ content: '', path: '' })
    const now = 1_760_000_000
    const insights = buildInsights([{ created_at: now - 100, updated_at: now - 50, input_tokens: 10, output_tokens: 5, cache_read_tokens: 5, estimated_cost: '$0.5', message_count: 3, model: 'm' }, { created_at: now - 10 * 86_400 * 4 }], '3', now)
    expect(insights).toMatchObject({ period_days: 3, total_sessions: 1, total_messages: 3, total_tokens: 15, total_cost: 0.5, total_cache_hit_percent: 33 })
    expect((insights.models as Json[])[0]).toMatchObject({ model: 'm', sessions: 1, session_share: 100, cost_share: 100 })
  })
})

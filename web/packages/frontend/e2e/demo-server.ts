import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootTestServer } from '../../server/dist/test/harness.js'
import { FakeSidecar } from '../../server/dist/sidecar/fake.js'
import { groupFixture } from '../../server/dist/test/group-fixture.js'
import { Session } from '../../server/dist/sessions/session.js'
import { writeEnvFile } from '../../server/dist/test/env-file.js'

/** The seeded chat with tool calls and thinking; `/session/<id>` opens its transcript. */
export const DEMO_SESSION_ID = '20261108_120000_demo'

const DAY = 86_400
const toolCall = (id: string, name: string, args: object) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const choices = (topic: string) => [{ value: 'keep', label: `Keep ${topic}`, effect: 'Nothing changes.' }, { value: 'change', label: `Change ${topic}`, effect: `${topic} changes tonight.` }]
/** One decision review item as the harness toolset sends it. */
export const decisionItem = (id: string, topic: string) => ({ id, title: `${topic} policy`, question: `Should ${topic} change?`, explanation: `${topic} affects every chat.`, example: null, current: `${topic} stays as it is.`, recommendation: 'Keep it.', recommended_choice: 'keep', choices: choices(topic), technical: { detail: 'Set in config.yaml.', sources: ['https://example.com/docs'] } })
// Persisted shape from the Agent's cron store, as `packages/server/src/tools/crons.test.ts` uses it; synthetic ids only.
const job = (id: string, name: string, extra: object) => ({ id, name, prompt: `${name}: synthetic prompt`, schedule: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' }, repeat: { times: null, completed: 12 }, enabled: true, state: 'scheduled', next_run_at: '2026-11-10T09:00:00+00:00', last_status: 'ok', profile: null, toast_notifications: true, monitor: '', continuity: false, ...extra })

/** A server whose fake sidecar answers `gateway.groups` from the group fixture: one discussion, "Design review", between two profiles. */
export async function discussionServer() {
  const sidecar = new FakeSidecar(), fixture = groupFixture(sidecar)
  const server = await bootTestServer({ sidecar, env: { HERMES_WEBUI_SKIP_ONBOARDING: '1' }, deps: (deps) => {
    deps.profiles.list = () => Promise.resolve([{ name: 'default', is_default: true, display_name: 'Writer' }, { name: 'helper', display_name: 'Reviewer' }])
  } })
  return { sidecar, fixture, server }
}

/**
 * A real server with synthetic data on the pages the replay server leaves empty: chats with a tool-call transcript and
 * token usage (Insights reads the same sessions), scheduled jobs, an open decision review and a discussion. Everything
 * is stored or answered server-side, so each page shows the server's own computed fields. `demo-tour.spec.ts` is its
 * check; `TOUR_SHOTS=<dir>` there saves a screenshot of every page. A failed seed closes the server before it throws.
 */
export async function bootDemoServer() {
  const { sidecar, fixture, server } = await discussionServer()
  try {
    return { server, reviewId: await seed(server, sidecar, fixture) }
  } catch (error) {
    await server.close()
    throw error
  }
}

async function seed(server: Awaited<ReturnType<typeof discussionServer>>['server'], sidecar: FakeSidecar, discussion: ReturnType<typeof groupFixture>): Promise<string> {
  sidecar.respond('cron.list', (params) => ({
    jobs: [job('digest', 'Morning digest', {}), job('backup', 'Weekly backup', { enabled: false, state: 'paused' }), job('audit', 'Dependency audit', { last_status: 'error', last_error: 'Synthetic failure: registry unreachable' })] as never[],
    ...(params.probe_store ? { schedule_policy: true } : {}),
  }))
  // A config.yaml with a default model and two synthetic provider keys gives the model picker a catalog to show.
  writeFileSync(join(server.state, 'config.yaml'), '# demo\n')
  sidecar.respond('config.get', (params) => ({ path: join(params.profile_home, 'config.yaml'), exists: true, config: { model: { default: 'claude-sonnet-4-6', provider: 'anthropic' } } }))
  writeEnvFile(join(server.state, '.env'), { ANTHROPIC_API_KEY: 'sk-ant-demo-0000', OPENROUTER_API_KEY: 'sk-or-demo-0000' })
  // The main model's reasoning levels, so Settings › Models shows its effort and Show thinking rows (TAL-2078).
  sidecar.respond('models.reasoning_efforts', () => ({ efforts: ['low', 'medium', 'high'], supports_reasoning: true }))
  server.deps.agentConfig.invalidate()
  server.deps.catalog.invalidate()
  const workspace = join(server.state, 'workspace')
  mkdirSync(workspace, { recursive: true })
  const now = Math.floor(Date.now() / 1000)
  const saveSession = (data: Record<string, unknown>) => server.deps.sessionStore.save(new Session({ profile: 'default', workspace, ...data }, { workspace, model: null }))

  await saveSession({
    session_id: DEMO_SESSION_ID, title: 'Audit the settings pages', model: 'claude-sonnet-4-6', pinned: true, input_tokens: 48_200, output_tokens: 3_900, estimated_cost: 0.31, created_at: now - 3600, updated_at: now - 600,
    messages: [
      { role: 'user', content: 'Audit the settings pages and tell me which ones need work.', timestamp: now - 3600 },
      { role: 'assistant', content: '', reasoning: 'Read the section components first, then compare each with the design system.', tool_calls: [toolCall('read', 'read_file', { path: 'src/features/settings/ChatSection.tsx' }), toolCall('grep', 'terminal', { command: 'grep -rn "settingKey" src/features/settings | wc -l' })], timestamp: now - 3590 },
      { role: 'tool', tool_call_id: 'read', content: 'export function ChatSection() {\n  // 87 lines\n}', timestamp: now - 3585 },
      { role: 'tool', tool_call_id: 'grep', content: '58', timestamp: now - 3580 },
      { role: 'assistant', content: '## Findings\n\n| Page | Problem |\n| --- | --- |\n| Chat | 19 controls in one group |\n| Sidebar | Destinations wrap inline |\n\n```ts\nconst groups = [\'Composer\', \'Transcript\']\n```\n\n1. Regroup **Chat** first.\n2. Then move the sidebar destinations into rows.', timestamp: now - 3500 },
      { role: 'user', content: 'Good. File tickets for both.', timestamp: now - 700 },
      { role: 'assistant', content: 'Filed two tickets and ordered them so they cannot conflict.', timestamp: now - 600 },
    ],
  })
  const older = [
    { title: 'Plan the release', model: 'claude-opus-4-6', daysAgo: 2, input: 91_000, output: 6_400 },
    { title: 'Fix the flaky upload test', model: 'gpt-5.2', daysAgo: 5, input: 23_500, output: 1_800 },
    { title: 'Draft the changelog', model: 'claude-sonnet-4-6', daysAgo: 9, input: 12_100, output: 2_250 },
  ]
  for (const [index, { title, model, daysAgo, input, output }] of older.entries()) {
    const at = now - daysAgo * DAY
    await saveSession({ session_id: `2026110${String(index + 1)}_090000_demo`, title, model, input_tokens: input, output_tokens: output, estimated_cost: input / 200_000, created_at: at, updated_at: at + 900, messages: [{ role: 'user', content: title, timestamp: at }, { role: 'assistant', content: `Done: ${title.toLowerCase()}.`, timestamp: at + 900 }] })
  }

  const review = await sidecar.serverRequest('server.decision_review_put', { caller_session_id: DEMO_SESSION_ID, title: 'Settings audit', items: [decisionItem('retention', 'Retention'), decisionItem('telemetry', 'Telemetry'), decisionItem('autosave', 'Autosave')] })
  if (!('result' in review)) throw new Error(JSON.stringify(review))

  // The group fixture stamps events near the epoch; a tour reads better with recent times.
  discussion.append('message.user', 'Review this proposal before Friday.').created_at = now - 1800
  discussion.append('message.member', 'The rollout plan looks right; the rollback step needs an owner.').created_at = now - 1700
  return (review.result as { review_id: string }).review_id
}

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

const BUNDLED_PLUGINS: Record<string, string> = {
  browser: 'browser_use browserbase firecrawl',
  dashboard_auth: 'basic drain nous self_hosted session_token',
  delegation: 'default',
  image_gen: 'deepinfra fal krea meta-ai openai openai-codex openrouter xai',
  platforms: 'a2a bluebubbles buzz dingtalk discord email feishu google_chat irc line matrix mattermost ntfy photon qqbot raft signal simplex slack sms teams telegram wecom weixin whatsapp whatsapp_cloud',
  video_gen: 'deepinfra fal openrouter xai',
  web: 'brave_free ddgs exa firecrawl keenable openai_native parallel perplexity searxng tavily xai',
  '': 'disk-cleanup google_meet security-guidance teams_pipeline',
}
const plugin = (key: string, name: string, extra: object) => ({ key, name, version: '1.0.0', description: `${name}: synthetic description`, enabled: true, kind: 'backend', activation: 'enabled', hooks: [], ...extra })
/** `plugins.list` rows: the Agent's own plugins (its four standalone ones off, as shipped) and the profile's `meshy` and `team-notes`. */
const DEMO_PLUGINS = [
  plugin('meshy', 'meshy', { version: '1.2.0', category: '', source: 'installed', kind: 'standalone', update_available: true, latest_revision: '1.3.0' }),
  plugin('team-notes', 'team-notes', { version: '0.3.1', description: 'Shared notes the agent can read and append to', category: '', source: 'installed', kind: 'standalone', enabled: false, activation: 'disabled' }),
  ...Object.entries(BUNDLED_PLUGINS).flatMap(([category, names]) => names.split(' ').map((name) => plugin(category ? `${category}/${name}` : name, name, {
    category, source: 'bundled',
    ...(category ? {} : { kind: 'standalone', enabled: false, activation: 'disabled' }),
    ...(category === 'image_gen' && name === 'fal' ? { kind: 'exclusive', activation: 'exclusive', is_active_provider: true, description: 'flux-2-klein, flux-2-pro, nano-banana-2' } : {}),
  }))),
]

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
  // TAL-2132: a stock Agent's plugins (v0.23.1's 62, by key) and two the profile installed, one with an update waiting.
  sidecar.respond('plugins.list', () => ({ plugins: DEMO_PLUGINS, supported_hooks: [] }))
  sidecar.respond('plugins.settings', () => ({ supported: true, plugins: [{ key: 'meshy', fields: [{ key: 'quality', type: 'enum', label: 'Quality', description: '', required: false, choices: ['draft', 'final'], value: 'draft' }] }, { key: 'image_gen/fal', fields: [{ key: 'model', type: 'string', label: 'Model', description: '', required: false, value: 'flux-2-pro' }] }] }))
  sidecar.respond('plugins.auto_update', () => ({ supported: true, auto_apply: true, check_hours: 6 }))
  server.deps.agentConfig.invalidate()
  server.deps.catalog.invalidate()
  const workspace = join(server.state, 'workspace')
  mkdirSync(workspace, { recursive: true })
  // The Agent's MemoryStore separates entries with a `§` line; the Memory page shows each as its own block.
  mkdirSync(join(server.state, 'memories'), { recursive: true })
  writeFileSync(join(server.state, 'memories', 'MEMORY.md'), 'Uses **TypeScript** for Web projects.\n§\nDeploys go through the `staging` host first.\n§\nRelease checklist:\n- Run the full suite\n- Tag `vX.Y.Z`\n')
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

  // TAL-2142: Settings › Extensions shows one gallery install and a gallery of three, one declaring what it can access.
  const extDir = join(server.state, 'extensions', 'flightdeck')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ name: 'Flightdeck', version: '0.2.0', description: 'Live agent instruments beside the chat', panel: 'index.html', capabilities: ['lifecycle', 'session'], permissions: { webui_api: { read: ['session'], write: [] } } }))
  writeFileSync(join(extDir, 'index.html'), '<!doctype html><title>Flightdeck</title>')
  writeFileSync(join(server.state, 'extension-install-manifest.json'), JSON.stringify({ version: 1, installed: { flightdeck: { version: '0.2.0', files: ['manifest.json', 'index.html'], installed_at: '2026-11-01T00:00:00Z' } } }))
  const gallery = { extensions: [
    { id: 'flightdeck', name: 'Flightdeck', version: '0.2.0', description: 'Live agent instruments beside the chat' },
    { id: 'message-pins', name: 'Message Pins', version: '0.1.0', description: 'Pin individual messages in a conversation. Adds a pin button to each message and a header popover listing pinned messages with click-to-jump.', capabilities: ['manifest-bundle'], permissions: { webui_api: { read: ['session'], write: [] }, dom: { owned: true, mutates_core_views: true } }, homepage: 'https://example.com/message-pins' },
    { id: 'model-favorites', name: 'Model Favorites', version: '0.1.0', description: 'Star your most-used models in the composer model picker' },
    { id: 'rss-feeds', name: 'RSS Feeds', version: '0.1.0', description: 'RSS and Atom reader with keyword filters and AI summaries' },
  ] }
  const realFetch = server.deps.fetch
  ;(server.deps as { fetch: typeof fetch }).fetch = (input, init) => String(input instanceof Request ? input.url : input).endsWith('/registry.json') ? Promise.resolve(new Response(JSON.stringify(gallery), { status: 200 })) : realFetch(input, init)

  const review = await sidecar.serverRequest('server.decision_review_put', { caller_session_id: DEMO_SESSION_ID, title: 'Settings audit', items: [decisionItem('retention', 'Retention'), decisionItem('telemetry', 'Telemetry'), decisionItem('autosave', 'Autosave')] })
  if (!('result' in review)) throw new Error(JSON.stringify(review))

  // The group fixture stamps events near the epoch; a tour reads better with recent times.
  discussion.append('message.user', 'Review this proposal before Friday.').created_at = now - 1800
  discussion.append('message.member', 'The rollout plan looks right; the rollback step needs an owner.').created_at = now - 1700
  return (review.result as { review_id: string }).review_id
}

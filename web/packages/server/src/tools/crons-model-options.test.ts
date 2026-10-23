import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentConfig, type Dict } from '../config/agent-config.js'
import { ProviderCatalog } from '../providers/catalog.js'
import { FakeSidecar } from '../sidecar/fake.js'
import { CronService, type CronDeps } from './crons.js'

/** TAL-1381: the cron list projects every row against one prepared catalog lookup, wired as runtime.ts wires it. */
describe('cron list model options (TAL-1381)', () => {
  let state: string
  let homes: { default: string; research: string }
  let stores: Map<string, Dict[]>
  let sidecar: FakeSidecar
  let catalog: ProviderCatalog
  let config: Dict
  let service: CronService
  const base = { profile: null, toast_notifications: true, monitor: '', continuity: false }
  const pairs: [string | null, string | null][] = [['claude-sonnet-4', 'anthropic'], ['local-model', 'ollama'], ['ds-model', 'deepseek'], ['unknown-model', 'anthropic'], [null, null]]
  const poolReads = (): number => sidecar.calls.filter((call) => call.method === 'usage.pool_providers').length

  beforeEach(async () => {
    state = mkdtempSync(join(tmpdir(), 'talaria-cron-models-'))
    homes = { default: state, research: join(state, 'profiles/research') }
    mkdirSync(homes.research, { recursive: true })
    stores = new Map(Object.values(homes).map((home) => [home, []]))
    config = {
      model: { provider: 'anthropic', default: 'claude-sonnet-4' },
      providers: { anthropic: { models: ['claude-sonnet-4'] }, ollama: { base_url: 'http://ollama.test/v1', models: ['local-model'] }, deepseek: { api_key: 'sk-synthetic-cron' } },
    }
    writeFileSync(join(homes.default, 'config.yaml'), '# synthetic config\n')
    sidecar = new FakeSidecar()
    sidecar.respond('config.get', (p) => ({ path: join(p.profile_home, 'config.yaml'), exists: true, config }))
    sidecar.respond('usage.pool_providers', () => ({ providers: [], keys: {} }))
    sidecar.respond('plugins.providers', () => ({ providers: [] }))
    sidecar.respond('providers.auth_status', () => ({ status: { logged_in: false } }))
    sidecar.respond('providers.local_models', () => ({ provider_id: 'llamacpp', models: [], current_endpoint: null }))
    sidecar.respond('providers.model_ids', (p) => ({ provider: p.provider, model_ids: p.provider === 'deepseek' ? ['ds-model'] : [] }))
    sidecar.respond('cron.list', ({ profile_home }) => ({ jobs: stores.get(profile_home) as never[] }))
    sidecar.respond('cron.pause', ({ profile_home, job_id }) => ({ job: stores.get(profile_home)?.find((row) => row.id === job_id) as { id: string } }))
    catalog = new ProviderCatalog({ sidecar: () => sidecar, config: new AgentConfig({ sidecar: () => sidecar, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: (home) => home === homes.default })
    const deps: CronDeps = {
      sidecar: () => sidecar,
      profileHome: (name) => homes[name as keyof typeof homes],
      profileNames: () => Promise.resolve(Object.keys(homes).map((name) => ({ name, visible: true }))),
      profilesMatch: (a, b) => a === b,
      isolatedProfileMode: () => false,
      log: () => undefined,
      modelOptions: (home) => catalog.modelOptionResolver(home),
    }
    service = new CronService(deps)
    await catalog.models(homes.default)
  })
  afterEach(() => { rmSync(state, { recursive: true, force: true }) })

  const addJobs = (home: string, count: number, extra: Dict = {}): void => {
    for (let i = 0; i < count; i += 1) {
      const [model, provider] = pairs[i % pairs.length]!
      stores.get(home)!.push({ ...base, ...extra, id: `job-${String(i).padStart(3, '0')}`, name: `Job ${String(i).padStart(3, '0')}`, model, provider })
    }
  }

  it('reads the provider pool once for 100 heterogeneous rows and keeps each row\'s option id', async () => {
    addJobs(homes.default, 100)
    const expected = new Map(pairs.map(([model, provider]) => [JSON.stringify([model, provider]), catalog.modelOptionFor(homes.default, model, provider)]))
    expect([...expected.values()].filter(Boolean)).toHaveLength(3)
    const before = poolReads()
    const listed = await service.list('default', false)
    expect(poolReads() - before).toBe(1)
    const jobs = listed.jobs as Dict[]
    expect(jobs).toHaveLength(100)
    for (const job of jobs) expect(job.model_option_id).toBe(expected.get(JSON.stringify([job.model ?? null, job.provider ?? null])))
  })

  it('prepares no catalog for an empty list or a list of only hidden rows, and still counts hidden rows', async () => {
    const before = poolReads()
    expect(await service.list('default', false)).toMatchObject({ jobs: [], other_profile_count: 0 })
    addJobs(homes.research, 3, { profile: 'research', owner_profile: 'research' })
    expect(await service.list('default', false)).toMatchObject({ jobs: [], other_profile_count: 3 })
    expect(poolReads() - before).toBe(0)
    const all = await service.list('default', true)
    expect(all).toMatchObject({ all_profiles: true, other_profile_count: 0 })
    expect(all.jobs as Dict[]).toHaveLength(3)
    expect(poolReads() - before).toBe(1)
  })

  it('observes a changed catalog source on the next list and keeps single-row responses on the same owner', async () => {
    stores.get(homes.default)!.push({ ...base, id: 'swap', name: 'Swap', model: 'new-model', provider: 'anthropic' })
    expect(((await service.list('default', false)).jobs as Dict[])[0]!.model_option_id).toBeNull()
    config = { ...config, providers: { ...(config.providers as Dict), anthropic: { models: ['claude-sonnet-4', 'new-model'] } } }
    writeFileSync(join(homes.default, 'config.yaml'), '# synthetic config, edited\n')
    const option = ((await service.list('default', false)).jobs as Dict[])[0]!.model_option_id
    expect(option).toEqual(expect.stringContaining('new-model'))
    const before = poolReads()
    expect((await service.pause(homes.default, 'swap', null)).job).toMatchObject({ id: 'swap', model_option_id: option })
    expect(poolReads() - before).toBe(1)
  })

  it('fails closed with null option ids when the catalog cannot be built', async () => {
    const cold = new ProviderCatalog({ sidecar: () => null, config: new AgentConfig({ sidecar: () => null, env: {} }), env: {}, now: () => 1_800_000_000, log: () => undefined, costBudget: () => null, isRootProfileHome: () => true })
    const failing = new CronService({ sidecar: () => sidecar, profileHome: (name) => homes[name as keyof typeof homes], profileNames: () => Promise.resolve([{ name: 'default', visible: true }]), profilesMatch: (a, b) => a === b, isolatedProfileMode: () => false, log: () => undefined, modelOptions: (home) => cold.modelOptionResolver(home) })
    addJobs(homes.default, 5)
    const jobs = (await failing.list('default', false)).jobs as Dict[]
    expect(jobs).toHaveLength(5)
    for (const job of jobs) expect(job.model_option_id).toBeNull()
  })
})

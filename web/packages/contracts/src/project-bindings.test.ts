import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sessionsContract } from './routes/sessions.js'
import { ProjectsSchema } from './views.js'

/** TAL-1032: the shared App/Web fixture for project bindings. */
describe('project bindings contract', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/project-bindings.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const bindInput = sessionsContract.projects.setBindings['~orpc'].inputSchema!

  it('parses the bound, unavailable and unbound project rows', () => {
    const list = ProjectsSchema.parse(fixture.list)
    expect(list.projects.map((p) => p.model_option_id ?? null)).toEqual(['@gemini:gemini-2.5-flash', null, null])
    expect(list.projects[1]).toMatchObject({ model: 'retired-model', model_provider: 'custom:backup' })
  })

  it('accepts the bind and clear requests and keeps rows older servers wrote', () => {
    for (const request of [fixture.bind_request, fixture.clear_request]) expect(bindInput['~standard'].validate(request)).toMatchObject({ value: request })
    expect(ProjectsSchema.parse({ projects: [{ project_id: 'legacy', name: 'Old', workspace: '/synthetic/home/alpha' }], active_profile: 'default', all_profiles: false, other_profile_count: 0 }).projects[0]).toMatchObject({ workspace: '/synthetic/home/alpha' })
  })
})

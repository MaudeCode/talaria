import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { beforeEach, expect, it, vi } from 'vitest'
import { cloneElement, type ReactNode } from 'react'
import { BootstrapContext } from '../../app/bootstrap'
import { DEFAULT_BOOTSTRAP } from '../../contracts/adapters/memory'
import { keys } from '../../api/queryKeys'
import * as api from '../../api/endpoints'
import { deferred } from '../../test/fixtures'
import { SkillsPage } from '../skills/SkillsPage'
import { McpSection } from './McpSection'
import { ExtensionsSection } from './ExtensionsSection'
import { ConnectorsSection } from '../connectors/ConnectorsSection'
import { teardownAll } from '../../stream/connection'
import { showToast } from '../toast/toast'
import { ApiError } from '../../contracts'

vi.mock('../../api/endpoints', () => ({ removeConnectorAccount: vi.fn(), fetchSkillContent: vi.fn(), deleteSkill: vi.fn(), saveSkill: vi.fn(), fetchSkills: vi.fn(), fetchSkillsUsage: vi.fn(), toggleSkill: vi.fn(), fetchMcpServers: vi.fn(), fetchMcpTools: vi.fn(), toggleMcpServer: vi.fn(), fetchExtensionRegistry: vi.fn(), extensionAction: vi.fn(), fetchConnectors: vi.fn(), fetchConnectorTools: vi.fn(), setConnectorRule: vi.fn() }))
vi.mock('../../shell/AppShell', () => ({ HubPage: ({ children, toolbar }: { children: ReactNode; toolbar?: ReactNode }) => <main>{toolbar}{children}</main> }))
vi.mock('../pending-writes/PendingWritesPanel', () => ({ PendingWritesPanel: () => null }))
vi.mock('../toast/toast', () => ({ showToast: vi.fn() }))
const manifests = vi.hoisted(() => vi.fn())
vi.mock('../../extensions/registry', () => ({ useExtensionManifests: () => useQuery({ queryKey: keys.extensions.manifests, queryFn: manifests, staleTime: 30_000 }) }))

const ids = ['alpha', 'beta']
const skills = () => ({ skills: ids.map((name) => ({ name, disabled: true, category: null, description: '' })) })
const mcp = () => ({ toggle_supported: true, reload_required: true, servers: ids.map((name) => ({ name, enabled: false, can_toggle: true, status: 'disabled', health: 'unhealthy' })) })
const extensions = () => ({ protocol_version: 1, manifests: ids.map((id) => ({ id, name: id, source: 'manifest', enabled: false, can_toggle: true, capabilities: [], permissions: {}, settings_schema: [], warnings: [], sidecar: { origin: 'http://127.0.0.1:1234', consented: false } })) })
const connectors = () => ({ available: true, policy_revision: 'rev-1', connectors: ids.map((slug) => ({ slug, name: slug, enabled: false, rules_editable: true, connected: true, accounts: [], tools_off: 3, org_locked: false })) })
const cases = [
  { name: 'skill', ui: <SkillsPage />, key: keys.skills.all, snapshot: skills, read: () => vi.mocked(api.fetchSkills), write: () => vi.mocked(api.toggleSkill) },
  { name: 'MCP', ui: <McpSection heading="" />, key: keys.mcp.servers, snapshot: mcp, read: () => vi.mocked(api.fetchMcpServers), write: () => vi.mocked(api.toggleMcpServer) },
  { name: 'extension', ui: <ExtensionsSection />, key: keys.extensions.manifests, snapshot: extensions, read: () => manifests, write: () => vi.mocked(api.extensionAction) },
  { name: 'connector', ui: <ConnectorsSection />, key: keys.connectors.page, snapshot: connectors, read: () => vi.mocked(api.fetchConnectors), write: () => vi.mocked(api.setConnectorRule) },
]

beforeEach(() => {
  vi.resetAllMocks()
  teardownAll()
  vi.mocked(api.fetchSkillsUsage).mockResolvedValue({ usage: {} })
  vi.mocked(api.fetchMcpTools).mockResolvedValue({ tools: [], total: 0 })
  vi.mocked(api.fetchExtensionRegistry).mockResolvedValue({ entries: [] })
  vi.mocked(api.fetchConnectorTools).mockResolvedValue({ connector: 'alpha', policy_revision: 'rev-1', tools: [{ slug: 'read', name: 'Read', description: '', deprecated: false, enabled: false, editable: true, facet: 'read', locked: false }] })
})

function setup(c: typeof cases[number]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  c.read().mockResolvedValue(c.snapshot())
  const tree = () => <QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}>{cloneElement(c.ui)}</BootstrapContext.Provider></QueryClientProvider>
  const view = render(tree())
  return { qc, ...view, tree }
}
const control = (name: string) => screen.getByRole('switch', { name: new RegExp(`^${name}(?:[: ]|$)`) })

const lost = () => new ApiError({ kind: 'network', path: '/x', message: 'Connection lost' })

it.each(cases)('$name flips at once, stays usable, replaces a repeated flip and ignores stale refreshes', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  expect(control('alpha')).not.toHaveAttribute('aria-busy')
  expect(control('alpha')).not.toHaveAttribute('aria-disabled', 'true')
  expect(screen.queryByText(/Pending/)).toBeNull()
  // A second flip shows at once and waits behind the first request (last write wins).
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  act(() => qc.setQueryData(c.key, c.snapshot()))
  expect(control('alpha')).toBeChecked()
  expect(control('beta')).not.toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(control('beta'))
  await waitFor(() => expect(control('beta')).toBeChecked())
  // Connector rules share one revision, so the peer write waits for the held one.
  expect(c.write()).toHaveBeenCalledTimes(c.name === 'connector' ? 1 : 2)
})

it.each(cases)('$name uses the authoritative normalized value after success', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  await act(async () => { write.resolve({ ok: true, enabled: false, revision: 'rev-2' } as never); await Promise.resolve() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
})

it.each(cases)('$name rolls a refused write back at once and reports it', async (c) => {
  const write = deferred<never>()
  c.write().mockReturnValue(write.promise)
  const read = deferred<never>()
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  c.read().mockReturnValue(read.promise)
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  await act(async () => { write.resolve({ ok: false, error: 'Refused' } as never); await Promise.resolve() })
  // No read answers: the rollback does not wait for one.
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(showToast).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 'error')
})

it.each(cases)('$name keeps its value across unmount, and fences a previous profile completion', async (c) => {
  const old = deferred<never>(), fresh = deferred<never>()
  c.write().mockReturnValueOnce(old.promise).mockReturnValue(fresh.promise)
  const { qc, rerender, tree } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  rerender(<div />)
  rerender(tree())
  expect(control('alpha')).toBeChecked()
  act(() => { teardownAll(); qc.clear(); qc.setQueryData(c.key, c.snapshot()) })
  rerender(tree())
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(c.write()).toHaveBeenCalledTimes(2))
  await act(async () => { old.resolve({ ok: true } as never); await Promise.resolve() })
  expect(control('alpha')).toBeChecked()
  expect(showToast).not.toHaveBeenCalled()
})

it.each(cases)('$name keeps an unknown outcome shown until a later read decides it, without resending', async (c) => {
  c.write().mockRejectedValue(lost())
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  c.read().mockRejectedValue(new Error('Offline'))
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(showToast).toHaveBeenCalled())
  await waitFor(() => expect(c.read().mock.calls.length).toBeGreaterThan(1))
  expect(control('alpha')).toBeChecked()
  expect(control('alpha')).not.toHaveAttribute('aria-disabled', 'true')
  c.read().mockResolvedValue(c.snapshot())
  // Every displayed snapshot the write covers reads again.
  await act(async () => { await qc.refetchQueries() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(c.write()).toHaveBeenCalledTimes(1)
  expect(qc.getQueryData(c.key)).toEqual(c.snapshot())
})

it.each(cases.filter((c) => c.name !== 'connector'))('$name keeps a peer value when the first write reconciles', async (c) => {
  const first = deferred<never>(), second = deferred<never>()
  c.write().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  fireEvent.click(control('beta'))
  await waitFor(() => expect(control('beta')).toBeChecked())
  await act(async () => { first.resolve({ ok: true } as never); await Promise.resolve() })
  await waitFor(() => expect(control('alpha')).not.toBeChecked())
  expect(control('beta')).toBeChecked()
  await act(async () => { second.resolve({ ok: true } as never); await Promise.resolve() })
  await waitFor(() => expect(control('beta')).not.toBeChecked())
})

it('serializes connector tool and app rules, sending the next rule on the reread revision after a conflict', async () => {
  const c = cases[3]!
  const write = deferred<never>()
  c.write().mockReturnValueOnce(write.promise).mockResolvedValue({ ok: true, revision: 'rev-3' } as never)
  const { qc } = setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  fireEvent.click(tool)
  await waitFor(() => expect(tool).toBeChecked())
  expect(control('alpha')).not.toHaveAttribute('aria-disabled', 'true')
  expect(control('alpha')).not.toBeChecked()
  // Reject the held transport without a timer, then read the server's replacement revision.
  c.read().mockResolvedValue({ ...connectors(), policy_revision: 'rev-2' })
  await act(async () => { write.resolve(Promise.reject(new ApiError({ kind: 'http', status: 409, path: '/api/connectors/alpha/policy', code: 'policy_conflict', message: 'stale', retryable: false })) as never); await Promise.resolve() })
  await waitFor(() => expect(tool).not.toBeChecked())
  expect(showToast).toHaveBeenCalledWith(expect.stringMatching(/changed/i), 5000, 'error')
  await waitFor(() => expect(qc.getQueryData(keys.connectors.page)).toMatchObject({ policy_revision: 'rev-2' }))
  fireEvent.click(control('beta'))
  await waitFor(() => expect(api.setConnectorRule).toHaveBeenLastCalledWith('beta', 'rev-2', { enabled: true }))
  // A rule sent before the page rereads uses the revision the last confirmed write returned.
  fireEvent.click(control('alpha'))
  await waitFor(() => expect(api.setConnectorRule).toHaveBeenLastCalledWith('alpha', 'rev-3', { enabled: true }))
})

it('keeps connector rules without a revision and server-locked tools disabled', async () => {
  const { qc } = setup(cases[3]!)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  act(() => qc.setQueryData(keys.connectors.page, { ...connectors(), policy_revision: null }))
  await waitFor(() => expect(control('alpha')).toHaveAttribute('aria-disabled', 'true'))
  fireEvent.click(control('alpha'))
  expect(api.setConnectorRule).not.toHaveBeenCalled()
  act(() => qc.setQueryData(keys.connectors.page, connectors()))
  vi.mocked(api.fetchConnectorTools).mockResolvedValue({ connector: 'alpha', policy_revision: 'rev-1', tools: [{ slug: 'read', name: 'Read', description: '', deprecated: false, enabled: false, editable: false, facet: 'read', locked: true }] })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  expect(tool).toHaveAttribute('aria-disabled', 'true')
  fireEvent.click(tool)
  expect(api.setConnectorRule).not.toHaveBeenCalled()
})

it('keeps a connector tool shown through a failed tool refresh until a later read decides it', async () => {
  const { qc } = setup(cases[3]!)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(screen.getAllByRole('button', { name: /Tools/ })[0]!)
  const tool = await screen.findByRole('switch', { name: 'Read available to Hermes' })
  const cached = qc.getQueryData<Awaited<ReturnType<typeof api.fetchConnectorTools>>>(keys.connectors.tools('alpha'))!
  vi.mocked(api.setConnectorRule).mockRejectedValue(lost())
  vi.mocked(api.fetchConnectorTools).mockRejectedValue(new Error('Offline'))
  fireEvent.click(tool)
  await waitFor(() => expect(showToast).toHaveBeenCalled())
  await waitFor(() => expect(vi.mocked(api.fetchConnectorTools).mock.calls.length).toBeGreaterThan(1))
  expect(tool).toBeChecked()
  expect(control('beta')).not.toHaveAttribute('aria-disabled', 'true')
  vi.mocked(api.fetchConnectorTools).mockResolvedValue(cached)
  await act(async () => { await qc.refetchQueries({ queryKey: keys.connectors.all }) })
  await waitFor(() => expect(tool).not.toBeChecked())
  expect(api.setConnectorRule).toHaveBeenCalledOnce()
})

it('review regression: skill list reconciliation excludes failed cached details', async () => {
  const { qc } = setup(cases[0]!)
  await screen.findByRole('switch', { name: /^alpha/ })
  const unrelated = vi.fn().mockRejectedValue(new Error('Removed skill'))
  await qc.query({ queryKey: keys.skills.content('removed'), queryFn: unrelated }).catch(() => undefined)
  vi.mocked(api.toggleSkill).mockResolvedValue({ ok: true, name: 'alpha', enabled: false })
  await userEvent.click(control('alpha'))
  await waitFor(() => expect(vi.mocked(api.fetchSkills).mock.calls.length).toBeGreaterThan(1))
  expect(unrelated).toHaveBeenCalledOnce()
  expect(control('alpha')).not.toBeChecked()
})

it.each(cases.filter((c) => c.name !== 'connector'))('review regression: $name accessible name stays consistent with requested checked state', async (c) => {
  c.write().mockReturnValue(deferred<never>().promise)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha/ })
  await userEvent.click(control('alpha'))
  await waitFor(() => expect(control('alpha')).toBeChecked())
  expect(control('alpha')).toHaveAccessibleName('alpha')
})

it('review regression: extension state text activates its switch and a second press replaces the first', async () => {
  vi.mocked(api.extensionAction).mockReturnValue(deferred<never>().promise)
  setup(cases[2]!)
  const toggle = await screen.findByRole('switch', { name: /^alpha/ })
  const row = toggle.closest('li')!
  await userEvent.click(within(row).getByText('Disabled', { exact: true }))
  await waitFor(() => expect(api.extensionAction).toHaveBeenCalledWith('toggle', { id: 'alpha', enabled: true }))
  expect(toggle).toBeChecked()
  await userEvent.click(within(row).getByText('Enabled', { exact: true }))
  expect(toggle).not.toBeChecked()
  expect(api.extensionAction).toHaveBeenCalledOnce()
})

it('reads the server revision before the next connector rule after an unknown outcome', async () => {
  const c = cases[3]!
  const first = deferred<never>()
  c.write().mockReturnValueOnce(first.promise).mockResolvedValue({ ok: true, revision: 'rev-3' } as never)
  setup(c)
  await screen.findByRole('switch', { name: /^alpha(?:[: ]|$)/ })
  fireEvent.click(control('alpha'))
  fireEvent.click(control('beta'))
  await waitFor(() => expect(control('beta')).toBeChecked())
  // The first write may have landed: the server moved to rev-2 although its answer was lost.
  c.read().mockResolvedValue({ ...connectors(), policy_revision: 'rev-2' })
  await act(async () => { first.reject(new ApiError({ kind: 'network', path: '/x', message: 'Connection lost' })); await Promise.resolve() })
  await waitFor(() => expect(api.setConnectorRule).toHaveBeenLastCalledWith('beta', 'rev-2', { enabled: true }))
})

it('deletes a skill at once, returning to the list without it, and restores it on refusal', async () => {
  let refuse!: (error: unknown) => void
  vi.mocked(api.fetchSkillContent).mockResolvedValue({ name: 'alpha', content: '# alpha', editable: true, linked_files: {} })
  vi.mocked(api.deleteSkill).mockReturnValue(new Promise((_, reject) => { refuse = reject }) as never)
  setup(cases[0]!)
  await userEvent.click(await screen.findByRole('button', { name: /^alpha/ }))
  await userEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }))
  expect(await screen.findByRole('switch', { name: /^beta/ })).toBeInTheDocument()
  expect(screen.queryByRole('switch', { name: /^alpha/ })).toBeNull()
  await act(async () => { refuse(new ApiError({ kind: 'http', status: 409, path: '/x', message: 'Skill in use' })); await Promise.resolve() })
  expect(await screen.findByRole('switch', { name: /^alpha/ })).toBeInTheDocument()
  expect(showToast).toHaveBeenCalledWith('Skill in use', 4000, 'error')
})

it('keeps a skill edit typed during a save, clearing only the confirmed draft', async () => {
  let answer!: (value: unknown) => void
  vi.mocked(api.fetchSkillContent).mockResolvedValue({ name: 'alpha', content: '# alpha', editable: true, linked_files: {} })
  vi.mocked(api.saveSkill).mockReturnValue(new Promise((resolve) => { answer = resolve }) as never)
  setup(cases[0]!)
  await userEvent.click(await screen.findByRole('button', { name: /^alpha/ }))
  const editor = await screen.findByRole('textbox')
  await userEvent.type(editor, '!')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await userEvent.type(editor, '?')
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  await act(async () => { answer({ ok: true }); await Promise.resolve() })
  await waitFor(() => expect(showToast).toHaveBeenCalled())
  expect(editor).toHaveValue('# alpha!?')
})

it('uninstalls an extension at once and flips its sidecar consent at once', async () => {
  vi.mocked(api.extensionAction).mockReturnValue(new Promise(() => undefined) as never)
  const gallery = extensions()
  gallery.manifests = gallery.manifests.map((e) => ({ ...e, source: 'gallery' }))
  manifests.mockResolvedValue(gallery)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><BootstrapContext.Provider value={DEFAULT_BOOTSTRAP}><ExtensionsSection /></BootstrapContext.Provider></QueryClientProvider>)
  const alpha = (await screen.findByRole('switch', { name: /^alpha/ })).closest('li')!
  await userEvent.click(within(alpha).getByRole('switch', { name: /Allow the proxied sidecar/ }))
  expect(within(alpha).getByRole('switch', { name: /Allow the proxied sidecar/ })).toBeChecked()
  expect(api.extensionAction).toHaveBeenCalledWith('sidecar-proxy-consent', { id: 'alpha', consent: true })
  await userEvent.click(within(alpha).getByRole('button', { name: 'Uninstall' }))
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Uninstall' }))
  expect(screen.queryByRole('switch', { name: /^alpha/ })).toBeNull()
  expect(screen.getByRole('switch', { name: /^beta/ })).toBeInTheDocument()
})

it('removes a disconnected connector account at once', async () => {
  vi.mocked(api.removeConnectorAccount).mockReturnValue(new Promise(() => undefined))
  const page = connectors()
  page.connectors = page.connectors.map((c) => ({ ...c, accounts: [{ connection_id: `${c.slug}-1`, name: `${c.slug} account`, problem: null, status_reason: null }] })) as never
  vi.mocked(api.fetchConnectors).mockResolvedValue(page as never)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={qc}><ConnectorsSection /></QueryClientProvider>)
  const account = (await screen.findByText('alpha account')).closest('li')!
  await userEvent.click(within(account).getByRole('button', { name: 'Disconnect' }))
  await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Disconnect' }))
  expect(api.removeConnectorAccount).toHaveBeenCalledWith('alpha-1')
  expect(screen.queryByText('alpha account')).toBeNull()
  expect(screen.getByText('beta account')).toBeInTheDocument()
})

it('sends a second skill save only after the first answers, so the newest text lands last (TAL-1383)', async () => {
  let first!: (value: unknown) => void
  vi.mocked(api.fetchSkillContent).mockResolvedValue({ name: 'alpha', content: '# alpha', editable: true, linked_files: {} })
  vi.mocked(api.saveSkill).mockReturnValueOnce(new Promise((resolve) => { first = resolve }) as never).mockReturnValue(new Promise(() => undefined) as never)
  setup(cases[0]!)
  await userEvent.click(await screen.findByRole('button', { name: /^alpha/ }))
  const editor = await screen.findByRole('textbox')
  await userEvent.type(editor, '!')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  await userEvent.type(editor, '?')
  await userEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(api.saveSkill).toHaveBeenCalledTimes(1)
  await act(async () => { first({ ok: true }); await Promise.resolve() })
  await waitFor(() => expect(api.saveSkill).toHaveBeenLastCalledWith('alpha', '# alpha!?'))
})

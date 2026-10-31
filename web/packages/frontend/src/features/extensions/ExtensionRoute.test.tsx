/**
 * TAL-224: a changed manifest remounts the open panel's iframe so its bridge reconnects;
 * an equal refetch keeps the live frame and bridge.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { ExtensionRoute } from './ExtensionRoute'
import { configureClient, resetClientForTests } from '../../api/client'
import { keys } from '../../api/queryKeys'
import { EXTENSION_PROTOCOL_VERSION, type ExtensionManifest } from '../../contracts/extension'

vi.mock('../../shell/AppShell', () => ({
  AppShell: ({ children }: { children: ReactNode }) => <>{children}</>,
  HubPage: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../sessions/SessionListPanel', () => ({ SessionListPanel: () => null }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn(), Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))

function manifest(version: string): ExtensionManifest {
  return {
    id: 'demo', name: 'Demo', version, source: 'manifest', enabled: true, can_toggle: true, panel: 'extensions/demo/index.html', nav: { label: 'Demo' },
    capabilities: ['toast'], settings_schema: [], theme: null, tts: null, sidecar: null, legacy_injection: false, warnings: [],
  }
}

let served: ExtensionManifest[] = []

/** Stands in for the panel document: answers the host's hello over the transferred port, as the SDK does. */
function answerHandshake(frame: HTMLIFrameElement): string[] {
  const nonces: string[] = []
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(((hello: { nonce: string }, _origin: string, transfer?: Transferable[]) => {
    nonces.push(hello.nonce)
    ;(transfer?.[0] as MessagePort).postMessage({ type: 'hermes:ready', version: EXTENSION_PROTOCOL_VERSION, nonce: hello.nonce })
  }) as Window['postMessage'])
  return nonces
}

/** A browser fires `load` only when a frame navigates, so the test fires it once per mounted frame. */
async function connect(): Promise<{ frame: HTMLIFrameElement; nonces: string[] }> {
  const frame = await screen.findByTitle<HTMLIFrameElement>('Demo')
  const nonces = answerHandshake(frame)
  fireEvent.load(frame)
  await waitFor(() => expect(frame.closest('.extension-panel')).toHaveAttribute('data-status', 'ready'))
  return { frame, nonces }
}

function renderRoute() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={qc}><ExtensionRoute extensionId="demo" /></QueryClientProvider>)
  return { refetch: () => act(() => qc.refetchQueries({ queryKey: keys.extensions.manifests })) }
}

beforeEach(() => {
  served = [manifest('1.0.0')]
  configureClient({ transport: () => Promise.resolve(new Response(JSON.stringify({ protocol_version: EXTENSION_PROTOCOL_VERSION, manifests: served }), { status: 200, headers: { 'content-type': 'application/json' } })) })
})
afterEach(() => { resetClientForTests(); vi.restoreAllMocks() })

describe('ExtensionRoute manifest changes (TAL-224)', () => {
  it('remounts the frame on a new manifest version and the new bridge reaches ready', async () => {
    const { refetch } = renderRoute()
    const first = await connect()
    served = [manifest('1.1.0')]
    await refetch()
    await waitFor(() => expect(screen.getByTitle('Demo')).not.toBe(first.frame))
    const second = await connect()
    expect(second.nonces).toHaveLength(1)
    expect(second.nonces[0]).not.toBe(first.nonces[0])
  })

  it('keeps the frame and its bridge on an equal refetch', async () => {
    const { refetch } = renderRoute()
    const first = await connect()
    served = [manifest('1.0.0')]
    await refetch()
    expect(screen.getByTitle('Demo')).toBe(first.frame)
    expect(first.frame.closest('.extension-panel')).toHaveAttribute('data-status', 'ready')
    expect(first.nonces).toHaveLength(1)
  })
})

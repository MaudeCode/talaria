import { createElement, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { Session } from '../contracts'

/** A writable, synthetic server session; each test supplies its own identity and transcript. */
export function sessionFixture(value: Partial<Session> & Pick<Session, 'session_id'>): Session {
  return {
    title: 'Navigation fixture', is_streaming: false, source_kind: 'webui', is_messaging_session: false,
    sort_ts: 0, read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true,
    can_duplicate: true, ...value,
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

/** A render wrapper with one fresh query client, for components whose writes go through the optimistic owner. */
export function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children)
}

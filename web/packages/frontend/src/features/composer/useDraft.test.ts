import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useState } from 'react'

vi.mock(import('../../api/endpoints'), async (importOriginal) => ({ ...(await importOriginal()), saveDraft: vi.fn(), fetchDraft: vi.fn() }))
import * as api from '../../api/endpoints'
import { readLocalDraft, useDraftPersistence, useServerDraft } from './useDraft'

describe('useDraftPersistence', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('keeps keystrokes out of browser storage until typing pauses (TAL-278)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'H' } })
    for (const text of ['He', 'Hel', 'Hell', 'Hello']) { rerender({ text }); vi.advanceTimersByTime(50) }
    expect(setItem).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(setItem).toHaveBeenCalledTimes(1)
    expect(readLocalDraft('s1')).toBe('Hello')
  })

  it('writes a pending draft at once when the session changes, the page hides, or the composer unmounts', () => {
    const { rerender, unmount } = renderHook(({ sid, text }) => { useDraftPersistence(sid, text) }, { initialProps: { sid: 's1', text: 'first draft' } })
    rerender({ sid: 's2', text: 'first draft' })
    expect(readLocalDraft('s1')).toBe('first draft')
    // The switch renders once with the old text before the composer loads the new session's draft.
    rerender({ sid: 's2', text: '' })
    expect(readLocalDraft('s2')).toBe('')
    rerender({ sid: 's2', text: 'second draft' })
    window.dispatchEvent(new Event('pagehide'))
    expect(readLocalDraft('s2')).toBe('second draft')
    rerender({ sid: 's2', text: 'second draft, more' })
    unmount()
    expect(readLocalDraft('s2')).toBe('second draft, more')
  })

  it('drops the stored draft as soon as the text is cleared', () => {
    const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'sent soon' } })
    vi.advanceTimersByTime(300)
    expect(readLocalDraft('s1')).toBe('sent soon')
    rerender({ text: '' })
    expect(readLocalDraft('s1')).toBe('')
    vi.advanceTimersByTime(2000)
    expect(readLocalDraft('s1')).toBe('')
  })
})

describe('useServerDraft (TAL-564)', () => {
  beforeEach(() => { localStorage.clear(); vi.mocked(api.saveDraft).mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.restoreAllMocks() })

  const serverHas = (text: string, draft_version: string | null) => {
    let resolve!: () => void
    const done = new Promise<void>((r) => { resolve = r })
    vi.mocked(api.fetchDraft).mockImplementation(() => { resolve(); return Promise.resolve({ draft: { text, files: [] }, draft_version }) })
    return done
  }
  const local = (text: string, updatedAt: number) => { localStorage.setItem('hermes-draft:s1', JSON.stringify({ text, updatedAt })) }
  const mount = () => renderHook(() => {
    const [text, setText] = useState(() => readLocalDraft('s1'))
    useServerDraft('s1', setText)
    return { text, setText }
  })

  it('restores the server draft when this browser has none, versioned or not', async () => {
    for (const version of ['1700000000000000', null]) {
      const fetched = serverHas('from another device', version)
      const { result, unmount } = mount()
      await act(async () => { await fetched })
      expect(result.current.text).toBe('from another device')
      unmount()
    }
  })

  it('keeps whichever copy is newer', async () => {
    local('local, newer', 2_000)
    let fetched = serverHas('server, older', String(1_000 * 1000))
    const older = mount()
    await act(async () => { await fetched })
    expect(older.result.current.text).toBe('local, newer')
    older.unmount()

    local('local, older', 1_000)
    fetched = serverHas('server, newer', String(2_000 * 1000))
    const newer = mount()
    await act(async () => { await fetched })
    expect(newer.result.current.text).toBe('server, newer')
  })

  it('never replaces text typed while the request runs', async () => {
    let answer!: (value: Awaited<ReturnType<typeof api.fetchDraft>>) => void
    vi.mocked(api.fetchDraft).mockImplementation(() => new Promise((r) => { answer = r }))
    const { result } = mount()
    act(() => { result.current.setText('typed meanwhile') })
    await act(async () => { answer({ draft: { text: 'server text', files: [] }, draft_version: String(Date.now() * 1000) }); await Promise.resolve() })
    expect(result.current.text).toBe('typed meanwhile')
  })

  it('versions every server save above the last one, so a slow request cannot overwrite later text', () => {
    vi.useFakeTimers()
    try {
      const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'first' } })
      vi.advanceTimersByTime(1200)
      rerender({ text: 'second' })
      vi.advanceTimersByTime(1200)
      const versions = vi.mocked(api.saveDraft).mock.calls.map(([body]) => Number(body.draft_version))
      expect(versions).toHaveLength(2)
      expect(versions[1]!).toBeGreaterThan(versions[0]!)
    } finally { vi.useRealTimers() }
  })
})

describe('useDraftPersistence server clears (TAL-564)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockClear().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers() })
  const serverWrites = () => vi.mocked(api.saveDraft).mock.calls.map(([body]) => [body.session_id, body.draft.text])

  it('clears the server draft when the text is emptied by any path, not only a send', () => {
    const { rerender } = renderHook(({ text }) => { useDraftPersistence('s1', text) }, { initialProps: { text: 'queued meanwhile' } })
    rerender({ text: '' })
    expect(serverWrites()).toEqual([['s1', '']])
  })

  it('never clears a server draft the box only loaded empty, on mount or on a session switch', () => {
    localStorage.setItem('hermes-draft:s2', JSON.stringify({ text: 'kept', updatedAt: 1 }))
    const { rerender } = renderHook(({ sid, text }) => { useDraftPersistence(sid, text) }, { initialProps: { sid: 's1', text: '' } })
    // The switch renders once with the previous session's text before the composer loads this session's draft.
    rerender({ sid: 's2', text: '' })
    expect(readLocalDraft('s2')).toBe('kept')
    rerender({ sid: 's2', text: 'kept' })
    rerender({ sid: 's3', text: 'kept' })
    rerender({ sid: 's3', text: '' })
    vi.advanceTimersByTime(2000)
    expect(serverWrites().filter(([, text]) => text === '')).toEqual([])
    expect(readLocalDraft('s2')).toBe('kept')
  })
})

describe('loaded drafts and clock skew (TAL-564)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockReset().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers() })
  const mount = () => renderHook(() => {
    const [text, setText] = useState(() => readLocalDraft('s1'))
    useDraftPersistence('s1', text)
    useServerDraft('s1', setText)
    return { text, setText }
  })

  it('never publishes a draft it only loaded, so a failed read cannot overwrite a newer server copy', async () => {
    localStorage.setItem('hermes-draft:s1', JSON.stringify({ text: 'stale local', updatedAt: 1 }))
    vi.mocked(api.fetchDraft).mockRejectedValue(new Error('offline'))
    mount()
    await act(async () => { await Promise.resolve() })
    vi.advanceTimersByTime(2000)
    expect(vi.mocked(api.saveDraft)).not.toHaveBeenCalled()
  })

  it('keeps an unsynced edit over a server copy stamped by a clock that runs ahead', async () => {
    const ahead = String((Date.now() + 120_000) * 1000)
    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: 'from a fast clock', files: [] }, draft_version: ahead })
    const first = mount()
    await act(async () => { await Promise.resolve() })
    expect(first.result.current.text).toBe('from a fast clock')
    vi.mocked(api.saveDraft).mockRejectedValue(new Error('offline'))
    act(() => { first.result.current.setText('my later edit') })
    vi.advanceTimersByTime(2000)
    first.unmount()

    const second = mount()
    await act(async () => { await Promise.resolve() })
    expect(second.result.current.text).toBe('my later edit')
  })
})

describe('restores that race an edit, and server truncation (TAL-564)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockReset().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers() })
  const mount = () => renderHook(() => {
    const [text, setText] = useState(() => readLocalDraft('s1'))
    useDraftPersistence('s1', text)
    useServerDraft('s1', setText)
    return { text, setText }
  })

  it('drops a slow restore once the box was edited, even if it is empty again after a send', async () => {
    let answer!: (value: Awaited<ReturnType<typeof api.fetchDraft>>) => void
    vi.mocked(api.fetchDraft).mockImplementation(() => new Promise((r) => { answer = r }))
    const { result } = mount()
    act(() => { result.current.setText('sent message') })
    act(() => { result.current.setText('') })
    await act(async () => { answer({ draft: { text: 'sent message', files: [] }, draft_version: String((Date.now() + 1) * 1000) }); await Promise.resolve() })
    expect(result.current.text).toBe('')
  })

  it('keeps the full local draft over the copy the server truncated on save', async () => {
    const long = 'x'.repeat(60_000)
    // Past every revision an earlier test observed, so this browser's clock alone orders the two saves.
    vi.setSystemTime(Date.now() + 3_600_000)
    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: '', files: [] }, draft_version: null })
    const first = mount()
    await act(async () => { await Promise.resolve() })
    act(() => { first.result.current.setText(long) })
    vi.advanceTimersByTime(2000)
    const saved = vi.mocked(api.saveDraft).mock.calls.at(-1)![0]
    first.unmount()

    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: long.slice(0, 50_000), files: [] }, draft_version: saved.draft_version! })
    const second = mount()
    await act(async () => { await Promise.resolve() })
    expect(second.result.current.text).toBe(long)
  })
})

describe('publishing after hydration, and reloads (TAL-564)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockReset().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers() })
  const mount = () => renderHook(() => {
    const [text, setText] = useState(() => readLocalDraft('s1'))
    useDraftPersistence('s1', text)
    useServerDraft('s1', setText)
    return { text, setText }
  })

  it('publishes a local edit the server never got once a read shows the server copy is older', async () => {
    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: '', files: [] }, draft_version: null })
    const first = mount()
    await act(async () => { await Promise.resolve() })
    act(() => { first.result.current.setText('left before the server save') })
    first.unmount()
    expect(vi.mocked(api.saveDraft)).not.toHaveBeenCalled()

    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: 'older', files: [] }, draft_version: '1000' })
    const second = mount()
    await act(async () => { await Promise.resolve() })
    expect(second.result.current.text).toBe('left before the server save')
    expect(vi.mocked(api.saveDraft).mock.calls.map(([body]) => body.draft.text)).toEqual(['left before the server save'])
  })

  it('stamps an edit after a reload above the revision the stored draft already carries', async () => {
    const ahead = Date.now() + 120_000
    localStorage.setItem('hermes-draft:s1', JSON.stringify({ text: 'stamped by a fast clock', updatedAt: ahead }))
    // A reload: a fresh module instance whose revision counter starts over.
    vi.resetModules()
    const fresh = await import('./useDraft')
    const freshApi = await import('../../api/endpoints')
    vi.mocked(freshApi.fetchDraft).mockImplementation(() => new Promise(() => undefined))
    vi.mocked(freshApi.saveDraft).mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null })
    const { result } = renderHook(() => {
      const [text, setText] = useState(() => fresh.readLocalDraft('s1'))
      fresh.useDraftPersistence('s1', text)
      fresh.useServerDraft('s1', setText)
      return { text, setText }
    })
    act(() => { result.current.setText('edited after reload') })
    vi.advanceTimersByTime(2000)
    const version = Number(vi.mocked(freshApi.saveDraft).mock.calls.at(-1)![0].draft_version)
    expect(version).toBeGreaterThan(ahead * 1000)
  })
})

describe('unknown server order, and exact revisions (TAL-564)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); vi.mocked(api.saveDraft).mockReset().mockResolvedValue({ ok: true, draft: { text: '', files: [] }, draft_version: null }) })
  afterEach(() => { vi.useRealTimers() })
  const mount = () => renderHook(() => {
    const [text, setText] = useState(() => readLocalDraft('s1'))
    useDraftPersistence('s1', text)
    useServerDraft('s1', setText)
    return { text, setText }
  })

  it('never publishes over an unversioned server draft, which gives no order', async () => {
    localStorage.setItem('hermes-draft:s1', JSON.stringify({ text: 'this browser', updatedAt: Date.now() }))
    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: 'an older client', files: [] }, draft_version: null })
    const { result } = mount()
    await act(async () => { await Promise.resolve() })
    expect(result.current.text).toBe('this browser')
    expect(vi.mocked(api.saveDraft)).not.toHaveBeenCalled()
  })

  it('ranks the local copy by its exact revision, so the next server revision still counts as newer', async () => {
    vi.setSystemTime(Date.now() + 7_200_000)
    const ahead = (Date.now() + 120_000) * 1000
    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: 'from a fast clock', files: [] }, draft_version: String(ahead) })
    const first = mount()
    await act(async () => { await Promise.resolve() })
    act(() => { first.result.current.setText('my edit') })
    vi.advanceTimersByTime(300)
    first.unmount()

    vi.mocked(api.fetchDraft).mockResolvedValue({ draft: { text: 'newer elsewhere', files: [] }, draft_version: String(ahead + 2) })
    const second = mount()
    await act(async () => { await Promise.resolve() })
    expect(second.result.current.text).toBe('newer elsewhere')
  })
})

import { expect, it, vi } from 'vitest'
const replies = vi.hoisted(() => ({ list: vi.fn(), read: vi.fn(), save: vi.fn() }))
vi.mock('./orpc', () => ({ orpc: () => ({ files: replies }) }))
import { listDir, readFile, saveFile } from './endpoints'

it('refuses an old server workspace reply instead of treating it as a managed buffer', async () => {
  replies.list.mockResolvedValue({ entries: [{ name: 'private-workspace.txt' }] })
  replies.read.mockResolvedValue({ content: 'workspace text' })
  replies.save.mockResolvedValue({ ok: true, path: 'buffer-one', size: 1 })
  for (const result of [listDir('s', '.', false, 'managed'), readFile('s', 'buffer-one', 'managed'), saveFile('s', 'buffer-one', 'x', 'managed')]) {
    await expect(result).rejects.toThrow('This server does not support session buffers.')
  }
  await expect(listDir('s')).resolves.toMatchObject({ entries: [{ name: 'private-workspace.txt' }] })
  replies.list.mockResolvedValue({ source: 'managed', entries: [] })
  await expect(listDir('s', '.', false, 'managed')).resolves.toMatchObject({ source: 'managed' })
})

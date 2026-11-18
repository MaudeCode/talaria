import { expect, it } from 'vitest'
import { DraftStore } from '../drafts.js'

it('does not invent an empty winning draft when the backend cannot read a conflicting write', async () => {
  const { RevisionConflict } = await import('./backend.js')
  let reads = 0
  const documents = {
    get: () => ++reads === 1 ? Promise.resolve({ value: { text: 'old', files: [], _draft_version: '1000' }, revision: '1000' }) : Promise.reject(new Error('synthetic backend read failed')),
    put: () => Promise.reject(new RevisionConflict('session')),
  }
  await expect(new DraftStore(documents as never).write('session', { text: 'new', files: [] }, '2000')).rejects.toThrow('synthetic backend read failed')
})

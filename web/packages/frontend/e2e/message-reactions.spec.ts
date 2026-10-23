import { mkdirSync, readFileSync } from 'node:fs'
import { expect, test } from './fixtures'
import type { Message, MessageReactionView } from '@maudecode/talaria-web-contracts'

const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-reactions.json', import.meta.url), 'utf8')) as { message: Message }

test('canonical reactions render and update optimistically with rollback', async ({ page, errors }, testInfo) => {
  const before = process.env.TALARIA_EVIDENCE_BEFORE === '1'
  const sid = 'canonical-reactions'
  const view = fixture.message.reaction_view!
  let state = view.state
  const session = () => ({ session_id: sid, title: 'Release review', read_only: true, message_count: 2,
    owner_attachment: { state: 'attached', reason: null, can_submit: true, can_interrupt: false, can_attach: false, restarting: false, revision: 2, execution_generation: 1, admissions: [] },
    messages: [{ role: 'user', message_id: 'question', content: 'Is the change ready for review?' },
      { ...fixture.message, message_id: 'answer', reaction_view: { ...view, state } }],
  })
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: session() } }))
  await page.route('**/api/session/stream?**', (route) => route.fulfill({ contentType: 'text/event-stream', body: `event: initial\ndata: {"session_id":"${sid}"}\n\n` }))
  await page.route('**/api/health/agent', (route) => route.fulfill({ json: { alive: true, chat: { available: true, condition: null } } }))
  const writes: unknown[] = []
  let finish: ((refuse?: boolean) => void) | undefined
  await page.route('**/api/chat/owner-action', async (route) => {
    const request = route.request().postDataJSON() as { row_id: number; emoji: MessageReactionView['state']['selected']; author?: string }
    writes.push(request)
    const refused = await new Promise<boolean>((resolve) => { finish = (refuse = false) => resolve(refuse) })
    expect(request.row_id).toBe(42)
    expect(request.author).toBeUndefined()
    if (refused) return route.fulfill({ status: 409, json: { error: 'Owner refused reaction' } })
    state = view.actions.find((action) => action.emoji === request.emoji)!.result
    return route.fulfill({ json: { ok: true, session: session() } })
  })
  await page.goto(`/session/${sid}`)
  await expect(page.getByText('The tests passed. The change is ready for review.')).toBeVisible()
  const evidence = process.env.TALARIA_EVIDENCE_DIR
  const capture = async (suffix = '') => {
    if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: `${evidence}/${before ? 'before' : 'after'}${suffix}-${testInfo.project.name}.png`, fullPage: true }) }
  }
  if (before) { await capture(); return }
  await expect(page.getByRole('button', { name: 'Remove 👍 reaction, 1' })).toBeVisible()
  await capture()
  await page.getByRole('button', { name: 'React to message' }).click()
  await expect(page.getByRole('menuitem', { name: 'React with ❤️' })).toBeVisible()
  await capture('-menu')
  await page.getByRole('menuitem', { name: 'React with ❤️' }).click()
  await expect(page.getByRole('button', { name: 'Remove ❤️ reaction, 1' })).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(() => writes.length).toBe(1)
  finish!(true)
  await expect(page.getByRole('button', { name: 'Remove 👍 reaction, 1' })).toBeVisible()
  await page.getByRole('button', { name: 'Remove 👍 reaction, 1' }).click()
  await expect(page.getByRole('button', { name: /👍 reaction/ })).toHaveCount(0)
  await expect.poll(() => writes.length).toBe(2)
  finish!()
  await expect(page.getByRole('button', { name: 'React with 🎉, 1' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: /👍 reaction/ })).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect(errors).toHaveLength(2)
  expect(errors).toEqual(expect.arrayContaining([expect.stringMatching(/^409 POST .*\/api\/chat\/owner-action$/), expect.stringContaining('status of 409')]))
  errors.length = 0
})

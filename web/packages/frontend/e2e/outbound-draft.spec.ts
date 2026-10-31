import { expect, test } from './fixtures'

test.use({ serviceWorkers: 'block' })

test('reviews exact outbound content, edits optimistically and reconciles a refused approval', async ({ page, errors }, info) => {
  const sid = 'outbound-draft-review'
  const ref = { draft_id: 'd_1234abcd', card: 1 }
  let draft = { ...ref, producer: 'draft-cards', producer_revision: '6e6ca659ece59b0ce1c28b3b188393491ee5a415', kind: 'email', platform: 'Mail', version: 2, revision: 'reviewed-v2', fields: { from: 'sender@example.invalid', to: ['reviewer@example.invalid'], cc: [], bcc: [], subject: 'Release review', body: 'The release is ready for your review. Please confirm the checklist.' }, state: 'draft', can_edit: true, can_approve: true, masked: false }
  await page.route('**/api/session?**', (route) => route.fulfill({ json: { session: {
    session_id: sid, title: 'Review the release message', read_only: false, can_branch: true, can_pin: true, can_archive: true, can_delete: true, can_duplicate: true, can_share: true,
    messages: [{ role: 'assistant', content: 'Please review this message.', _turn_id: 'draft-turn', _anchor_activity_scene: {
      version: 'activity_scene_v1', terminal_state: 'completed', expanded_by_default: true, final_answer: 'Please review this message.', activity_rows: [{ row_id: 'draft-row', role: 'tool', tool: { id: 'draft-tool', name: 'draft_card', kind: 'write', target: 'Release review', preview: 'Draft prepared', done: true, is_error: false, duration: null, cost_usd: null, result_view: { text: 'Draft prepared', outbound_draft: ref } } }],
    } }],
  } } }))
  const actions: Record<string, unknown>[] = []
  await page.route('**/api/session/outbound-draft**', async (route) => {
    if (route.request().method() === 'GET') { await route.fulfill({ json: { draft } }); return }
    const body = route.request().postDataJSON() as Record<string, unknown>
    actions.push(body)
    if (body.action === 'edit') {
      draft = { ...draft, version: 3, revision: 'edited-v3', fields: body.fields as typeof draft.fields }
      await route.fulfill({ json: { draft } })
    } else {
      draft = { ...draft, state: 'superseded', can_edit: false, can_approve: false }
      await route.fulfill({ status: 409, json: { error: 'The producer revised this draft. Review it again.' } })
    }
  })
  await page.goto(`/session/${sid}`)
  await expect(page.locator('[data-tool-id="draft-tool"]')).toBeVisible()
  if (process.env.TALARIA_DRAFT_EVIDENCE) await page.screenshot({ path: `${process.env.TALARIA_DRAFT_EVIDENCE}-${info.project.name}-initial.png`, fullPage: true })
  const review = page.getByRole('region', { name: 'Outbound draft' })
  await expect(review).toContainText('reviewer@example.invalid')
  await expect(review).toContainText('Version 2')
  if (process.env.TALARIA_DRAFT_EVIDENCE) await page.screenshot({ path: `${process.env.TALARIA_DRAFT_EVIDENCE}-${info.project.name}-review.png`, fullPage: true })
  await review.getByRole('button', { name: 'Edit' }).click()
  await review.getByRole('textbox', { name: 'Body', exact: true }).fill('Please review the updated release checklist.')
  await review.getByRole('button', { name: 'Save' }).click()
  await expect(review).toContainText('Please review the updated release checklist.')
  await expect(review).toContainText('Version 3')
  await review.getByRole('button', { name: 'Approve this version' }).click()
  await expect(review).toContainText('Superseded')
  await expect(review.getByRole('button', { name: 'Approve this version' })).toHaveCount(0)
  const expected = /^409 POST .*\/api\/session\/outbound-draft$|the server responded with a status of 409/i
  expect(errors.filter((error) => expected.test(error))).toHaveLength(2)
  errors.splice(0, errors.length, ...errors.filter((error) => !expected.test(error)))
  expect(actions.map((a) => [a.action, a.version, a.revision])).toEqual([['edit', 2, 'reviewed-v2'], ['approve', 3, 'edited-v3']])
  if (process.env.TALARIA_DRAFT_EVIDENCE) await page.screenshot({ path: `${process.env.TALARIA_DRAFT_EVIDENCE}-${info.project.name}-refused.png`, fullPage: true })
})

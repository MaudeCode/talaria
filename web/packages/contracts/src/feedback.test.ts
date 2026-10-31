import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { FEEDBACK_ATTACHMENT_LIMITS, FeedbackAttachmentStagedSchema, FeedbackDiagnosticsSchema, FeedbackErrorSchema, FeedbackOptionsSchema, FeedbackResultSchema, FeedbackSubmitSchema } from './routes/settings.js'
it('pins feedback preview, submission, response and errors for every client', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-feedback.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(FeedbackSubmitSchema.parse(fixture.submit)).toEqual(fixture.submit)
  const diagnostics = FeedbackDiagnosticsSchema.parse(fixture.diagnostics)
  expect(diagnostics).toEqual(fixture.diagnostics)
  expect(diagnostics.bytes).toBe(Buffer.byteLength(diagnostics.text))
  expect(FeedbackResultSchema.parse(fixture.sent)).toEqual(fixture.sent)
  expect(FeedbackOptionsSchema.parse(fixture.options)).toEqual(fixture.options)
  expect(FeedbackAttachmentStagedSchema.parse(fixture.staged)).toEqual(fixture.staged)
  expect(FeedbackSubmitSchema.safeParse({ ...(fixture.submit as object), attachmentIds: Array.from({ length: 6 }, () => crypto.randomUUID()) }).success).toBe(false)
  for (const error of fixture.errors as unknown[]) expect(FeedbackErrorSchema.parse(error)).toEqual(error)
  const report = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/feedback-report.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const input = { requestId: report.requestId, kind: report.kind, title: report.title, body: report.body, client: report.client }
  expect(FeedbackSubmitSchema.parse({ ...input, includeDiagnostics: true })).toMatchObject(input)
})

it('mirrors the attachment limits Relay enforces', () => {
  const limits = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/feedback-attachment-limits.json', import.meta.url), 'utf8')) as unknown
  expect(FEEDBACK_ATTACHMENT_LIMITS).toEqual(limits)
})

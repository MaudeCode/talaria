import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { FeedbackDiagnosticsSchema, FeedbackErrorSchema, FeedbackResultSchema, FeedbackSubmitSchema } from './routes/settings.js'
it('pins feedback preview, submission, response and errors for every client', () => {
  const fixture = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/web-feedback.json', import.meta.url), 'utf8')) as Record<string, unknown>
  expect(FeedbackSubmitSchema.parse(fixture.submit)).toEqual(fixture.submit)
  const diagnostics = FeedbackDiagnosticsSchema.parse(fixture.diagnostics)
  expect(diagnostics).toEqual(fixture.diagnostics)
  expect(diagnostics.bytes).toBe(Buffer.byteLength(diagnostics.text))
  expect(FeedbackResultSchema.parse(fixture.sent)).toEqual(fixture.sent)
  for (const error of fixture.errors as unknown[]) expect(FeedbackErrorSchema.parse(error)).toEqual(error)
  const report = JSON.parse(readFileSync(new URL('../../../../contracts/fixtures/feedback-report.json', import.meta.url), 'utf8')) as Record<string, unknown>
  const input = { requestId: report.requestId, kind: report.kind, title: report.title, body: report.body, client: report.client }
  expect(FeedbackSubmitSchema.parse({ ...input, includeDiagnostics: true })).toMatchObject(input)
})

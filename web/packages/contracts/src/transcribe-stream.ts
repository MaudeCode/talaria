import { z } from 'zod'

/**
 * TAL-802: live dictation over one WebSocket per recording at `TRANSCRIBE_STREAM_PATH`, offered when
 * `GET /api/transcribe/capability` reports `streaming`. The provider session and its keys stay on the server.
 *
 * Client → server: a `TranscribeStreamStart` text frame first, then binary s16le mono PCM frames at that rate, then a
 * `TranscribeStreamEnd` text frame when the recording stops. Closing the socket earlier cancels the session.
 * Server → client: `partial` text as the provider recognizes it, then exactly one `final` or `error`, then the server
 * closes. A client keeps its recording and falls back to `POST /api/transcribe` on `error` or a close without `final`.
 */
export const TRANSCRIBE_STREAM_PATH = '/api/transcribe/stream'
export const TRANSCRIBE_STREAM_MIN_RATE = 8000
export const TRANSCRIBE_STREAM_MAX_RATE = 48000

export const TranscribeStreamStartSchema = z.object({ sample_rate: z.number().int().min(TRANSCRIBE_STREAM_MIN_RATE).max(TRANSCRIBE_STREAM_MAX_RATE) })
export const TranscribeStreamEndSchema = z.object({ eos: z.literal(true) })

export const TranscribeStreamEventSchema = z.discriminatedUnion('type', [
  /** The provider's current text for the whole recording so far; each one replaces the last. */
  z.object({ type: z.literal('partial'), text: z.string() }),
  z.object({ type: z.literal('final'), transcript: z.string(), provider: z.string() }),
  z.object({ type: z.literal('error'), message: z.string() }),
])

export type TranscribeStreamStart = z.infer<typeof TranscribeStreamStartSchema>
export type TranscribeStreamEnd = z.infer<typeof TranscribeStreamEndSchema>
export type TranscribeStreamEvent = z.infer<typeof TranscribeStreamEventSchema>

/// <reference lib="webworker" />
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, Input, Mp4OutputFormat, Output, Quality, WebMOutputFormat, canEncodeVideo, getFirstEncodableVideoCodec } from 'mediabunny'

/** One feedback clip to re-encode (TAL-1596); every bound comes from the server's `feedback.options`. */
export interface VideoJob { file: File; maxBytes: number; maxSeconds: number; encode: boolean }
export type VideoResult =
  | { kind: 'done'; data: ArrayBuffer; contentType: 'video/mp4' | 'video/webm' }
  | { kind: 'too_long' }
  | { kind: 'unavailable' }
  | { kind: 'unreadable' }

export const MAX_VIDEO_WIDTH = 1280
const MAX_VIDEO_BITRATE = 2_500_000

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)

async function compress(job: VideoJob): Promise<VideoResult> {
  const input = new Input({ source: new BlobSource(job.file), formats: ALL_FORMATS })
  try {
    return await convert(input, job)
  } finally {
    input.dispose()
  }
}

async function convert(input: Input, { maxBytes, maxSeconds, encode }: VideoJob): Promise<VideoResult> {
  const video = await input.getPrimaryVideoTrack()
  if (!video) return { kind: 'unreadable' }
  const duration = await input.computeDuration()
  if (!(duration > 0)) return { kind: 'unreadable' }
  if (duration > maxSeconds) return { kind: 'too_long' }
  if (!encode) return { kind: 'unavailable' }
  const [displayWidth, displayHeight] = await Promise.all([video.getDisplayWidth(), video.getDisplayHeight()])
  const width = even(Math.min(MAX_VIDEO_WIDTH, displayWidth))
  const height = even(displayHeight * (width / displayWidth))
  // Headroom under the size limit for container overhead and rate-control overshoot.
  const quality = new Quality({ bitrate: Math.floor(Math.min(MAX_VIDEO_BITRATE, (0.9 * maxBytes * 8) / duration)) })
  // MP4/H.264 where the browser encodes AVC, else WebM with the first encodable VP codec.
  const avc = await canEncodeVideo('avc', { width, height, quality })
  const codec = avc ? 'avc' : await getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height, quality })
  if (!codec) return { kind: 'unavailable' }
  const output = new Output({ format: avc ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(), target: new BufferTarget() })
  const conversion = await Conversion.init({
    input, output, tracks: 'primary', tags: {}, showWarnings: false,
    video: { width, height, fit: 'contain', codec, quality, forceTranscode: true },
    audio: { discard: true },
  })
  if (!conversion.isValid) return { kind: 'unavailable' }
  await conversion.execute()
  const data = output.target.buffer
  return data ? { kind: 'done', data, contentType: avc ? 'video/mp4' : 'video/webm' } : { kind: 'unavailable' }
}

const scope = self as unknown as DedicatedWorkerGlobalScope
scope.onmessage = ({ data }: MessageEvent<VideoJob>) => {
  void compress(data).catch((): VideoResult => ({ kind: 'unreadable' })).then((result) => {
    if (result.kind === 'done') scope.postMessage(result, [result.data])
    else scope.postMessage(result)
  })
}

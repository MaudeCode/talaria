import type { SidecarResult } from '@maudecode/talaria-web-contracts'

/** The final text and whether it can be committed, for both transcription transports. */
export function transcriptionResult(result: SidecarResult<'stt.transcribe'>) {
  const transcript = result.transcript.trim()
  return {
    transcript,
    filtered: result.filtered,
    has_usable_transcript: !result.filtered && !result.no_speech && transcript !== '',
  }
}

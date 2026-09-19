import { m } from '../../paraglide/messages.js'
import { LoadingState } from '../../ui/States'

/**
 * Placeholder shown while a cold transcript loads: a few rows shaped like the
 * real message column so the pane does not jump when content lands, plus the
 * shared status line. Fades in after a short delay so cached loads never flash.
 */
export function TranscriptSkeleton() {
  return (
    <div className="transcript-skeleton flex flex-1 min-h-0 flex-col" data-testid="transcript-skeleton">
      <div className="mx-auto flex w-full flex-col max-w-(--msg-max) pt-5 max-[641px]:pt-3" aria-hidden="true">
        <div className="msg-row"><div className="skeleton-bar skeleton-role" /><div className="skeleton-bar w-[92%]" /><div className="skeleton-bar w-[78%]" /><div className="skeleton-bar w-[55%]" /></div>
        <div className="msg-row flex justify-end"><div className="skeleton-user" /></div>
        <div className="msg-row"><div className="skeleton-bar skeleton-role" /><div className="skeleton-bar w-[84%]" /><div className="skeleton-bar w-[40%]" /></div>
      </div>
      <LoadingState label={m.transcript_loading()} className="flex-1" />
    </div>
  )
}

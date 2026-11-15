import type { ReactNode } from 'react'
import type { TalariaActivity } from '@maudecode/talaria-web-contracts'
import { ChevronRight } from 'lucide-react'
import { Brandmark } from '../../shell/Brandmark'
import { appUrl } from '../../lib/appRoot'

/** MarkerRow's flat disclosure chrome, shared by markers, notices and admitted activity. */
export function TranscriptActivityLine({ activity, title: explicitTitle, icon, label, children }: { activity?: TalariaActivity | undefined; title?: string; icon?: ReactNode; label?: ReactNode; children?: ReactNode }) {
  const title = explicitTitle ?? activity?.summary ?? ''
  const accessibilityLabel = activity ? `Talaria. ${title}` : title
  const heading = <>
    {icon ?? <Brandmark size={14} className="shrink-0" />}
    <div className="min-w-0 [overflow-wrap:anywhere]">{label ?? (activity?.target ? <a href={appUrl(activity.target.path).href} className="hover:underline">{title}</a> : title)}</div>
    {children && <ChevronRight size={14} aria-hidden="true" className="shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none" />}
  </>
  return children ? <details className="marker-row group text-[13px] text-muted">
    <summary className="flex cursor-pointer list-none items-center gap-2 [&::-webkit-details-marker]:hidden" aria-label={accessibilityLabel}>{heading}</summary>
    <div className="mt-2 pl-[22px]">{children}</div>
  </details> : <div role="note" className="flex items-center gap-2 text-[13px] text-muted" aria-label={accessibilityLabel}>{heading}</div>
}

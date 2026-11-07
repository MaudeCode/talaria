import { useQuery } from '@tanstack/react-query'
import { Copy } from 'lucide-react'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { appUrl } from '../../lib/appRoot'
import { copyWithToast } from '../../lib/clipboard'
import { Button, buttonClass } from '../../ui/Button'
import { SectionHeader } from '../../ui/List'
import { Toaster } from '../toast/Toaster'
import { m } from '../../paraglide/messages.js'
import { SharedTranscript } from './SharedTranscript'

/** Public read-only snapshot (`/share/$token`). Unauthenticated; server marks it noindex. */
export function SharePage({ token }: { token: string }) {
  const share = useQuery({ queryKey: keys.share(token), queryFn: () => api.fetchShare(token), retry: false })
  const data = share.data?.share
  const title = data?.title ?? (share.isError ? m.share_unavailable_title() : m.loading())
  const copy = () => { copyWithToast(window.location.href) }
  return (
    <div className="share-shell min-h-full bg-bg text-text">
      <header className="share-topbar sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border bg-sidebar px-5 py-4 max-[720px]:flex-col max-[720px]:items-start max-[720px]:px-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="brandmark app-titlebar-icon inline-block h-5 w-5" aria-hidden="true" />
          <div>
            <div className="text-[13px] font-bold">{m.share_brand_title()}</div>
            <div className="text-[11px] text-muted">{m.share_readonly()}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 max-[720px]:w-full">
          <Button onClick={copy} className="min-h-11 max-[720px]:flex-1">
            <Copy size={14} aria-hidden="true" /> {m.share_copy_link()}
          </Button>
          <a href={appUrl('').href} className={buttonClass('default', 'min-h-11 no-underline max-[720px]:flex-1')}>{m.share_open_hermes()}</a>
        </div>
      </header>
      <main className="share-wrap mx-auto w-[min(920px,calc(100vw-32px))] pb-18 pt-7">
        <section className="pb-4">
          <div className="inline-flex items-center rounded-full border border-border2 bg-surface px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-muted">{m.share_public_badge()}</div>
          <h1 className="mb-2.5 mt-4 text-[32px] font-semibold leading-tight tracking-tight text-strong max-[720px]:text-[26px]" id="shareTitle">{title}</h1>
          <div className="text-[13px] leading-relaxed text-muted" id="shareMeta">
            {share.isPending && m.share_fetching()}
            {share.isError && m.share_error_meta()}
            {data && m.share_meta({ n: data.message_count ?? data.messages?.length ?? 0 })}
          </div>
        </section>
        <SectionHeader className="mt-5">{m.transcript()}</SectionHeader>
        <section className="share-transcript mt-3" id="shareTranscript">
          {share.isPending && <div className="px-4 py-10 text-center text-muted">{m.loading()}</div>}
          {share.isError && (
            <div className="px-4 py-10 text-center text-muted" role="alert">
              <strong className="text-text">{m.share_error_title()}</strong>
              <div className="mt-2">{m.share_error_detail()}</div>
            </div>
          )}
          {data && <SharedTranscript messages={data.messages ?? []} />}
        </section>
        <div className="mt-4 border-t border-border pt-4 text-xs leading-relaxed text-muted">{m.share_footer()}</div>
      </main>
      <Toaster />
    </div>
  )
}

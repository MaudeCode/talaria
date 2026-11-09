import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ShowBlock, ShowBlockRef } from '@maudecode/talaria-web-contracts'
import * as api from '../../../api/endpoints'
import { keys } from '../../../api/queryKeys'
import { appUrl } from '../../../lib/appRoot'
import { copyWithToast } from '../../../lib/clipboard'
import { m } from '../../../paraglide/messages.js'
import { Button } from '../../../ui/Button'
import { RowContextMenu, type RowAction } from '../../../ui/Menu'
import { formatBytes } from '../../../ui/States'
import { BarChart } from '../../insights/BarChart'
import { requestOpenFile } from '../../workspace/openFileRequest'
import { MediaTiles } from './MediaTiles'
import { ResultSection } from './OutboundDraftResult'

const href = (url: string): string => appUrl(url.replace(/^\.\//, '')).href

/** TAL-1971: save a delivered file through a download link, as the session export does. */
function download(url: string): void {
  const a = document.createElement('a')
  a.href = href(url)
  a.download = ''
  a.rel = 'noopener'
  a.click()
}

/** The block's Download, Open and Copy, for its visible controls and its right-click and long-press menu alike. */
function blockActions(block: ShowBlock): RowAction[] {
  const open = (url: string) => () => { window.open(href(url), '_blank', 'noopener,noreferrer') }
  switch (block.kind) {
    case 'file': {
      const path = block.focus_path
      const delivery = block.delivery
      const save: RowAction[] = delivery ? [{ label: m.deliver_download(), run: () => { download(delivery.download_url) } }] : []
      if (path !== null) return [...save, { label: m.show_open(), run: () => { requestOpenFile({ sessionId: block.session_id, path }) } }]
      return block.media ? [...save, { label: m.show_open(), run: open(block.media.url) }] : save
    }
    case 'table': return [{ label: m.show_copy_table(), run: () => { copyWithToast(block.tsv) } }]
    case 'chart': return []
    case 'html': return [{ label: m.show_open(), run: open(block.frame_url) }]
  }
}

function BlockBody({ block }: { block: ShowBlock }) {
  switch (block.kind) {
    case 'file':
      return <>
        {block.delivery && <DeliveryLine block={block} />}
        {block.media?.kind === 'image' ? <img src={href(block.media.url)} alt={block.title} loading="lazy" className="mt-2 max-h-80 max-w-full rounded" />
          : block.media ? <div className="mt-2"><MediaTiles media={[block.media]} sessionId={block.session_id} /></div>
          : !block.delivery && <p className="mt-1 break-all font-mono text-xs text-muted">{block.file.path}</p>}
      </>
    case 'table':
      return <>
        <div className="mt-2 max-h-96 overflow-auto">
          <table className="w-full text-left text-xs tabular-nums">
            <caption className="sr-only">{block.title}</caption>
            <thead><tr>{block.columns.map((column, index) => <th key={index} scope="col" className="sticky top-0 border-b border-border bg-surface-subtle px-2 py-1 font-medium">{column}</th>)}</tr></thead>
            <tbody>{block.rows.map((row, r) => <tr key={r} className="border-t border-border-subtle">{row.map((value, c) => <td key={c} className="whitespace-pre-wrap break-words px-2 py-1 align-top">{value}</td>)}</tr>)}</tbody>
          </table>
        </div>
        {block.truncation && <p className="mt-1 text-xs text-muted">{m.show_table_truncated({ shownRows: String(block.rows.length), totalRows: String(block.truncation.total_rows), shownColumns: String(block.columns.length), totalColumns: String(block.truncation.total_columns) })}</p>}
      </>
    case 'chart':
      return <div className="mt-2 flex flex-col gap-4">
        {block.series.map((series, index) => <BarChart key={index} id={`show-${block.block_id}-${String(index)}`} variant={block.chart} title={block.series.length > 1 ? `${block.title} · ${series.name}` : block.title} maxDisplay={series.max_display} peak={series.peak} rows={series.points.map((point) => ({ label: point.label, value: point.value, display: point.display }))} />)}
      </div>
    case 'html':
      return <ShowFrame key={block.frame_url} block={block} />
  }
}

/** TAL-1971: a delivered file's name, size and type, and the server's note when the file changed after delivery. */
function DeliveryLine({ block }: { block: Extract<ShowBlock, { kind: 'file' }> }) {
  return <>
    <p className="mt-1 break-all text-xs text-muted">{[block.file.name, formatBytes(block.file.size), block.delivery?.mime].join(' · ')}</p>
    {block.delivery?.changed && <p role="note" className="mt-1 text-xs text-warning">{m.deliver_changed()}</p>}
  </>
}

/**
 * The page in a frame with `allow-scripts` only: an opaque origin, so it gets no cookie, and its CSP gives it no fetch.
 * A CSP cannot stop the frame navigating itself, so a second load (the page left its grant URL) closes the frame: the
 * page it went to never shows, and nothing typed afterwards reaches it. The App's web view refuses that navigation.
 */
function ShowFrame({ block }: { block: Extract<ShowBlock, { kind: 'html' }> }) {
  const loads = useRef(0)
  const [left, setLeft] = useState(false)
  if (left) return <p role="status" className="mt-2 text-muted">{m.show_frame_left()}</p>
  return <iframe src={href(block.frame_url)} title={block.title} sandbox="allow-scripts" referrerPolicy="no-referrer" onLoad={() => { loads.current += 1; if (loads.current > 1) setLeft(true) }} className="mt-2 h-96 w-full rounded border border-border-subtle bg-white" />
}

/**
 * TAL-1968: a file, table, chart or HTML page an agent showed, rendered from the server's block: a media row or a file
 * row whose Open shows it on the side panel's Files page, a table with the server's truncation note and Copy (TSV),
 * the Insights chart with the server's formatted values, or a sandboxed frame. It collects no input. TAL-1971: a
 * delivered file adds Download, its name, size and type, and the server's "changed since delivered" note.
 */
export function ShowBlockResult({ reference }: { reference: ShowBlockRef }) {
  const query = useQuery({ queryKey: keys.showBlock(reference.block_id), queryFn: ({ signal }) => api.fetchShowBlock(reference.block_id, signal), retry: false })
  const block = query.data
  const actions = block ? blockActions(block) : []
  return <ResultSection label={block?.kind === 'file' && block.delivery ? m.deliver_heading() : m.show_heading()}>
    <RowContextMenu label={block?.title ?? reference.title} actions={actions} trigger={<div data-show-block={reference.block_id} data-kind={reference.kind}>
      {/* A chart's caption carries its title. */}
      {reference.kind !== 'chart' && <strong>{block?.title ?? reference.title}</strong>}
      {block ? <BlockBody block={block} /> : <p role="status" className="mt-1 text-muted">{query.isPending ? m.loading() : m.show_unavailable()}</p>}
      {actions.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{actions.map((action) => <Button key={action.label} onClick={action.run}>{action.label}</Button>)}</div>}
    </div>} />
  </ResultSection>
}

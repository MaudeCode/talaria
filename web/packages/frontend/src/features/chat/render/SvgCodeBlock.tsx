import { use, useState } from 'react'
import { Eye } from 'lucide-react'
import { CodeBlockCopyButton, CodeBlockDownloadButton, StreamdownContext, type CustomRendererProps } from 'streamdown'
import { m } from '../../../paraglide/messages.js'
import { Tooltip } from '../../../ui/Tooltip'
import { ImageLightbox } from '../ImageLightbox'
import { CodeBlock } from './CodeBlock'

/**
 * TAL-2678: a settled ```svg fence opens as a picture in the image lightbox. The source loads as an `<img>` data URI,
 * which runs no scripts and fetches nothing; source the browser cannot decode shows the lightbox's failure state.
 */
export function SvgCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  const settled = !isIncomplete && !use(StreamdownContext).isAnimating
  const [open, setOpen] = useState(false)
  const image = { src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`, name: 'SVG' }
  return (
    <>
      <CodeBlock code={code} language={language} isIncomplete={isIncomplete}>
        {/* Streamdown's own code-block button look, beside its Download and Copy. */}
        {settled && <Tooltip label={m.view_image()} side="top"><button type="button" className="cursor-pointer p-1 text-muted-foreground transition-all hover:text-foreground" aria-label={m.view_image()} onClick={() => { setOpen(true) }}><Eye size={14} aria-hidden="true" /></button></Tooltip>}
        <CodeBlockDownloadButton code={code} language={language} />
        <CodeBlockCopyButton code={code} />
      </CodeBlock>
      <ImageLightbox images={[image]} index={settled && open ? 0 : null} onIndexChange={(index) => { setOpen(index !== null) }} />
    </>
  )
}

import { useMemo, useState } from 'react'
import { CodeBlock, CodeBlockContainer, CodeBlockCopyButton, CodeBlockDownloadButton, CodeBlockHeader, type CustomRendererProps } from 'streamdown'
import { m } from '../../../paraglide/messages.js'

// Streamdown's own code-block chrome, so the tree sits in the same frame as the raw view.
const ACTIONS = 'pointer-events-none sticky top-2 z-10 -mt-10 flex h-8 items-center justify-end'
const ACTION_BAR = 'pointer-events-auto flex shrink-0 items-center gap-2 rounded-md border border-sidebar bg-sidebar/80 px-1.5 py-1 supports-[backdrop-filter]:bg-sidebar/70 supports-[backdrop-filter]:backdrop-blur'
const BODY = 'overflow-x-auto rounded-md border border-border bg-background p-4 font-mono text-sm'

/** Objects and arrays get a tree; scalars, fragments, and a fence still streaming stay raw only. */
function parseTree(code: string, incomplete: boolean): object | null {
  if (incomplete) return null
  try {
    const value: unknown = JSON.parse(code)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

function JsonNode({ name, value, depth, last }: { name?: string | undefined; value: unknown; depth: number; last: boolean }) {
  const label = name === undefined ? null : <span className="text-muted">{JSON.stringify(name)}: </span>
  const comma = last ? null : <span className="text-muted">,</span>
  if (value === null || typeof value !== 'object') {
    return <div>{label}<span className="text-pre-text">{JSON.stringify(value)}</span>{comma}</div>
  }
  const array = Array.isArray(value)
  const entries: [string | undefined, unknown][] = array ? value.map((item: unknown) => [undefined, item]) : Object.entries(value)
  const [open, close] = array ? ['[', ']'] : ['{', '}']
  return (
    // Deep levels start folded, as in the legacy tree.
    <details open={depth < 2}>
      <summary className="cursor-pointer">{label}<span className="text-muted">{open}{entries.length}{close}</span>{comma}</summary>
      <div className="pl-4">
        {entries.map(([key, item], index) => <JsonNode key={key ?? index} name={key} value={item} depth={depth + 1} last={index === entries.length - 1} />)}
      </div>
    </details>
  )
}

/** A ```json fence with a Raw/Tree toggle when it parses; the choice is per block and device-local. */
export function JsonCodeBlock({ code, language, isIncomplete }: CustomRendererProps) {
  const tree = useMemo(() => parseTree(code, isIncomplete), [code, isIncomplete])
  const [showTree, setShowTree] = useState(false)
  const actions = (
    <>
      {tree && <button type="button" className="cursor-pointer px-1 text-xs text-muted-foreground transition-colors hover:text-foreground" onClick={() => { setShowTree(!showTree) }}>{showTree ? m.raw_view() : m.tree_view()}</button>}
      <CodeBlockDownloadButton code={code} language={language} />
      <CodeBlockCopyButton code={code} />
    </>
  )
  if (!tree || !showTree) return <CodeBlock code={code} language={language} isIncomplete={isIncomplete}>{actions}</CodeBlock>
  return (
    <CodeBlockContainer language={language}>
      <CodeBlockHeader language={language} />
      <div className={ACTIONS}><div className={ACTION_BAR}>{actions}</div></div>
      <div className={BODY} data-json-tree="1"><JsonNode value={tree} depth={0} last /></div>
    </CodeBlockContainer>
  )
}

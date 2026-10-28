import { useState } from 'react'
import { CodeBlockContainer, CodeBlockCopyButton, CodeBlockDownloadButton, CodeBlockHeader, type CustomRendererProps } from 'streamdown'
import { m } from '../../../paraglide/messages.js'
import { ACTION_BAR, ACTIONS, BODY, CodeBlock } from './CodeBlock'

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
  const tree = parseTree(code, isIncomplete)
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
      <div className={`${BODY} font-mono`} data-json-tree="1"><JsonNode value={tree} depth={0} last /></div>
    </CodeBlockContainer>
  )
}

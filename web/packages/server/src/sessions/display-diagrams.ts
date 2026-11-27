import { DiagramKindSchema, type TranscriptDiagramPreview } from '@maudecode/talaria-web-contracts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import type { Nodes } from 'mdast'
import { isDict, messageText } from './merge.js'

type DiagramProjector = (text: string) => TranscriptDiagramPreview[]

/** Each exact Markdown body is normally repeated in its assistant row and its scene. Parse it once per response. */
function diagramProjector(): DiagramProjector {
  const byText = new Map<string, TranscriptDiagramPreview[]>()
  return (text) => {
    const cached = byText.get(text)
    if (cached !== undefined) return cached
    const previews: TranscriptDiagramPreview[] = []
    if (/^[^`~\r\n]*(?:`{3,}|~{3,})[ \t]*(?:svg|mermaid)\b/im.test(text)) {
      const visit = (node: Nodes): void => {
        if (node.type === 'code' && node.lang) {
          const kind = DiagramKindSchema.safeParse(node.lang.toLowerCase())
          // MarkdownUI's CommonMark renderer presents line endings as LF.
          if (kind.success) previews.push({ kind: kind.data, source: node.value.replace(/\r\n?/g, '\n') })
        }
        if ('children' in node) for (const child of node.children) visit(child)
      }
      visit(fromMarkdown(text))
    }
    byText.set(text, previews)
    return previews
  }
}

function withDiagramDisplay(
  item: Record<string, unknown>, source: string, displayKey: string, previewsKey: string, project: DiagramProjector | null,
): Record<string, unknown> {
  const existing = item[displayKey]
  const display = typeof existing === 'string' ? existing : source
  const previews = project?.(display)
  if (previews?.length) return { ...item, [displayKey]: display, [previewsKey]: previews }
  if (!(previewsKey in item)) return item
  const { [previewsKey]: _discarded, ...rest } = item
  return rest
}

export function withSceneRowDiagramPreviews(rows: unknown, project: DiagramProjector | null = diagramProjector()): unknown {
  if (!Array.isArray(rows)) return rows
  let changed = false
  const out = (rows as unknown[]).map((row) => {
    if (!isDict(row)) return row
    const display = withDiagramDisplay(row, typeof row.text === 'string' ? row.text : '',
      'display_text', 'diagram_previews', row.role === 'prose' ? project : null)
    changed ||= display !== row
    return display
  })
  return changed ? out : rows
}

/** Use the redacted display text, so a preview only repeats source already visible in the transcript. */
export function withTranscriptDiagramPreviews(messages: unknown[], activeTurnId: string | null): unknown[] {
  const project = diagramProjector()
  return messages.map((message) => {
    if (!isDict(message)) return message
    const settled = message.role === 'assistant' && (!activeTurnId || message._turn_id !== activeTurnId)
    const previews = settled ? project : null
    const source = settled ? messageText(message.content) : ''
    const display = withDiagramDisplay(message, source, '_display_content', '_diagram_previews', previews)
    const scene = display._anchor_activity_scene
    if (!isDict(scene)) return display
    const finalAnswer = typeof scene.final_answer === 'string' ? scene.final_answer : ''
    const final = withDiagramDisplay(scene, finalAnswer, 'final_answer_display', 'final_answer_diagram_previews', previews)
    const rows = withSceneRowDiagramPreviews(scene.activity_rows, previews)
    if (final === scene && rows === scene.activity_rows) return display
    return { ...display, _anchor_activity_scene: { ...final, activity_rows: rows } }
  })
}

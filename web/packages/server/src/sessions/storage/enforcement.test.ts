import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps session file access inside the storage adapter', () => {
  const root = join(import.meta.dirname, '../..')
  const violations: string[] = []
  const scan = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const name = relative(root, path)
      if (name.startsWith('sessions/storage') || name.startsWith('test/') || entry.name.endsWith('.test.ts')) continue
      if (entry.isDirectory()) { scan(path); continue }
      if (!entry.name.endsWith('.ts')) continue
      violations.push(...sourceViolations(name, readFileSync(path, 'utf8')))
    }
  }
  scan(root)
  expect(violations).toEqual([])
})

function sourceViolations(name: string, text: string): string[] {
  const violations: string[] = []
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && /(?:store|sessionStore)$/.test(node.expression.getText(source)) && ['pathFor', 'sessionDir', 'indexFile'].includes(node.name.text)) violations.push(`${name}: ${node.getText(source)}`)
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /_index\.json|_deleted_webui_sessions|\.json\.bak/.test(node.getText(source))) violations.push(`${name}: ${node.getText(source)}`)
    // These two document owners remain outside the session backend until TAL-1065.
    if (!['sessions/drafts.ts', 'sessions/background-tasks.ts'].includes(name)) {
      const sessionId = (expression: ts.Node): boolean => /\b(?:sid|sessionId|session_id)\b/.test(expression.getText(source))
      const template = ts.isTemplateExpression(node) && /\.json(?:\.bak)?$/.test(node.templateSpans.at(-1)?.literal.text ?? '') && node.templateSpans.some((span) => sessionId(span.expression))
      const concatenated = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(node.right) && /^\.json(?:\.bak)?$/.test(node.right.text) && sessionId(node.left)
      if (template || concatenated) violations.push(`${name}: ${node.getText(source)}`)
    }
    if (name === 'sessions/store.ts' && ts.isImportDeclaration(node) && /node:(fs|path)/.test(node.moduleSpecifier.getText(source))) violations.push(`${name}: filesystem import`)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

it.each([
  'readFileSync(join(directory, `${sid}.json`))',
  "writeFileSync(join(directory, sessionId + '.json'), '{}')",
  "readFileSync('_index.json')",
  "readFileSync('_deleted_webui_sessions.json')",
  'rmSync(`${store.pathFor(sid)}.bak`)',
  'readFileSync(store.indexFile)',
  'readdirSync(store.sessionDir)',
])('rejects a reintroduced session file access: %s', (source) => {
  expect(sourceViolations('sessions/rogue.ts', source)).not.toEqual([])
})

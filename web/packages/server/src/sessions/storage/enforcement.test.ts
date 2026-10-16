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
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
      const visit = (node: ts.Node): void => {
        if (ts.isPropertyAccessExpression(node) && /(?:store|sessionStore)$/.test(node.expression.getText(source)) && ['pathFor', 'sessionDir', 'indexFile'].includes(node.name.text)) violations.push(`${name}: ${node.getText(source)}`)
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node)) && /_index\.json|_deleted_webui_sessions|\.json\.bak/.test(node.getText(source))) violations.push(`${name}: ${node.getText(source)}`)
        if (name === 'sessions/store.ts' && ts.isImportDeclaration(node) && /node:(fs|path)/.test(node.moduleSpecifier.getText(source))) violations.push(`${name}: filesystem import`)
        ts.forEachChild(node, visit)
      }
      visit(source)
    }
  }
  scan(root)
  expect(violations).toEqual([])
})

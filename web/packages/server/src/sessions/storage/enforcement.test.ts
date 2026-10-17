import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { expect, it } from 'vitest'

it('keeps Web-owned state file access inside the storage adapter', () => {
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
    {
      const sessionId = (expression: ts.Node): boolean => /\b(?:sid|sessionId|session_id)\b/.test(expression.getText(source))
      const template = ts.isTemplateExpression(node) && /\.json(?:\.bak)?$/.test(node.templateSpans.at(-1)?.literal.text ?? '') && node.templateSpans.some((span) => sessionId(span.expression))
      const concatenated = ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken && ts.isStringLiteral(node.right) && /^\.json(?:\.bak)?$/.test(node.right.text) && sessionId(node.left)
      if (template || concatenated) violations.push(`${name}: ${node.getText(source)}`)
    }
    const noFileOwners = ['settings.ts', 'projects.ts', 'auth/store.ts', 'auth/passkeys.ts', 'sessions/drafts.ts', 'sessions/background-tasks.ts', 'tools/update-notifications.ts']
    if (noFileOwners.includes(name) && ts.isImportDeclaration(node) && /node:(fs|path)/.test(node.moduleSpecifier.getText(source))) violations.push(`${name}: document owner imports the filesystem`)
    if (ts.isPropertyAccessExpression(node) && /(?:journal|drafts)$/.test(node.expression.getText(source)) && ['path', 'pathFor', 'dir', 'root', 'sessionDir'].includes(node.name.text)) violations.push(`${name}: ${node.getText(source)}`)
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'settingsFile') violations.push(`${name}: settings file access`)
    if (ts.isCallExpression(node) && /(?:join|resolve|readFile(?:Sync)?|writeFile(?:Sync)?|atomicWrite(?:Text|SecretJson)|unlink(?:Sync)?|rm(?:Sync)?|open(?:Sync)?)$/.test(node.expression.getText(source))) {
      const owned = /(?:^|[/\\])(?:settings\.json|projects\.json|workspaces\.json|last_workspace\.txt|passkeys\.json|\.passkey_challenges\.json|\.sessions\.json|\.login_attempts\.json|\.pbkdf2_key|\.signing_key|\.quota_scope_id|\.talaria-relay-profile-id|talaria-relay[^/\\]*|deleted-profiles\.json|update-notifications\.json|extension-overrides\.json|extension-install-manifest\.json|recovery_stamping_since|_drafts|_background|_wakeup_held\.json|_run_journal|_turn_journal)(?:$|[/\\])/
      const containsOwned = (value: ts.Node): boolean => {
        if (ts.isStringLiteralLike(value)) return owned.test(value.text)
        if (ts.isTemplateExpression(value)) return /talaria-relay|_run_journal|_turn_journal/.test(value.getText(source))
        return ts.forEachChild(value, (child) => containsOwned(child) ? true : undefined) === true
      }
      // Config exposes a location for diagnostics and old callers; it performs no file access through it.
      const locationOnly = name === 'config.ts' && ts.isPropertyAssignment(node.parent) && node.parent.name.getText(source) === 'settingsFile'
      if (!locationOnly && node.arguments.some(containsOwned)) violations.push(`${name}: ${node.getText(source)}`)
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

it.each([
  "readFileSync(join(stateDir, 'settings.json'))",
  "atomicWriteText(join(stateDir, 'projects.json'), '{}')",
  "join(stateDir, 'sessions', '_drafts', 'session.json')",
  "join(stateDir, 'talaria-relay-deleted.json')",
  "join(home, '.talaria-relay-profile-id')",
  "join(stateDir, '.quota_scope_id')",
  "readFileSync(config.settingsFile)",
  "journal.pathFor(sid, stream)",
])('rejects reintroduced document or journal access: %s', (source) => {
  expect(sourceViolations('sessions/rogue.ts', source)).not.toEqual([])
})

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parseSync, visitorKeys, type Node } from 'oxc-parser'
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
  const { program, errors } = parseSync(name, text)
  // A file that fails to parse has no nodes left to check, so it must not pass as clean.
  if (errors.length > 0) throw new Error(`${name}: ${errors.map((error) => error.message).join('; ')}`)
  const source = (node: { start: number, end: number }): string => text.slice(node.start, node.end)
  const children = (node: Node): Node[] => (visitorKeys[node.type] ?? []).flatMap((key) => (node as unknown as Record<string, Node | (Node | null)[] | null>)[key] ?? []).filter((child) => child !== null)
  const stringValue = (node: Node): string | undefined => node.type === 'Literal' && typeof node.value === 'string' ? node.value : undefined
  const memberName = (node: Node): string | undefined => node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' ? node.property.name : undefined
  const visit = (node: Node, parent?: Node): void => {
    const member = memberName(node)
    if (node.type === 'MemberExpression' && member !== undefined && /(?:store|sessionStore)$/.test(source(node.object)) && ['pathFor', 'sessionDir', 'indexFile'].includes(member)) violations.push(`${name}: ${source(node)}`)
    if ((stringValue(node) !== undefined || node.type === 'TemplateLiteral') && /_index\.json|_deleted_webui_sessions|\.json\.bak/.test(source(node))) violations.push(`${name}: ${source(node)}`)
    {
      const sessionId = (expression: Node): boolean => /\b(?:sid|sessionId|session_id)\b/.test(source(expression))
      const template = node.type === 'TemplateLiteral' && /\.json(?:\.bak)?$/.test(node.quasis.at(-1)?.value.cooked ?? '') && node.expressions.some(sessionId)
      const concatenated = node.type === 'BinaryExpression' && node.operator === '+' && /^\.json(?:\.bak)?$/.test(stringValue(node.right) ?? '') && sessionId(node.left)
      if (template || concatenated) violations.push(`${name}: ${source(node)}`)
    }
    const noFileOwners = ['settings.ts', 'projects.ts', 'auth/store.ts', 'auth/passkeys.ts', 'sessions/drafts.ts', 'sessions/background-tasks.ts', 'tools/update-notifications.ts']
    if (noFileOwners.includes(name) && node.type === 'ImportDeclaration' && /node:(fs|path)/.test(source(node.source))) violations.push(`${name}: document owner imports the filesystem`)
    if (node.type === 'MemberExpression' && member !== undefined && /(?:journal|drafts)$/.test(source(node.object)) && ['path', 'pathFor', 'dir', 'root', 'sessionDir'].includes(member)) violations.push(`${name}: ${source(node)}`)
    if (member === 'settingsFile') violations.push(`${name}: settings file access`)
    if (node.type === 'CallExpression' && /(?:join|resolve|readFile(?:Sync)?|writeFile(?:Sync)?|atomicWrite(?:Text|SecretJson)|unlink(?:Sync)?|rm(?:Sync)?|open(?:Sync)?)$/.test(source(node.callee))) {
      const owned = /(?:^|[/\\])(?:settings\.json|projects\.json|workspaces\.json|last_workspace\.txt|passkeys\.json|\.passkey_challenges\.json|\.sessions\.json|\.login_attempts\.json|\.pbkdf2_key|\.signing_key|\.quota_scope_id|\.talaria-relay-profile-id|talaria-relay[^/\\]*|deleted-profiles\.json|update-notifications\.json|extension-overrides\.json|extension-install-manifest\.json|recovery_stamping_since|_drafts|_background|_wakeup_held\.json|_run_journal|_turn_journal)(?:$|[/\\])/
      const containsOwned = (value: Node): boolean => {
        const literal = value.type === 'TemplateLiteral' && value.expressions.length === 0 ? value.quasis[0]?.value.cooked ?? '' : stringValue(value)
        if (literal !== undefined) return owned.test(literal)
        if (value.type === 'TemplateLiteral') return /talaria-relay|_run_journal|_turn_journal/.test(source(value))
        return children(value).some(containsOwned)
      }
      // Config exposes a location for diagnostics and old callers; it performs no file access through it.
      const locationOnly = name === 'config.ts' && parent?.type === 'Property' && source(parent.key) === 'settingsFile'
      if (!locationOnly && node.arguments.some(containsOwned)) violations.push(`${name}: ${source(node)}`)
    }
    if (name === 'sessions/store.ts' && node.type === 'ImportDeclaration' && /node:(fs|path)/.test(source(node.source))) violations.push(`${name}: filesystem import`)
    for (const child of children(node)) visit(child, node)
  }
  visit(program)
  return violations
}

it.each([
  'readFileSync(join(directory, `${sid}.json`))',
  "writeFileSync(join(directory, sessionId + '.json'), '{}')",
  "const path = sessionId + '.json'",
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

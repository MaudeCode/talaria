import { describe, expect, it } from 'vitest'
import { normalizeChangedPath, turnFileChanges } from './file-changes.js'

const call = (name: string, args: unknown) => ({ tool: { name, args } })

describe('turnFileChanges', () => {
  it.each([
    ['create_file', 'added'],
    ['write_file', 'edited'], ['patch', 'edited'], ['edit_file', 'edited'], ['mcp_filesystem_write_file', 'edited'], ['mcp_filesystem_edit_file', 'edited'],
    ['remove_file', 'deleted'], ['delete_file', 'deleted'], ['mcp_filesystem_remove_file', 'deleted'],
    ['move_file', 'renamed'], ['rename_file', 'renamed'], ['mcp_filesystem_move_file', 'renamed'],
    [' Write_File ', 'edited'],
  ])('%s is %s', (name, action) => {
    expect(turnFileChanges([call(name, { path: 'a.swift' })])).toEqual([{ path: 'a.swift', action }])
  })

  it.each(['read_file', 'terminal', 'search_files', 'list_directory', 'mcp_filesystem_read_file', '', 'constructor'])('%s changes nothing', (name) => {
    expect(turnFileChanges([call(name, { path: 'a.swift', command: 'ls' })])).toEqual([])
  })

  it('reads every path argument, the paths list and each edit\'s path, in order', () => {
    expect(turnFileChanges([
      call('write_file', { path: 'Sources/App.swift', file_path: 'b.swift', filename: 'c.swift', paths: ['d.txt', 7, 'e.txt'], edits: [{ path: 'x/one.swift' }, { start: 1 }, 'bad'] }),
      call('edit_file', { file_path: 'README.md' }),
    ]).map((c) => c.path)).toEqual(['Sources/App.swift', 'b.swift', 'c.swift', 'd.txt', 'e.txt', 'x/one.swift', 'README.md'])
  })

  it('attributes a rename to its destination only', () => {
    expect(turnFileChanges([call('rename_file', { source: 'old/name.swift', destination: 'new/name.swift' })])).toEqual([{ path: 'new/name.swift', action: 'renamed' }])
    expect(turnFileChanges([call('move_file', { source: 'a', path: 'b' })])).toEqual([{ path: 'b', action: 'renamed' }])
    expect(turnFileChanges([call('move_file', { source: 'a' })])).toEqual([])
  })

  it('keeps one entry per path at its first position, with the strongest action', () => {
    expect(turnFileChanges([
      call('write_file', { path: 'a.swift' }), call('create_file', { path: 'b.swift' }),
      call('create_file', { path: './a.swift' }), call('edit_file', { path: 'b.swift' }),
    ])).toEqual([{ path: 'a.swift', action: 'added' }, { path: 'b.swift', action: 'added' }])
  })

  it('skips calls without argument objects and non-string paths', () => {
    expect(turnFileChanges([call('write_file', null), call('write_file', '{"path":"a"}'), call('write_file', { path: 42 }), {}])).toEqual([])
  })

  it('drops generated and vendored trees', () => {
    const paths = ['node_modules/lib/index.js', '.git/config', 'dist/bundle.js', 'build/output.o', '.venv/lib/site.py', 'pkg/__pycache__/mod.pyc', 'src/keep.swift']
    expect(turnFileChanges(paths.map((path) => call('write_file', { path })))).toEqual([{ path: 'src/keep.swift', action: 'edited' }])
  })
})

describe('normalizeChangedPath', () => {
  it.each([
    ['~/Sources/App.swift', 'Sources/App.swift'], ['./README.md', 'README.md'], ['././nested/file.swift', 'nested/file.swift'],
    ['"quoted.swift"', 'quoted.swift'], ['`code.swift`', 'code.swift'], ['  spaced.swift  ', 'spaced.swift'], ['/abs/path.swift', '/abs/path.swift'],
  ])('%s is %s', (raw, path) => {
    expect(normalizeChangedPath(raw)).toBe(path)
  })

  it.each(['https://example.com/x.swift', '', '   ', 'a'.repeat(241)])('drops %s', (raw) => {
    expect(normalizeChangedPath(raw)).toBeNull()
  })
})

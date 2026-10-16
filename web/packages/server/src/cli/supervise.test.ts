import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RESTART_EXIT_CODE, supervise } from './supervise.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(mode: 'before-ready' | 'after-ready' | 'no-marker' | 'restored-crash' | 'retry' | 'newer-update') {
  const root = mkdtempSync(join(tmpdir(), 'talaria-supervise-'))
  roots.push(root)
  const packageRoot = join(root, '@maudecode/talaria-web')
  const previous = join(dirname(packageRoot), '.talaria-web-previous')
  const stateDir = join(root, 'state')
  const marker = join(stateDir, 'update-rollback.json')
  mkdirSync(packageRoot, { recursive: true })
  mkdirSync(previous)
  mkdirSync(stateDir)
  writeFileSync(join(packageRoot, 'version'), '2.0.0')
  writeFileSync(join(previous, 'version'), '1.0.0')
  const count = join(root, 'count')
  // The initial worker requests a restart; subsequent workers load whichever package is on disk.
  const script = `
    const fs = require('node:fs');
    const paths = ${JSON.stringify({ count, marker, packageRoot, previous })};
    const mode = ${JSON.stringify(mode)};
    const n = fs.existsSync(paths.count) ? Number(fs.readFileSync(paths.count)) : 0;
    fs.writeFileSync(paths.count, String(n + 1));
    if (n === 0) {
      if (mode !== 'no-marker') fs.writeFileSync(paths.marker, JSON.stringify({
        version: '2.0.0', previousVersion: '1.0.0', ...(mode === 'retry' ? { failedVersion: '2.0.0' } : {})
      }));
      process.exit(${String(RESTART_EXIT_CODE)});
    }
    const old = fs.readFileSync(paths.packageRoot + '/version', 'utf8') === '1.0.0';
    if (old && mode === 'newer-update' && n === 2) {
      process.send('ready', () => {
        fs.renameSync(paths.packageRoot, paths.previous);
        fs.mkdirSync(paths.packageRoot);
        fs.writeFileSync(paths.packageRoot + '/version', '3.0.0');
        fs.writeFileSync(paths.marker, JSON.stringify({ version: '3.0.0', previousVersion: '1.0.0' }));
        process.exit(${String(RESTART_EXIT_CODE)});
      });
    } else if (mode === 'after-ready' || mode === 'retry' || (old && mode !== 'restored-crash')) {
      if (!process.send) process.exit(9);
      process.send('ready', () => { process.disconnect(); process.exit(old ? 4 : 3); });
    } else process.exit(old ? 4 : 3);
  `
  const lines: string[] = []
  const run = () => supervise({ command: [process.execPath, '-e', script], env: process.env, log: (line) => lines.push(line), restartDelayMs: 0, packageRoot, stateDir })
  return { packageRoot, previous, marker, count, lines, run }
}

describe('self-update startup rollback', () => {
  it('restores the previous package and respawns once after a crash before ready', async () => {
    const f = fixture('before-ready')
    expect(await f.run()).toBe(4)
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('1.0.0')
    expect(readFileSync(join(dirname(f.packageRoot), '.talaria-web-failed/version'), 'utf8')).toBe('2.0.0')
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({ version: '2.0.0', previousVersion: '1.0.0', failedVersion: '2.0.0' })
    expect(readFileSync(f.count, 'utf8')).toBe('3')
    expect(f.lines).toContain('[serve] update to 2.0.0 failed to start; restored 1.0.0')
  })

  it('keeps the new package and clears the marker after ready, even if it then crashes', async () => {
    const f = fixture('after-ready')
    expect(await f.run()).toBe(3)
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('2.0.0')
    expect(existsSync(f.previous)).toBe(true)
    expect(existsSync(f.marker)).toBe(false)
  })

  it('exits normally when there is no rollback marker', async () => {
    const f = fixture('no-marker')
    expect(await f.run()).toBe(3)
    expect(readFileSync(f.count, 'utf8')).toBe('2')
  })

  it('exits after the restored worker crashes without looping', async () => {
    const f = fixture('restored-crash')
    expect(await f.run()).toBe(4)
    expect(readFileSync(f.count, 'utf8')).toBe('3')
  })

  it('can recover a later update after the restored worker becomes ready', async () => {
    const f = fixture('newer-update')
    expect(await f.run()).toBe(4)
    expect(readFileSync(f.count, 'utf8')).toBe('5')
    expect(readFileSync(join(f.packageRoot, 'version'), 'utf8')).toBe('1.0.0')
    expect(JSON.parse(readFileSync(f.marker, 'utf8'))).toEqual({ version: '3.0.0', previousVersion: '1.0.0', failedVersion: '3.0.0' })
  })

  it('clears a failed-version record when a manual retry starts successfully', async () => {
    const f = fixture('retry')
    expect(await f.run()).toBe(3)
    expect(existsSync(f.marker)).toBe(false)
  })
})

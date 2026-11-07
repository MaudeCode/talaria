import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test as base, expect, type TestInfo } from '@playwright/test'
import globalSetup from './global-setup'

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

/** Another run's server: it holds a port and answers `/health`. */
async function holdPort() {
  const paths: (string | undefined)[] = []
  const server = createServer((req, res) => { paths.push(req.url); res.end('ok') })
  const url = `http://127.0.0.1:${String(await listen(server))}`
  return { url, port: new URL(url).port, paths, close: () => new Promise((resolve) => server.close(resolve)) }
}

const test = base.extend<{ held: Awaited<ReturnType<typeof holdPort>> }>({
  held: async ({}, runFixture) => {
    const held = await holdPort()
    await runFixture(held)
    await held.close()
  },
})

test.skip(({ isMobile }) => isMobile, 'Browserless: the desktop project owns it')

async function freeUrl() {
  const server = createServer()
  const port = await listen(server)
  await new Promise((resolve) => server.close(resolve))
  return `http://127.0.0.1:${String(port)}`
}

/** Disposable boot dirs from `server.ts`, which picks its root the same way. Parallel runs share it, so only a rejection this fast can compare it. */
const stateDirs = () => readdirSync(existsSync('/dev/shm') ? '/dev/shm' : tmpdir()).filter((name) => name.startsWith('hermes-e2e-'))
/** This run's handle file; a setup that reaches `saveHandles` overwrites it. */
const handleFile = () => readFileSync(join(tmpdir(), `hermes-e2e-${process.env.HERMES_E2E_PORT ?? '8797'}.json`), 'utf8')

/** Runs the real `globalSetup` against other ports, with `npm` replaced so it cannot rebuild this run's bundle. Returns the path npm leaves behind if called. */
async function setupRejection(testInfo: TestInfo, openUrl: string, authUrl: string) {
  const bin = testInfo.outputPath('bin')
  const npmRan = testInfo.outputPath('npm-ran')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\ntouch "${npmRan}"\n`)
  chmodSync(join(bin, 'npm'), 0o755)
  const saved = { PATH: process.env.PATH, HERMES_E2E_BASE_URL: process.env.HERMES_E2E_BASE_URL, HERMES_E2E_AUTH_BASE_URL: process.env.HERMES_E2E_AUTH_BASE_URL }
  Object.assign(process.env, { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HERMES_E2E_BASE_URL: openUrl, HERMES_E2E_AUTH_BASE_URL: authUrl })
  try {
    const error = await globalSetup().then(() => undefined, (err: unknown) => err)
    return { error, npmRan }
  } finally {
    Object.assign(process.env, saved)
  }
}

test('an occupied port fails the run without booting, building, or touching the listener', async ({ held }, testInfo) => {
  const dirs = stateDirs()
  const handles = handleFile()

  const { error, npmRan } = await setupRejection(testInfo, held.url, held.url)

  expect(String(error)).toContain(`port ${held.port} is already in use`)
  expect(String(error)).toContain('HERMES_E2E_PORT')
  expect(existsSync(npmRan)).toBe(false)
  expect(stateDirs().filter((dir) => !dirs.includes(dir))).toEqual([])
  expect(handleFile()).toBe(handles)
  expect(held.paths).toEqual([])
  expect((await fetch(`${held.url}/health`)).status).toBe(200)
})

test('an occupied second port stops the server already booted on the first', async ({ held }, testInfo) => {
  const open = await freeUrl()
  const handles = handleFile()

  const { error } = await setupRejection(testInfo, open, held.url)

  expect(String(error)).toContain(`port ${held.port} is already in use`)
  await expect.poll(() => fetch(`${open}/health`).then(() => 'up', () => 'down')).toBe('down')
  expect(handleFile()).toBe(handles)
})

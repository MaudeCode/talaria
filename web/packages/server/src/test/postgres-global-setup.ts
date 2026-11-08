/**
 * With `TALARIA_STORAGE=postgres`, the whole server suite shares one embedded Postgres (TAL-1067); every booted server
 * keeps its tables in a schema of its own, so suites stay isolated. Other runs start nothing.
 */
import type { TestProject } from 'vitest/node'
import { startTestPostgres, type TestPostgres } from './postgres.js'

declare module 'vitest' {
  export interface ProvidedContext { talariaPostgresUrl: string }
}

let postgres: TestPostgres | null = null

export async function setup(project: TestProject): Promise<void> {
  if (process.env.TALARIA_STORAGE !== 'postgres') { project.provide('talariaPostgresUrl', ''); return }
  postgres ??= await startTestPostgres()
  project.provide('talariaPostgresUrl', postgres.url)
}

export async function teardown(): Promise<void> {
  await postgres?.stop()
  postgres = null
}

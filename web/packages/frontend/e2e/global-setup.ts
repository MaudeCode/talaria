import { bootServer, saveHandles, stopHandles } from './server'

export const E2E_PASSWORD = 'e2e-password-123'

export default async function globalSetup(): Promise<void> {
  const open = await bootServer(process.env.HERMES_E2E_BASE_URL!)
  try {
    saveHandles([open, await bootServer(process.env.HERMES_E2E_AUTH_BASE_URL!, { HERMES_WEBUI_PASSWORD: E2E_PASSWORD })])
  } catch (err) {
    // No handle file exists yet, so teardown cannot stop this server; left running, it would fail every later run on this port.
    stopHandles([open])
    throw err
  }
}

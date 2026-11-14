import { bootServer, saveHandles, stopHandles } from './server'

export const E2E_PASSWORD = 'e2e-password-123'

export default async function globalSetup(): Promise<void> {
  // streamdown-copy.spec.ts loads this server as http://talaria.test (an insecure origin), like a LAN hostname install.
  const open = await bootServer(process.env.HERMES_E2E_BASE_URL!, { HERMES_WEBUI_ALLOWED_HOSTS: 'talaria.test' })
  try {
    saveHandles([open, await bootServer(process.env.HERMES_E2E_AUTH_BASE_URL!, { HERMES_WEBUI_PASSWORD: E2E_PASSWORD })])
  } catch (err) {
    // No handle file exists yet, so teardown cannot stop this server; left running, it would fail every later run on this port.
    stopHandles([open])
    throw err
  }
}

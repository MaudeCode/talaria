import { bootServer, saveHandles } from './server'

export const E2E_PASSWORD = 'e2e-password-123'

export default async function globalSetup(): Promise<void> {
  const open = await bootServer(process.env.HERMES_E2E_BASE_URL!)
  const auth = await bootServer(process.env.HERMES_E2E_AUTH_BASE_URL!, { HERMES_WEBUI_PASSWORD: E2E_PASSWORD })
  saveHandles([open, auth])
}

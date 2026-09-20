import { SIDECAR_RPC_VERSION } from '@maudecode/talaria-web-contracts'

/** The sidecar RPC version this server speaks; the sidecar refuses any other. */
export const SERVER_SIDECAR_RPC_VERSION: number = SIDECAR_RPC_VERSION

export { createApp, type App } from './app.js'
export { createDeps } from './runtime.js'
export { startServer } from './server.js'
export { loadConfig, type ServerConfig } from './config.js'
export { SettingsStore } from './settings.js'
export { AuthStore } from './auth/store.js'
export { StartupGate } from './startup.js'
export { SpaShell } from './spa.js'

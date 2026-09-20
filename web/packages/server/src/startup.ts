/**
 * Startup readiness gate (Python `api/startup.py`). Starts ready; the server
 * arms it before deferred recovery and releases it when recovery settles.
 * `/api/` requests wait a bounded time, with a bounded number of waiters.
 */
export const STARTUP_WAIT_SECONDS = 10
export const STARTUP_WAIT_SLOT_COUNT = 8
export const STARTUP_RECOVERY_CONDITION = 'startup_recovery'
export const STARTUP_IMMEDIATE_PATHS = new Set(['/api/health/restart', '/api/csp-report'])

export class StartupGate {
  ready = true
  phase = 'session recovery'
  private waiters = 0
  private resolvers: (() => void)[] = []

  arm(phase = 'session recovery'): void {
    this.ready = false
    this.phase = phase
  }

  release(): void {
    this.ready = true
    const pending = this.resolvers
    this.resolvers = []
    for (const resolve of pending) resolve()
  }

  /** `true` when the request may proceed; `false` when it should get the startup 503. */
  async wait(timeoutMs = STARTUP_WAIT_SECONDS * 1000): Promise<boolean> {
    if (this.ready) return true
    if (this.waiters >= STARTUP_WAIT_SLOT_COUNT) return false
    this.waiters += 1
    try {
      return await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => { resolve(this.ready) }, timeoutMs)
        this.resolvers.push(() => { clearTimeout(timer); resolve(true) })
      })
    } finally {
      this.waiters -= 1
    }
  }
}

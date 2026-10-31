import { showToast } from './toast'

/** The existing error toast for a failed request: its message, or the value as text, after an optional prefix. */
export function showErrorToast(error: unknown, prefix = ''): void {
  showToast(prefix + (error instanceof Error ? error.message : String(error)), 4000, 'error')
}

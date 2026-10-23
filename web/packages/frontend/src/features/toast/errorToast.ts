import { showToast } from './toast'

/** The existing error toast for a failed request: its message, or the value as text. */
export function showErrorToast(error: unknown): void {
  showToast(error instanceof Error ? error.message : String(error), 4000, 'error')
}

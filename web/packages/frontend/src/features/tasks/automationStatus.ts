import { m } from '../../paraglide/messages.js'
import type { PromptQueueRun, PromptQueueCard } from '@maudecode/talaria-web-contracts'
import type { CronState } from './cronJob'

export function statusLabel(state: CronState | PromptQueueRun['phase'] | PromptQueueCard['status']): { label: string; tone: string } {
  switch (state) {
    case 'draft': return { label: m.prompt_queue_draft(), tone: 'text-muted' }
    case 'dispatching': return { label: m.prompt_queue_dispatching(), tone: 'text-muted' }
    case 'waiting': return { label: m.prompt_queue_waiting(), tone: 'text-muted' }
    case 'completed': return { label: m.prompt_queue_completed(), tone: 'text-success' }
    case 'cancelled': return { label: m.prompt_queue_cancelled(), tone: 'text-muted' }
    case 'unknown': return { label: m.prompt_queue_unknown(), tone: 'text-warning' }
    case 'failed': return { label: m.prompt_queue_failed(), tone: 'text-error' }
    case 'refused': return { label: m.prompt_queue_refused(), tone: 'text-error' }
    case 'running': return { label: m.cron_status_running(), tone: 'text-accent-text' }
    case 'needs_attention': case 'schedule_error': return { label: m.cron_status_needs_attention(), tone: 'text-warning' }
    case 'paused': return { label: m.cron_status_paused(), tone: 'text-muted' }
    case 'off': return { label: m.cron_status_off(), tone: 'text-muted' }
    case 'error': return { label: m.cron_status_error(), tone: 'text-error' }
    case 'active': return { label: m.cron_status_active(), tone: 'text-success' }
    default: return { label: '', tone: 'text-muted' }
  }
}

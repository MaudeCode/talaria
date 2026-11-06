import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { m } from '../../paraglide/messages.js'
import { Button } from '../../ui/Button'
import { HelpTip } from '../../ui/Field'
import { showErrorToast } from '../toast/errorToast'
import { showToast } from '../toast/toast'

/** TAL-1627: restart only when the server says Web controls the monitored Gateway; otherwise its reason, read-only. An older server sends no capability, so nothing is offered. */
export function GatewayRestart() {
  const qc = useQueryClient()
  const agent = useQuery({ queryKey: keys.health.agent, queryFn: api.fetchAgentHealth, staleTime: 15_000 })
  // A refused restart (TAL-1627) rereads the capability, so the control disappears with the error. A finished one may settle a required restart (TAL-1828).
  const restart = useMutation({ mutationFn: api.restartAgent, onSuccess: () => { showToast(m.saved()) }, onError: (e) => showErrorToast(e), onSettled: () => { void qc.invalidateQueries({ queryKey: keys.health.agent }); void qc.invalidateQueries({ queryKey: keys.settings }) } })
  const lifecycle = agent.data?.gateway_lifecycle
  if (lifecycle?.managed === true) return <Button onClick={() => restart.mutate()} disabled={restart.isPending}>{m.system_restart_agent()}</Button>
  if (!lifecycle) return null
  return (
    <HelpTip label={m.system_gateway_restart_unavailable()}>
      {lifecycle.reason === 'external_gateway' ? m.system_gateway_external()
        : lifecycle.start_command ? <>{m.system_gateway_start_once()}<code className="mt-1 block break-words font-mono">{lifecycle.start_command}</code></>
          : m.system_gateway_unconfirmed()}
    </HelpTip>
  )
}

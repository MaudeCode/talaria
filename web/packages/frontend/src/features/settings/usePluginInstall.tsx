import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { PluginInstallResult } from '@maudecode/talaria-web-contracts'
import { m } from '../../paraglide/messages.js'
import * as api from '../../api/endpoints'
import { keys } from '../../api/queryKeys'
import { ConfirmDialog } from '../../ui/Dialog'
import { showToast } from '../toast/toast'
import { getStreamContext, useStreamContext } from '../../stream/connection'

/** The reviewed catalog install: preview, consent, install, read back. Shared by the Plugins catalog and a provider's card. */
export function usePluginInstall() {
  const qc = useQueryClient()
  const [result, setResult] = useState<{ context: object; value: PluginInstallResult } | null>(null)
  const streamContext = useStreamContext()
  const active = useRef(false)
  // An installed provider plugin joins the provider cards and the picker.
  const refresh = async () => { await Promise.all([keys.plugins, keys.pluginCatalog, keys.providers, keys.models].map((queryKey) => qc.invalidateQueries({ queryKey }))) }
  const install = useMutation({
    mutationFn: async ({ name, token, context }: { name: string; token?: string; context: object }) => {
      if (context !== getStreamContext()) throw new Error(m.plugins_catalog_changed())
      return api.installPlugin(name, token)
    },
    retry: false,
    onSuccess: (value, variables) => {
      if (variables.context !== getStreamContext()) return
      setResult({ context: variables.context, value })
      if (value.status === 'installed') { showToast(m.plugins_catalog_installed()); void refresh() }
    },
    onError: (error, variables) => {
      if (variables.context !== getStreamContext()) return
      showToast(error instanceof Error ? error.message : String(error), 10000, 'error')
      // Read back even after a lost acknowledgement. Never replay the non-idempotent install.
      void refresh()
    },
    onSettled: () => { active.current = false },
  })
  const request = (name: string, token?: string) => {
    if (active.current) return
    active.current = true
    setResult(null)
    install.mutate({ name, ...(token ? { token } : {}), context: getStreamContext() })
  }
  const current = result?.context === streamContext ? result.value : null
  const consent = <ConfirmDialog open={current?.status === 'needs_consent'} onOpenChange={(open) => { if (!open) setResult(null) }} title={m.plugins_catalog_install()} description={current?.status === 'needs_consent' ? current.findings : undefined} confirmLabel={m.plugins_catalog_install()} cancelLabel={m.cancel()}
    onConfirm={() => { if (current?.status === 'needs_consent') request(current.name, current.consent_token) }} />
  return {
    request,
    consent,
    isInstalling: (name: string) => install.isPending && install.variables.name === name,
    blocked: (name: string) => (current?.name === name && current.status === 'blocked' ? <p role="alert" className="mt-2 whitespace-pre-line text-xs text-error [overflow-wrap:anywhere]">{current.findings}</p> : null),
  }
}

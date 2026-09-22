import { useCallback } from 'react'
import * as api from '../../api/endpoints'
import { appUrl } from '../../lib/appRoot'
import { removePersistedByPrefix } from '../../lib/persisted'

export function useLogout() {
  return useCallback(async () => {
    try {
      await api.logout()
    } finally {
      removePersistedByPrefix('hermes-boot:')
      removePersistedByPrefix('hermes-webui-session')
      window.location.assign(appUrl('login').href)
    }
  }, [])
}

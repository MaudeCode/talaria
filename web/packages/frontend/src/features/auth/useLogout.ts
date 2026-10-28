import { teardownAll } from '../../stream/connection'
import * as api from '../../api/endpoints'
import { appUrl } from '../../lib/appRoot'
import { resetIdentityCache } from '../../api/queryClient'

export function useLogout() {
  return async () => {
    await api.logout().finally(() => {
      teardownAll()
      resetIdentityCache()
      window.location.assign(appUrl('login').href)
    })
  }
}

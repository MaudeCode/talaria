import type { Bootstrap } from '@maudecode/talaria-web-contracts'
export { BootstrapSchema, type Bootstrap } from '@maudecode/talaria-web-contracts'

export function isAuthenticated(b: Bootstrap): boolean {
  return !b.auth.auth_enabled || b.auth.logged_in
}

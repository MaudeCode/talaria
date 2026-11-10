import { createFileRoute, redirect } from '@tanstack/react-router'

/** TAL-2101: Logs is a Settings section; bookmarks and older links land there, search included. */
export const Route = createFileRoute('/_app/logs')({
  beforeLoad: ({ search }) => { throw redirect({ to: '/settings/$section', params: { section: 'logs' }, search, replace: true }) },
})

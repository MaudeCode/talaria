import { createFileRoute, redirect } from '@tanstack/react-router'

/** TAL-2101: Spaces is a Settings section; bookmarks and older links land there, search included. */
export const Route = createFileRoute('/_app/workspaces')({
  beforeLoad: ({ search }) => { throw redirect({ to: '/settings/$section', params: { section: 'workspaces' }, search, replace: true }) },
})

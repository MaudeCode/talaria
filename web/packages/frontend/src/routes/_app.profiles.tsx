import { createFileRoute, redirect } from '@tanstack/react-router'

/** TAL-2101: Profiles is a Settings section; bookmarks and older links land there, search included. */
export const Route = createFileRoute('/_app/profiles')({
  beforeLoad: ({ search }) => { throw redirect({ to: '/settings/$section', params: { section: 'profiles' }, search, replace: true }) },
})

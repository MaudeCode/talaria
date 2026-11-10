import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'
import { ToolsTabSchema } from '../contracts/url'

/** TAL-2100: the retired Agent section. Its tabs live on Tools, except Extensions, now a section of its own. */
export const Route = createFileRoute('/_app/settings/agent')({
  validateSearch: z.object({ tab: z.string().optional().catch(undefined) }),
  beforeLoad: ({ search }) => {
    if (search.tab === 'extensions') throw redirect({ to: '/settings/$section', params: { section: 'extensions' }, replace: true })
    const tab = ToolsTabSchema.safeParse(search.tab)
    throw redirect({ to: '/settings/$section', params: { section: 'tools' }, search: tab.success ? { tab: tab.data } : {}, replace: true })
  },
})

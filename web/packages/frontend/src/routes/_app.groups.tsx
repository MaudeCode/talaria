import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'
import { GroupIdSchema } from '@maudecode/talaria-web-contracts'
import { GroupsPage } from '../features/groups/GroupsPage'

export const Route = createFileRoute('/_app/groups')({
  validateSearch: z.object({ room: GroupIdSchema.optional() }),
  component: Page,
})
function Page() { return <GroupsPage roomId={Route.useSearch().room} /> }

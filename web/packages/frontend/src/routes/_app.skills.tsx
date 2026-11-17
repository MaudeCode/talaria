import { createFileRoute } from '@tanstack/react-router'
import { HubRoute } from '../features/hub/HubRoute'
import { SkillsSearchSchema } from '../contracts/url'

export const Route = createFileRoute('/_app/skills')({
  validateSearch: SkillsSearchSchema,
  component: function SkillsRoute() {
    const { skill } = Route.useSearch()
    return <HubRoute panel="skills" skill={skill} />
  },
})

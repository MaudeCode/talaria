import { createFileRoute, redirect } from '@tanstack/react-router'
import { LoginSearchSchema } from '../contracts/url'
import { isAuthenticated } from '../contracts/bootstrap'
import { LoginPage } from '../features/auth/LoginPage'

export const Route = createFileRoute('/login')({
  validateSearch: LoginSearchSchema,
  beforeLoad: ({ context }) => {
    if (isAuthenticated(context.bootstrap)) throw redirect({ to: '/' })
  },
  component: LoginRoutePage,
})

function LoginRoutePage() {
  const { next } = Route.useSearch()
  return <LoginPage next={next} />
}

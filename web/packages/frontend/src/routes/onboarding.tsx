import { createFileRoute, redirect } from '@tanstack/react-router'
import { isAuthenticated } from '../contracts/bootstrap'
import { OnboardingPage } from '../features/onboarding/OnboardingPage'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: ({ context, location }) => {
    if (!isAuthenticated(context.bootstrap)) throw redirect({ to: '/login', search: { next: location.pathname } })
  },
  component: OnboardingPage,
})

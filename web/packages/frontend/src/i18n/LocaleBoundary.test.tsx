import { act, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { m } from '../paraglide/messages.js'
import { LocaleBoundary } from './LocaleBoundary'
import { applyLocale } from './runtime'

function Label() { return <p data-testid="label">{m.loading()}</p> }

afterEach(async () => { await applyLocale('en', { persist: false }) })

it('shows compiled text in the new language after a locale switch', async () => {
  await applyLocale('en', { persist: false })
  render(<LocaleBoundary><Label /></LocaleBoundary>)
  expect(screen.getByTestId('label')).toHaveTextContent(m.loading({}, { locale: 'en' }))
  await act(async () => { await applyLocale('de', { persist: false }) })
  expect(screen.getByTestId('label')).toHaveTextContent(m.loading({}, { locale: 'de' }))
})

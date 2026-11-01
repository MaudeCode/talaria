import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { alertForTransition, type AlertKind, type AlertPreferences } from './alerts.js'

// The relay applies the same vectors (relay/tests/notificationAlerts.test.ts), so the rule cannot drift.
interface Vector { name: string; previous: string | null; next: string; alertEligible: boolean; preferences: AlertPreferences; expected: AlertKind | null }
const { vectors } = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../../../contracts/fixtures/notification-alerts.json'), 'utf8')) as { vectors: Vector[] }

it.each(vectors)('shared alert rule: $name', (vector) => {
  expect(alertForTransition(vector.previous, { phase: vector.next, alertEligible: vector.alertEligible }, vector.preferences)).toBe(vector.expected)
})

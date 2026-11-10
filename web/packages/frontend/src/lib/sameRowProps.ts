import { replaceEqualDeep } from '@tanstack/react-query'

/** `memo`'s compare for a row whose list is a new server answer per filter (TAL-2127, TAL-2129): `field` compares by value, every other prop by identity. */
export const sameRowProps = <P extends object>(field: keyof P) => (a: P, b: P) =>
  (Object.keys(b) as (keyof P)[]).every((k) => k === field ? replaceEqualDeep(a[k], b[k]) === a[k] : Object.is(a[k], b[k]))

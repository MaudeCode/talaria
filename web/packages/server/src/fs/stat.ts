import { statSync, type BigIntStats } from 'node:fs'
import { stat } from 'node:fs/promises'

/** The revision identity of the file at `path`; one format for path stats and open-descriptor fstats. */
export function signatureOf(path: string, st: BigIntStats): string {
  return `${path}:${st.mtimeNs}:${st.size}:${st.ctimeNs}`
}

export function statSignature(path: string): string | null {
  try {
    return signatureOf(path, statSync(path, { bigint: true }))
  } catch {
    return null
  }
}

export async function statSignatureAsync(path: string): Promise<string | null> {
  try {
    return signatureOf(path, await stat(path, { bigint: true }))
  } catch {
    return null
  }
}

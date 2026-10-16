import { statSync } from 'node:fs'
export function statSignature(path: string): string | null {
  try {
    const st = statSync(path, { bigint: true })
    return `${path}:${st.mtimeNs}:${st.size}:${st.ctimeNs}`
  } catch {
    return null
  }
}

/**
 * Python `_persistent_state_snapshot` / `_persistent_state_changes`: lightweight memory and skill file signatures
 * taken before and after a turn so the stream can toast `state_saved` when the agent wrote them.
 */
import { statSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { walkSkillFiles } from '../tools/skills.js'

export interface PersistentStateSnapshot { memory: Record<string, string>; skills: Record<string, string> }

const MEMORY_FILES: [string, string[]][] = [['memory', ['memories', 'MEMORY.md']], ['user', ['memories', 'USER.md']], ['soul', ['SOUL.md']]]

function fileSignature(path: string): string | null {
  try { const st = statSync(path, { bigint: true }); return `${st.mtimeNs}:${st.size}` } catch { return null }
}

export function persistentStateSnapshot(profileHome: string | null): PersistentStateSnapshot {
  const out: PersistentStateSnapshot = { memory: {}, skills: {} }
  if (!profileHome) return out
  for (const [key, parts] of MEMORY_FILES) { const sig = fileSignature(join(profileHome, ...parts)); if (sig !== null) out.memory[key] = sig }
  const skillsDir = join(profileHome, 'skills')
  for (const file of walkSkillFiles(skillsDir)) { const sig = fileSignature(file); if (sig !== null) out.skills[relative(skillsDir, file).replaceAll('\\', '/')] = sig }
  return out
}

export function persistentStateChanges(before: PersistentStateSnapshot, after: PersistentStateSnapshot): { memory_saved: boolean; skills: { name: string; path: string; action: 'created' | 'updated' }[] } {
  const memorySaved = Object.entries(after.memory).some(([key, sig]) => before.memory[key] !== sig)
  const skills: { name: string; path: string; action: 'created' | 'updated' }[] = []
  for (const [rel, sig] of Object.entries(after.skills)) {
    const old = before.skills[rel]
    if (old === sig) continue
    const parent = basename(dirname(rel))
    skills.push({ name: parent && parent !== '.' ? parent : basename(rel, '.md'), path: rel, action: old === undefined ? 'created' : 'updated' })
  }
  return { memory_saved: memorySaved, skills: skills.slice(0, 10) }
}

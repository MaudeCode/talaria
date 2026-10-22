/**
 * Python `_persistent_state_snapshot` / `_persistent_state_changes`: lightweight memory and skill file signatures
 * taken before and after a turn so the stream can toast `state_saved` when the agent wrote them.
 */
import { lstat, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { walkSkillFiles } from '../tools/skills.js'

export interface PersistentStateSnapshot { memory: Record<string, string>; skills: Record<string, string> }

const MEMORY_FILES: [string, string[]][] = [['memory', ['memories', 'MEMORY.md']], ['user', ['memories', 'USER.md']], ['soul', ['SOUL.md']]]
const skillInventories = new Map<string, { files: string[]; directories: Map<string, string | null> }>()

async function fileSignature(path: string, followSymlinks = true): Promise<string | null> {
  try {
    const st = await (followSymlinks ? stat : lstat)(path, { bigint: true })
    if (!followSymlinks && st.isSymbolicLink()) return null
    return `${st.dev}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}:${st.size}`
  } catch { return null }
}

export async function persistentStateSnapshot(profileHome: string | null): Promise<PersistentStateSnapshot> {
  const out: PersistentStateSnapshot = { memory: {}, skills: {} }
  if (!profileHome) return out
  profileHome = resolve(profileHome)
  await Promise.all(MEMORY_FILES.map(async ([key, parts]) => {
    const sig = await fileSignature(join(profileHome, ...parts))
    if (sig !== null) out.memory[key] = sig
  }))
  const skillsDir = join(profileHome, 'skills')
  let inventory = skillInventories.get(profileHome)
  // Deep additions change their immediate parent, while in-place edits change only the file.
  const unchanged = inventory && (await Promise.all([...inventory.directories].map(async ([dir, sig]) =>
    (await fileSignature(dir, dir === skillsDir)) === sig,
  ))).every(Boolean)
  if (!inventory || !unchanged) {
    const directories = new Map<string, string | null>()
    let complete = true
    const files = await walkSkillFiles(skillsDir, {
      beforeRead: async (dir) => { directories.set(dir, await fileSignature(dir, dir === skillsDir)) },
      onReadError: () => { complete = false },
    })
    inventory = { files, directories }
    skillInventories.delete(profileHome)
    if (complete) {
      skillInventories.set(profileHome, inventory)
      // Deleted profiles must not accumulate inventories for the lifetime of the server.
      if (skillInventories.size > 32) skillInventories.delete(skillInventories.keys().next().value!)
    }
  }
  const signatures = await Promise.all(inventory.files.map((file) => fileSignature(file, false)))
  for (const [i, file] of inventory.files.entries()) {
    const sig = signatures[i]!
    if (sig !== null) out.skills[relative(skillsDir, file).replaceAll('\\', '/')] = sig
  }
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

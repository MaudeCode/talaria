/**
 * One skill as a row: the Skills hub's catalog entry (with its enable switch and lock) and, TAL-1649, the chat panel's skills a
 * conversation used (with its server count and an optional detail disclosure in `children`). One layout for both.
 */
import { memo, type ReactNode } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { IconButton } from '../../ui/Button'
import { cn } from '../../ui/cn'
import { ContextMenu, MenuItem } from '../../ui/Menu'
import type { ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'

export interface SkillRowSkill { name: string; description?: string | null | undefined; category?: string | null | undefined; disabled?: boolean | undefined; locked?: boolean | null | undefined }

// ResourceSwitch remains the shared write control; the row skips unrelated filter renders.
export const SkillRow = memo(function SkillRow({ skill: s, uses, effect, lockEffect, onSelect, onToggle, onLock, expanded, children }: {
  skill: SkillRowSkill
  uses: number
  effect?: ResourceEffect<boolean> | undefined
  lockEffect?: ResourceEffect<boolean> | undefined
  /** Absent: the row has nothing to open. */
  onSelect?: ((name: string) => void) | undefined
  /** Absent: the row has no enable switch. */
  onToggle?: ((value: { name: string; enabled: boolean }) => void) | undefined
  /** Absent: the row has no lock control. The server's null `locked` hides it too. */
  onLock?: ((value: { name: string; locked: boolean }) => void) | undefined
  /** Set when selecting the row discloses `children` in place. */
  expanded?: boolean | undefined
  children?: ReactNode
}) {
  const label = (
    <>
      <div className={cn('truncate text-sm font-medium', s.disabled ? 'text-muted' : 'text-text')}>{s.name}</div>
      {s.description && <div className="truncate text-xs text-muted">{s.description}</div>}
    </>
  )
  const locked = onLock && s.locked != null ? (lockEffect?.value ?? s.locked) : null
  const enabled = effect?.value ?? !s.disabled
  const line = (
    <div className="flex items-center gap-3">
      {onSelect
        ? <button type="button" className="min-h-11 min-w-0 flex-1 text-left" aria-expanded={expanded} onClick={() => onSelect(s.name)}>{label}</button>
        : <div className="min-w-0 flex-1">{label}</div>}
      {s.category && <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wider text-muted">{s.category}</span>}
      {uses > 0 && <span className="shrink-0 text-[11px] text-muted">{m.skill_uses({ n: uses })}</span>}
      {locked !== null && (
        <IconButton label={m.skill_lock_named({ name: s.name })} title={locked ? m.skill_locked_hint() : m.skill_unlocked_hint()} aria-pressed={locked} active={locked} onClick={() => onLock?.({ name: s.name, locked: !locked })}>
          {locked ? <Lock size={15} aria-hidden="true" /> : <LockOpen size={15} aria-hidden="true" />}
        </IconButton>
      )}
      {onToggle && (
        <span className="flex items-center gap-1 text-xs text-muted">
          <ResourceSwitch effect={effect} checked={!s.disabled} onCheckedChange={(checked) => onToggle({ name: s.name, enabled: checked })} aria-label={s.name} />
        </span>
      )}
    </div>
  )
  return (
    <li className="py-2.5">
      {locked === null || !onToggle ? line : (
        <ContextMenu label={s.name} trigger={line}>
          <MenuItem onClick={() => onToggle({ name: s.name, enabled: !enabled })}>{enabled ? m.disable() : m.skill_enable()}</MenuItem>
          <MenuItem onClick={() => onLock?.({ name: s.name, locked: !locked })}>{locked ? m.skill_unlock() : m.skill_lock()}</MenuItem>
        </ContextMenu>
      )}
      {children}
    </li>
  )
})

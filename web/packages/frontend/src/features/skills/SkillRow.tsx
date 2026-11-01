/**
 * One skill as a row: the Skills hub's catalog entry (with its enable switch) and, TAL-1649, the chat panel's skills a
 * conversation used (with its server count and an optional detail disclosure in `children`). One layout for both.
 */
import { memo, type ReactNode } from 'react'
import { m } from '../../paraglide/messages.js'
import { cn } from '../../ui/cn'
import type { ResourceEffect } from '../sessions/useResourceMutation'
import { ResourceSwitch } from '../sessions/ResourceSwitch'

export interface SkillRowSkill { name: string; description?: string | null | undefined; category?: string | null | undefined; disabled?: boolean | undefined }

// ResourceSwitch remains the shared write control; the row skips unrelated filter renders.
export const SkillRow = memo(function SkillRow({ skill: s, uses, effect, onSelect, onToggle, expanded, children }: {
  skill: SkillRowSkill
  uses: number
  effect?: ResourceEffect<boolean> | undefined
  /** Absent: the row has nothing to open. */
  onSelect?: ((name: string) => void) | undefined
  /** Absent: the row has no enable switch. */
  onToggle?: ((value: { name: string; enabled: boolean }) => void) | undefined
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
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-3">
        {onSelect
          ? <button type="button" className="min-h-11 min-w-0 flex-1 text-left" aria-expanded={expanded} onClick={() => onSelect(s.name)}>{label}</button>
          : <div className="min-w-0 flex-1">{label}</div>}
        {s.category && <span className="rounded-full border border-border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted">{s.category}</span>}
        {uses > 0 && <span className="shrink-0 text-[11px] text-muted">{m.skill_uses({ n: uses })}</span>}
        {onToggle && (
          <span className="flex items-center gap-1 text-xs text-muted">
            <ResourceSwitch effect={effect} checked={!s.disabled} onCheckedChange={(checked) => onToggle({ name: s.name, enabled: checked })} aria-label={s.name} />
          </span>
        )}
      </div>
      {children}
    </li>
  )
})

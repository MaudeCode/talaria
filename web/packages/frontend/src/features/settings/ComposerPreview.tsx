import type { ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useBootstrap } from '../../app/bootstrap'
import { cn } from '../../ui/cn'
import { Chip, ContextRingGlyph } from '../composer/chips'
import { SettingsGroup } from './SettingsGroup'
import { useSettingField } from './useSettingField'
import { COMPOSER_CONTROLS, composerControlId, type ComposerControl } from './composerControls'

const KEYS = COMPOSER_CONTROLS.map((c) => c.key)
/** A hidden control: a dashed outline in its own text colour (the chip's border colour is clear until hovered), faded and struck through. */
const HIDDEN = 'border-dashed border-current! line-through opacity-50'

/**
 * TAL-2138: Settings › Chat's Composer group. Its header counts the controls shown, and its first row is the composer drawing.
 * Pressing a control saves its key at once through `useSettingField`, which rolls it back with the error toast when the server refuses.
 */
export function ComposerGroup({ children }: { children: ReactNode }) {
  const { bool, set } = useSettingField(KEYS)
  const shown = (c: ComposerControl) => c.shows ? bool(c.key, true) : !bool(c.key)
  // TAL-2172 sends this count from the server; until then the client counts the stored keys, its own writes included.
  const count = COMPOSER_CONTROLS.filter(shown).length
  return (
    <SettingsGroup id="composer" title={m.settings_group_composer()} detail={m.settings_composer_controls_shown({ shown: count, total: COMPOSER_CONTROLS.length })}>
      <ComposerPreview shown={shown} onToggle={(c) => set({ [c.key]: c.shows ? !shown(c) : shown(c) })} />
      {children}
    </SettingsGroup>
  )
}

/**
 * A drawing of the composer: its placeholder, then each hideable control drawn with its own icon and a sample label as a
 * toggle button (`aria-pressed` while shown), and the send button, which is always there. A hidden control is drawn dashed,
 * faded and struck through.
 */
function ComposerPreview({ shown, onToggle }: { shown: (c: ComposerControl) => boolean; onToggle: (c: ComposerControl) => void }) {
  const bot = useBootstrap().bot_name
  return (
    <div className="py-2">
      <div className="flex flex-col gap-2 rounded-(--composer-radius) border-(length:--composer-border-width) border-(--composer-border-color) p-2.5 max-[641px]:rounded-(--composer-radius-phone)" data-composer-preview="">
        <p className="px-1 text-sm text-muted" aria-hidden="true">{m.composer_placeholder({ name: bot })}</p>
        <div className="flex flex-wrap items-center gap-1">
          {COMPOSER_CONTROLS.map((c) => {
            const on = shown(c)
            const icon = c.glyph === 'ring' ? <ContextRingGlyph pct={40} /> : c.glyph === 'yolo' ? <span aria-hidden="true">⚡</span> : c.icon && <c.icon size={14} className="shrink-0" aria-hidden="true" />
            return (
              <button key={c.key} type="button" id={composerControlId(c.key)} aria-pressed={on} aria-label={m.settings_composer_show({ control: c.name() })} title={c.name()} onClick={() => onToggle(c)}
                className="rounded-(--control-radius) outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)">
                {c.label
                  ? <Chip readOnly size="xs" icon={icon} label={c.label()} title={c.name()} className={cn('cursor-pointer', !on && HIDDEN)} />
                  : <span className={cn('flex size-7 items-center justify-center rounded-(--control-radius) border text-(--chip-fg)', on ? 'border-transparent' : HIDDEN)}>{icon}</span>}
              </button>
            )
          })}
          <span className="send-btn ms-auto cursor-default" aria-hidden="true"><ArrowUp size={14} /></span>
        </div>
      </div>
    </div>
  )
}

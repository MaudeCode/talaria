import type { ReactNode } from 'react'
import { ArrowUp } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { useBootstrap } from '../../app/bootstrap'
import { cn } from '../../ui/cn'
import { Chip, ContextRingGlyph } from '../composer/chips'
import { PreviewToggle } from './PreviewToggle'
import { SettingsGroup } from './SettingsGroup'
import { useSettingField, useShownCounts } from './useSettingField'
import { COMPOSER_CONTROLS, composerControlId, type ComposerControl } from './composerControls'

const KEYS = COMPOSER_CONTROLS.map((c) => c.key)
const COUNT_KEYS = ['composer_controls_shown', 'composer_controls_total']

/**
 * TAL-2138: Settings › Chat's Composer group. Its header shows the server's count of the controls shown (TAL-2172), and its first
 * row is the composer drawing. Pressing a control saves its key at once through `useSettingField`, which rolls it back with the
 * error toast when the server refuses.
 */
export function ComposerGroup({ children }: { children: ReactNode }) {
  const { bool, num, set } = useSettingField([...KEYS, ...COUNT_KEYS])
  const shown = (c: ComposerControl) => c.shows ? bool(c.key) : !bool(c.key)
  const count = useShownCounts(KEYS, num)('composer_controls', KEYS, () => COMPOSER_CONTROLS.filter(shown).length)
  return (
    <SettingsGroup id="composer" title={m.settings_group_composer()} detail={count && m.settings_composer_controls_shown(count)}>
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
        {/* The send button keeps its own column at the right, as in the composer; the controls wrap beside it. */}
        <div className="flex items-end gap-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {COMPOSER_CONTROLS.map((c) => {
              const icon = c.glyph === 'ring' ? <ContextRingGlyph pct={40} /> : c.glyph === 'yolo' ? <span aria-hidden="true">⚡</span> : c.icon && <c.icon size={14} className="shrink-0" aria-hidden="true" />
              return (
                <PreviewToggle key={c.key} id={composerControlId(c.key)} name={c.name()} shown={shown(c)} onToggle={() => onToggle(c)}>
                  {(hidden) => c.label
                    ? <Chip readOnly size="xs" icon={icon} label={c.label()} title={c.name()} className={cn('cursor-pointer', hidden)} />
                    : <span className={cn('flex size-7 items-center justify-center rounded-(--control-radius) border border-transparent text-(--chip-fg)', hidden)}>{icon}</span>}
                </PreviewToggle>
              )
            })}
          </div>
          <span className="send-btn cursor-default" aria-hidden="true"><ArrowUp size={14} /></span>
        </div>
      </div>
    </div>
  )
}

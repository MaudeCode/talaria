import { Brain, Cpu, FolderOpen, Gauge, Mic, Paperclip, UserRound, Wrench, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'

/**
 * TAL-2138: one composer control a setting hides, in the composer's order. `shows` marks the one key stored as shown
 * (`show_quota_chip`, on by default) rather than hidden. `label` is the sample a chip draws; a control without one is drawn
 * as its `icon`, or as the context ring or YOLO notice (`glyph`). Kept apart from the drawing so the Settings search loads no composer code.
 */
export interface ComposerControl { key: string; name: () => string; icon?: LucideIcon; glyph?: 'ring' | 'yolo'; label?: () => string; shows?: true }
export const COMPOSER_CONTROLS: readonly ComposerControl[] = [
  { key: 'hide_composer_attach', name: m.settings_label_composer_attach, icon: Paperclip },
  { key: 'hide_composer_model', name: m.settings_label_composer_model, icon: Cpu, label: m.settings_label_composer_model },
  { key: 'hide_composer_reasoning', name: m.settings_label_composer_reasoning, icon: Brain, label: m.reasoning_default },
  { key: 'hide_composer_profile', name: m.settings_label_composer_profile, icon: UserRound, label: m.settings_label_composer_profile },
  { key: 'hide_composer_workspace', name: m.settings_label_composer_workspace, icon: FolderOpen, label: m.settings_label_composer_workspace },
  { key: 'hide_composer_toolsets', name: m.settings_label_composer_toolsets, icon: Wrench, label: m.settings_label_composer_toolsets },
  { key: 'show_quota_chip', name: m.composer_control_quota_chip, icon: Gauge, shows: true },
  { key: 'hide_composer_context', name: m.settings_label_composer_context, glyph: 'ring' },
  { key: 'hide_composer_mic', name: m.settings_label_composer_mic, icon: Mic },
  { key: 'hide_composer_yolo', name: m.settings_label_composer_yolo, glyph: 'yolo', label: m.composer_control_yolo },
]

/** A drawn control's id: the `SettingToggle` id its switch row had, so links to it still land on it. */
export const composerControlId = (key: string) => `settings-${key}`

import { Languages, Moon, Monitor, MoveHorizontal, PilcrowRight, Sun, Type, type LucideIcon } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { Switch } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { Segmented } from '../../ui/Segmented'
import { Mark } from '../../ui/Badge'
import { setChatWidth, setFontSize, setLanguage, setRtl, setSkin, setTheme, useAppearance } from '../../app/appearance'
import { SKINS } from '../../theme/skins'
import { ChatWidthSchema, FontSizeSchema, SkinSchema, type ChatWidth, type Theme } from '../../contracts/persisted'
import { LOCALE_INFO } from '@maudecode/talaria-web-contracts'
import { useLocale } from '../../i18n/useLocale'
import { useSaveSettings } from '../../app/queries'
import { useExtensionSkins } from '../../extensions/registry'
import { cn } from '../../ui/cn'
import { SectionHeader } from '../../ui/List'
import { SettingRow, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/** The three theme previews: a page colour and two text bars. System splits light and dark down the middle. */
const THEMES: readonly { value: Theme; label: () => string; Icon: LucideIcon; page: string; bar: string }[] = [
  { value: 'light', label: m.theme_light, Icon: Sun, page: '#fff', bar: '#d4d4d8' },
  { value: 'dark', label: m.theme_dark, Icon: Moon, page: '#1c1c22', bar: '#3f3f46' },
  { value: 'system', label: m.theme_system, Icon: Monitor, page: 'linear-gradient(to right,#fff 50%,#1c1c22 50%)', bar: '#a1a1aa' },
]

/** Font sizes with the pixel size their "Aa" is drawn at. */
const FONT_SIZES = [['small', 10, m.font_size_small], ['default', 13, m.font_size_default], ['large', 16, m.font_size_large], ['xlarge', 19, m.font_size_xlarge]] as const
const CHAT_WIDTHS: readonly [ChatWidth, () => string][] = [['comfortable', m.chat_width_comfortable], ['wide', m.chat_width_wide], ['full', m.chat_width_full]]

/**
 * A theme is a visual choice, so it keeps a bordered preview tile (§12), the one bordered shape on a Settings page; the
 * selected tile has the accent border (`settings.css`) and a check.
 */
function ThemeTile({ theme, active }: { theme: typeof THEMES[number]; active: boolean }) {
  return (
    <button type="button" className={cn('theme-pick-btn flex flex-col gap-2 rounded-[10px] border border-border2 p-2 text-left', active && 'active')} aria-pressed={active} data-theme-val={theme.value} onClick={() => setTheme(theme.value)}>
      <span aria-hidden="true" className="flex h-12 w-full flex-col justify-center gap-1.5 rounded-md border border-border px-2.5" style={{ background: theme.page }}>
        <span className="block h-1.5 w-3/5 rounded-full" style={{ background: theme.bar }} />
        <span className="block h-1.5 w-2/5 rounded-full" style={{ background: theme.bar }} />
      </span>
      <span className="flex min-w-0 items-center gap-1.5 px-0.5 text-xs font-medium text-text">
        <theme.Icon size={13} aria-hidden="true" className="shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate">{theme.label()}</span>
        {active && <Mark />}
      </span>
    </button>
  )
}

/** One skin as a row: its colour dots, its name, and a check when selected. */
function SkinRow({ skin, name, colors, active, title, onPick }: { skin: string; name: string; colors: readonly string[]; active: boolean; title?: string; onPick: () => void }) {
  return (
    <button type="button" className="flex min-h-11 min-w-0 items-center gap-2.5 border-t border-border-subtle py-2 text-left text-sm text-text transition-colors hover:text-accent-text" aria-pressed={active} title={title} data-skin-val={skin} onClick={onPick}>
      <span aria-hidden="true" className="flex shrink-0 gap-[3px]">{colors.map((c, i) => <span key={i} className="inline-block size-2.5 rounded-full" style={{ background: c }} />)}</span>
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {active && <Mark />}
    </button>
  )
}

const SKIN_GRID = 'grid grid-cols-2 gap-x-6 min-[601px]:grid-cols-3'

/** TAL-2083, TAL-2086, TAL-2146: Settings > Appearance; theme, skin and direction stay in this browser, text size, width and language are saved. */
export function AppearanceSection() {
  const appearance = useAppearance()
  const locale = useLocale()
  const save = useSaveSettings()
  const extSkins = useExtensionSkins()
  const pickSkin = (key: string) => { const v = SkinSchema.safeParse(key); if (v.success) setSkin(v.data); else if (extSkins.some((s) => s.key === key)) setSkin(key) }
  return (
    <div className={cn('settings-section', SETTINGS_PAGE)} data-section="appearance">
      <SettingsGroup id="theme" title={m.settings_label_theme()}>
        <div id="themePickerGrid" role="group" aria-label={m.settings_label_theme()} className="grid grid-cols-3 gap-2 pt-1">
          {THEMES.map((t) => <ThemeTile key={t.value} theme={t} active={appearance.theme === t.value} />)}
        </div>
      </SettingsGroup>
      <SettingsGroup id="skin" title={m.settings_label_skin()} detail={SKINS.length + extSkins.length}>
        <div id="skinPickerGrid" role="group" aria-label={m.settings_label_skin()} className={SKIN_GRID}>
          {SKINS.map((sk) => <SkinRow key={sk.key} skin={sk.key} name={sk.name} colors={sk.colors} active={appearance.skin === sk.key} onPick={() => pickSkin(sk.key)} />)}
        </div>
        {extSkins.length > 0 && <>
          <SectionHeader className="mt-3">{m.settings_group_skins_from_extensions()}</SectionHeader>
          <div role="group" aria-label={m.settings_group_skins_from_extensions()} className={SKIN_GRID} data-skin-grid="extensions">
            {extSkins.map((s) => <SkinRow key={s.key} skin={s.key} name={s.name} colors={(s.colors ?? []).slice(0, 3)} active={appearance.skin === s.key} title={m.extensions_skin_from({ name: s.extensionId })} onPick={() => pickSkin(s.key)} />)}
          </div>
        </>}
      </SettingsGroup>
      <SettingsGroup id="text-layout" title={m.settings_group_text_layout()}>
        <SettingRow label={m.settings_label_font_size()} htmlFor="fontSizePickerGrid" icon={Type}>
          <Segmented id="fontSizePickerGrid" label={m.settings_label_font_size()} value={appearance.fontSize}
            options={FONT_SIZES.map(([value, px, label]) => ({ value, label: label(), display: <span className="font-semibold" style={{ fontSize: px }}>Aa</span> }))}
            onChange={(size) => { const v = FontSizeSchema.safeParse(size); if (v.success) { setFontSize(v.data); save.mutate({ font_size: v.data }) } }} />
        </SettingRow>
        <SettingRow label={m.settings_label_chat_width()} htmlFor="chatWidthPickerGrid" icon={MoveHorizontal}>
          <Segmented id="chatWidthPickerGrid" label={m.settings_label_chat_width()} value={appearance.chatWidth}
            options={CHAT_WIDTHS.map(([value, label]) => ({ value, label: label() }))}
            onChange={(width) => { const w = ChatWidthSchema.safeParse(width); if (w.success) { setChatWidth(w.data); save.mutate({ chat_width: w.data, full_width_chat: w.data === 'full' }) } }} />
        </SettingRow>
      </SettingsGroup>
      <SettingsGroup id="language" title={m.settings_label_language()}>
        <SettingRow label={m.settings_label_language()} htmlFor="settingsLanguage" icon={Languages}>
          <Select id="settingsLanguage" value={locale} onValueChange={(v) => { setLanguage(v); save.mutate({ language: v }) }}>
            {LOCALE_INFO.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </SettingRow>
        <SettingRow label={m.settings_label_rtl()} htmlFor="settingsRtl" icon={PilcrowRight}>
          <Switch id="settingsRtl" checked={appearance.rtl} onCheckedChange={(checked) => setRtl(checked)} />
        </SettingRow>
      </SettingsGroup>
    </div>
  )
}

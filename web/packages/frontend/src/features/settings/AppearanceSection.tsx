import { Moon, Monitor, Sun } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import { FieldRow, Switch } from '../../ui/Field'
import { Select } from '../../ui/Select'
import { setChatWidth, setFontSize, setLanguage, setRtl, setSkin, setTheme, useAppearance } from '../../app/appearance'
import { SKINS } from '../../theme/skins'
import { FontSizeSchema, SkinSchema } from '../../contracts/persisted'
import { LOCALE_INFO } from '@maudecode/talaria-web-contracts'
import { useLocale } from '../../i18n/useLocale'
import { useSaveSettings } from '../../app/queries'
import { useExtensionSkins } from '../../extensions/registry'
import { cn } from '../../ui/cn'
import { SectionHeader } from '../../ui/List'
import { SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/** Swatch colours per skin, carried forward from the legacy picker catalogue. */

const PICK_PREVIEW = 'flex w-full h-10 rounded-[6px] mb-1.5 items-center justify-center'

function PickButton({ active, onClick, className, children, label, title, ...rest }: { active: boolean; onClick: () => void; className: string; children: React.ReactNode; label: string; title?: string } & Record<`data-${string}`, string>) {
  // Skin tiles are denser than the theme and font-size tiles (legacy inline styles).
  const skin = className === 'skin-pick-btn'
  return (
    <button type="button" className={cn(className, 'flex flex-col items-center text-center cursor-pointer bg-transparent border border-border2 rounded-[10px] transition-all duration-150', skin ? 'py-2 px-1' : 'py-2.5 px-2', active && 'active')} title={title} aria-pressed={active} onClick={onClick} {...rest}>
      {children}
      <span className="text-xs font-medium text-text">{label}</span>

    </button>
  )
}

function SkinDots({ colors }: { colors: readonly string[] }) {
  return <div className="flex gap-[3px] justify-center mb-1">{colors.map((c, i) => <span key={i} className="inline-block size-2.5 rounded-full" style={{ background: c }} />)}</div>
}

/** TAL-2083, TAL-2086: Settings > Appearance; theme, skin and direction stay in this browser, so they sit under This device. */
export function AppearanceSection() {
  const appearance = useAppearance()
  const locale = useLocale()
  const save = useSaveSettings()
  const extSkins = useExtensionSkins()
  const pickSkin = (key: string) => { const v = SkinSchema.safeParse(key); if (v.success) setSkin(v.data); else if (extSkins.some((s) => s.key === key)) setSkin(key) }
  return (
    <div className={cn('settings-section', SETTINGS_PAGE)} data-section="appearance">
      <SettingsGroup id="this-device" title={m.settings_group_this_device()}>
        <FieldRow label={m.settings_label_theme()}>
          <div id="themePickerGrid" role="group" aria-label={m.settings_label_theme()} className="grid gap-2 grid-cols-3">
            <PickButton className="theme-pick-btn" data-theme-val="light" active={appearance.theme === 'light'} onClick={() => setTheme('light')} label={m.theme_light()}>
              <div className={PICK_PREVIEW} style={{ background: '#fff', border: '1px solid rgba(0,0,0,.12)' }}><Sun size={16} color="#999" aria-hidden="true" /></div>
            </PickButton>
            <PickButton className="theme-pick-btn" data-theme-val="dark" active={appearance.theme === 'dark'} onClick={() => setTheme('dark')} label={m.theme_dark()}>
              <div className={PICK_PREVIEW} style={{ background: '#1a1a2e', border: '1px solid rgba(255,255,255,.1)' }}><Moon size={16} color="#666" aria-hidden="true" /></div>
            </PickButton>
            <PickButton className="theme-pick-btn" data-theme-val="system" active={appearance.theme === 'system'} onClick={() => setTheme('system')} label={m.theme_system()}>
              <div className={PICK_PREVIEW} style={{ background: 'linear-gradient(to right,#fff,#1a1a2e)', border: '1px solid rgba(0,0,0,.12)' }}><Monitor size={16} color="#888" aria-hidden="true" /></div>
            </PickButton>
          </div>
        </FieldRow>
        <FieldRow label={m.settings_label_skin()}>
          <div id="skinPickerGrid" role="group" aria-label={m.settings_label_skin()} className="grid gap-1.5 grid-cols-4">
            {SKINS.map((sk) => (
              <PickButton key={sk.key} className="skin-pick-btn" data-skin-val={sk.key} active={appearance.skin === sk.key} onClick={() => pickSkin(sk.key)} label={sk.name}>
                <SkinDots colors={sk.colors} />
              </PickButton>
            ))}
          </div>
          {extSkins.length > 0 && <>
            <SectionHeader className="mt-3 mb-1.5">{m.settings_group_skins_from_extensions()}</SectionHeader>
            <div className="grid gap-1.5 grid-cols-4" data-skin-grid="extensions">
              {extSkins.map((s) => (
                <PickButton key={s.key} className="skin-pick-btn" data-skin-val={s.key} active={appearance.skin === s.key} onClick={() => pickSkin(s.key)} label={s.name} title={m.extensions_skin_from({ name: s.extensionId })}>
                  <SkinDots colors={(s.colors ?? []).slice(0, 3)} />
                </PickButton>
              ))}
            </div>
          </>}
        </FieldRow>
        <FieldRow label={m.settings_label_rtl()} htmlFor="settingsRtl" inline>
          <Switch id="settingsRtl" checked={appearance.rtl} onCheckedChange={(checked) => setRtl(checked)} />
        </FieldRow>
      </SettingsGroup>
      <SettingsGroup id="text-layout" title={m.settings_group_text_layout()}>
        <FieldRow label={m.settings_label_font_size()}>
          <div id="fontSizePickerGrid" role="group" aria-label={m.settings_label_font_size()} className="grid gap-2 grid-cols-[repeat(auto-fit,minmax(96px,1fr))]">
            {([['small', 10, m.font_size_small()], ['default', 13, m.font_size_default()], ['large', 17, m.font_size_large()], ['xlarge', 20, m.font_size_xlarge()]] as const).map(([size, px, label]) => (
              <PickButton key={size} className="font-size-pick-btn" data-font-size-val={size} active={appearance.fontSize === size} onClick={() => { const v = FontSizeSchema.safeParse(size); if (v.success) { setFontSize(v.data); save.mutate({ font_size: v.data }) } }} label={label}>
                <div className={PICK_PREVIEW + ' bg-surface border border-border'}><span className="font-semibold text-muted" style={{ fontSize: px }}>Aa</span></div>
              </PickButton>
            ))}
          </div>
        </FieldRow>
        <FieldRow label={m.settings_label_chat_width()}>
          <div id="chatWidthPickerGrid" role="group" aria-label={m.settings_label_chat_width()} className="grid gap-2 grid-cols-3">
            {([['comfortable', '45%', m.chat_width_comfortable()], ['wide', '70%', m.chat_width_wide()], ['full', '100%', m.chat_width_full()]] as const).map(([width, bar, label]) => (
              <PickButton key={width} className="chat-width-pick-btn" data-chat-width-val={width} active={appearance.chatWidth === width} onClick={() => { setChatWidth(width); save.mutate({ chat_width: width, full_width_chat: width === 'full' }) }} label={label}>
                <div className={PICK_PREVIEW + ' bg-surface border border-border px-2'}><span className="block h-2 rounded-full bg-muted opacity-40" style={{ width: bar }} /></div>
              </PickButton>
            ))}
          </div>
        </FieldRow>
        <FieldRow label={m.settings_label_language()} htmlFor="settingsLanguage" inline>
          <Select id="settingsLanguage" value={locale} onValueChange={(v) => { setLanguage(v); save.mutate({ language: v }) }}>
            {LOCALE_INFO.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
          </Select>
        </FieldRow>
      </SettingsGroup>
    </div>
  )
}

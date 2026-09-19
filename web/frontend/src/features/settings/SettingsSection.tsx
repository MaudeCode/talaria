import type { ReactNode } from 'react'
import type { SettingsSection as Section } from '../../contracts/url'
import { SECTION_LABEL } from './SettingsLayout'
import { AppearanceSection } from './AppearanceSection'
import { PreferencesSection } from './PreferencesSection'
import { ConversationSection } from './ConversationSection'
import { ProvidersSection } from './ProvidersSection'
import { PluginsSection } from './PluginsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { SystemSection } from './SystemSection'
import { HelpSection } from './HelpSection'
import { useLocale } from '../../i18n/useLocale'
import { m } from '../../paraglide/messages.js'

const SECTIONS: Partial<Record<Section, () => ReactNode>> = {
  appearance: () => <AppearanceSection />,
  preferences: () => <PreferencesSection />,
  conversation: () => <ConversationSection />,
  providers: () => <ProvidersSection />,
  plugins: () => <PluginsSection />,
  extensions: () => <ExtensionsSection />,
  system: () => <SystemSection />,
  help: () => <HelpSection />,
}

export function registerSettingsSection(section: Section, render: () => ReactNode): void {
  SECTIONS[section] = render
}

export function SettingsSection({ section }: { section: Section }) {
  useLocale()
  const render = SECTIONS[section]
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="settings-main w-full max-w-[820px] mx-auto min-w-0 pt-6 px-7 pb-12 max-[769px]:pt-4 max-[769px]:px-3.5 max-[769px]:pb-10">
        <div className="settings-section-head flex items-start justify-between gap-4 mb-5 pb-3.5 border-b border-border max-[769px]:flex-col">
          <div>
            <h1 className="settings-section-title text-[18px] font-semibold tracking-(--heading-tracking) text-text leading-[1.3] mb-1">{SECTION_LABEL[section]()}</h1>
          </div>
        </div>
        {render ? render() : <p className="text-sm text-muted">{m.loading()}</p>}
      </div>
    </div>
  )
}

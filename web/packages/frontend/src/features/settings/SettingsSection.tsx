import { lazy, Suspense, type ReactNode } from 'react'
import type { SettingsSection as Section } from '../../contracts/url'
import { SECTION_LABEL } from './SettingsLayout'
import { LoadingState } from '../../ui/States'
import { useLocale } from '../../i18n/useLocale'

const AppearanceSection = lazy(() => import('./AppearanceSection').then((module) => ({ default: module.AppearanceSection })))
const PreferencesSection = lazy(() => import('./PreferencesSection').then((module) => ({ default: module.PreferencesSection })))
const ConversationSection = lazy(() => import('./ConversationSection').then((module) => ({ default: module.ConversationSection })))
const SpeechSection = lazy(() => import('./SpeechSection').then((module) => ({ default: module.SpeechSection })))
const NotificationsSection = lazy(() => import('./NotificationsSection').then((module) => ({ default: module.NotificationsSection })))
const ProvidersSection = lazy(() => import('./ProvidersSection').then((module) => ({ default: module.ProvidersSection })))
const AuxiliaryModelsSection = lazy(() => import('./AuxiliaryModels').then((module) => ({ default: module.AuxiliaryModelsSection })))
const ConnectorsSection = lazy(() => import('../connectors/ConnectorsSection').then((module) => ({ default: module.ConnectorsSection })))
const PluginsSection = lazy(() => import('./PluginsSection').then((module) => ({ default: module.PluginsSection })))
const ExtensionsSection = lazy(() => import('./ExtensionsSection').then((module) => ({ default: module.ExtensionsSection })))
const SystemSection = lazy(() => import('./SystemSection').then((module) => ({ default: module.SystemSection })))
const HelpSection = lazy(() => import('./HelpSection').then((module) => ({ default: module.HelpSection })))

const SECTIONS: Partial<Record<Section, () => ReactNode>> = {
  appearance: () => <AppearanceSection />,
  preferences: () => <PreferencesSection />,
  conversation: () => <ConversationSection />,
  speech: () => <SpeechSection />,
  notifications: () => <NotificationsSection />,
  providers: () => <ProvidersSection />,
  auxiliary: () => <AuxiliaryModelsSection />,
  connectors: () => <ConnectorsSection />,
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
        <Suspense fallback={<LoadingState compact />}>{render ? render() : <LoadingState compact />}</Suspense>
      </div>
    </div>
  )
}

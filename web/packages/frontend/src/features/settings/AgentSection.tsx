import { m } from '../../paraglide/messages.js'
import type { AgentTab } from '../../contracts/url'
import { useConnectorsAvailable } from '../../app/queries'
import { SECTION_HEADER } from '../../ui/List'
import { TabStrip } from '../../ui/TabStrip'
import { LoadingState } from '../../ui/States'
import { useSettingField } from './useSettingField'
import { PluginsSection } from './PluginsSection'
import { ExtensionsSection } from './ExtensionsSection'
import { ConnectorsSection } from '../connectors/ConnectorsSection'
import { McpSection } from './McpSection'
import { SettingToggle } from './SettingsRows'

/**
 * TAL-1691: Settings > Agent, what the agent can reach. Plugins, extensions, connectors (behind the server's gate) and MCP
 * servers each fill a long list, so each takes a tab.
 */
export function AgentSection({ tab, onTabChange }: { tab?: AgentTab | undefined; onTabChange?: ((tab: AgentTab) => void) | undefined }) {
  const { settings } = useSettingField(['agent_approvals'])
  const connectors = useConnectorsAvailable()
  const tabs: { id: AgentTab; label: () => string }[] = [
    { id: 'plugins', label: m.settings_section_plugins_title },
    { id: 'extensions', label: m.settings_section_extensions_title },
    ...(connectors === true ? [{ id: 'connectors' as const, label: m.settings_section_connectors_title }] : []),
    { id: 'mcp', label: m.mcp_servers_title },
  ]
  const active: AgentTab = tabs.find((t) => t.id === tab)?.id ?? 'plugins'
  // A Connectors link waits for the gate rather than opening Plugins first.
  const gating = tab === 'connectors' && connectors === undefined
  return (
    <div className="flex flex-col gap-5" data-section="agent">
      {typeof settings.data?.agent_approvals === 'boolean' ? <SettingToggle label={m.settings_label_agent_approvals()} settingKey="agent_approvals" /> : null}
      {gating ? <LoadingState compact /> : <>
        <TabStrip label={m.settings_section_agent_title()} tabs={tabs} value={active} onChange={(next) => onTabChange?.(next)} panelPrefix="agent" />
        <div role="tabpanel" id={`agent-${active}`} data-group={active} className="flex flex-col gap-5">
          {active === 'plugins' && <PluginsSection />}
          {active === 'extensions' && <ExtensionsSection />}
          {active === 'connectors' && <ConnectorsSection />}
          {active === 'mcp' && <McpSection heading={SECTION_HEADER} />}
        </div>
      </>}
    </div>
  )
}

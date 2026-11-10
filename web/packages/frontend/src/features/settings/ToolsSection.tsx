import { ShieldCheck } from 'lucide-react'
import { m } from '../../paraglide/messages.js'
import type { ToolsTab } from '../../contracts/url'
import { useConnectorsAvailable } from '../../app/queries'
import { TabStrip } from '../../ui/TabStrip'
import { ErrorState, LoadingState } from '../../ui/States'
import { useSettingField } from './useSettingField'
import { PluginsSection } from './PluginsSection'
import { ConnectorsSection } from '../connectors/ConnectorsSection'
import { McpSection } from './McpSection'
import { SettingToggle, SettingsGroup, SETTINGS_PAGE } from './SettingsRows'

/**
 * TAL-1691, TAL-2100: Settings > Tools, what the active profile's agent can reach. Plugins, connectors (behind the
 * server's gate) and MCP servers each fill a long list, so each takes a tab.
 */
export function ToolsSection({ tab, onTabChange }: { tab?: ToolsTab | undefined; onTabChange?: ((tab: ToolsTab) => void) | undefined }) {
  const { settings } = useSettingField(['agent_approvals'])
  const gate = useConnectorsAvailable()
  const connectors = gate.data?.available
  const tabs: { id: ToolsTab; label: () => string }[] = [
    { id: 'plugins', label: m.settings_section_plugins_title },
    ...(connectors === true ? [{ id: 'connectors' as const, label: m.settings_section_connectors_title }] : []),
    { id: 'mcp', label: m.mcp_servers_title },
  ]
  const active: ToolsTab = tabs.find((t) => t.id === tab)?.id ?? 'plugins'
  // A Connectors link waits for the gate rather than opening Plugins first; a failed gate says so and offers a retry.
  const gating = tab === 'connectors' && gate.isPending
  const gateFailed = tab === 'connectors' && gate.isError && !gate.data
  return (
    <div className={SETTINGS_PAGE} data-section="tools">
      {gateFailed && <ErrorState error={gate.error} onRetry={() => { void gate.refetch() }} />}
      {gating ? <LoadingState compact /> : <>
        <TabStrip label={m.settings_section_tools_title()} tabs={tabs} value={active} onChange={(next) => onTabChange?.(next)} panelPrefix="tools" />
        <div role="tabpanel" id={`tools-${active}`} data-group={active} className={SETTINGS_PAGE}>
          {active === 'plugins' && <PluginsSection />}
          {active === 'connectors' && <ConnectorsSection />}
          {active === 'mcp' && <McpSection />}
        </div>
      </>}
      {/* TAL-2138: below the tab panel, so the tab strip sits directly under the header on every tab. */}
      {typeof settings.data?.agent_approvals === 'boolean' ? <SettingsGroup id="agent-permissions" title={m.settings_group_agent_permissions()}><SettingToggle icon={ShieldCheck} label={m.settings_label_agent_approvals()} settingKey="agent_approvals" /></SettingsGroup> : null}
    </div>
  )
}

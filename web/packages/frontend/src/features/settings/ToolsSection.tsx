import { m } from '../../paraglide/messages.js'
import type { ToolsTab } from '../../contracts/url'
import { useConnectorsAvailable } from '../../app/queries'
import { SECTION_HEADER } from '../../ui/List'
import { TabStrip } from '../../ui/TabStrip'
import { ErrorState, LoadingState } from '../../ui/States'
import { useSettingField } from './useSettingField'
import { PluginsSection } from './PluginsSection'
import { ConnectorsSection } from '../connectors/ConnectorsSection'
import { McpSection } from './McpSection'
import { SettingToggle } from './SettingsRows'

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
    <div className="flex flex-col gap-5" data-section="tools">
      {typeof settings.data?.agent_approvals === 'boolean' ? <SettingToggle label={m.settings_label_agent_approvals()} settingKey="agent_approvals" /> : null}
      {gateFailed && <ErrorState error={gate.error} onRetry={() => { void gate.refetch() }} />}
      {gating ? <LoadingState compact /> : <>
        <TabStrip label={m.settings_section_tools_title()} tabs={tabs} value={active} onChange={(next) => onTabChange?.(next)} panelPrefix="tools" />
        <div role="tabpanel" id={`tools-${active}`} data-group={active} className="flex flex-col gap-5">
          {active === 'plugins' && <PluginsSection />}
          {active === 'connectors' && <ConnectorsSection />}
          {active === 'mcp' && <McpSection heading={SECTION_HEADER} />}
        </div>
      </>}
    </div>
  )
}

import Foundation

enum SessionListUtilityDestination: Hashable, Identifiable {
    /// Optional section to scroll to when Settings opens — "Manage Servers"
    /// passes `.servers`, a plain avatar tap passes `nil` (#283).
    case settings(SettingsScrollAnchor?)
    case providers(String?)
    case providerQuotaWidgetSettings
    case tasks
    case kanban
    case skills
    case memory
    case insights
    /// Archived sessions screen (issue #17), also reachable from Settings.
    case archived
    case scheduled
    case webhook

    var id: Self { self }
}

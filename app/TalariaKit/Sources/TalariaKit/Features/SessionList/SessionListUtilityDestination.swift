import Foundation

public enum SessionListUtilityDestination: Hashable, Identifiable, Sendable {
    /// Optional category to open when Settings appears. "Manage Servers"
    /// passes `.servers`, while a plain Settings action passes `nil` (#283).
    case settings(SettingsScrollAnchor?)
    /// A widget link or pinned row: one quota account's page, pushed once above the current root.
    case providers(String)
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
    /// TAL-1966: the Decisions list, and one review pushed once above the current root (its push alert).
    case decisions
    case decisionReview(String)

    public var id: Self { self }

    /// Archived, scheduled and webhook are lists of chats; the rest are app sections.
    public var listsSessions: Bool {
        switch self {
        case .archived, .scheduled, .webhook:
            return true
        default:
            return false
        }
    }
}

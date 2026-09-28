import SwiftUI

public enum SessionSidebarDisclosureSettings {
    static let profilesAreExpandedKey = "sessionSidebar.profilesAreExpanded"
    static let projectsAreExpandedKey = "sessionSidebar.projectsAreExpanded"
    public static let scheduledSessionsAreExpandedKey = "sessionSidebar.scheduledSessionsAreExpanded"
    public static let webhookSessionsAreExpandedKey = "sessionSidebar.webhookSessionsAreExpanded"
    static let defaultProfilesAreExpanded = false
    static let defaultProjectsAreExpanded = false
    public static let defaultScheduledSessionsAreExpanded = false
    public static let defaultWebhookSessionsAreExpanded = false

    static func profilesAreExpanded(in defaults: UserDefaults = .standard) -> Bool {
        guard let value = defaults.object(forKey: profilesAreExpandedKey) as? Bool else {
            return defaultProfilesAreExpanded
        }

        return value
    }

    static func projectsAreExpanded(in defaults: UserDefaults = .standard) -> Bool {
        guard let value = defaults.object(forKey: projectsAreExpandedKey) as? Bool else {
            return defaultProjectsAreExpanded
        }

        return value
    }

    static func scheduledSessionsAreExpanded(in defaults: UserDefaults = .standard) -> Bool {
        guard let value = defaults.object(forKey: scheduledSessionsAreExpandedKey) as? Bool else {
            return defaultScheduledSessionsAreExpanded
        }

        return value
    }

    static func webhookSessionsAreExpanded(in defaults: UserDefaults = .standard) -> Bool {
        guard let value = defaults.object(forKey: webhookSessionsAreExpandedKey) as? Bool else {
            return defaultWebhookSessionsAreExpanded
        }

        return value
    }
}

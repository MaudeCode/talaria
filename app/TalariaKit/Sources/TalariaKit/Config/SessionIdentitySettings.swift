import Foundation

public enum SessionIdentitySettings {
    public static let displayNameKey = "sessionIdentity.displayName"
    public static let initialsKey = "sessionIdentity.initials"

    public static func normalizedInitials(_ rawValue: String) -> String {
        rawValue
            .filter { $0.isLetter || $0.isNumber }
            .prefix(3)
            .map { String($0).uppercased() }
            .joined()
    }

    public static func displayInitials(
        displayName: String,
        storedInitials: String,
        fallbackFullName: String
    ) -> String {
        let normalizedStoredInitials = normalizedInitials(storedInitials)
        if !normalizedStoredInitials.isEmpty {
            return normalizedStoredInitials
        }

        let displayNameInitials = initials(from: displayName)
        if !displayNameInitials.isEmpty {
            return displayNameInitials
        }

        let fallbackInitials = initials(from: fallbackFullName)
        return fallbackInitials.isEmpty ? "UZ" : fallbackInitials
    }

    private static func initials(from rawName: String) -> String {
        rawName
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .compactMap(\.first)
            .prefix(2)
            .map { String($0).uppercased() }
            .joined()
    }
}

public enum SessionRowDisplaySettings {
    public static let showMessageCountKey = "sessionRow.showMessageCount"
    public static let showWorkspaceKey = "sessionRow.showWorkspace"
    // Cron, webhook, and CLI sessions default to shown; delegated subagents default to
    // hidden. Each kind has an independent visibility control.
    public static let showCronSessionsKey = "sessionRow.showCronSessions"
    public static let showWebhookSessionsKey = "sessionRow.showWebhookSessions"
    public static let showSubagentSessionsKey = "sessionRow.showSubagentSessions"
    public static let defaultShowsSubagentSessions = false
    // Legacy global CLI-sessions key. Since #19 the CLI toggle is stored
    // per-server (it mirrors the server's own `show_cli_sessions` setting, and a
    // value adopted from server A must not leak to server B); this key survives
    // only as the migration seed for servers with no per-server value yet.
    public static let showCliSessionsKey = "sessionRow.showCliSessions"
    public static let showClaudeCodeSessionsKey = "sessionRow.showClaudeCodeSessions"

    /// Per-server storage key for the CLI-sessions toggle (#19). Keyed by the
    /// active server's absolute URL, matching how the offline cache scopes rows.
    public static func showCliSessionsKey(for server: URL) -> String {
        "\(showCliSessionsKey)|\(server.absoluteString)"
    }

    public static func showClaudeCodeSessionsKey(for server: URL) -> String {
        "\(showClaudeCodeSessionsKey)|\(server.absoluteString)"
    }

    /// Forgets both per-server toggles when `server` is removed from the app,
    /// so re-adding the same URL starts from the server's own setting again.
    static func clearServerScopedSettings(for server: URL, in defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: showCliSessionsKey(for: server))
        defaults.removeObject(forKey: showClaudeCodeSessionsKey(for: server))
    }

    /// Effective CLI-sessions visibility for `server`: the per-server value if
    /// one was ever stored, else the pre-#19 global value, else shown-by-default
    /// like every other session-row toggle.
    public static func showsCliSessions(for server: URL, in defaults: UserDefaults = .standard) -> Bool {
        if let perServer = defaults.object(forKey: showCliSessionsKey(for: server)) as? Bool {
            return perServer
        }

        if let legacy = defaults.object(forKey: showCliSessionsKey) as? Bool {
            return legacy
        }

        return true
    }

    /// Claude Code visibility is new and per-server, with no legacy global
    /// value. Omission defaults to shown for compatibility with older servers.
    public static func showsClaudeCodeSessions(
        for server: URL,
        in defaults: UserDefaults = .standard
    ) -> Bool {
        defaults.object(forKey: showClaudeCodeSessionsKey(for: server)) as? Bool ?? true
    }

    static func showsSubagentSessions(in defaults: UserDefaults = .standard) -> Bool {
        guard let stored = defaults.object(forKey: showSubagentSessionsKey) as? Bool else {
            return defaultShowsSubagentSessions
        }

        return stored
    }

    public static func showsWebhookSessions(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: showWebhookSessionsKey) as? Bool ?? true
    }
}

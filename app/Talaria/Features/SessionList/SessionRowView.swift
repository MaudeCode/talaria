import SwiftUI
import TalariaKit

struct SessionRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption2) private var pinnedIconSize: CGFloat = 11
    @ScaledMetric(relativeTo: .body) private var verticalPadding: CGFloat = 8

    let session: SessionSummary
    var showsMessageCount = true
    var showsWorkspace = true
    var isViewingCachedData = false
    /// Server-redacted excerpt around a content-search hit (TAL-164); nil for
    /// title-only matches and rows outside a search.
    var matchPreview: String? = nil
    /// The search text the excerpt is highlighted against.
    var searchText = ""

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if Self.isActiveStreaming(session) {
                ActiveSessionStreamingIndicator()
                    .padding(.top, streamingIndicatorTopPadding)
            }

            rowContent
        }
        .padding(.horizontal, 12)
        .padding(.vertical, verticalPadding)
        .frame(minHeight: rowMinimumHeight, alignment: .center)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilitySummary)
    }

    static func displayTitle(for session: SessionSummary) -> String {
        let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let title, !title.isEmpty else {
            return String(localized: "Untitled Session")
        }
        return title
    }

    static func isActiveStreaming(_ session: SessionSummary) -> Bool {
        session.isStreaming == true
    }

    static func metadataLabel(
        for session: SessionSummary,
        showsMessageCount: Bool,
        showsWorkspace: Bool
    ) -> String? {
        let parts = [
            messageCountLabel(for: session, showsMessageCount: showsMessageCount),
            workspaceLabel(for: session, showsWorkspace: showsWorkspace)
        ].compactMap(\.self)

        return parts.isEmpty ? nil : parts.joined(separator: " • ")
    }

    /// Emphasizes every case-insensitive occurrence of `query` in `preview`.
    /// Foundation's search is canonical-equivalence aware, so a composed query
    /// still highlights a decomposed excerpt and vice versa; text the server
    /// redacted simply has no hit to emphasize.
    static func highlightedPreview(_ preview: String, query rawQuery: String) -> AttributedString {
        var result = AttributedString(preview)
        // The excerpt arrives whitespace-collapsed, so the query must be too or a
        // doubled space in the search box would leave a real hit unemphasized.
        let query = rawQuery.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !query.isEmpty else { return result }

        var searchRange = preview.startIndex..<preview.endIndex
        while let hit = preview.range(of: query, options: .caseInsensitive, range: searchRange),
              let attributedHit = Range(hit, in: result) {
            result[attributedHit].foregroundColor = .primary
            result[attributedHit].font = AppFont.caption(weight: .semibold)
            searchRange = hit.upperBound..<preview.endIndex
        }

        return result
    }

    static func accessibilityStateLabels(
        for session: SessionSummary,
        isViewingCachedData: Bool
    ) -> [String] {
        var labels: [String] = []

        if isActiveStreaming(session) {
            labels.append(String(localized: "Streaming"))
        }

        if session.pinned == true {
            labels.append(String(localized: "Pinned"))
        }

        if isViewingCachedData {
            labels.append(String(localized: "Cached"))
        }

        return labels
    }

    private var displayTitle: String {
        Self.displayTitle(for: session)
    }

    private static func messageCountLabel(for session: SessionSummary, showsMessageCount: Bool) -> String? {
        guard showsMessageCount else { return nil }
        guard let count = session.messageCount, count >= 0 else { return nil }
        return String(localized: "\(count) messages")
    }

    private static func workspaceLabel(for session: SessionSummary, showsWorkspace: Bool) -> String? {
        guard showsWorkspace else { return nil }
        guard let workspace = session.workspace?.trimmingCharacters(in: .whitespacesAndNewlines),
              !workspace.isEmpty
        else {
            return nil
        }

        let lastPathComponent = (workspace as NSString).lastPathComponent
        return lastPathComponent.isEmpty ? workspace : lastPathComponent
    }

    private var metadataLabel: String? {
        Self.metadataLabel(
            for: session,
            showsMessageCount: showsMessageCount,
            showsWorkspace: showsWorkspace
        )
    }

    private var rowContent: some View {
        VStack(alignment: .leading, spacing: rowContentSpacing) {
            titleArea

            if showsSupplementalContent {
                supplementalArea
            }

            if let matchPreview {
                Text(Self.highlightedPreview(matchPreview, query: searchText))
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
                    .lineLimit(metadataLineLimit + 1)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var titleArea: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 3) {
                titleAndPin

                if let relativeDate {
                    relativeDateText(relativeDate)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                titleAndPin

                if let relativeDate {
                    Spacer(minLength: 8)

                    relativeDateText(relativeDate)
                }
            }
        }
    }

    private var titleAndPin: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(displayTitle)
                .font(AppFont.headline(weight: .semibold))
                .foregroundStyle(.primary)
                .lineLimit(titleLineLimit)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .layoutPriority(2)

            if session.pinned == true {
                Image(systemName: "pin.fill")
                    .font(.system(size: pinnedIconSize, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
    }

    private func relativeDateText(_ text: String) -> some View {
        Text(text)
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var supplementalArea: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                if !visibleStateBadges.isEmpty {
                    stateBadgesRow
                }

                if let metadataLabel {
                    metadataText(metadataLabel)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                if !visibleStateBadges.isEmpty {
                    stateBadgesRow
                }

                if let metadataLabel {
                    metadataText(metadataLabel)
                }
            }
        }
    }

    private var stateBadgesRow: some View {
        HStack(spacing: 5) {
            ForEach(visibleStateBadges) { badge in
                SessionRowStateBadge(badge: badge)
            }
        }
    }

    private func metadataText(_ text: String) -> some View {
        Text(text)
            .font(AppFont.caption())
            .foregroundStyle(.secondary)
            .lineLimit(metadataLineLimit)
            .truncationMode(.middle)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var visibleStateBadges: [SessionRowStateBadgeKind] {
        var badges: [SessionRowStateBadgeKind] = []

        if Self.isActiveStreaming(session) {
            badges.append(.streaming)
        }

        if isViewingCachedData {
            badges.append(.cached)
        }

        return badges
    }

    private var showsSupplementalContent: Bool {
        metadataLabel != nil || !visibleStateBadges.isEmpty
    }

    private var rowContentSpacing: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 6 : 4
    }

    private var rowMinimumHeight: CGFloat {
        showsSupplementalContent ? 54 : 46
    }

    private var titleLineLimit: Int {
        dynamicTypeSize.isAccessibilitySize ? 3 : 2
    }

    private var metadataLineLimit: Int {
        dynamicTypeSize.isAccessibilitySize ? 3 : 1
    }

    private var streamingIndicatorTopPadding: CGFloat {
        dynamicTypeSize.isAccessibilitySize ? 8 : 7
    }

    private var relativeDate: String? {
        let timestamp = session.lastMessageAt ?? session.updatedAt ?? session.createdAt
        guard let timestamp, timestamp > 0 else { return nil }

        return SessionRelativeDateFormatter.shared.localizedString(
            for: Date(timeIntervalSince1970: timestamp),
            relativeTo: Date()
        )
    }

    private var accessibilitySummary: String {
        var parts = [displayTitle]

        parts.append(contentsOf: Self.accessibilityStateLabels(for: session, isViewingCachedData: isViewingCachedData))

        if let metadataLabel {
            parts.append(metadataLabel)
        }

        if let matchPreview {
            parts.append(matchPreview)
        }

        if let relativeDate {
            parts.append(relativeDate)
        }

        return parts.joined(separator: ", ")
    }
}

enum SessionRowStateBadgeKind: String, Identifiable {
    case streaming
    case cached

    var id: String { rawValue }

    var title: String {
        switch self {
        case .streaming:
            return String(localized: "Live")
        case .cached:
            return String(localized: "Cached")
        }
    }

    var tint: Color {
        switch self {
        case .streaming:
            return .green
        case .cached:
            return .orange
        }
    }
}

private enum SessionRelativeDateFormatter {
    static let shared: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

enum SessionRowDisplaySettings {
    static let showMessageCountKey = "sessionRow.showMessageCount"
    static let showWorkspaceKey = "sessionRow.showWorkspace"
    // Cron, webhook, and CLI sessions default to shown; delegated subagents default to
    // hidden. Each kind has an independent visibility control.
    static let showCronSessionsKey = "sessionRow.showCronSessions"
    static let showWebhookSessionsKey = "sessionRow.showWebhookSessions"
    static let showSubagentSessionsKey = "sessionRow.showSubagentSessions"
    static let defaultShowsSubagentSessions = false
    // Legacy global CLI-sessions key. Since #19 the CLI toggle is stored
    // per-server (it mirrors the server's own `show_cli_sessions` setting, and a
    // value adopted from server A must not leak to server B); this key survives
    // only as the migration seed for servers with no per-server value yet.
    static let showCliSessionsKey = "sessionRow.showCliSessions"
    static let showClaudeCodeSessionsKey = "sessionRow.showClaudeCodeSessions"

    /// Per-server storage key for the CLI-sessions toggle (#19). Keyed by the
    /// active server's absolute URL, matching how the offline cache scopes rows.
    static func showCliSessionsKey(for server: URL) -> String {
        "\(showCliSessionsKey)|\(server.absoluteString)"
    }

    static func showClaudeCodeSessionsKey(for server: URL) -> String {
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
    static func showsCliSessions(for server: URL, in defaults: UserDefaults = .standard) -> Bool {
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
    static func showsClaudeCodeSessions(
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

    static func showsWebhookSessions(in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: showWebhookSessionsKey) as? Bool ?? true
    }
}

enum SessionSidebarDisclosureSettings {
    static let profilesAreExpandedKey = "sessionSidebar.profilesAreExpanded"
    static let projectsAreExpandedKey = "sessionSidebar.projectsAreExpanded"
    static let scheduledSessionsAreExpandedKey = "sessionSidebar.scheduledSessionsAreExpanded"
    static let webhookSessionsAreExpandedKey = "sessionSidebar.webhookSessionsAreExpanded"
    static let defaultProfilesAreExpanded = false
    static let defaultProjectsAreExpanded = false
    static let defaultScheduledSessionsAreExpanded = false
    static let defaultWebhookSessionsAreExpanded = false

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

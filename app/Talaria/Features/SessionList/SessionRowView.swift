import SwiftUI
import TalariaKit

/// How a session row lays out: the regular list row, or a run card for the Duo's tent pose (TAL-1460).
enum SessionRowStyle: Equatable {
    case regular
    case sidebar
    case monitor(ChatActiveRunStatusPresentation)
}

struct SessionRowView: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ScaledMetric(relativeTo: .caption2) private var pinnedIconSize: CGFloat = 11
    @ScaledMetric(relativeTo: .body) private var verticalPadding: CGFloat = 8
    @ScaledMetric(relativeTo: .body) private var sidebarMinimumHeight: CGFloat = 44
    /// Two run cards fill the outer display's landscape list.
    @ScaledMetric(relativeTo: .title2) private var monitorMinimumHeight: CGFloat = 150
    @ScaledMetric(relativeTo: .title2) private var monitorIconSize: CGFloat = 36

    let session: SessionSummary
    var isViewingCachedData = false
    /// Server-redacted excerpt around a content-search hit (TAL-164); nil for
    /// title-only matches and rows outside a search.
    var matchPreview: String? = nil
    /// The search text the excerpt is highlighted against.
    var searchText = ""
    var pendingChange: PendingResourceChange? = nil
    var style = SessionRowStyle.regular

    var body: some View {
        switch style {
        case .sidebar:
            sidebarRow
        case .regular:
            regularRow
                .transition(.opacity)
        case .monitor(let runStatus):
            if runStatus.runStartedAt != nil {
                // The elapsed time is text, so redraw it each second.
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    monitorRow(runStatus, now: context.date)
                }
                .transition(.opacity)
            } else {
                monitorRow(runStatus, now: .now)
                    .transition(.opacity)
            }
        }
    }

    private var sidebarRow: some View {
        HStack(spacing: 8) {
            Text(displayTitle)
                .font(.body)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .truncationMode(.tail)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if SessionRowPresentation.isActiveStreaming(session) {
                ActiveSessionStreamingIndicator()
            }
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: pinnedIconSize, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }
        }
        .foregroundStyle(.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, verticalPadding)
        .frame(minHeight: sidebarMinimumHeight)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([accessibilitySummary, pendingStatus].compactMap { $0 }.joined(separator: ", "))
    }

    /// Title at `.title2`, phase and elapsed time at `.title3`, the provider icon, and "Needs you" while the run waits.
    private func monitorRow(_ runStatus: ChatActiveRunStatusPresentation, now: Date) -> some View {
        // No list status label names the agent.
        let phase = runStatus.label(agentName: "")
        let elapsed = runStatus.elapsedTime(now: now)
        return HStack(alignment: .center, spacing: 14) {
            if let provider = session.modelProvider {
                ProviderIconView(providerID: provider, label: provider, size: monitorIconSize)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(displayTitle)
                    .font(AppFont.title2(weight: .semibold))
                    .foregroundStyle(.primary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text(phase)
                    if let elapsed {
                        Text(elapsed)
                            .monospacedDigit()
                    }
                }
                .font(AppFont.title3())
                .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if runStatus.isAwaitingUser {
                SessionRowStateBadge(badge: .needsYou, font: AppFont.headline(weight: .semibold))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 16)
        .frame(minHeight: monitorMinimumHeight, alignment: .center)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            [displayTitle, phase, runStatus.accessibilityElapsedTime(now: now), runStatus.isAwaitingUser ? SessionRowStateBadgeKind.needsYou.title : nil]
                .compactMap { $0 }
                .joined(separator: ", ")
        )
        .accessibilityIdentifier("session-run-card")
    }

    private var regularRow: some View {
        HStack(alignment: .top, spacing: 10) {
            if SessionRowPresentation.isActiveStreaming(session) {
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
        .accessibilityLabel([accessibilitySummary, pendingStatus].compactMap { $0 }.joined(separator: ", "))
    }

    private var displayTitle: String {
        pendingChange?.title ?? SessionRowPresentation.displayTitle(for: session)
    }

    private var isPinned: Bool { (pendingChange?.pinned ?? session.pinned) == true }
    private var pendingStatus: String? { pendingChange?.pinned == nil ? pendingChange?.status : nil }

    private var metadataLabel: String? {
        SessionRowPresentation.metadataLabel(for: session)
    }

    private var rowContent: some View {
        VStack(alignment: .leading, spacing: rowContentSpacing) {
            titleArea
            if let pendingStatus {
                Text(pendingStatus)
                    .font(AppFont.caption())
                    .foregroundStyle(.secondary)
            }

            if showsSupplementalContent {
                supplementalArea
            }

            if let matchPreview {
                Text(SessionRowPresentation.highlightedPreview(matchPreview, query: searchText))
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
                titleText

                if showsTrailingMeta {
                    trailingMeta
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                titleText

                if showsTrailingMeta {
                    Spacer(minLength: 8)

                    trailingMeta
                }
            }
        }
    }

    private var titleText: some View {
        Text(displayTitle)
            .font(AppFont.headline(weight: .semibold))
            .foregroundStyle(.primary)
            .lineLimit(titleLineLimit)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .layoutPriority(2)
    }

    private var showsTrailingMeta: Bool {
        isPinned || relativeDate != nil
    }

    /// The pin sits beside the timestamp so every pinned row shows it in the same place,
    /// however the title wraps (TAL-482).
    private var trailingMeta: some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: pinnedIconSize, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .accessibilityHidden(true)
            }

            if let relativeDate {
                relativeDateText(relativeDate)
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

        if SessionRowPresentation.isActiveStreaming(session) {
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
        guard let timestamp = session.sortTimestamp, timestamp > 0 else { return nil }

        return SessionRelativeDateFormatter.shared.localizedString(
            for: Date(timeIntervalSince1970: timestamp),
            relativeTo: Date()
        )
    }

    private var accessibilitySummary: String {
        var parts = [displayTitle]

        parts.append(contentsOf: SessionRowPresentation.accessibilityStateLabels(for: session, isViewingCachedData: isViewingCachedData,
                                                                               pinned: pendingChange?.pinned))

        let spokenMetadata = style == .sidebar
            ? SessionRowPresentation.metadataLabel(for: session)
            : metadataLabel
        if let spokenMetadata { parts.append(spokenMetadata) }

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
    case needsYou

    var id: String { rawValue }

    var title: String {
        switch self {
        case .streaming:
            return String(localized: "Live")
        case .cached:
            return String(localized: "Cached")
        case .needsYou:
            return String(localized: "Needs you")
        }
    }

    var tint: Color {
        switch self {
        case .streaming:
            return .green
        case .cached:
            return .orange
        case .needsYou:
            return .red
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

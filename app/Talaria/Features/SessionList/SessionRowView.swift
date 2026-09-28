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
        .accessibilityLabel(accessibilitySummary)
    }

    private var displayTitle: String {
        SessionRowPresentation.displayTitle(for: session)
    }

    private var metadataLabel: String? {
        SessionRowPresentation.metadataLabel(
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
        let timestamp = session.lastMessageAt ?? session.updatedAt ?? session.createdAt
        guard let timestamp, timestamp > 0 else { return nil }

        return SessionRelativeDateFormatter.shared.localizedString(
            for: Date(timeIntervalSince1970: timestamp),
            relativeTo: Date()
        )
    }

    private var accessibilitySummary: String {
        var parts = [displayTitle]

        parts.append(contentsOf: SessionRowPresentation.accessibilityStateLabels(for: session, isViewingCachedData: isViewingCachedData))

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

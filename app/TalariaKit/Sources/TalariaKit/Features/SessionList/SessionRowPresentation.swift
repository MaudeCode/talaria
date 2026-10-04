import SwiftUI

public enum SessionRowPresentation {
    public static func displayTitle(for session: SessionSummary) -> String {
        let title = session.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let title, !title.isEmpty else {
            return String(localized: "Untitled Session")
        }
        return title
    }

    public static func isActiveStreaming(_ session: SessionSummary) -> Bool {
        session.isStreaming == true
    }

    public static func metadataLabel(
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
    public static func highlightedPreview(_ preview: String, query rawQuery: String) -> AttributedString {
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

    public static func accessibilityStateLabels(
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

    private static func messageCountLabel(for session: SessionSummary, showsMessageCount: Bool) -> String? {
        guard showsMessageCount else { return nil }
        guard let count = session.messageCount, count >= 0 else { return nil }
        return String(localized: "\(count) messages")
    }

    /// The server names the workspace (TAL-303); a row without a name shows none.
    private static func workspaceLabel(for session: SessionSummary, showsWorkspace: Bool) -> String? {
        guard showsWorkspace,
              let name = session.workspaceName?.trimmingCharacters(in: .whitespacesAndNewlines),
              !name.isEmpty
        else {
            return nil
        }

        return name
    }
}

import MarkdownUI
import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Visual references only. The behaviour behind these surfaces is asserted in
/// `SessionListMutationTests`, `ChatAttachmentCoordinatorTests` and friends;
/// nothing here asserts on anything but pixels.
@MainActor
final class AppScreenVisualReferenceTests: XCTestCase {
    private static let rowSize = CGSize(width: 390, height: 76)

    func testSessionRowReferences() throws {
        let session = try makeSession()

        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                SessionRowView(session: session),
                named: "session-row-\(name(for: scheme))",
                size: Self.rowSize,
                colorScheme: scheme
            )
        }
    }

    /// `SessionRowView` stacks the title and relative date vertically once the
    /// text size is an accessibility size, so the layout materially changes.
    func testSessionRowAccessibilityTextSizeReference() throws {
        try VisualReference.assertMatchesReference(
            SessionRowView(session: try makeSession()),
            named: "session-row-accessibility3",
            size: CGSize(width: 390, height: 320),
            dynamicTypeSize: .accessibility3
        )
    }

    func testSessionListEmptyStateReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                SessionListStatusRow(
                    title: "No sessions yet",
                    description: "Start a chat and it shows up here.",
                    systemImage: "bubble.left.and.bubble.right"
                )
                .padding(.horizontal, 16),
                named: "session-list-empty-\(name(for: scheme))",
                size: Self.rowSize,
                colorScheme: scheme
            )
        }
    }

    func testOfflineBannerReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                ChatOfflineCacheBanner(),
                named: "chat-offline-banner-\(name(for: scheme))",
                size: CGSize(width: 390, height: 44),
                colorScheme: scheme
            )
        }
    }

    /// The shared status chip's surface, padding, type and every emphasis, through its symbol
    /// form. The activity form's `ProgressView` draws as a placeholder under `ImageRenderer`.
    func testStatusChipReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                VStack(spacing: 8) {
                    StatusChip(label: "Updated", icon: .symbol("checkmark"))
                    StatusChip(label: "Relay paired", icon: .symbol("antenna.radiowaves.left.and.right"), emphasis: .prominent)
                    StatusChip(label: "Approval bypass active", icon: .symbol("bolt.slash.fill"), emphasis: .warning)
                }
                .padding(.horizontal, 16),
                named: "status-chip-\(name(for: scheme))",
                size: CGSize(width: 390, height: 132),
                colorScheme: scheme
            )
        }
    }

    /// TAL-2337: the run status chip naming the running call at phone width: its kind's icon and label, a long label cut
    /// short before the elapsed time, and a held call's "Waiting for approval" in the warning colour.
    func testRunStatusToolChipReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                VStack(spacing: 8) {
                    StatusChip(label: "Running npm test", icon: .symbol("circle.dotted"), toolIcon: "terminal", elapsed: "34s")
                    StatusChip(label: "Searching the web for hermes agent 0.24 changelog", icon: .symbol("circle.dotted"), toolIcon: "globe", elapsed: "1m")
                    StatusChip(label: "Waiting for approval", icon: .symbol("circle.dotted"), toolIcon: "terminal", emphasis: .attention, elapsed: "12s")
                }
                .padding(.horizontal, 16),
                named: "run-status-tool-chip-\(name(for: scheme))",
                size: CGSize(width: 390, height: 132),
                colorScheme: scheme
            )
        }
    }

    /// `ChatTranscriptLoadingSkeletonView` wraps these rows in a `ScrollView`,
    /// which `ImageRenderer` draws empty, so the reference covers the rows the
    /// loading state is actually made of.
    func testTranscriptLoadingSkeletonReference() throws {
        try VisualReference.assertMatchesReference(
            VStack(spacing: 12) {
                ForEach(ChatTranscriptSkeletonRowConfiguration.loadingRows) { row in
                    ChatTranscriptLoadingSkeletonRow(configuration: row)
                }
            }
            .padding(.horizontal),
            named: "chat-transcript-loading-light",
            size: CGSize(width: 390, height: 320)
        )
    }

    func testAttachmentThumbnailReferences() throws {
        let image = PendingAttachment(
            id: Self.fixtureID,
            name: "diagram.png",
            path: "/uploads/diagram.png",
            mime: "image/png",
            size: 48_120,
            isImage: true,
            thumbnailData: Self.thumbnailData
        )
        let document = PendingAttachment(
            id: Self.fixtureID,
            name: "upstream-contract.md",
            path: "/uploads/upstream-contract.md",
            mime: "text/markdown",
            size: 12_400,
            isImage: false
        )

        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                thumbnail(for: image),
                named: "attachment-image-\(name(for: scheme))",
                size: CGSize(width: 80, height: 80),
                colorScheme: scheme
            )
        }

        try VisualReference.assertMatchesReference(
            ComposerFileLinkView(attachment: document, onRemove: {}, onOpen: {}),
            named: "attachment-document-light",
            size: CGSize(width: 260, height: 60)
        )
    }

    /// A disabled skill dims its text but keeps the switch that turns it back on at full
    /// strength (TAL-467). `ImageRenderer` draws the switch as its UIKit placeholder, whose
    /// colour still shows whether the switch's slot was dimmed.
    func testDisabledSkillRowReferences() throws {
        let skill = SkillSummary(
            name: "fixture-archivist",
            category: "Fixture",
            description: "Archives deterministic fixture output.",
            path: nil,
            disabled: true,
            tags: ["fixture"]
        )

        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                SkillRows(
                    skills: [skill],
                    selection: .constant(nil),
                    togglingSkillNames: [],
                    onToggleSkill: { _, _ in }
                )
                .padding(.horizontal, 16),
                named: "skill-row-disabled-\(name(for: scheme))",
                size: CGSize(width: 390, height: 130),
                colorScheme: scheme
            )
        }
    }

    /// The quota detail's windows block with two live windows, their server pace and forecast, and a fixed clock (TAL-1750).
    func testProviderQuotaWindowsReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                try InsightsHostedTests.quotaWindowsView(InsightsHostedTests.pacedSource)
                    .padding(16)
                    .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16),
                named: "insights-quota-windows-\(name(for: scheme))",
                size: CGSize(width: 390, height: 500),
                colorScheme: scheme,
                background: Color(.systemGroupedBackground)
            )
        }
    }

    /// The daily chart's stacked input and output bars over a month, with its legend and axes (TAL-764).
    func testInsightsDailyChartReferences() throws {
        let days = try InsightsHostedTests.dailySeries(InsightsHostedTests.consecutiveDays(30))
        let variants: [(String, ColorScheme, DynamicTypeSize, CGSize)] = [
            ("light", .light, .large, CGSize(width: 390, height: 270)),
            ("dark", .dark, .large, CGSize(width: 390, height: 270)),
            ("accessibility3", .light, .accessibility3, CGSize(width: 390, height: 360)),
        ]
        for (variant, scheme, typeSize, size) in variants {
            try VisualReference.assertMatchesReference(
                InsightsDailyChart(days: days, metric: .tokens).padding(16),
                named: "insights-daily-chart-\(variant)",
                size: size,
                colorScheme: scheme,
                dynamicTypeSize: typeSize
            )
        }
    }

    // MARK: - Fixtures

    private static let fixtureID = UUID(uuidString: "00000000-0000-0000-0000-0000000000A1")!

    /// Flat two-tone bitmap, so the reference never depends on an asset or on
    /// image-decoding differences between runtime builds.
    private static let thumbnailData: Data = {
        UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor(red: 0.16, green: 0.44, blue: 0.86, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
            UIColor(red: 0.98, green: 0.78, blue: 0.24, alpha: 1).setFill()
            context.fill(CGRect(x: 8, y: 24, width: 48, height: 16))
        }.pngData()!
    }()

    private func thumbnail(for attachment: PendingAttachment) -> some View {
        ComposerAttachmentThumbnailView(attachment: attachment, onRemove: {}, onOpen: {})
    }

    /// A chat table is a reading table like Web's (TAL-2320): row separators with a stronger header rule,
    /// no cell grid, no fills. Rendered without its horizontal `ScrollView`, which `ImageRenderer` draws empty.
    func testChatMarkdownTableReferences() throws {
        let variants: [(String, ColorScheme, DynamicTypeSize, CGSize)] = [
            ("light", .light, .large, CGSize(width: 390, height: 260)),
            ("dark", .dark, .large, CGSize(width: 390, height: 260)),
            ("accessibility3", .light, .accessibility3, CGSize(width: 390, height: 600)),
        ]
        for (variant, scheme, typeSize, size) in variants {
            try VisualReference.assertMatchesReference(
                Markdown(Self.chatTableMarkdown)
                    .markdownBlockStyle(\.table) { ChatMarkdownTable.readingTable($0.label) }
                    .markdownTheme(.chat(colorScheme: scheme, isStreaming: false))
                    .padding(16)
                    .frame(width: size.width, height: size.height, alignment: .topLeading),
                named: "chat-table-\(variant)",
                size: size,
                colorScheme: scheme,
                dynamicTypeSize: typeSize
            )
        }
    }

    private static let chatTableMarkdown = """
    | Check | Result |
    | --- | --- |
    | Lint | Passed |
    | Unit tests | 412 passed |
    | Hosted tests | Passed after the simulator pool handed out a fresh device |
    | Visual references | Passed |
    | Release notes | Passed |
    """

    /// Decoding matches how the app builds summaries, and the relative-date
    /// label, which reads the server's `sort_ts`, is anchored to a whole number
    /// of days before the render so it reads the same on every run.
    private func makeSession() throws -> SessionSummary {
        let sortTs = Date().addingTimeInterval(-3 * 24 * 60 * 60).timeIntervalSince1970
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data("""
            {
              "session_id": "session-visual-reference",
              "title": "Wire the relay pairing handshake",
              "workspace": "/Users/talaria/git/hermes-webui",
              "workspace_name": "hermes-webui",
              "message_count": 42,
              "sort_ts": \(sortTs),
              "pinned": true
            }
            """.utf8)
        )
    }

    private func name(for scheme: ColorScheme) -> String {
        scheme == .dark ? "dark" : "light"
    }
}

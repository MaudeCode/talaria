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

    /// The shared status chip's surface, padding and type, through its symbol form. The activity
    /// form's `ProgressView` draws as a placeholder under `ImageRenderer`, so it is not referenced.
    func testStatusChipReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            try VisualReference.assertMatchesReference(
                StatusChip(label: "Approval bypass active", icon: .symbol("bolt.slash.fill"))
                    .padding(.horizontal, 16),
                named: "status-chip-symbol-\(name(for: scheme))",
                size: CGSize(width: 390, height: 48),
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
                size: CGSize(width: 140, height: 140),
                colorScheme: scheme
            )
        }

        try VisualReference.assertMatchesReference(
            thumbnail(for: document),
            named: "attachment-document-light",
            size: CGSize(width: 260, height: 120)
        )
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

    /// Decoding matches how the app builds summaries, and the relative-date
    /// label is anchored to a whole number of days before the render so it
    /// reads the same on every run.
    private func makeSession() throws -> SessionSummary {
        let lastMessageAt = Date().addingTimeInterval(-3 * 24 * 60 * 60).timeIntervalSince1970
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            SessionSummary.self,
            from: Data("""
            {
              "session_id": "session-visual-reference",
              "title": "Wire the relay pairing handshake",
              "workspace": "/Users/talaria/git/hermes-webui",
              "message_count": 42,
              "last_message_at": \(lastMessageAt),
              "pinned": true
            }
            """.utf8)
        )
    }

    private func name(for scheme: ColorScheme) -> String {
        scheme == .dark ? "dark" : "light"
    }
}

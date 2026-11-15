import SwiftUI
import WidgetKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1479: the Needs you widget's families, its stale state and its tap target, then its visual references.
@MainActor
final class NeedsYouWidgetTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testCircularShowsTheWaitingCount() {
        XCTAssertEqual(view(rows: 0, family: .accessoryCircular).rows.count, 0)
        XCTAssertEqual(view(rows: 0, family: .accessoryCircular).inlineText, "Nothing needs you")
        XCTAssertEqual(view(rows: 1, family: .accessoryCircular).rows.count, 1)
        XCTAssertEqual(view(rows: 1, family: .accessoryCircular).inlineText, "1 chat needs you")
        XCTAssertEqual(view(rows: 12, family: .accessoryCircular).rows.count, 12)
        XCTAssertEqual(view(rows: 12, family: .accessoryCircular).inlineText, "12 chats need you")
    }

    func testRectangularCountsTheRowsBeyondTheFirst() {
        XCTAssertNil(view(rows: 1, family: .accessoryRectangular).moreText(shown: 1))
        XCTAssertEqual(view(rows: 3, family: .accessoryRectangular).moreText(shown: 1), "+2 more")
        XCTAssertNil(view(rows: 3, family: .systemSmall).moreText(shown: NeedsYouWidgetView.smallRowLimit))
    }

    func testAStaleSnapshotSaysWaiting() {
        XCTAssertFalse(view(rows: 2, family: .accessoryInline, age: NeedsYouSnapshot.staleAfter).isStale)
        let stale = view(rows: 2, family: .accessoryInline, age: NeedsYouSnapshot.staleAfter + 1)
        XCTAssertTrue(stale.isStale)
        XCTAssertEqual(stale.inlineText, "Waiting")
    }

    func testATapOpensTheFirstWaitingChatOnItsServer() throws {
        let url = try XCTUnwrap(view(rows: 3, family: .accessoryRectangular).widgetURL)
        XCTAssertEqual(url, TalariaDeepLink.sessionURL(sessionID: "s-0", publisherID: "https://example.test"))
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "s-0")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), "https://example.test")
        XCTAssertEqual(view(rows: 0, family: .systemSmall).widgetURL, TalariaDeepLink.openAppURL)
    }

    // MARK: Visual references

    func testCircularReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            for count in [0, 1, 12] {
                try VisualReference.assertMatchesReference(
                    view(rows: count, family: .accessoryCircular),
                    named: "needs-you-circular-\(count)-\(scheme == .dark ? "dark" : "light")",
                    size: CGSize(width: 72, height: 72), colorScheme: scheme
                )
            }
        }
    }

    func testRectangularReferences() throws {
        for scheme in [ColorScheme.light, .dark] {
            let suffix = scheme == .dark ? "dark" : "light"
            for count in [1, 3] {
                try VisualReference.assertMatchesReference(
                    view(rows: count, family: .accessoryRectangular),
                    named: "needs-you-rectangular-\(count)-\(suffix)",
                    size: CGSize(width: 170, height: 72), colorScheme: scheme
                )
            }
            try VisualReference.assertMatchesReference(
                view(rows: 3, family: .accessoryRectangular, age: NeedsYouSnapshot.staleAfter + 1),
                named: "needs-you-rectangular-stale-\(suffix)",
                size: CGSize(width: 170, height: 72), colorScheme: scheme
            )
        }
    }

    private func view(rows count: Int, family: WidgetFamily, age: TimeInterval = 60) -> NeedsYouWidgetView {
        let titles = ["Deploy fix", "Release notes", "Rotate keys"]
        let rows = (0..<count).map { index in
            NeedsYouSnapshot.Row(
                sessionID: "s-\(index)", title: titles[index % titles.count],
                phase: index == 1 ? "waiting_for_input" : "waiting_for_approval", serverID: "https://example.test"
            )
        }
        return NeedsYouWidgetView(
            snapshot: NeedsYouSnapshot(updatedAt: now.addingTimeInterval(-age), rows: rows), date: now, family: family
        )
    }
}

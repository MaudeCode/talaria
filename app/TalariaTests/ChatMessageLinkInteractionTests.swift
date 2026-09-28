import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// Proves the geometry end of the pipeline: a rendered mixed text-and-link
/// paragraph reports where its link was actually drawn.
@MainActor
final class ChatMarkdownLinkGeometryTests: XCTestCase {
    func testRenderedParagraphReportsItsLinkRect() throws {
        let store = try renderRegions(
            content: "FixturePlainLead words before [FixtureLinkTarget](https://example.invalid/fixture-link) and trailing words after."
        )
        let regions = store.regions()

        XCTAssertFalse(regions.isEmpty, "The rendered link reported no hit target")
        XCTAssertEqual(regions.first?.url, URL(string: "https://example.invalid/fixture-link"))
        for region in regions {
            XCTAssertGreaterThan(region.rect.width, 0)
            XCTAssertLessThan(region.rect.width, paragraphWidth)
            XCTAssertGreaterThan(region.rect.height, 0)
        }
    }

    /// Links live in table cells too, which render through their own block style.
    func testRenderedTableCellReportsItsLinkRect() throws {
        let store = try renderRegions(content: """
        | head | link |
        | --- | --- |
        | cell | [FixtureCellLink](https://example.invalid/cell) |
        """)

        XCTAssertEqual(
            store.regions().map(\.url),
            [URL(string: "https://example.invalid/cell")],
            "A link inside a table cell reported no hit target"
        )
    }

    /// The streaming fade is drawn by a text renderer of its own; tracking a
    /// link inside a streaming paragraph would replace it.
    func testStreamingParagraphReportsNoRegions() throws {
        let store = ChatMessageLinkRegionStore()
        try host(
            ChatMarkdownView(
                content: "words before [FixtureLinkTarget](https://example.invalid/x) and after.",
                colorScheme: .light,
                isStreaming: true
            )
            .environment(\.chatMessageLinkRegionStore, store)
        )

        XCTAssertEqual(store.regions(), [], "A streaming paragraph must leave its fade renderer in place")
    }

    func testParagraphWithoutLinksReportsNoRegions() throws {
        let store = try renderRegions(content: "FixturePlainLead words with no link at all in this paragraph.")
        XCTAssertEqual(store.regions(), [])
    }

    /// `MarkdownRenderer` also renders memory, skills, workspace previews and
    /// Kanban cards. Only a transcript row tracks links there — and only a
    /// transcript row trades inline selection for that tracking.
    func testMarkdownRendererTracksLinksOnlyForATranscriptRow() throws {
        let content = "words before [FixtureLinkTarget](https://example.invalid/x) and after."
        let tracked = ChatMessageLinkRegionStore()
        try host(MarkdownRenderer(content: content).environment(\.chatMessageLinkRegionStore, tracked))
        XCTAssertEqual(tracked.regions().map(\.url), [URL(string: "https://example.invalid/x")])

        let untracked = ChatMessageLinkRegionStore()
        try host(MarkdownRenderer(content: content))
        XCTAssertEqual(untracked.regions(), [], "A view outside a transcript row must not report regions")
    }

    private let paragraphWidth: CGFloat = 320

    /// Renders in a real window: the regions are published from the paragraph's
    /// draw pass, which only a hosted layout performs the way the transcript does.
    private func renderRegions(content: String) throws -> ChatMessageLinkRegionStore {
        let store = ChatMessageLinkRegionStore()
        try host(
            ChatMarkdownView(content: content, colorScheme: .light, isStreaming: false)
                .environment(\.chatMessageLinkRegionStore, store)
        )
        return store
    }

    private func host(_ view: some View) throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = try XCTUnwrap(scene.windows.first { $0.isKeyWindow } ?? scene.windows.first)
        let root = try XCTUnwrap(window.rootViewController)

        let host = UIHostingController(rootView: AnyView(
            view
                .frame(width: paragraphWidth)
                .coordinateSpace(.named(ChatMessageInteraction.rowCoordinateSpace))
        ))
        root.addChild(host)
        host.view.frame = CGRect(x: 0, y: 0, width: paragraphWidth, height: 300)
        root.view.addSubview(host.view)
        host.didMove(toParent: root)
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        addTeardownBlock {
            MainActor.assumeIsolated {
                host.view.removeFromSuperview()
                host.removeFromParent()
            }
        }
    }
}

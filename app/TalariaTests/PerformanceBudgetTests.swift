import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

extension XCTestCase {
    /// `measure` takes a synchronous body, but the paths worth budgeting here
    /// (`KanbanFeatureState.load`, a `ChatViewModel` replay) are main-actor and
    /// async. This runs one iteration to completion on the main actor and keeps
    /// the metrics attached to the caller's test case.
    func measureAsync(
        metrics: [any XCTMetric],
        options: XCTMeasureOptions,
        timeout: TimeInterval = 120,
        _ body: @escaping @MainActor (XCTestCase) async throws -> Void
    ) {
        measure(metrics: metrics, options: options) {
            let iteration = expectation(description: "Performance iteration")
            Task { @MainActor in
                defer { iteration.fulfill() }
                do {
                    try await body(self)
                } catch {
                    XCTFail("Performance iteration failed: \(error)")
                }
            }
            wait(for: [iteration], timeout: timeout)
        }
    }

    /// Three iterations, matching the repo's existing performance budgets:
    /// enough for XCTest to report a spread, cheap enough to leave in CI.
    func performanceOptions(manualWindow: Bool = false, iterations: Int = 3) -> XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = iterations
        if manualWindow {
            options.invocationOptions = [.manuallyStart, .manuallyStop]
        }
        return options
    }
}

/// Dense Kanban load and filter (TAL-75).
///
/// The Board view reads `statusCount` for every column and then
/// `groupedVisibleCards`, and each of those recomputes the search match over
/// every card on the Board. One keystroke in the filter field therefore costs a
/// full pass per column, which is why the budget covers load plus filtering
/// rather than load alone.
final class KanbanBoardPerformanceTests: KanbanDefaultsTestCase {
    /// A Board far denser than the fixture's four cards, and denser than a
    /// healthy real Board — enough that a per-card regression is visible
    /// without making the run slow.
    private static let cardCount = 1_200
    private static let statuses = ["triage", "todo", "ready", "running", "blocked", "done"]

    func testDenseBoardLoadAndFilter() {
        let snapshot = Self.denseSnapshot()

        measureAsync(metrics: [XCTClockMetric(), XCTMemoryMetric()], options: performanceOptions()) { _ in
            let state = KanbanFeatureState(
                server: URL(string: "https://example.test")!,
                defaults: self.defaults,
                client: KanbanClientStub(boardResult: .success(snapshot))
            )
            await state.load()
            XCTAssertEqual(state.allCards.count, Self.cardCount)

            // One render per filter state, the way the Board reads it.
            for query in ["", "fixture", "card-9", "reviewer", "no-such-card"] {
                state.searchText = query
                for status in Self.statuses {
                    _ = state.statusCount(status)
                }
                _ = state.groupedVisibleCards
            }
        }
    }

    private static func denseSnapshot() -> KanbanBoardSnapshot {
        let columns = statuses.enumerated().map { statusIndex, status -> String in
            let cards = stride(from: statusIndex, to: cardCount, by: statuses.count).map { index in
                """
                {"id":"CARD-\(index)","title":"Fixture card \(index)","status":"\(status)",
                 "assignee":"fixture-\(index.isMultiple(of: 2) ? "builder" : "reviewer")",
                 "tenant":"fixture","body":"Deterministic card body \(index) for the dense Board budget.",
                 "priority":\(index % 3),"comment_count":\(index % 5),"age_seconds":\(index * 7)}
                """
            }
            return #"{"name":"\#(status)","tasks":[\#(cards.joined(separator: ","))]}"#
        }
        return mutationDecode("""
        {"changed":true,"latest_event_id":1,"read_only":false,
         "tenants":["fixture"],"assignees":["fixture-builder","fixture-reviewer"],
         "columns":[\(columns.joined(separator: ","))]}
        """)
    }
}

/// Large image preview preparation (TAL-75).
///
/// `TranscriptMediaPreviewViewModel` hands every previewed image to
/// `ImagePreviewDownsampler`, which decodes the original at full size before
/// producing the preview. That decode is where a large photo costs both time
/// and a memory spike, so it is budgeted directly rather than through the UI.
final class ImagePreviewPerformanceTests: XCTestCase {
    /// A 12 MP frame — a full-size iPhone capture, the largest thing the
    /// transcript preview is realistically asked to downsample.
    private static let pixelWidth = 4_032
    private static let pixelHeight = 3_024

    func testLargeImagePreviewPreparation() throws {
        let original = try XCTUnwrap(Self.deterministicJPEG(), "Could not build the fixture image")

        measure(metrics: [XCTClockMetric(), XCTMemoryMetric()], options: performanceOptions()) {
            let preview = ImagePreviewDownsampler.previewData(
                from: original,
                maxPixelSize: ImagePreviewDownsampler.filePreviewMaxPixelSize
            )
            XCTAssertNotNil(preview, "The preview path produced no data")
        }
    }

    /// A fixed grid over a fixed gradient: the same bytes on every run and on
    /// every machine, and structured enough that JPEG cannot collapse it to a
    /// size the decoder never sees in practice.
    private static func deterministicJPEG() -> Data? {
        let size = CGSize(width: pixelWidth, height: pixelHeight)
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            let tile = 64
            for row in 0..<Int(size.height) / tile {
                for column in 0..<Int(size.width) / tile {
                    let shade = CGFloat((row &* 7 &+ column &* 13) % 256) / 255
                    context.cgContext.setFillColor(
                        red: shade, green: 1 - shade, blue: CGFloat((row &+ column) % 2), alpha: 1
                    )
                    context.cgContext.fill(CGRect(
                        x: column * tile, y: row * tile, width: tile, height: tile
                    ))
                }
            }
        }
        return image.jpegData(compressionQuality: 0.9)
    }
}

/// A 5,000-line `diff` block against the same block drawn plain (TAL-447).
///
/// Prefix tinting adds one prefix check, a background and an accessibility
/// label per line on top of the plain path; the pair of budgets shows that
/// cost directly, so a regression in either path is visible beside the other.
final class DiffCodeBlockPerformanceTests: XCTestCase {
    private static let content = (0..<5_000).map { index in
        switch index % 5 {
        case 0: "@@ -\(index),4 +\(index),4 @@"
        case 1: "-let removed\(index) = \(index)"
        case 2: "+let added\(index) = \(index)"
        default: " let context\(index) = \(index)"
        }
    }.joined(separator: "\n")

    @MainActor
    func testPlainBlockLayout() {
        measureLayout(colorsDiffLines: false)
    }

    @MainActor
    func testDiffBlockLayout() {
        measureLayout(colorsDiffLines: true)
    }

    @MainActor
    private func measureLayout(colorsDiffLines: Bool) {
        measure(metrics: [XCTClockMetric()], options: performanceOptions()) {
            let host = UIHostingController(
                rootView: PlainCodeBlockText(content: Self.content, colorsDiffLines: colorsDiffLines)
            )
            let size = host.sizeThatFits(in: CGSize(width: 390, height: CGFloat.greatestFiniteMagnitude))
            XCTAssertGreaterThan(size.height, 5_000)
        }
    }
}

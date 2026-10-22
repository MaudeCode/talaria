import SwiftUI
import SwiftData
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's transcript rows, hosted in process against the UI fixture's scenarios (TAL-856): what each row
/// says to VoiceOver, its button trait, and where it sits against its neighbours.
@MainActor
final class TranscriptHostedTests: XCTestCase {
    func testRunningToolProgressAndCompletion() throws {
        for (size, name) in [(CGSize(width: 320, height: 844), "phone"), (HostedSize.padLandscape, "pad")] {
            for (state, fields, expected) in [
                ("before", #""done":false"#, false),
                ("running", #""done":false,"progress":{"percent":42,"message":"indexing"}"#, true),
                ("completed", #""done":true,"progress":null"#, false)
            ] {
                let decoder = JSONDecoder()
                decoder.keyDecodingStrategy = .convertFromSnakeCase
                let message = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"assistant","content":"","tool_calls":[{"id":"call-index","name":"mcp__index",\#(fields)}]}"#.utf8))
                let group = try XCTUnwrap(ToolCallGroup.groups(messages: [message], messageOffset: nil).first)
                let window = try hostWindow(ToolActivityGroupView(group: group).padding(), size: size)
                let labels = HostedAccessibility.labels(in: window)
                XCTAssertEqual(labels.contains { $0.contains("42% · indexing") }, expected, "Incorrect progress in \(state): \(labels)")
                attachHostedScreenshot(window, name: "tool-progress-\(state)-\(name)")
                window.isHidden = true
            }
        }
    }

    func testAnimatedNavigationReachesNewlyMountedRichRows() async throws {
        let previousArguments = FixtureLaunchArguments.scenario
        FixtureLaunchArguments.scenario = [UITestFixtureEnvironment.launchArgument]
        addTeardownBlock { FixtureLaunchArguments.scenario = previousArguments }
        for count in [50, 75, 50, 75] {
            let first = 2_000 - count
            let neighbor = (first + 3).isMultiple(of: 2) ? first + 4 : first + 3
            var commands: ChatTranscriptScrollProxy?
            let window = try hostWindow(PagedHistoryTranscript(initialStart: first, richContent: true,
                load: { _ in false }, onScrollRequest: { commands = $0 }), animationsEnabled: true)
            let ready = await awaitCondition { commands != nil }
            XCTAssertTrue(ready)
            let position = try XCTUnwrap(historyObserver(in: window)?.coordinator?.scrollPositionController)
            try XCTUnwrap(commands).scrollTo(id: ChatTranscriptView.containerID(for: "transcript:\(first + 2)"),
                anchor: .top, animation: .easeOut(duration: 0.25))
            let arrived = await awaitCondition {
                position.readingAnchorRowID == ChatTranscriptView.containerID(for: "transcript:\(first + 2)")
                    && HostedAccessibility.elements(in: window).contains {
                        $0.accessibilityLabel?.hasPrefix("History answer \(neighbor).") == true
                    }
            }
            XCTAssertTrue(arrived, "An animated jump must reach the measured destination and admit its rich neighbor; count \(count), reader \(position.readingAnchorRowID ?? "nil")")
            window.isHidden = true
            window.rootViewController = nil
            commands = nil
        }
    }

    func testHistoryInsertionWorkWithAlreadyLoadedRows() async throws {
        // Rich rows must not start live LinkPresentation/WebKit work under XCTest.
        let previousArguments = FixtureLaunchArguments.scenario
        FixtureLaunchArguments.scenario = [UITestFixtureEnvironment.launchArgument]
        addTeardownBlock { FixtureLaunchArguments.scenario = previousArguments }
        var samples: [[String: Double]] = []
        // Repeated hosted readers also exercise deferred scroll/layout handoffs.
        for sample in 0..<6 {
            let count = sample.isMultiple(of: 2) ? 50 : 75
            let first = 2_000 - count
            var requested: [Int] = []
            var started: TimeInterval?
            var inserted: TimeInterval?
            var previousHeight: CGFloat = 0
            var referenceScroll: UIScrollView?
            var readHistory: (() -> Void)?
            defer { readHistory = nil }
            var initialRowBodies = 0
            var oldRowBodies = 0
            var newRowBodies = 0
            let window = try hostWindow(PagedHistoryTranscript(initialStart: first, richContent: true, onMetrics: { _ in
                if started != nil, inserted == nil, let scroll = referenceScroll, scroll.contentSize.height > previousHeight + 1 {
                    inserted = ProcessInfo.processInfo.systemUptime
                }
            }, onInsert: { _ in
                previousHeight = referenceScroll?.contentSize.height ?? 0
                started = ProcessInfo.processInfo.systemUptime
            }, shouldRender: { message in
                if started == nil { initialRowBodies += 1 }
                if started != nil {
                    if let id = message.messageId, Int(id.dropFirst("history-".count)) ?? 0 >= first { oldRowBodies += 1 }
                    else { newRowBodies += 1 }
                }
                return true
            }, onReady: { readHistory = $0 }, onRequest: { cursor in
                requested.append(cursor)
            }))
            let scroll = try XCTUnwrap(historyScroll(in: window))
            referenceScroll = scroll
            try await Task.sleep(for: .milliseconds(150))
            let read = try XCTUnwrap(readHistory)
            read()
            var longestTick: TimeInterval = 0
            for _ in 0..<500 where inserted == nil {
                let tick = ProcessInfo.processInfo.systemUptime
                try await Task.sleep(for: .milliseconds(8))
                longestTick = max(longestTick, ProcessInfo.processInfo.systemUptime - tick)
            }
            let start = try XCTUnwrap(started, "Requests \(requested); initial bodies \(initialRowBodies); viewport \(type(of: scroll)) bounds \(scroll.bounds) offset \(scroll.contentOffset) content \(scroll.contentSize)")
            let end = try XCTUnwrap(inserted, "The real transcript must finish laying out its older page")
            XCTAssertEqual(requested, [first])
            XCTAssertLessThanOrEqual(oldRowBodies, 50, "A 50-row prepend must bound existing-row layout work independently of loaded history")
            samples.append(["alreadyLoadedRows": Double(count), "insertMilliseconds": (end - start) * 1_000,
                            "longestTickMilliseconds": longestTick * 1_000, "oldRowBodies": Double(oldRowBodies),
                            "newRowBodies": Double(newRowBodies)])
            window.isHidden = true
            window.rootViewController = nil
        }
        let data = try JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "History insertion profile"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func testFastUpwardScrollingKeepsLoadingWithoutLeavingThePrefetchRegion() async throws {
        var requested: [Int] = []
        var observedMetrics = false
        let window = try hostWindow(PagedHistoryTranscript(sparseOlderPages: true,
            onMetrics: { _ in observedMetrics = true }, onRequest: { requested.append($0) }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let ready = await awaitCondition {
            guard observedMetrics,
                  let controller = self.historyObserver(in: window)?.coordinator?.scrollPositionController,
                  let geometry = ChatScrollMetrics.geometry(of: scroll) else { return false }
            return !controller.isNavigating && !controller.isRealizingRows
                && geometry.contentHeight > geometry.visibleHeight
        }
        XCTAssertTrue(ready, "The native observer and initial layout must be ready before fast scrolling")
        let coordinator = try XCTUnwrap(historyObserver(in: window)?.coordinator)
        let controller = try XCTUnwrap(coordinator.scrollPositionController)
        // Raw offsets do not send UIKit's drag-began event, which clears the
        // initial bottom anchor before a reader moves through older messages.
        controller.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        // A fast reader repeatedly reaches the loaded edge while a prepend is settling.
        for _ in 0..<150 {
            scroll.contentOffset.y = -scroll.adjustedContentInset.top
            try await Task.sleep(for: .milliseconds(10))
        }
        try await Task.sleep(for: .milliseconds(200))
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        XCTAssertGreaterThanOrEqual(requested.count, 3, "Fast scrolling must keep requesting older pages without an away/back gesture")
        let pages = Array(stride(from: 1_950, through: 50, by: -50))
        XCTAssertEqual(requested, Array(pages.prefix(requested.count)), "Every cursor is requested once; never request past the first page")
        attachHistoryImage(window, name: "Fast upward history after prefetch")
    }

    func testHistoryPrefetchStartsBeforeTheLastViewport() async throws {
        var requests = 0
        var proxy: ChatTranscriptScrollProxy?
        defer { proxy = nil }
        let window = try hostWindow(PagedHistoryTranscript(initialStart: 1_900, load: { _ in requests += 1; return false }, onScrollRequest: { proxy = $0 }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        let native = try XCTUnwrap(proxy)
        // Leave at least three viewports above the reader, outside the old two-viewport buffer.
        native.scrollTo("transcript:1900", anchor: UnitPoint(x: 0.5, y: -3.5))
        for _ in 0..<20 where requests == 0 { try await Task.sleep(for: .milliseconds(25)) }
        let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        XCTAssertGreaterThan(scroll.contentOffset.y + scroll.adjustedContentInset.top, viewportHeight * 3)
        XCTAssertEqual(requests, 1, "Prefetch must start with at least three viewports of history still available")
    }

    func testHistoryInsertionIsPreservedBeforeTheLoaderReturns() async throws {
        try await assertHistoryResponsePreservesReader(holdCompletion: true)
    }

    func testHistoryResponsePreservesWhereTheReaderMovedWhilePageWasInFlight() async throws {
        try await assertHistoryResponsePreservesReader(holdCompletion: false)
    }

    private func assertHistoryResponsePreservesReader(holdCompletion: Bool) async throws {
        var requested: [Int] = []
        var proxy: ChatTranscriptScrollProxy?
        var finishRequest: (() -> Void)?
        var inserted = false
        var laidOut = false
        var referenceScroll: UIScrollView?
        var oldHeight: CGFloat = 0
        var completed = false
        var finishCompletion: (() -> Void)?
        defer { finishRequest?(); finishCompletion?(); proxy = nil; referenceScroll = nil }
        let window = try hostWindow(PagedHistoryTranscript(onMetrics: { _ in
                if inserted, let scroll = referenceScroll, abs(scroll.contentSize.height - oldHeight) > 1 { laidOut = true }
            }, onInsert: { _ in
                oldHeight = referenceScroll?.contentSize.height ?? 0
                inserted = true
            }, onScrollRequest: { proxy = $0 }, onComplete: {
                if holdCompletion {
                    await withCheckedContinuation { continuation in finishCompletion = { continuation.resume() } }
                }
                completed = true
            }, onRequest: { cursor in
                requested.append(cursor)
                await withCheckedContinuation { continuation in finishRequest = { continuation.resume() } }
            }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        referenceScroll = scroll
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        try XCTUnwrap(proxy).scrollTo("transcript:1952", anchor: .top)
        let pending = await awaitCondition { finishRequest != nil }
        XCTAssertTrue(pending)
        XCTAssertEqual(requested, [1950])
        try XCTUnwrap(proxy).scrollTo("transcript:1956", anchor: .top)
        let label = "History row 1956. Synthetic transcript text."
        let before = try await settledReaderY(in: window, scroll: scroll, label: label)
        let release = try XCTUnwrap(finishRequest)
        finishRequest = nil
        release()
        let committed = await awaitCondition { laidOut }
        XCTAssertTrue(committed)
        let during = try await requireElement(in: window, label: label).accessibilityFrame.minY
        XCTAssertEqual(during, before, accuracy: 2, "The insertion must preserve the reader's latest position")
        if holdCompletion {
            XCTAssertFalse(completed, "Position must be restored before the asynchronous loader completes")
        }
        finishCompletion?()
        finishCompletion = nil
        try await Task.sleep(for: .milliseconds(200))
        let after = try await requireElement(in: window, label: label).accessibilityFrame.minY
        XCTAssertEqual(after, before, accuracy: 2, "Finishing the loader must not move the reader")
    }

    private func settledReaderY(in window: UIWindow, scroll: UIScrollView, label: String) async throws -> CGFloat {
        var previous: [CGFloat] = []
        var stableTurns = 0
        for _ in 0..<100 {
            let row = try await requireElement(in: window, label: label)
            let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
            guard viewport.intersects(window.convert(row.accessibilityFrame, from: nil)) else {
                stableTurns = 0
                try await Task.sleep(for: .milliseconds(20))
                continue
            }
            let current = [row.accessibilityFrame.minY, scroll.contentOffset.y, scroll.contentSize.height]
            if previous.count == current.count, zip(current, previous).allSatisfy({ abs($0 - $1) < 0.1 }) {
                stableTurns += 1
                if stableTurns >= 5 { return current[0] }
            } else { stableTurns = 0 }
            previous = current
            try await Task.sleep(for: .milliseconds(20))
        }
        return try XCTUnwrap(nil as CGFloat?, "The reader must settle before the held response is released")
    }

    func testScrollingNearTheTopLoadsHistoryWithoutATap() async throws {
        var requests = 0
        var finish: ((Bool) -> Void)?
        var proxy: ChatTranscriptScrollProxy?
        defer { finish?(false); proxy = nil }
        let window = try hostWindow(NavigationStack {
            PagedHistoryTranscript(load: { _ in
                requests += 1
                return await withCheckedContinuation { continuation in
                    finish = { result in finish = nil; continuation.resume(returning: result) }
                }
            }, onScrollRequest: { proxy = $0 })
            .navigationTitle("Transcript history")
        })
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(requests, 0, "Opening at the latest row must not page history")
        try XCTUnwrap(proxy).scrollTo("transcript:1952", anchor: .top)
        for _ in 0..<30 where requests == 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 1, "The top sentinel must request history before the reader reaches the top")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Load older messages"))
        for _ in 0..<5 { proxy?.scrollTo("transcript:1952", anchor: .top); try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertEqual(requests, 1, "Repeated appearances must not overlap requests")
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        try await Task.sleep(for: .milliseconds(250))
        attachHistoryImage(window, name: "History loading")
        finish?(false)
        let retry = await awaitElement(in: window, label: "Try Again", timeout: 2)
        XCTAssertNotNil(retry, "Failed history must offer inline retry")
        try await Task.sleep(for: .milliseconds(250))
        attachHistoryImage(window, name: "History retry")
        proxy?.scrollTo("bottom", anchor: .bottom)
        try await Task.sleep(for: .milliseconds(50))
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(requests, 1, "Failed history must stop automatic requests")
        if let retry { HostedAccessibility.activate(retry) }
        for _ in 0..<20 where requests < 2 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 2)
        finish?(true)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(requests, 2, "One appearance must not chain pages")
    }

    func testContinuousHistoryLoadsAllTwoThousandRowsAndPreservesPosition() async throws {
        var requested: [Int] = []
        var proxy: ChatTranscriptScrollProxy?
        var finishRequest: (() -> Void)?
        var insertedStart = 1_950
        defer { finishRequest?(); proxy = nil }
        let window = try hostWindow(PagedHistoryTranscript(onInsert: { insertedStart = $0 }, onScrollRequest: { proxy = $0 }, onRequest: { cursor in
            requested.append(cursor)
            await withCheckedContinuation { continuation in finishRequest = { continuation.resume() } }
        }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        let pages = Array(stride(from: 1_950, through: 50, by: -50))
        for start in pages {
            XCTAssertEqual(insertedStart, start)
            try XCTUnwrap(proxy).scrollTo("transcript:\(start + 2)", anchor: .top)
            let pending = await awaitCondition { finishRequest != nil }
            XCTAssertTrue(pending)
            XCTAssertEqual(requested.last, start)
            let label = "History row \(start + 3). Synthetic transcript text."
            let before = try await settledReaderY(in: window, scroll: scroll, label: label)
            let beforeOffset = scroll.contentOffset.y
            let beforeAnchor = historyObserver(in: window)?.coordinator?.scrollPositionController?.readingAnchorRowID
            let oldHeight = scroll.contentSize.height
            let release = try XCTUnwrap(finishRequest)
            finishRequest = nil
            release()
            let committed = await awaitCondition { insertedStart == start - 50 && scroll.contentSize.height != oldHeight }
            XCTAssertTrue(committed)
            try await Task.sleep(for: .milliseconds(100))
            let afterElement = await awaitElement(in: window, label: label)
            let after = try XCTUnwrap(afterElement, "Reader \(label), anchor \(beforeAnchor ?? "nil"); offset \(beforeOffset) → \(scroll.contentOffset.y); height \(oldHeight) → \(scroll.contentSize.height); cursors \(requested)").accessibilityFrame.minY
            XCTAssertEqual(after, before, accuracy: 2, "Prepending a page moved the reader at offset \(start); anchor \(beforeAnchor ?? "nil")")
            // A programmatic jump has no pan event to advance an active prepend baseline.
            try await Task.sleep(for: .milliseconds(1_050))
            XCTAssertEqual(requested, Array(pages.prefix(requested.count)), "Every cursor must remain ordered and unique")
            let settled = try await requireElement(in: window, label: label).accessibilityFrame.minY
            XCTAssertEqual(settled, before, accuracy: 2)
        }
        XCTAssertEqual(requested, pages)
        proxy?.scrollTo("transcript:0", anchor: .top)
        _ = try await requireElement(in: window, label: "History row 0. Synthetic transcript text.")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Load older messages"))
    }

    func testANewTopAppearanceDuringLoadingRunsAfterThePageSettles() async throws {
        var requests = 0
        var finish: ((Bool) -> Void)?
        var proxy: ChatTranscriptScrollProxy?
        var referenceScroll: UIScrollView?
        var observedNearTop: Bool?
        defer { finish?(false); proxy = nil; referenceScroll = nil }
        let window = try hostWindow(PagedHistoryTranscript(onMetrics: { _ in
            if let scroll = referenceScroll, let geometry = ChatScrollMetrics.geometry(of: scroll) {
                observedNearTop = ChatScrollPolicy.shouldPrefetchHistory(geometry: geometry)
            }
        }, load: { _ in
            requests += 1
            return await withCheckedContinuation { continuation in
                finish = { result in finish = nil; continuation.resume(returning: result) }
            }
        }, onScrollRequest: { proxy = $0 }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        referenceScroll = scroll
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        try XCTUnwrap(proxy).scrollTo("transcript:1952", anchor: .top)
        for _ in 0..<30 where requests == 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 1)
        proxy?.scrollTo("bottom", anchor: .bottom)
        let left = await awaitCondition { observedNearTop == false }
        XCTAssertTrue(left, "The native bottom jump must leave the prefetch region before returning")
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        let returned = await awaitCondition { observedNearTop == true }
        XCTAssertTrue(returned, "The observer must acknowledge top re-entry while the request is held")
        XCTAssertEqual(requests, 1, "A repeated appearance must not overlap a page")
        finish?(true)
        for _ in 0..<40 where requests < 2 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(requests, 2, "A new appearance while loading must not strand the reader at the top")
        finish?(false)
    }

    private func historyObserver(in view: UIView) -> ChatScrollObserver.ObserverView? {
        view.firstView(ofType: ChatScrollObserver.ObserverView.self)
    }

    private func historyScroll(in view: UIView) -> UIScrollView? {
        var ancestor = historyObserver(in: view)?.superview
        while let current = ancestor {
            if let scroll = current as? UIScrollView { return scroll }
            ancestor = current.superview
        }
        return nil
    }

    func testPrependPreservesPositionWithAnExpandedDisclosure() async throws {
        var requested: [Int] = []
        var readHistory: (() -> Void)?
        var finishRequest: (() -> Void)?
        defer { finishRequest?(); readHistory = nil }
        let window = try hostWindow(PagedHistoryTranscript(hasDisclosure: true, onReady: { readHistory = $0 }, onRequest: { cursor in
            requested.append(cursor)
            await withCheckedContinuation { continuation in
                finishRequest = { continuation.resume() }
            }
        }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        try await Task.sleep(for: .milliseconds(150))
        try XCTUnwrap(readHistory)()
        let showMore = try await requireElement(in: window, label: "Show more")
        HostedAccessibility.activate(showMore)
        _ = try await requireElement(in: window, label: "Show less")
        try await Task.sleep(for: .milliseconds(150))
        let before = try await requireElement(in: window, label: "Show less").accessibilityFrame.minY
        let beforeOffset = scroll.contentOffset.y
        let beforeHeight = scroll.contentSize.height
        XCTAssertEqual(requested, [1950])
        let release = try XCTUnwrap(finishRequest)
        finishRequest = nil
        release()
        for _ in 0..<60 where scroll.contentSize.height == beforeHeight { try await Task.sleep(for: .milliseconds(10)) }
        XCTAssertNotEqual(scroll.contentSize.height, beforeHeight, "The older page must be laid out before comparing position")
        try await Task.sleep(for: .milliseconds(150))
        let after = try await requireElement(in: window, label: "Show less").accessibilityFrame.minY
        XCTAssertEqual(requested, [1950])
        XCTAssertEqual(after, before, accuracy: 2, "Prepend cursors \(requested); offset \(beforeOffset) → \(scroll.contentOffset.y); height \(beforeHeight) → \(scroll.contentSize.height)")
        attachHistoryImage(window, name: "Expanded disclosure after history insertion")
    }




    /// A server wakeup renders as completion lines above its reply; a silent reply stays hidden and a typed marker
    /// stays the user's message (TAL-371).
    func testWakeupsRenderAsCompletionLinesWithTheirReplies() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let ready = await awaitCondition {
            HostedAccessibility.elements(in: window).filter {
                HostedAccessibility.identifier(of: $0) == "background-update-lines"
            }.count == 4
        }
        XCTAssertTrue(ready, "All four background-update rows must finish realization before checking order")
        let found = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "background-update-lines" }
        let batch = try XCTUnwrap(found, "The wakeup did not render as completion lines")
        let updates = HostedAccessibility.elements(in: window).filter {
            HostedAccessibility.identifier(of: $0) == "background-update-lines"
        }
        XCTAssertEqual(batch.accessibilityLabel, "Audit the fixture. The parent reviewed this result., make test. The worker or parent review failed. Parent review: The parent reviewed this result.")
        XCTAssertEqual(updates.dropFirst().first?.accessibilityLabel, "./backup.sh. The parent reviewed this result.")
        XCTAssertTrue(updates.contains { $0.accessibilityLabel == "Waiting result. Waiting for the parent to review this result., Active review. The parent is reviewing this result., Unknown result. The worker or parent review outcome is unknown." })
        let reply = try await requireElement(in: window, label: "The audit finished and the test run failed.")
        XCTAssertLessThan(batch.accessibilityFrame.maxY, reply.accessibilityFrame.minY, "The reply is not under its completion lines")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "[SILENT]"), "A silent background reply is shown")
        _ = try await requireElement(
            in: window, label: "[ASYNC DELEGATION BATCH COMPLETE — typed] I typed this",
            "The typed marker is no longer the user's message"
        )

        HostedAccessibility.activate(batch)
        let body = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Delegated result body.") == true }
        XCTAssertNotNil(body, "The expanded update does not show the full notification")
    }

    func testLegacyBackgroundFailuresKeepTheirWarningWithoutInventingParentReview() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let expected = "Legacy failed goal. The worker or parent review failed., Legacy completed goal. The worker or parent review outcome is unknown."
        let row = await awaitElement(in: window, label: expected)
        XCTAssertNotNil(row, "An older server's known failure must remain a warning, while its success proves no parent review")
    }

    func testBackgroundReviewUsesTheAgreedPlatformIcons() {
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.waiting), "clock")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.reviewed), "checkmark")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.failed), "exclamationmark.triangle.fill")
        XCTAssertEqual(BackgroundWorkSheet.icon(BackgroundReviewState.unknown), "questionmark.circle")
        XCTAssertEqual(BackgroundWorkSheet.icon(nil as BackgroundReviewState?), "questionmark.circle")
    }

    /// The compaction card follows the row the server named and precedes the next one (TAL-560).
    func testTheReferenceCardFollowsTheServersNamedRow() async throws {
        let window = try await hostFixtureChat(["--ui-test-compression-reference"])
        let found = await awaitElement(in: window) {
            $0.accessibilityLabel?.contains("Reference only · Earlier turns were summarised.") == true
        }
        let card = try XCTUnwrap(found, "The reference card is missing")
        let anchor = try await requireElement(in: window, label: "Here is the plan.")
        let next = try await requireElement(in: window, label: "Start step one.")
        XCTAssertLessThan(anchor.accessibilityFrame.maxY, card.accessibilityFrame.minY, "The card is not after the named row")
        XCTAssertLessThan(card.accessibilityFrame.maxY, next.accessibilityFrame.minY, "The card is not before the following row")
    }

    /// A branch links back to the chat it came from as one button, and that parent shows no such link (TAL-454). The
    /// link's session URL and its routing are unit tests (`LiveActivityTests`, `SessionListOpenTests`).
    func testTheBranchShowsItsParentLinkAndTheParentShowsNone() async throws {
        let branch = try await hostFixtureChat(["--ui-test-branched-from"])
        let branchReply = await awaitElement(in: branch, label: "Branched fixture reply")
        XCTAssertNotNil(branchReply, "The branch transcript is missing")
        let link = try await requireElement(in: branch, label: "Branched from Fixture Session 01", "The branch row is missing")
        XCTAssertTrue(link.accessibilityTraits.contains(.button), "VoiceOver does not read the branch row as a button")
        branch.isHidden = true

        let parent = try await hostFixtureChat(["--ui-test-branched-from"], sessionID: "ui-fixture-session-1")
        let parentReply = await awaitElement(in: parent, label: "Parent fixture reply")
        XCTAssertNotNil(parentReply, "The parent transcript is missing")
        XCTAssertNil(HostedAccessibility.element(in: parent, label: "Branched from Fixture Session 01"), "The parent chat shows a branch row")
    }

    /// Only the server's collapsible prompt folds; Show more shows it whole and Show less returns it to its fold (TAL-452).
    func testLongPromptOpensFoldedAndToggles() async throws {
        let window = try await hostFixtureChat(["--ui-test-long-prompt"])
        let isPrompt: (NSObject) -> Bool = { $0.accessibilityLabel?.hasPrefix("Fixture prompt line 1\n") == true }
        let rendered = await awaitElement(in: window, where: isPrompt)
        XCTAssertNotNil(rendered, "The long prompt did not render")
        let showMore = try await requireElement(in: window, label: "Show more", "The long prompt did not open folded")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == "Show more" }.count, 1, "Only the long prompt folds")
        func promptHeight() throws -> CGFloat {
            try XCTUnwrap(HostedAccessibility.elements(in: window).first(where: isPrompt)).accessibilityFrame.height
        }
        let folded = try promptHeight()

        HostedAccessibility.activate(showMore)
        let showLess = try await requireElement(in: window, label: "Show less", "The folded prompt did not expand")
        // 24 lines against a fold of 8.
        XCTAssertGreaterThan(try promptHeight(), folded * 2, "The expanded prompt is not shown whole")

        HostedAccessibility.activate(showLess)
        let refolded = await awaitElement(in: window, label: "Show more")
        XCTAssertNotNil(refolded, "The expanded prompt did not fold again")
        XCTAssertEqual(try promptHeight(), folded, accuracy: 2, "The prompt did not return to its fold")
    }

    /// `diff` and `patch` blocks announce added and removed lines in light and dark; `log` and `text` blocks with the same
    /// prefixes, and a file header, stay plain (TAL-447).
    func testDiffAndPatchBlocksMarkChangedLinesInLightAndDark() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let window = try await hostFixtureChat(["--ui-test-diff-blocks"]) { $0.userInterfaceStyle = style }
            for label in [
                "Removed: -let fixtureRemoved = 1",
                "Added: +let fixtureAdded = 2",
                "Added: +",
                "Removed: -patch fixture removed",
                "Added: +patch fixture added"
            ] {
                let line = await awaitElement(in: window, label: label)
                XCTAssertNotNil(line, "Missing \(label) in \(style)")
            }
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "+log fixture line"), "The log block lost its line")
            for plain in ["Added: +log fixture line", "Added: +text fixture line", "Added: +++ b/Fixture.swift"] {
                XCTAssertNil(HostedAccessibility.element(in: window, label: plain), "\(plain) was announced as a change")
            }
            window.isHidden = true
        }
    }
}


@MainActor
private func historyTranscript(messages supplied: [ChatMessage]? = nil, messageCount: Int = 50, messageOffset: Int? = nil, hasOlderMessages: Bool = true, onMetrics: @escaping (ChatScrollMetrics) -> Void = { _ in }, shouldRender: @escaping (ChatMessage) -> Bool = { _ in true }, scrollRequest: Int = 0, onScrollRequest: @escaping (ChatTranscriptScrollProxy) -> Void = { _ in }, load: @escaping (@MainActor () -> Void) async -> Bool) -> some View {
    let messages = supplied ?? (0..<messageCount).map { index in
        ChatMessage(role: "user", content: "History row \(index). Synthetic transcript text.", timestamp: nil, messageId: "history-\(index)")
    }
    return ChatTranscriptView(
        isLoading: false, errorMessage: nil, messages: messages,
        displayedTranscriptMessages: ChatViewModel.transcriptMessages(from: messages, messageOffset: messageOffset),
        compressionReferenceCard: nil, branchedFrom: nil, reasoningGroups: [],
        completedToolCallGroupsForAnchor: { _ in [] }, archivedActivityRowsForAnchor: { _ in [] },
        earlierSceneRowsForTurn: { _ in [] }, onLoadEarlierSceneRows: { _ in },
        liveReasoningText: "", liveActivityRows: [], reasoningAnchorMessageID: nil,
        liveToolCalls: [], toolCallAnchorMessageID: nil, streamingAssistantMessageID: nil,
        liveTokensPerSecond: nil, showsRunStateCheck: false, clarificationPrompt: nil,
        showsThinkingAndToolCards: false, shouldFollowLatestMessage: false,
        isDisclosureSettling: false, latestTranscriptMessageRole: nil, isScrolledNearBottom: false,
        activeStreamID: nil, streamingScrollTrigger: 0, cacheFirstReconcileScrollToken: 0,
        transcriptMessageSpacing: 12, transcriptBlockSpacing: 8,
        transcriptBottomInsetHeight: 0, scrollToBottomRequest: scrollRequest, followReplayRequest: 0,
        assistantName: "Assistant", localAttachmentPreviews: [:], listeningMessageID: nil,
        isViewingCachedData: false, isSessionReadOnly: false, canBranch: false,
        hasOlderMessages: hasOlderMessages, isLoadingOlderMessages: false,
        isRegeneratingMessage: false, isEditingMessage: false, isForkingMessage: false,
        loadAttachmentImage: { _ in nil }, loadAttachmentData: { _ in nil },
        loadTranscriptMediaImage: { _ in nil }, loadTranscriptMediaData: { _ in nil },
        transcriptMediaCacheNamespace: "history-test", actionContext: { _, _ in nil },
        shouldRenderMessageRow: shouldRender, onLoadMessages: {}, onLoadOlderMessages: load,
        onUpdateScrollMetrics: onMetrics, onFollowEvent: { _ in }, onDisclosureToggle: { {} },
        onFollowSuppressed: {}, onDismissKeyboard: {}, onScrollToBottom: onScrollRequest,
        onScrollToLatestTranscriptMessage: { _ in }, onScrollToLatestContent: { _, _ in },
        onPreviewAttachment: { _, _ in }, onPreviewTranscriptMedia: { _ in },
        onToggleListening: { _ in }, onSelectText: { _ in }, onRegenerate: { _ in },
        onEdit: { _ in }, onFork: { _ in }, onCopy: { _ in }
    )
}

/// Hosts the transcript directly because FixtureApp's canned session does not page.
@MainActor
private struct PagedHistoryTranscript: View {
    @State private var start: Int
    @State private var readHistoryRequest = 0
    let hasDisclosure: Bool
    let sparseOlderPages: Bool
    let richContent: Bool
    let onMetrics: (ChatScrollMetrics) -> Void
    let onInsert: (Int) -> Void
    let shouldRender: (ChatMessage) -> Bool
    let onReady: (@escaping () -> Void) -> Void
    let load: ((@MainActor () -> Void) async -> Bool)?
    let onScrollRequest: ((ChatTranscriptScrollProxy) -> Void)?
    let onRequest: @MainActor (Int) async -> Void
    let onComplete: @MainActor () async -> Void

    init(initialStart: Int = 1_950, hasDisclosure: Bool = false, sparseOlderPages: Bool = false,
         richContent: Bool = false,
         onMetrics: @escaping (ChatScrollMetrics) -> Void = { _ in }, onInsert: @escaping (Int) -> Void = { _ in },
         shouldRender: @escaping (ChatMessage) -> Bool = { _ in true },
         onReady: @escaping (@escaping () -> Void) -> Void = { _ in },
         load: ((@MainActor () -> Void) async -> Bool)? = nil,
         onScrollRequest: ((ChatTranscriptScrollProxy) -> Void)? = nil,
         onComplete: @escaping @MainActor () async -> Void = {}, onRequest: @escaping @MainActor (Int) async -> Void = { _ in }) {
        _start = State(initialValue: initialStart)
        self.hasDisclosure = hasDisclosure
        self.sparseOlderPages = sparseOlderPages
        self.richContent = richContent
        self.onMetrics = onMetrics
        self.onInsert = onInsert
        self.shouldRender = shouldRender
        self.onReady = onReady
        self.load = load
        self.onScrollRequest = onScrollRequest
        self.onRequest = onRequest
        self.onComplete = onComplete
    }

    var body: some View {
        let messages = (start..<2_000).map { index in
            if hasDisclosure && index == 1953 {
                return ChatMessage(role: "user", content: String(repeating: "Expanded history fixture.\n", count: 30), timestamp: nil, messageId: "history-\(index)", displayExcerpt: "Expanded history fixture.", collapsible: true)
            }
            if richContent && !index.isMultiple(of: 2) {
                return ChatMessage(role: "assistant", content: "History answer \(index).\n\n## Details\n\nA paragraph with **emphasis**, `code`, and a [synthetic link](https://example.test).\n\n```swift\nlet value = \(index)\nprint(value)\n```\n\n- First item\n- Second item\n", timestamp: nil, messageId: "history-\(index)")
            }
            return ChatMessage(role: "user", content: "History row \(index). Synthetic transcript text.", timestamp: nil, messageId: "history-\(index)", display: sparseOlderPages && index < 1_950 && index % 50 != 0 ? .hidden : .row)
        }
        historyTranscript(messages: messages, messageOffset: start, hasOlderMessages: start > 0, onMetrics: onMetrics, shouldRender: shouldRender,
                          scrollRequest: readHistoryRequest, onScrollRequest: { proxy in
            if let onScrollRequest { onScrollRequest(proxy) }
            else { proxy.scrollTo("transcript:\(start + 2)", anchor: .top) }
        }) { beforePrepend in
            if let load { return await load(beforePrepend) }
            await onRequest(start)
            beforePrepend()
            start = max(0, start - 50)
            onInsert(start)
            await onComplete()
            return true
        }
        .onAppear {
            onReady { readHistoryRequest += 1 }
            if onScrollRequest != nil { readHistoryRequest += 1 }
        }
    }
}

// Preserve the fixture's named destinations while exercising the same typed API as the app.
private extension ChatTranscriptScrollProxy {
    func scrollTo(_ id: String, anchor: UnitPoint) {
        if id == "chat-transcript-content" { scrollTo(id: id, anchor: .top) }
        else {
            let target = ChatTranscriptView.containerID(for: id == "bottom" ? "transcript:1999" : id)
            scrollTo(id: target, anchor: anchor)
        }
    }
}

@MainActor
extension TranscriptHostedTests {
    func testPendingPhotoFileAndVoicePresentationAtPhoneAndPadWidths() async throws {
        let bytes = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 80)).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 80))
        }
        let audio = silentWave()
        let photo = PendingAttachment(name: "Photo.png", path: "local-photo", mime: "image/png", isImage: true,
                                      thumbnailData: bytes, uploadPhase: .uploading)
        let file = PendingAttachment(name: "Notes.txt", path: "local-file", mime: "text/plain", isImage: false,
                                     uploadPhase: .failed("Upload failed. Try again."))
        var voice = ChatMessage(role: "user", content: "", timestamp: 1, messageId: "local-voice",
                                attachments: [MessageAttachment(name: "Voice.wav", path: "local-voice", mime: "audio/wav")])
        voice.localVoicePhase = .preparing
        for size in [HostedSize.phone, HostedSize.padLandscape] {
            let before = try hostWindow(
                VStack { Spacer(); TextField("Message", text: .constant("New typed draft")) }
                    .padding(20).background(Color(.systemBackground)), size: size
            )
            attachMediaEvidence(before, name: size == HostedSize.phone ? "before-local-media-phone" : "before-local-media-pad")
            before.isHidden = true
            var retries = 0
            let window = try hostWindow(
                VStack(spacing: 16) {
                    MessageBubbleView(message: voice, loadAttachmentData: { _ in audio })
                    Spacer()
                    ComposerAttachmentStripView(photos: [photo], onRemove: { _ in }, onPreview: { _ in })
                    ComposerFileLinkView(attachment: file, onRemove: {}, onOpen: {})
                    TextField("Message", text: .constant("New typed draft"))
                }
                .padding(20)
                .background(Color(.systemBackground))
                .environment(\.retryPendingAttachment, { _ in retries += 1 }),
                size: size
            )
            let uploading = await awaitElement(in: window, label: "Uploading Photo.png")
            XCTAssertNotNil(uploading, "Missing upload state: \(HostedAccessibility.labels(in: window))")
            let retry = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Retry upload Notes.txt"))
            HostedAccessibility.activate(retry)
            XCTAssertEqual(retries, 1)
            let preparing = await awaitElement(in: window, label: "Preparing voice note")
            XCTAssertNotNil(preparing)
            let play = await awaitElement(in: window, label: "Play Voice.wav")
            _ = try XCTUnwrap(play, "The local voice note must be replayable during preparation")
            attachMediaEvidence(window, name: size == HostedSize.phone ? "local-media-phone" : "local-media-pad")
            window.isHidden = true
        }
    }

    func testRemovingRestoredAttachmentClearsItsDraftEvenWhenUploadIsHeld() async throws {
        for held in [false, true] {
            let scenarios = [UITestFixtureEnvironment.failAttachmentUploadsArgument]
                + (held ? [UITestFixtureEnvironment.holdAttachmentUploadsArgument] : [])
            let fixture = try FixtureApp(scenarios, for: self)
            let session = try await fixture.session()
            let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
            defer { try? FileManager.default.removeItem(at: directory) }
            let copies = ChatDraftAttachmentStore(directoryURL: directory)
            let file = try await copies.save(data: Data("saved attachment".utf8), suggestedFilename: "saved.txt")
            let record = ChatDraftAttachment(pending: PendingAttachment(name: "saved.txt", path: "", mime: "text/plain",
                                                                        isImage: false, draftFileName: file))
            let drafts = fixture.environment.draftStore
            let key = ChatDraftKey.session(server: UITestFixtureEnvironment.serverURL, session: session)
            drafts.setDraft("Keep typed input", for: key)
            drafts.setAttachments([record], for: key)
            let window = try hostWindow(
                NavigationStack {
                    ChatView(session: session, server: UITestFixtureEnvironment.serverURL, onAPIError: { _ in },
                             draftStore: drafts, draftAttachmentStore: copies)
                }
                .environment(\.scenePhase, .active)
                .modelContainer(fixture.cache)
            )
            if !held {
                _ = try await requireElement(in: window, label: "Retry upload saved.txt")
                let send = try await requireElement(in: window, label: "Send")
                XCTAssertTrue(send.accessibilityTraits.contains(.notEnabled), "Failed attachments must disable Send")
                attachMediaEvidence(window, name: "restored-failed-attachment-send")
            }
            let remove = try await requireElement(in: window, label: "Remove attachment saved.txt")
            HostedAccessibility.activate(remove)
            if held {
                let canSendBeforeReply = await awaitCondition {
                    guard let send = HostedAccessibility.element(in: window, label: "Send") else { return false }
                    return !send.accessibilityTraits.contains(.notEnabled)
                }
                XCTAssertTrue(canSendBeforeReply, "Removing every saved attachment must not wait for an obsolete upload reply")
            }
            fixture.releaseHeldLoads()
            let finished = await awaitCondition {
                guard let send = HostedAccessibility.element(in: window, label: "Send") else { return false }
                return !send.accessibilityTraits.contains(.notEnabled)
                    && HostedAccessibility.element(in: window, label: "Remove attachment saved.txt") == nil
            }
            XCTAssertTrue(finished)
            let draft = await drafts.draft(for: key)
            XCTAssertEqual(draft?.attachments, [], "Explicit removal must clear both visible and retained restore receipts")
            XCTAssertEqual(draft?.text, "Keep typed input")
            let removedCopy = try? await copies.data(named: file)
            XCTAssertNil(removedCopy)
            window.isHidden = true
        }
    }

    private func attachMediaEvidence(_ window: UIWindow, name: String) {
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        let evidence = XCTAttachment(image: image)
        evidence.name = name
        evidence.lifetime = .keepAlways
        add(evidence)
    }


    private func silentWave() -> Data {
        var data = Data()
        func number<T: FixedWidthInteger>(_ value: T) {
            var littleEndian = value.littleEndian
            withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
        }
        data.append(Data("RIFF".utf8))
        number(UInt32(36 + 16_000))
        data.append(Data("WAVEfmt ".utf8))
        number(UInt32(16))
        number(UInt16(1))
        number(UInt16(1))
        number(UInt32(8_000))
        number(UInt32(16_000))
        number(UInt16(2))
        number(UInt16(16))
        data.append(Data("data".utf8))
        number(UInt32(16_000))
        data.append(Data(count: 16_000))
        return data
    }

}

import SwiftUI
import SwiftData
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's transcript rows, hosted in process against the UI fixture's scenarios (TAL-856): what each row
/// says to VoiceOver, its button trait, and where it sits against its neighbours.
@MainActor
final class TranscriptHostedTests: XCTestCase {
    func testBrandedQueueControlsAndBackgroundDisclosureRetainTheirActions() async throws {
        let decoder = DecisionReview.decoder
        let peer = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","_talaria_activity":{"version":1,"origin":"peer_agent","id":"peer","kind":"peer_message","summary":"Message from Reviewer","details":"Check the result."}}"#.utf8))
        let background = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Full result details.","message_id":"background","_talaria_activity":{"version":1,"origin":"talaria","id":"background","kind":"process_wakeup","summary":"Background update received"},"_background_update":{"kind":"process","attention":false,"count":1,"summary":"Command done","lines":[{"kind":"command","status":"completed","label":"make check","review_state":"reviewed"}]}}"#.utf8))
        let peerActivity = try XCTUnwrap(peer.talariaActivity)
        let backgroundUpdate = try XCTUnwrap(background.backgroundUpdate)
        var requested: (String, PendingSteerAction)?
        let window = try hostWindow(VStack(alignment: .leading, spacing: 12) {
            MarkerMessageCardView(activity: peerActivity, stateID: "pending", messageID: "pending")
            BackgroundUpdateLinesView(update: backgroundUpdate, message: background)
        }.padding()
            .environment(\.pendingSteerControls, PendingSteerControls(actions: ["pending": .init(edit: false, cancel: true, sendNow: true)]))
            .environment(\.pendingSteerAction, ChatEnvironmentAction<(String, PendingSteerAction), Void> { requested = $0 }))
        defer { window.isHidden = true }
        let send = try await requireElement(in: window, label: "Send now")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Edit steering message"))
        HostedAccessibility.activate(send)
        XCTAssertTrue(requested?.0 == "pending" && requested?.1 == .sendNow)
        _ = try await requireElement(in: window, label: "Cancel steering message")
        let batch = try await requireElement(in: window, label: "Talaria. make check. The parent reviewed this result.")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Full result details."))
        attachHostedScreenshot(window, name: "activity-queue-and-background-collapsed")
        HostedAccessibility.activate(batch)
        _ = try await requireElement(in: window, label: "Full result details.")
        attachHostedScreenshot(window, name: "activity-queue-and-background-expanded")
    }

    func testBrandedActivitiesUseFlatAccessibleRowsAndDisclosePeerContent() async throws {
        let decoder = DecisionReview.decoder
        let peer = try decoder.decode(ChatMessage.self, from: Data(#"{"role":"user","content":"Agent-only prompt","_talaria_activity":{"version":1,"origin":"peer_agent","id":"peer","kind":"future_kind","summary":"Message from Reviewer","details":"The result is ready.","sender":{"session_id":"reviewer","name":"Reviewer"}}}"#.utf8))
        let activity = try XCTUnwrap(peer.talariaActivity)
        for variant in HostedVariant.gallery {
            let window = try hostWindow(
                VStack(alignment: .leading, spacing: 12) {
                    Text("Before the activity")
                    MarkerMessageCardView(activity: activity, stateID: "\(variant.name):peer")
                    Text("After the activity")
                }.padding(), size: variant.size,
                traits: { $0.userInterfaceStyle = variant.style; $0.preferredContentSizeCategory = variant.textSize }
            )
            defer { window.isHidden = true }
            let row = try await requireElement(in: window, label: "Talaria. Message from Reviewer")
            XCTAssertGreaterThanOrEqual(row.accessibilityFrame.height.rounded(), 44)
            XCTAssertNil(HostedAccessibility.element(in: window, label: "Agent-only prompt"))
            XCTAssertNil(HostedAccessibility.element(in: window, label: "The result is ready."))
            attachHostedScreenshot(window, name: "activity-\(variant.name)-collapsed")
            HostedAccessibility.activate(row)
            _ = try await requireElement(in: window, label: "The result is ready.")
            attachHostedScreenshot(window, name: "activity-\(variant.name)-expanded")
        }
    }

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
            let idle = await awaitIdleTranscript(in: window, scroll: scroll)
            XCTAssertTrue(idle, "The transcript must finish its first layout before reading history")
            let read = try XCTUnwrap(readHistory)
            read()
            _ = await awaitCondition { inserted != nil }
            let start = try XCTUnwrap(started, "Requests \(requested); initial bodies \(initialRowBodies); viewport \(type(of: scroll)) bounds \(scroll.bounds) offset \(scroll.contentOffset) content \(scroll.contentSize)")
            let end = try XCTUnwrap(inserted, "The real transcript must finish laying out its older page")
            XCTAssertEqual(requested, [first])
            XCTAssertLessThanOrEqual(oldRowBodies, 50, "A 50-row prepend must bound existing-row layout work independently of loaded history")
            samples.append(["alreadyLoadedRows": Double(count), "insertMilliseconds": (end - start) * 1_000,
                            "oldRowBodies": Double(oldRowBodies), "newRowBodies": Double(newRowBodies)])
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
        let ready = await awaitIdleTranscript(in: window, scroll: scroll)
        XCTAssertTrue(ready && observedMetrics, "The native observer and initial layout must be ready before fast scrolling")
        let coordinator = try XCTUnwrap(historyObserver(in: window)?.coordinator)
        let controller = try XCTUnwrap(coordinator.scrollPositionController)
        // Raw offsets do not send UIKit's drag-began event, which clears the
        // initial bottom anchor before a reader moves through older messages.
        controller.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        // A fast reader repeatedly reaches the loaded edge while a prepend is settling.
        let keptLoading = await awaitCondition {
            scroll.contentOffset.y = -scroll.adjustedContentInset.top
            return requested.count >= 3
        }
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        XCTAssertTrue(keptLoading, "Fast scrolling must keep requesting older pages without an away/back gesture; requested \(requested)")
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
        _ = await awaitCondition { requests > 0 }
        let viewportHeight = scroll.bounds.height - scroll.adjustedContentInset.top - scroll.adjustedContentInset.bottom
        XCTAssertGreaterThan(scroll.contentOffset.y + scroll.adjustedContentInset.top, viewportHeight * 3)
        XCTAssertEqual(requests, 1, "Prefetch must start with at least three viewports of history still available")
    }

    func testHistoryLoadsWhenTheReaderReturnsToTheTopBetweenMetricDeliveries() async throws {
        var requests = 0
        var interleave: (() -> Void)?
        let window = try hostWindow(PagedHistoryTranscript(onMetrics: { metrics in
            // Runs right after the transcript has published this delivery's near-top state.
            guard metrics.distanceFromTop < 1, let run = interleave else { return }
            interleave = nil
            run()
        }, load: { _ in requests += 1; return false }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        var settledOffset = CGFloat.nan
        let ready = await awaitCondition {
            guard let controller = self.historyObserver(in: window)?.coordinator?.scrollPositionController,
                  !controller.isNavigating, !controller.isRealizingRows, !controller.shouldPrefetchHistory() else { return false }
            defer { settledOffset = scroll.contentOffset.y }
            return scroll.contentOffset.y == settledOffset
        }
        XCTAssertTrue(ready, "The reader must settle at the latest message, outside the prefetch region")
        XCTAssertEqual(requests, 0)
        let coordinator = try XCTUnwrap(historyObserver(in: window)?.coordinator)
        try XCTUnwrap(coordinator.scrollPositionController).userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        let away = scroll.contentOffset.y
        let top = -scroll.adjustedContentInset.top
        // Under load the history check can run after the offset moved away again, and the reader's
        // return lands before the observer's next coalesced delivery, which then reports no change.
        interleave = {
            scroll.contentOffset.y = away
            window.layoutIfNeeded()
            scroll.contentOffset.y = top
        }
        // The transcript can hold the reader at the latest message briefly after startup, so each look moves it again.
        let reachedTop = await awaitCondition {
            scroll.contentOffset.y = top
            return interleave == nil
        }
        XCTAssertTrue(reachedTop, "The reader never reached the top")
        let loaded = await awaitCondition(timeout: 2) { requests > 0 }
        XCTAssertTrue(loaded, "A reader resting at the top must load older history after a check saw them away")
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
        let after = try await settledReaderY(in: window, scroll: scroll, label: label)
        XCTAssertEqual(after, before, accuracy: 2, "Finishing the loader must not move the reader")
    }

    /// The reader row's top once it shows in the viewport and its frame, the offset and the content height have held
    /// still for five looks in a row.
    private func settledReaderY(in window: UIWindow, scroll: UIScrollView, label: String) async throws -> CGFloat {
        var previous: [CGFloat] = []
        var stableLooks = 0
        let settled = await awaitCondition {
            guard let row = HostedAccessibility.element(in: window, label: label),
                  window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                    .intersects(window.convert(row.accessibilityFrame, from: nil)) else {
                stableLooks = 0
                previous = []
                return false
            }
            let current = [row.accessibilityFrame.minY, scroll.contentOffset.y, scroll.contentSize.height]
            let still = previous.count == current.count && zip(current, previous).allSatisfy { abs($0 - $1) < 0.1 }
            stableLooks = still ? stableLooks + 1 : 0
            previous = current
            return stableLooks >= 5
        }
        XCTAssertTrue(settled, "The reader must settle before the held response is released")
        return try XCTUnwrap(previous.first, "The reader \(label) never showed")
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
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let idle = await awaitIdleTranscript(in: window, scroll: scroll)
        XCTAssertTrue(idle)
        XCTAssertEqual(requests, 0, "Opening at the latest row must not page history")
        try XCTUnwrap(proxy).scrollTo("transcript:1952", anchor: .top)
        _ = await awaitCondition { requests > 0 }
        XCTAssertEqual(requests, 1, "The top sentinel must request history before the reader reaches the top")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Load older messages"))
        for _ in 0..<5 {
            proxy?.scrollTo("transcript:1952", anchor: .top)
            _ = await awaitRenderedQuiet(in: window) { requests }
        }
        XCTAssertEqual(requests, 1, "Repeated appearances must not overlap requests")
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        _ = await awaitRenderedQuiet(in: window) { scroll.contentOffset.y }
        attachHistoryImage(window, name: "History loading")
        finish?(false)
        let retry = await awaitElement(in: window, label: "Try Again")
        XCTAssertNotNil(retry, "Failed history must offer inline retry")
        attachHistoryImage(window, name: "History retry")
        proxy?.scrollTo("bottom", anchor: .bottom)
        _ = await awaitRenderedQuiet(in: window) { scroll.contentOffset.y }
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        _ = await awaitRenderedQuiet(in: window) { scroll.contentOffset.y }
        XCTAssertEqual(requests, 1, "Failed history must stop automatic requests")
        if let retry { HostedAccessibility.activate(retry) }
        _ = await awaitCondition { requests >= 2 }
        XCTAssertEqual(requests, 2)
        let pageHeight = scroll.contentSize.height
        finish?(true)
        let inserted = await awaitCondition { scroll.contentSize.height != pageHeight }
        XCTAssertTrue(inserted, "The older page must be laid out before checking for a chained request")
        _ = await awaitRenderedQuiet(in: window) { requests }
        XCTAssertEqual(requests, 2, "One appearance must not chain pages")
    }

    /// Pages of 650 rows reach the same 2000: one page's preservation does not depend on its length, and each prepend
    /// waits out the one-second measurement window on a transcript that grows with every page (TAL-1891). Three
    /// prepends, not five of 400, keep it inside the per-test run-time budget (TAL-2405).
    func testContinuousHistoryLoadsAllTwoThousandRowsAndPreservesPosition() async throws {
        let pageSize = 650
        var requested: [Int] = []
        var proxy: ChatTranscriptScrollProxy?
        var finishRequest: (() -> Void)?
        var insertedStart = 1_950
        defer { finishRequest?(); proxy = nil }
        let window = try hostWindow(PagedHistoryTranscript(pageSize: pageSize, onInsert: { insertedStart = $0 }, onScrollRequest: { proxy = $0 }, onRequest: { cursor in
            requested.append(cursor)
            await withCheckedContinuation { continuation in finishRequest = { continuation.resume() } }
        }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        let pages = Array(stride(from: 1_950, to: 0, by: -pageSize))
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
            let committed = await awaitCondition { insertedStart == max(0, start - pageSize) && scroll.contentSize.height != oldHeight }
            XCTAssertTrue(committed)
            let after = try await settledReaderY(in: window, scroll: scroll, label: label)
            XCTAssertEqual(after, before, accuracy: 2, "Prepending a page moved the reader at offset \(start); anchor \(beforeAnchor ?? "nil"); offset \(beforeOffset) → \(scroll.contentOffset.y); height \(oldHeight) → \(scroll.contentSize.height); cursors \(requested)")
            // A programmatic jump has no pan event to advance an active prepend baseline: let the one-second
            // measurement window end on its own before the next jump.
            let windowEnded = await awaitCondition {
                self.historyObserver(in: window)?.coordinator?.scrollPositionController?.isPreservingPosition == false
            }
            XCTAssertTrue(windowEnded, "The prepend's measurement window must end")
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
        var bottomRequested = false
        var movement: [Bool] = []
        defer { finish?(false); proxy = nil; referenceScroll = nil }
        let window = try hostWindow(PagedHistoryTranscript(onMetrics: { _ in
            if let scroll = referenceScroll, let geometry = ChatScrollMetrics.geometry(of: scroll) {
                observedNearTop = ChatScrollPolicy.shouldPrefetchHistory(geometry: geometry)
                if bottomRequested, let observedNearTop, movement.last != observedNearTop {
                    movement.append(observedNearTop)
                }
            }
        }, load: { _ in
            requests += 1
            return await withCheckedContinuation { continuation in
                finish = { result in finish = nil; continuation.resume(returning: result) }
                if requests == 1 {
                    bottomRequested = true
                    proxy?.scrollTo("bottom", anchor: .bottom)
                }
            }
        }, onScrollRequest: { proxy = $0 }))
        let scroll = try XCTUnwrap(historyScroll(in: window))
        referenceScroll = scroll
        defer {
            attachFailureScreenshot(window, name: "Held history navigation")
            window.isHidden = true
            window.rootViewController = nil
        }
        let ready = await awaitCondition { proxy != nil }
        XCTAssertTrue(ready)
        try XCTUnwrap(proxy).scrollTo("transcript:1952", anchor: .top)
        _ = await awaitCondition { requests > 0 }
        XCTAssertEqual(requests, 1)
        let left = await awaitCondition { movement.contains(false) }
        XCTAssertTrue(left, "The native bottom jump must leave the prefetch region before returning")
        proxy?.scrollTo("chat-transcript-content", anchor: .top)
        let returned = await awaitCondition {
            guard let departure = movement.firstIndex(of: false) else { return false }
            return movement.dropFirst(departure + 1).contains(true)
        }
        XCTAssertTrue(returned, "The observer must acknowledge top re-entry while the request is held")
        XCTAssertEqual(requests, 1, "A repeated appearance must not overlap a page")
        finish?(true)
        _ = await awaitCondition { requests >= 2 }
        XCTAssertEqual(requests, 2, "A new appearance while loading must not strand the reader at the top")
        finish?(false)
    }

    /// The transcript has laid out and its position controller is idle: no navigation, row realization or position
    /// preservation (a disclosure hold or a prepend's measurement window) is still running.
    private func awaitIdleTranscript(in window: UIWindow, scroll: UIScrollView) async -> Bool {
        await awaitCondition {
            guard let controller = self.historyObserver(in: window)?.coordinator?.scrollPositionController,
                  let geometry = ChatScrollMetrics.geometry(of: scroll) else { return false }
            return controller.isIdle && geometry.contentHeight > geometry.visibleHeight
        }
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
        let idle = await awaitIdleTranscript(in: window, scroll: scroll)
        XCTAssertTrue(idle)
        try XCTUnwrap(readHistory)()
        let showMore = try await requireElement(in: window, label: "Show more")
        HostedAccessibility.activate(showMore)
        _ = try await requireElement(in: window, label: "Show less")
        // The disclosure's position hold lets go once the expanded row has settled.
        let expanded = await awaitIdleTranscript(in: window, scroll: scroll)
        XCTAssertTrue(expanded)
        let before = try await requireElement(in: window, label: "Show less").accessibilityFrame.minY
        let beforeOffset = scroll.contentOffset.y
        let beforeHeight = scroll.contentSize.height
        XCTAssertEqual(requested, [1950])
        let release = try XCTUnwrap(finishRequest)
        finishRequest = nil
        release()
        let laidOut = await awaitCondition { scroll.contentSize.height != beforeHeight }
        XCTAssertTrue(laidOut, "The older page must be laid out before comparing position")
        // The prepend's preservation window ends once its rows have measured.
        let settled = await awaitIdleTranscript(in: window, scroll: scroll)
        XCTAssertTrue(settled)
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

    func testScheduledTaskShowsTheJobPromptAndCopiesTheStoredMessage() async throws {
        let fixture = try FixtureApp(for: self)
        let sessions = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("web-session")) as? [String: Any])
        let rows = try XCTUnwrap((sessions["scheduled_task_session"] as? [String: Any])?["messages"] as? [[String: Any]])
        let task = try XCTUnwrap(rows.first { $0["_marker_kind"] as? String == "scheduled_task" })
        let prompt = try XCTUnwrap(task["_marker_body"] as? String)
        let stored = try XCTUnwrap(task["content"] as? String)
        let reply = try XCTUnwrap(rows.first { $0["role"] as? String == "assistant" }?["content"] as? String)
        var detail = UITestFixtureURLProtocol.session(id: UITestFixtureURLProtocol.sessionID, title: "Daily brief")
        detail["messages"] = rows
        let response = try JSONSerialization.data(withJSONObject: ["session": detail])
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = response }
        let copied = recordCopies()
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)
        defer { window.isHidden = true }

        _ = try await requireElement(in: window, label: reply)
        attachHostedScreenshot(window, name: "scheduled-task-chat")
        let marker = try await requireElement(in: window, label: "Scheduled task with daily-brief and inbox-triage")
        let body = try await requireElement(in: window) { $0.accessibilityLabel == prompt }
        XCTAssertLessThan(marker.accessibilityFrame.minY, body.accessibilityFrame.minY)
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains { $0.contains("You are running as a scheduled cron job") })
        let copy = try await requireElement(in: window, label: "Copy scheduled task")
        HostedAccessibility.activate(copy)
        XCTAssertEqual(copied.last, stored)
    }

    /// TAL-1003: a long delivery shows the server's excerpt of its body, not the whole body, until Show more opens it.
    func testALongDeliveryShowsTheServersExcerptUntilShowMore() async throws {
        let message = try DecisionReview.decoder.decode(ChatMessage.self, from: Data(#"""
        {"role":"user","content":"[Cron delivery: Digest]\nThe whole digest.","message_id":"delivery-long",
         "_display_truncated":true,"_display_excerpt":"The digest's excerpt…",
         "_delivery":{"kind":"cron","name":"Digest","body":"The whole digest."}}
        """#.utf8))
        let delivery = try XCTUnwrap(message.delivery)
        let excerpt = try XCTUnwrap(message.displayExcerpt)
        let window = try hostWindow(
            MarkerMessageCardView(delivery: delivery, excerpt: excerpt, stateID: message.id).padding(), size: HostedSize.phone
        )
        _ = try await requireElement(in: window, label: excerpt, "The collapsed delivery does not show the server's excerpt")
        XCTAssertNil(HostedAccessibility.element(in: window, label: delivery.body), "The collapsed delivery lays out its whole body")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show more"))
        _ = try await requireElement(in: window, label: delivery.body, "Show more does not open the whole body")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Show less"), "The open delivery offers no Show less")
    }

    /// TAL-1962: a background result is the marker's disclosure row: as tall, its icons and titles on the marker's
    /// edges, quiet labels, one chevron centred on the lines that stays on screen past a long label, and a flat body
    /// on the title's edge when it opens.
    func testBackgroundResultLinesShareTheMarkerRowsChrome() async throws {
        let long = String(repeating: "Apply approved default-profile plugin decisions ", count: 4)
        let message = try DecisionReview.decoder.decode(ChatMessage.self, from: Data(#"""
        {"role":"user","content":"Full result details.","message_id":"bg-1962","_display_truncated":true,"_display_excerpt":"Full result…",
         "_background_update":{"lines":[{"kind":"agent","status":"failed","label":"\#(long)","review_state":"failed"},
          {"kind":"command","status":"completed","label":"make test","review_state":"reviewing"}]}}
        """#.utf8))
        let update = try XCTUnwrap(message.backgroundUpdate)
        let window = try hostWindow(VStack(alignment: .leading, spacing: 12) {
            MarkerMessageCardView(kind: .contextCompaction, content: "Earlier turns were summarised.", stateID: "tal-1962")
            BackgroundUpdateLinesView(update: update, message: message)
        }.padding(), size: HostedSize.phone)
        let marker = try await requireElement(in: window, label: "Context compaction")
        let lines = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "background-update-lines"))
        settle(0.2)
        let markerRow = drawnLayers(in: window, within: marker.accessibilityFrame)
        let (markerIcon, markerTitle) = (try XCTUnwrap(markerRow.first), markerRow[1])
        var row = drawnLayers(in: window, within: lines.accessibilityFrame)
        XCTAssertTrue(lines.accessibilityTraits.contains(.button), "The lines are not one button")
        XCTAssertGreaterThanOrEqual(lines.accessibilityFrame.height.rounded(), 44)
        var chevron = try XCTUnwrap(row.popLast(), "The lines have no chevron")
        let icons = row.filter { $0.maxX <= markerTitle.minX }
        let titles = row.filter { $0.minX >= markerTitle.minX }
        XCTAssertEqual(icons.count, 2, "Each line has one icon, the reviewing spinner included")
        XCTAssertEqual(titles.count, 2)
        for icon in icons {
            XCTAssertEqual(icon.midX, markerIcon.midX, accuracy: 1, "A line's icon is off the marker icon's 16pt frame")
        }
        let lineHeight = UIFont.preferredFont(forTextStyle: .callout).lineHeight
        for title in titles {
            XCTAssertEqual(title.minX, markerTitle.minX, accuracy: 0.5, "A line's title is off the marker title's edge")
            XCTAssertLessThan(title.height, lineHeight * 1.5, "A label wrapped")
            XCTAssertLessThan(title.maxX, chevron.minX, "A long label runs under the chevron")
        }
        XCTAssertLessThanOrEqual(chevron.maxX, window.bounds.maxX)
        XCTAssertEqual(chevron.midX, markerRow[markerRow.count - 1].midX, accuracy: 0.5, "The chevron is off the marker's")
        XCTAssertEqual(chevron.midY, lines.accessibilityFrame.midY, accuracy: 1, "The chevron is not centred on the lines")

        // The failed icon keeps its orange; every label is as quiet as the marker title is not.
        let failedIcon = try XCTUnwrap(icons.min { $0.minY < $1.minY })
        XCTAssertGreaterThan(saturation(in: window, failedIcon), 100, "The failed icon lost its orange")
        for title in titles {
            XCTAssertLessThan(strongestInk(in: window, title), strongestInk(in: window, markerTitle) - 40, "A label is not secondary")
        }
        attachHostedScreenshot(window, name: "background-lines-collapsed")

        HostedAccessibility.activate(lines)
        let excerpt = try await requireElement(in: window, label: "Full result…")
        settle(0.2)
        row = drawnLayers(in: window, within: lines.accessibilityFrame)
        chevron = try XCTUnwrap(row.last)
        XCTAssertGreaterThan(chevron.width, chevron.height, "The chevron did not turn")
        XCTAssertEqual(excerpt.accessibilityFrame.minX, markerTitle.minX, accuracy: 0.5, "The body is not indented 24pt")
        let beside = CGPoint(x: (lines.accessibilityFrame.minX + excerpt.accessibilityFrame.minX) / 2, y: excerpt.accessibilityFrame.midY)
        XCTAssertEqual(windowPixels(window, at: [beside])[0], windowPixels(window, at: [CGPoint(x: 4, y: beside.y)])[0], "The body sits on a surface")
        attachHostedScreenshot(window, name: "background-lines-expanded")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show more"))
        _ = try await requireElement(in: window, label: "Full result details.")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show less"))
        _ = try await requireElement(in: window, label: "Full result…")
    }

    /// The frames, in window points and left to right, of what SwiftUI drew inside `rect`: each icon, label and chevron.
    private func drawnLayers(in window: UIWindow, within rect: CGRect) -> [CGRect] {
        var found: [CGRect] = []
        func visit(_ layer: CALayer) {
            let frame = layer.convert(layer.bounds, to: window.layer)
            if (layer.sublayers ?? []).isEmpty, layer.contents != nil || "\(type(of: layer))".contains("ShapeLayer"),
               rect.insetBy(dx: -1, dy: -1).contains(frame) { found.append(frame) }
            layer.sublayers?.forEach(visit)
        }
        visit(window.layer)
        return found.sorted { $0.minX == $1.minX ? $0.minY < $1.minY : $0.minX < $1.minX }
    }

    /// Every pixel of `rect` in `window`'s committed frame at 3x, as its colour channels: at 3x a glyph's stems are solid, so
    /// its strongest pixel is its colour.
    private func pixels(in window: UIWindow, _ rect: CGRect) -> [[Int]] {
        guard let cgImage = committedWindowImage(window, scale: 3), let data = cgImage.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return [] }
        let pixelBytes = cgImage.bitsPerPixel / 8
        let (xs, ys) = (Int(rect.minX * 3)..<Int(rect.maxX * 3), Int(rect.minY * 3)..<Int(rect.maxY * 3))
        return ys.flatMap { y in xs.map { x in (0..<3).map { Int(bytes[y * cgImage.bytesPerRow + x * pixelBytes + $0]) } } }
    }

    private func saturation(in window: UIWindow, _ rect: CGRect) -> Int {
        pixels(in: window, rect).map { ($0.max() ?? 0) - ($0.min() ?? 0) }.max() ?? 0
    }

    /// How far the strongest pixel of `rect` stands from the window's background: primary text reaches further than
    /// secondary in either appearance.
    private func strongestInk(in window: UIWindow, _ rect: CGRect) -> Int {
        let background = pixels(in: window, CGRect(x: 2, y: rect.midY, width: 1, height: 1)).first ?? [0, 0, 0]
        return pixels(in: window, rect).map { zip($0, background).map { abs($0 - $1) }.reduce(0, +) / 3 }.max() ?? 0
    }

    /// A compaction is its own row in its place, a flat disclosure line as tall as the transcript's other ones (TAL-1566).
    func testTheCompactionRowSitsInPlaceAsAFlatLine() async throws {
        let window = try await hostFixtureChat(["--ui-test-compaction-row"])
        let row = try await requireElement(in: window, label: "Context compaction")
        let anchor = try await requireElement(in: window, label: "Here is the plan.")
        let next = try await requireElement(in: window, label: "Start step one.")
        XCTAssertLessThan(anchor.accessibilityFrame.maxY, row.accessibilityFrame.minY, "The row is not after the turn before it")
        XCTAssertLessThan(row.accessibilityFrame.maxY, next.accessibilityFrame.minY, "The row is not before the turn after it")
        XCTAssertGreaterThanOrEqual(row.accessibilityFrame.height.rounded(), 44, "The line is not the disclosure rows' height")
        let collapsed = await awaitElement(in: window, timeout: 0.5) { $0.accessibilityLabel?.contains("Earlier turns were summarised.") == true }
        XCTAssertNil(collapsed, "The summary shows before the row is expanded")
        HostedAccessibility.activate(row)
        let expanded = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Earlier turns were summarised.") == true }
        XCTAssertNotNil(expanded, "Expanding the row does not show the summary")
    }

    /// TAL-1761: an open running subagent rereads its detail on the server's `refresh_after` until the settled scene
    /// arrives, and a turn the reader collapsed meanwhile stays collapsed.
    func testARunningSubagentUpdatesInPlaceAndKeepsTheReadersCollapsedTurn() async throws {
        let fixture = try FixtureApp(for: self)
        let running = try Self.subagentDetail("running")
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = running }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)

        let earlier = try await requireElement(in: window, label: "Worked for 12s")
        XCTAssertEqual(earlier.accessibilityHint, "Double tap to collapse work.", "The server opens the earlier turn")
        let work = await awaitElement(in: window) { $0.accessibilityLabel?.contains("parser.swift") == true }
        XCTAssertNotNil(work, "The running turn's work is not shown")
        attachHostedScreenshot(window, name: "running-subagent-before")
        HostedAccessibility.activate(earlier)
        let collapsed = await awaitCondition {
            HostedAccessibility.element(in: window, label: "Worked for 12s")?.accessibilityHint == "Double tap to expand work."
        }
        XCTAssertTrue(collapsed)

        let settledDetail = try Self.subagentDetail("settled")
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = settledDetail }
        _ = try await requireElement(in: window, label: "All fixed.", "The settled scene never replaced the running one")
        XCTAssertEqual(HostedAccessibility.element(in: window, label: "Worked for 12s")?.accessibilityHint, "Double tap to expand work.",
                       "The reread reopened the turn the reader collapsed")
        settle(0.3)
        attachHostedScreenshot(window, name: "running-subagent-settled")
    }

    /// TAL-2332: a settled turn splits and names its activity groups from the server's fields, and a run of calls the server
    /// merged shows as one row named for them that opens to each call.
    func testServerActivityGroupsSplitNameAndMergeTheTurnsCalls() async throws {
        let fixture = try FixtureApp(for: self)
        let detail = try Self.activityGroupDetail()
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)

        let first = try await requireElement(in: window, label: "Completed activity, Read files, ran a command", "The first group is not named from its record")
        // The web search is its own group of one call, shown inline after the prose rather than folded into the first group.
        let search = await awaitElement(in: window) { $0.accessibilityLabel?.contains("swift concurrency") == true }
        XCTAssertNotNil(search, "The second group's call is not shown on its own")
        settle(0.3)
        attachHostedScreenshot(window, name: "activity-groups-collapsed")
        HostedAccessibility.activate(first)
        let merged = try await requireElement(in: window, label: "Read files", "The merged reads are not one row")
        let labels = { HostedAccessibility.elements(in: window).compactMap(\.accessibilityLabel) }
        let shell = await awaitCondition { labels().contains { $0.contains("ls -la") } }
        XCTAssertTrue(shell, "The command is not its own row in the group")
        XCTAssertFalse(labels().contains { $0.contains("beta.swift") }, "The merged reads are not folded into their row")
        settle(0.3)
        attachHostedScreenshot(window, name: "activity-groups-merged-folded")
        HostedAccessibility.activate(merged)
        let opened = await awaitCondition { ["alpha.swift", "beta.swift", "gamma.swift"].allSatisfy { target in labels().contains { $0.contains(target) } } }
        XCTAssertTrue(opened, "The merged row does not open to each call: \(labels())")
        settle(0.3)
        attachHostedScreenshot(window, name: "activity-groups-merged-open")
    }

    /// TAL-2027: a settled turn shows the question the agent asked and the answer it got, from the shared
    /// `contracts/fixtures/answered-question.json` row, without opening the call; the open row does not repeat them.
    func testASettledTurnShowsTheAnsweredQuestionWithoutOpeningIt() async throws {
        let fixture = try FixtureApp(for: self)
        let detail = try Self.answeredQuestionDetail()
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)

        let labels = { HostedAccessibility.elements(in: window).compactMap(\.accessibilityLabel) }
        let expected = ["Which branch should I deploy?", "release", "Run the migrations first?", "No answer", "The clarification timed out."]
        let shown = await awaitCondition { expected.allSatisfy { text in labels().contains { $0.contains(text) } } }
        XCTAssertTrue(shown, "The answered question is not in view: \(labels())")
        let call = try await requireElement(in: window, "The question's row is missing") {
            $0.accessibilityLabel?.contains("Asked") == true && $0.accessibilityHint == "Double tap to expand details."
        }
        settle(0.3)
        attachHostedScreenshot(window, name: "answered-question-settled")
        HostedAccessibility.activate(call)
        let opened = await awaitCondition { HostedAccessibility.elements(in: window).contains { $0.accessibilityHint == "Double tap to collapse details." } }
        XCTAssertTrue(opened, "The question's row did not open")
        XCTAssertEqual(labels().filter { $0.contains("No answer") }.count, 1, "The open row repeats the rows: \(labels())")
    }

    /// TAL-1961: the control that pages a long turn's earlier rows reads as one of its activity rows: the row's leading edge
    /// and height, one button named with the remaining count. Tapping it loads the rows in a plain and a steered turn.
    func testEarlierStepsSitInTheActivityColumnAndLoadThePagedRows() async throws {
        let fixture = try FixtureApp(for: self)
        let detail = try Self.earlierStepsDetail()
        let page = try JSONSerialization.data(withJSONObject: ["start": 0, "rows": [
            ["row_id": "earlier:prose", "order_index": 0, "role": "prose", "text": "Earlier progress"],
            ["row_id": "earlier:more", "order_index": 1, "role": "prose", "text": "More earlier progress"],
        ]])
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        UITestFixtureURLProtocol.anchorScenePage.withLock { $0 = page }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)

        let controls = { HostedAccessibility.elements(in: window, labelContaining: "Earlier steps (") }
        let ready = await awaitCondition { controls().count == 2 }
        XCTAssertTrue(ready, "Both turns do not offer their earlier steps")
        let control = try XCTUnwrap(controls().first)
        let activity = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix("Completed activity") == true }
        let row = try XCTUnwrap(activity, "The plain turn's activity row is missing")
        XCTAssertEqual(control.accessibilityLabel, "Earlier steps (2)")
        XCTAssertTrue(control.accessibilityTraits.contains(.button))
        XCTAssertGreaterThanOrEqual(control.accessibilityFrame.height.rounded(), 44, "The control is not an activity row's height")
        XCTAssertEqual(control.accessibilityFrame.minX, row.accessibilityFrame.minX, accuracy: 0.5, "The control does not share the activity row's leading edge")
        XCTAssertEqual(HostedAccessibility.identifier(of: control), "transcript-earlier-steps")
        settle(0.3)
        attachHostedScreenshot(window, name: "earlier-steps")

        HostedAccessibility.activate(control)
        let loaded = await awaitCondition { !HostedAccessibility.elements(in: window, labelContaining: "Earlier progress").isEmpty }
        XCTAssertTrue(loaded, "The plain turn's earlier rows did not load")
        let plainDone = await awaitCondition { controls().count == 1 }
        XCTAssertTrue(plainDone, "The plain turn still offers earlier steps once none remain")
        HostedAccessibility.activate(try XCTUnwrap(controls().first))
        let steeredDone = await awaitCondition { controls().isEmpty }
        XCTAssertTrue(steeredDone, "The steered turn still offers earlier steps once none remain")
    }

    /// TAL-1975: the control says what its read is doing, as Web's does: a disabled "Loading…" while the page is held,
    /// "Retry" once it failed, and gone once a retry loads the rows. Each title is the control's VoiceOver label.
    func testEarlierStepsShowLoadingThenRetryAndLoadOnRetry() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-anchor-scene"], for: self)
        let detail = try Self.earlierStepsDetail()
        let page = try JSONSerialization.data(withJSONObject: ["start": 0, "rows": [
            ["row_id": "earlier:prose", "order_index": 0, "role": "prose", "text": "Earlier progress"],
            ["row_id": "earlier:more", "order_index": 1, "role": "prose", "text": "More earlier progress"],
        ]])
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        UITestFixtureURLProtocol.anchorScenePage.withLock { $0 = page }
        UITestFixtureURLProtocol.anchorScenePageStatus.withLock { $0 = 500 }
        let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)
        defer { window.isHidden = true }
        func control(_ title: String) async throws -> NSObject {
            try await requireElement(in: window, "The earlier-steps control never reads \(title)") {
                HostedAccessibility.identifier(of: $0) == "transcript-earlier-steps" && $0.accessibilityLabel == title
            }
        }

        HostedAccessibility.activate(try await control("Earlier steps (2)"))
        let loading = try await control("Loading…")
        XCTAssertTrue(loading.accessibilityTraits.contains(.notEnabled), "The loading control still takes taps")
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount == 1 }
        XCTAssertTrue(held, "The page read was not held")
        settle(0.3)
        attachHostedScreenshot(window, name: "earlier-steps-loading")
        fixture.releaseHeldLoads()

        let retry = try await control("Retry")
        XCTAssertFalse(retry.accessibilityTraits.contains(.notEnabled), "Retry does not take taps")
        settle(0.3)
        attachHostedScreenshot(window, name: "earlier-steps-retry")

        UITestFixtureURLProtocol.anchorScenePageStatus.withLock { $0 = 200 }
        HostedAccessibility.activate(retry)
        _ = try await control("Loading…")
        let heldAgain = await awaitCondition { UITestFixtureHold.shared.pendingCount == 1 }
        XCTAssertTrue(heldAgain, "Retry did not read the page again")
        fixture.releaseHeldLoads()
        let loaded = await awaitCondition { !HostedAccessibility.elements(in: window, labelContaining: "Earlier progress").isEmpty }
        XCTAssertTrue(loaded, "Retry did not load the earlier rows")
        let remaining = HostedAccessibility.elements(in: window).filter { HostedAccessibility.identifier(of: $0) == "transcript-earlier-steps" }
        XCTAssertEqual(remaining.map(\.accessibilityLabel), ["Earlier steps (2)"], "The other turn no longer offers its untouched steps")
        settle(0.3)
        attachHostedScreenshot(window, name: "earlier-steps-loaded")
    }

    /// Two settled tail previews that omit their first two rows: a plain turn with a group of calls, then a steered turn.
    private nonisolated static func earlierStepsDetail() throws -> Data {
        func tool(_ id: String, name: String, kind: String, group: String, order: Int) -> [String: Any] {
            ["row_id": "tool:\(id)", "order_index": order, "role": "tool", "group_id": group,
             "tool": ["id": id, "name": name, "kind": kind, "target": "\(id).swift", "args": [:], "done": true, "is_error": false]]
        }
        func scene(_ ref: String, answer: String, rows: [[String: Any]], groups: [[String: Any]] = []) -> [String: Any] {
            ["version": "activity_scene_v1", "terminal_state": "completed", "final_answer": answer, "expanded_by_default": true,
             "turn_duration": 9, "activity_rows_offset": 2, "activity_rows_total": rows.count + 2, "activity_scene_ref": ref,
             "activity_rows": rows, "activity_groups": groups]
        }
        let plain = scene("plain", answer: "All read.", rows: [
            tool("alpha", name: "read_file", kind: "read", group: "group:0", order: 2),
            tool("list", name: "terminal", kind: "shell", group: "group:0", order: 3),
        ], groups: [["group_id": "group:0", "parts": [["kind": "read", "count": 1, "failed": 0], ["kind": "shell", "count": 1, "failed": 0]], "failed": 0, "running": false]])
        let steered = scene("steered", answer: "Docs checked.", rows: [
            tool("beta", name: "read_file", kind: "read", group: "group:1", order: 2),
            ["row_id": "steering:docs", "order_index": 3, "role": "steering", "text": "Also check the docs",
             "steering": ["steer_id": "docs", "consumed": true]],
            tool("docs", name: "read_file", kind: "read", group: "group:2", order: 4),
        ])
        let session: [String: Any] = [
            "session_id": UITestFixtureURLProtocol.sessionID, "title": "Paged turns",
            "messages": [
                ["role": "user", "content": "Read the sources", "message_id": "plain-goal", "_turn_id": "plain"],
                ["role": "assistant", "content": "All read.", "message_id": "plain-reply", "_turn_id": "plain", "_anchor_activity_scene": plain],
                ["role": "user", "content": "Check the docs", "message_id": "steered-goal", "_turn_id": "steered"],
                ["role": "assistant", "content": "Docs checked.", "message_id": "steered-reply", "_turn_id": "steered", "_anchor_activity_scene": steered],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: ["session": session])
    }

    /// TAL-1484: a chat that ran while the reader was away opens with "New since you left" above the server's first
    /// unread row, that rule in the top third, and reports the chat viewed once the rule has stayed on screen.
    func testAChatOpensAtTheUnreadRuleAndReportsItViewed() async throws {
        let fixture = try FixtureApp(for: self)
        let (detail, unreadText) = try Self.unreadDetail()
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        let window = try hostWindow(fixture.chat(try await fixture.session())
            .environment(\.chatViewedDwell, .milliseconds(100)), size: HostedSize.phone)

        let scroll = try await unreadTranscriptScrollView(in: window)
        let placed = await awaitCondition { self.unreadRulePlacement(in: window, scroll: scroll, above: unreadText) == "top third" }
        // The rows around the rule realize after it lands; the evidence shows them drawn.
        _ = await awaitCondition { ["Here is the plan.", "later note 2"].allSatisfy { HostedAccessibility.element(in: window, label: $0) != nil } }
        attachHostedScreenshot(window, name: "unread-rule-open")
        XCTAssertTrue(placed, "The rule is not above its row in the top third: \(String(describing: unreadRulePlacement(in: window, scroll: scroll, above: unreadText)))")
        let reported = await awaitCondition { UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains("/api/talaria/viewed") } }
        XCTAssertTrue(reported, "The chat was never reported viewed")
    }

    /// TAL-1484: the rule belongs to the visit. A later read naming another row, as a reply arriving while the chat is
    /// open would, neither moves the rule nor adds one.
    func testALaterReadNeverMovesTheUnreadRule() async throws {
        let fixture = try FixtureApp(for: self)
        let (detail, unreadText) = try Self.unreadDetail()
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        let session = try await fixture.session()
        let model = ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
                                  liveActivityManager: SpyChatLiveActivityManager(), networkPath: nil)
        let window = try hostWindow(fixture.chat(session, viewModel: model), size: HostedSize.phone)
        let scroll = try await unreadTranscriptScrollView(in: window)
        let placed = await awaitCondition { self.unreadRulePlacement(in: window, scroll: scroll, above: unreadText) == "top third" }
        XCTAssertTrue(placed, "The rule never opened above its row")

        let (later, _) = try Self.unreadDetail(appending: ["role": "assistant", "content": "Arrived while open", "message_id": "arrived-while-open"],
                                               unreadFrom: "arrived-while-open")
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = later }
        NotificationCenter.default.post(name: .talariaReauthenticated, object: UITestFixtureEnvironment.serverURL)
        let applied = await awaitCondition { model.messages.contains { $0.messageId == "arrived-while-open" } }
        XCTAssertTrue(applied, "The later read never applied")
        attachHostedScreenshot(window, name: "unread-rule-after-later-read")
        let rules = HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == "New since you left" }.count
        XCTAssertEqual(rules, 1, "The later read added a rule")
        XCTAssertNotNil(unreadRulePlacement(in: window, scroll: scroll, above: unreadText), "The rule left its row")
    }

    /// TAL-1484: a server that names nothing new, or predates the field, opens on the latest message with no rule.
    func testAChatWithNothingNewOpensAtTheLatestMessageWithoutTheRule() async throws {
        for unreadFrom in [NSNull(), nil] as [Any?] {
            let fixture = try FixtureApp(for: self)
            let (detail, _) = try Self.unreadDetail(unreadFrom: unreadFrom)
            UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
            let window = try hostWindow(fixture.chat(try await fixture.session()), size: HostedSize.phone)
            let scroll = try await unreadTranscriptScrollView(in: window)
            let atLatest = await awaitCondition {
                scroll.contentOffset.y + scroll.bounds.height - scroll.adjustedContentInset.bottom >= scroll.contentSize.height - 2
            }
            XCTAssertTrue(atLatest, "The chat did not open on its latest message (\(String(describing: unreadFrom)))")
            XCTAssertNil(HostedAccessibility.element(in: window, label: "New since you left"), "A rule showed (\(String(describing: unreadFrom)))")
            window.isHidden = true
        }
    }

    /// TAL-1484: the server records a viewed position only from the App's reports, so a chat with nothing new is still
    /// reported viewed once it has been on screen; otherwise a chat read only in the App would never get a rule.
    func testAChatWithNothingNewIsStillReportedViewed() async throws {
        let fixture = try FixtureApp(for: self)
        let (detail, _) = try Self.unreadDetail(unreadFrom: NSNull())
        UITestFixtureURLProtocol.sessionDetail.withLock { $0 = detail }
        let window = try hostWindow(fixture.chat(try await fixture.session())
            .environment(\.chatViewedDwell, .milliseconds(100)), size: HostedSize.phone)
        _ = try await unreadTranscriptScrollView(in: window)
        let reported = await awaitCondition { UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains("/api/talaria/viewed") } }
        XCTAssertTrue(reported, "A chat with nothing new was never reported viewed")
    }

    /// TAL-1484: the server may name a row up to 500 rows before the window it sent; the chat loads older pages until it
    /// reaches that row and opens at the rule there.
    func testAnUnreadRowPagesBeforeTheWindowLoadsAndOpensAtTheRule() async throws {
        let fixture = try FixtureApp(for: self)
        let (detail, unreadText) = try Self.unreadDetail(laterRows: 40)
        var session = try XCTUnwrap(JSONSerialization.jsonObject(with: detail) as? [String: Any])["session"] as? [String: Any] ?? [:]
        let rows = try XCTUnwrap(session["messages"] as? [[String: Any]])
        // Two older pages, each taller than the history prefetch reaches, separate the window from the unread row.
        let middle = try XCTUnwrap(rows.firstIndex { $0["content"] as? String == unreadText }) + 2
        let newest = middle + 20
        func page(_ range: Range<Int>, newest: Bool) throws -> String {
            session["messages"] = Array(rows[range])
            session["_messages_offset"] = range.lowerBound
            session["_messages_truncated"] = range.lowerBound > 0
            if !newest { session.removeValue(forKey: "unread_from_message_id") }
            return String(decoding: try JSONSerialization.data(withJSONObject: ["session": session]), as: UTF8.self)
        }
        let pages = ["": try page(newest..<rows.count, newest: true), "\(newest)": try page(middle..<newest, newest: false),
                     "\(middle)": try page(0..<middle, newest: false)]
        let stream = ScriptedSSEStreamingClient()
        let summary = SessionSummary(sessionId: UITestFixtureURLProtocol.sessionID, title: "Unread fixture")
        let model = try makeScriptedChatViewModel(streamClient: stream, sessionSummary: summary) { request in
            guard request.url?.path == "/api/session", let url = request.url else { return apiTestJSONResponse("{}", for: request) }
            let before = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "msg_before" }?.value ?? ""
            return apiTestJSONResponse(pages[before] ?? "{}", for: request)
        }
        defer {
            model.cleanupPollingTasks()
            stream.stop()
        }
        let hosted = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://example.test")!, onAPIError: { _ in }, viewModel: model)
        }.modelContainer(fixture.cache), size: HostedSize.phone)

        let scroll = try await unreadTranscriptScrollView(in: hosted)
        let placed = await awaitCondition { self.unreadRulePlacement(in: hosted, scroll: scroll, above: unreadText) == "top third" }
        attachHostedScreenshot(hosted, name: "unread-rule-pages-before")
        XCTAssertTrue(placed, "The rule two pages before the window never opened in the top third")
    }

    /// The shared unread fixture's chat, long enough to scroll, with `appending` after its rows and its
    /// `unread_from_message_id` replaced by `unreadFrom` (removed when nil); also the text of the row the fixture names.
    nonisolated static func unreadDetail(appending extra: [String: Any]? = nil, unreadFrom: Any?? = .none,
                                         laterRows: Int = 10) throws -> (Data, String) {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("unread-from-message")) as? [String: Any])
        var session = try XCTUnwrap(fixture["session"] as? [String: Any])
        let rows = try XCTUnwrap(session["messages"] as? [[String: Any]])
        let unreadID = try XCTUnwrap(session["unread_from_message_id"] as? String)
        let unreadText = try XCTUnwrap(rows.first { $0["message_id"] as? String == unreadID }?["content"] as? String)
        func filler(_ prefix: String, count: Int = 10) -> [[String: Any]] {
            (0..<count).map { ["role": $0.isMultiple(of: 2) ? "user" : "assistant", "content": "\(prefix) note \($0)", "message_id": "\(prefix)-\($0)"] }
        }
        session["session_id"] = UITestFixtureURLProtocol.sessionID
        session["messages"] = filler("earlier") + rows + filler("later", count: laterRows) + (extra.map { [$0] } ?? [])
        switch unreadFrom {
        case .none: break
        case .some(.none): session.removeValue(forKey: "unread_from_message_id")
        case .some(.some(let value)): session["unread_from_message_id"] = value
        }
        return (try JSONSerialization.data(withJSONObject: ["session": session]), unreadText)
    }

    private func unreadTranscriptScrollView(in window: UIWindow) async throws -> UIScrollView {
        _ = try await requireElement(in: window, "The transcript never loaded") { $0.accessibilityLabel?.contains(" note ") == true }
        var scroll: UIScrollView?
        _ = await awaitCondition {
            scroll = window.firstView(ofType: ChatMessageMenuHostView.self)?.superview.flatMap {
                sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
            }
            return scroll != nil
        }
        return try XCTUnwrap(scroll, "The transcript's scroll view did not attach")
    }

    /// Where the rule sits: "top third" when it is in the viewport's top third, "on screen" lower down, nil when it is
    /// missing or not directly above the row showing `text`.
    private func unreadRulePlacement(in window: UIWindow, scroll: UIScrollView, above text: String) -> String? {
        let elements = HostedAccessibility.elements(in: window)
        guard let rule = elements.first(where: { $0.accessibilityLabel == "New since you left" })?.accessibilityFrame,
              let row = elements.first(where: { $0.accessibilityLabel?.contains(text) == true })?.accessibilityFrame,
              rule.maxY <= row.minY, row.minY - rule.maxY < 40 else { return nil }
        let viewport = scroll.convert(scroll.bounds.inset(by: scroll.adjustedContentInset), to: nil)
        return rule.minY >= viewport.minY && rule.maxY <= viewport.minY + viewport.height / 3 ? "top third" : "on screen"
    }

    /// A settled turn as the server ships it: a read, then the shared answered question in a group of its own.
    private nonisolated static func answeredQuestionDetail() throws -> Data {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("answered-question")) as? [String: Any])
        var question = try XCTUnwrap(fixture["row"] as? [String: Any])
        question["order_index"] = 1
        let read: [String: Any] = ["row_id": "tool:read", "order_index": 0, "role": "tool", "group_id": "group:0",
                                   "tool": ["id": "read", "name": "read_file", "kind": "read", "target": "deploy.md", "args": [:], "done": true, "is_error": false]]
        let groups: [[String: Any]] = [
            ["group_id": "group:0", "parts": [["kind": "read", "count": 1, "failed": 0]], "failed": 0, "running": false],
            ["group_id": "group:1", "parts": [["kind": "question", "count": 1, "failed": 0]], "failed": 0, "running": false],
        ]
        let session: [String: Any] = [
            "session_id": UITestFixtureURLProtocol.sessionID, "title": "Answered question",
            "messages": [
                ["role": "user", "content": "Deploy it", "message_id": "ask-goal", "_turn_id": "ask"],
                ["role": "assistant", "content": "Deployed release.", "message_id": "ask-reply", "_turn_id": "ask",
                 "_anchor_activity_scene": ["version": "activity_scene_v1", "terminal_state": "completed", "final_answer": "Deployed release.",
                                            "expanded_by_default": true, "turn_duration": 9, "activity_rows": [read, question], "activity_groups": groups]],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: ["session": session])
    }

    /// A settled turn as the server ships it: three merged reads and a command in one group, prose, then a web search.
    private nonisolated static func activityGroupDetail() throws -> Data {
        func tool(_ id: String, name: String, kind: String, target: String, group: String, extra: [String: Any] = [:]) -> [String: Any] {
            ["row_id": "tool:\(id)", "order_index": 0, "role": "tool", "group_id": group,
             "tool": ["id": id, "name": name, "kind": kind, "target": target, "args": [:], "done": true, "is_error": false]].merging(extra) { $1 }
        }
        let rows: [[String: Any]] = [
            tool("alpha", name: "read_file", kind: "read", target: "alpha.swift", group: "group:0", extra: ["merged_count": 3]),
            tool("beta", name: "read_file", kind: "read", target: "beta.swift", group: "group:0", extra: ["merged_into": "tool:alpha"]),
            tool("gamma", name: "read_file", kind: "read", target: "gamma.swift", group: "group:0", extra: ["merged_into": "tool:alpha"]),
            tool("list", name: "terminal", kind: "shell", target: "ls -la", group: "group:0"),
            ["row_id": "reply:prose", "order_index": 0, "role": "prose", "text": "Read the sources; checking the docs next."],
            tool("docs", name: "web_search", kind: "web", target: "swift concurrency", group: "group:1"),
        ].enumerated().map { index, row in row.merging(["order_index": index]) { $1 } }
        let groups: [[String: Any]] = [
            ["group_id": "group:0", "parts": [["kind": "read", "count": 3, "failed": 0], ["kind": "shell", "count": 1, "failed": 0]], "failed": 0, "running": false],
            ["group_id": "group:1", "parts": [["kind": "web", "count": 1, "failed": 0]], "failed": 0, "running": false],
        ]
        let session: [String: Any] = [
            "session_id": UITestFixtureURLProtocol.sessionID, "title": "Activity groups",
            "messages": [
                ["role": "user", "content": "Read the sources", "message_id": "groups-goal", "_turn_id": "groups"],
                ["role": "assistant", "content": "All read.", "message_id": "groups-reply", "_turn_id": "groups",
                 "_anchor_activity_scene": ["version": "activity_scene_v1", "terminal_state": "completed", "final_answer": "All read.",
                                            "expanded_by_default": true, "turn_duration": 9, "activity_rows": rows, "activity_groups": groups]],
            ],
        ]
        return try JSONSerialization.data(withJSONObject: ["session": session])
    }

    /// The shared fixture's `key` detail for the fixture chat: an earlier turn the server opens, then the last turn,
    /// running or settled as `key` says.
    private nonisolated static func subagentDetail(_ key: String) throws -> Data {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("running-subagent")) as? [String: Any])
        var session = try XCTUnwrap(fixture[key] as? [String: Any])
        session["session_id"] = UITestFixtureURLProtocol.sessionID
        session["refresh_after"] = key == "running" ? 1 : NSNull()
        let running = key == "running"
        func tool(_ id: String, done: Bool) -> [String: Any] {
            ["row_id": "tool:\(id)", "order_index": 0, "role": "tool",
             "tool": ["id": id, "name": "read_file", "kind": "read", "target": "\(id).swift", "args": [:], "done": done, "is_error": false]]
        }
        session["messages"] = [
            ["role": "user", "content": "Read the lexer", "message_id": "first-goal", "_turn_id": "first"],
            ["role": "assistant", "content": "Lexer read.", "message_id": "first-reply", "_turn_id": "first",
             "_anchor_activity_scene": ["version": "activity_scene_v1", "terminal_state": "completed", "final_answer": "Lexer read.",
                                        "expanded_by_default": true, "turn_duration": 12, "activity_rows": [tool("lexer", done: true)]]],
            ["role": "user", "content": "Fix the parser", "message_id": "second-goal", "_turn_id": "second"],
            ["role": "assistant", "content": running ? "" : "All fixed.", "message_id": "second-reply", "_turn_id": "second",
             "_anchor_activity_scene": ["version": "activity_scene_v1", "terminal_state": running ? "running" : "completed",
                                        "final_answer": running ? "" : "All fixed.", "expanded_by_default": running, "turn_duration": 30,
                                        "activity_rows": [tool("parser", done: !running)]]]
        ]
        return try JSONSerialization.data(withJSONObject: ["session": session])
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
private func historyTranscript(messages supplied: [ChatMessage]? = nil, messageCount: Int = 50, messageOffset: Int? = nil, hasOlderMessages: Bool = true, onMetrics: @escaping (ChatScrollMetrics) -> Void = { _ in }, shouldRender: @escaping (ChatMessage) -> Bool = { _ in true }, scrollRequest: Int = 0, onScrollRequest: @escaping (ChatTranscriptScrollProxy) -> Void = { _ in }, turnChangesSummary: TurnFileChangeSummary? = nil, streamingAssistantMessageID: String? = nil, actionContext: @escaping (ChatMessage, Int) -> MessageActionContext? = { _, _ in nil }, onCopy: @escaping (MessageActionContext) -> Void = { _ in }, load: @escaping (@MainActor () -> Void) async -> Bool) -> some View {
    let messages = supplied ?? (0..<messageCount).map { index in
        ChatMessage(role: "user", content: "History row \(index). Synthetic transcript text.", timestamp: nil, messageId: "history-\(index)")
    }
    return ChatTranscriptView(
        isLoading: false, errorMessage: nil, messages: messages,
        excerptRevision: messages.map { [$0.displayExcerpt, $0.activityScene?.finalAnswerExcerpt] }.hashValue,
        displayedTranscriptMessages: ChatViewModel.transcriptMessages(from: messages, messageOffset: messageOffset),
        branchedFrom: nil, reasoningGroupsForAnchor: { _ in [] },
        completedToolCallGroupsForAnchor: { _ in [] }, archivedActivityRowsForAnchor: { _ in [] },
        earlierSceneRowsForTurn: { _ in [] }, earlierSceneRowsLoadStateForTurn: { _ in .idle }, onLoadEarlierSceneRows: { _ in },
        liveReasoningText: "", liveActivityRows: [], reasoningAnchorMessageID: nil,
        liveToolCalls: [], toolCallAnchorMessageID: nil, streamingAssistantMessageID: streamingAssistantMessageID,
        liveTokensPerSecond: nil, showsRunStateCheck: false, clarificationPrompt: nil,
        showsThinkingAndToolCards: false, shouldFollowLatestMessage: false,
        isDisclosureSettling: false, latestTranscriptMessageRole: nil, isScrolledNearBottom: false,
        activeStreamID: streamingAssistantMessageID, streamingScrollTrigger: { 0 }, cacheFirstReconcileScrollToken: 0,
        transcriptMessageSpacing: 12, transcriptBlockSpacing: 8,
        transcriptBottomInsetHeight: 0, scrollToBottomRequest: scrollRequest, followReplayRequest: 0,
        assistantName: "Assistant", localAttachmentPreviews: [:], listeningMessageID: nil,
        isViewingCachedData: false, isSessionReadOnly: false, canBranch: false,
        hasOlderMessages: hasOlderMessages, isLoadingOlderMessages: false,
        isRegeneratingMessage: false, isEditingMessage: false, isForkingMessage: false,
        loadAttachmentImage: { _ in nil }, loadAttachmentData: { _ in nil },
        loadTranscriptMediaImage: { _ in nil }, loadTranscriptMediaData: { _ in nil },
        transcriptMediaCacheNamespace: "history-test", actionContext: actionContext,
        shouldRenderMessageRow: shouldRender, onLoadMessages: {}, onLoadOlderMessages: load,
        onUpdateScrollMetrics: onMetrics, onFollowEvent: { _ in }, onDisclosureToggle: { {} },
        onFollowSuppressed: {}, onDismissKeyboard: {}, onScrollToBottom: onScrollRequest,
        onScrollToLatestTranscriptMessage: { _ in }, onScrollToLatestContent: { _, _ in },
        onPreviewAttachment: { _, _ in }, onPreviewTranscriptMedia: { _ in },
        onToggleListening: { _ in }, onSelectText: { _ in }, onRegenerate: { _ in },
        onEdit: { _ in }, onFork: { _ in }, onCopy: onCopy, turnChangesSummary: turnChangesSummary
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
    let pageSize: Int
    let onMetrics: (ChatScrollMetrics) -> Void
    let onInsert: (Int) -> Void
    let shouldRender: (ChatMessage) -> Bool
    let onReady: (@escaping () -> Void) -> Void
    let load: ((@MainActor () -> Void) async -> Bool)?
    let onScrollRequest: ((ChatTranscriptScrollProxy) -> Void)?
    let onRequest: @MainActor (Int) async -> Void
    let onComplete: @MainActor () async -> Void

    init(initialStart: Int = 1_950, hasDisclosure: Bool = false, sparseOlderPages: Bool = false,
         richContent: Bool = false, pageSize: Int = 50,
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
        self.pageSize = pageSize
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
            start = max(0, start - pageSize)
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
            attachHostedScreenshot(before, name: size == HostedSize.phone ? "before-local-media-phone" : "before-local-media-pad")
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
            attachHostedScreenshot(window, name: size == HostedSize.phone ? "local-media-phone" : "local-media-pad")
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
                attachHostedScreenshot(window, name: "restored-failed-attachment-send")
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

/// TAL-2339: a reply's header says what its turn changed, without the file count where the git recap card under it says that.
@MainActor
extension TranscriptHostedTests {
    private func summarizedTurn(_ summary: String) throws -> (ChatMessage, AssistantActivityScene) {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let answer = "Fixed the cookie expiry and saved your preference."
        let scene = try decoder.decode(AssistantActivityScene.self, from: Data("""
        {"version": "activity_scene_v1", "final_answer": "\(answer)", "terminal_state": "completed",
         "activity_rows": [{"row_id": "tool:p", "order_index": 0, "role": "tool", "tool": {"id": "p", "name": "patch", "preview": null, "done": true, "is_error": false, "duration": null, "cost_usd": null}}],
         "file_changes": [{"path": "src/auth/session.ts", "action": "edited"}], "turn_summary": \(summary)}
        """.utf8))
        return (ChatMessage(role: "assistant", content: answer, timestamp: nil, messageId: "summary-answer", activityScene: scene, turnSummary: scene.turnSummary, turnId: "summary-run"), scene)
    }

    func testReplyHeaderSaysWhatTheTurnChangedAndLeavesTheFileCountToTheRecapCard() async throws {
        let (message, scene) = try summarizedTurn(#"[{"key": "files_changed", "count": 1}, {"key": "memories_saved", "count": 1}]"#)
        let recap = TurnFileChangeAggregator.summarize(changes: scene.fileChanges ?? [], status: nil)
        for (name, card, label) in [("alone", nil, "Assistant, Changed 1 file · Saved 1 memory"), ("recap", recap, "Assistant, Saved 1 memory")] {
            let window = try hostWindow(historyTranscript(messages: [message], hasOlderMessages: false, turnChangesSummary: card) { _ in false })
            let header = await awaitElement(in: window, label: label)
            XCTAssertNotNil(header, "\(name): the header never read \(label)")
            if card != nil {
                XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Changed 1 file").isEmpty, "The header repeats the recap card's file count")
            }
            attachHostedScreenshot(window, name: "turn-summary-header-\(name)")
            window.isHidden = true
        }
    }

    func testReplyHeaderKeepsALongSummaryOnOneLine() async throws {
        let (message, _) = try summarizedTurn(#"""
        [{"key": "files_changed", "count": 3}, {"key": "memories_saved", "count": 2}, {"key": "skills_updated", "count": 1},
         {"key": "schedules_changed", "count": 1}, {"key": "tasks_updated", "count": 4}, {"key": "messages_sent", "count": 2}]
        """#)
        let window = try hostWindow(historyTranscript(messages: [message], hasOlderMessages: false) { _ in false })
        let label = "Assistant, Changed 3 files · Saved 2 memories · Updated 1 skill · Changed 1 schedule · Updated 4 tasks · Sent 2 messages"
        let found = await awaitElement(in: window, label: label)
        let header = try XCTUnwrap(found, "The header never read the whole summary")
        // One footnote line, cut at the window's edge rather than wrapped.
        let frame = header.accessibilityFrame
        XCTAssertLessThan(frame.height, UIFont.preferredFont(forTextStyle: .footnote).lineHeight * 1.8)
        XCTAssertLessThanOrEqual(frame.maxX, window.bounds.maxX)
        attachHostedScreenshot(window, name: "turn-summary-header-long")
        window.isHidden = true
    }
}

/// TAL-1077: a settled reply's header shows that turn's own token usage when the reader turned it on, and opens the
/// server's cache and estimated-cost figures; a reply the server recorded no usage for shows no control.
@MainActor
extension TranscriptHostedTests {
    /// An earlier turn with no recorded usage, then a settled turn whose reply carries `usage`.
    private func usageTurns(_ usage: String) throws -> [ChatMessage] {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode([ChatMessage].self, from: Data("""
        [{"role": "user", "content": "First question.", "message_id": "usage-q1", "_turn_id": "usage-run-1"},
         {"role": "assistant", "content": "Earlier answer.", "message_id": "usage-a1", "_turn_id": "usage-run-1"},
         {"role": "user", "content": "Check the build.", "message_id": "usage-q2", "_turn_id": "usage-run-2"},
         {"role": "assistant", "content": "The build passes.", "message_id": "usage-a2", "_turn_id": "usage-run-2", "_turnUsage": \(usage),
          "_anchor_activity_scene": {"version": "activity_scene_v1", "final_answer": "The build passes.", "terminal_state": "completed",
           "activity_rows": [{"row_id": "tool:b", "order_index": 0, "role": "tool", "tool": {"id": "b", "name": "terminal", "preview": null, "done": true, "is_error": false, "duration": null, "cost_usd": null}}]}}]
        """.utf8))
    }

    private func showingTokenUsage(_ shown: Bool) {
        UserDefaults.standard.set(shown, forKey: ChatTranscriptDisplaySettings.showsTokenUsageKey)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: ChatTranscriptDisplaySettings.showsTokenUsageKey) }
    }

    func testReplyHeaderShowsItsTurnsUsageAndOpensTheCacheAndCostDetails() async throws {
        showingTokenUsage(true)
        let messages = try usageTurns(#"{"input_tokens": 1200, "output_tokens": 134, "cache_read_tokens": 900, "cache_write_tokens": 12, "estimated_cost": 0.0042, "cache_hit_percent": 75}"#)
        let window = try hostWindow(historyTranscript(messages: messages, hasOlderMessages: false) { _ in false })
        let header = try await requireElement(in: window, label: "Assistant, 1,200 input tokens, 134 output tokens")
        // Only the reply that recorded usage shows it.
        XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: "input tokens").count, 1)
        attachHostedScreenshot(window, name: "turn-usage-header")

        let details = try XCTUnwrap(header.accessibilityCustomActions?.first { $0.name == "Token Usage" }, "The header offers no usage details")
        XCTAssertTrue(details.actionHandler?(details) ?? false)
        for row in ["Input, 1,200 tokens", "Output, 134 tokens", "Cache read, 900 tokens", "Cache write, 12 tokens", "Cache hit, 75%", "Estimated cost, $0.0042"] {
            _ = try await requireElement(in: window, label: row, "The usage details never read \(row)")
        }
        attachHostedScreenshot(window, name: "turn-usage-details")
    }

    func testReplyHeaderLeavesOutUsageTheServerCouldNotGiveOrTheReaderHid() async throws {
        let unpriced = #"{"input_tokens": 1200, "output_tokens": 134, "cache_read_tokens": 0, "cache_write_tokens": 0, "estimated_cost": null, "cache_hit_percent": null}"#
        showingTokenUsage(true)
        let window = try hostWindow(historyTranscript(messages: try usageTurns(unpriced), hasOlderMessages: false) { _ in false })
        let header = try await requireElement(in: window, label: "Assistant, 1,200 input tokens, 134 output tokens")
        let details = try XCTUnwrap(header.accessibilityCustomActions?.first { $0.name == "Token Usage" })
        XCTAssertTrue(details.actionHandler?(details) ?? false)
        _ = try await requireElement(in: window, label: "Cache read, 0 tokens")
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Estimated cost").isEmpty, "An unpriced reply shows a cost")
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Cache hit").isEmpty, "A reply with no cache hit rate shows one")
        window.isHidden = true

        showingTokenUsage(false)
        let hidden = try hostWindow(historyTranscript(messages: try usageTurns(unpriced), hasOlderMessages: false) { _ in false })
        _ = try await requireElement(in: hidden, label: "The build passes.")
        XCTAssertTrue(HostedAccessibility.elements(in: hidden, labelContaining: "input tokens").isEmpty, "Usage shows with the setting off")
    }

    func testReplyHeaderKeepsLongUsageOnOneLineAtLargeTextInBothAppearances() async throws {
        showingTokenUsage(true)
        let messages = try usageTurns(#"{"input_tokens": 98765432, "output_tokens": 1234567, "cache_read_tokens": 87654321, "cache_write_tokens": 1234, "estimated_cost": 1234.5678, "cache_hit_percent": 89}"#)
        for (name, style, size) in [("light-narrow", UIUserInterfaceStyle.light, HostedSize.duoOuter), ("dark-wide", .dark, HostedSize.padLandscape)] {
            let window = try hostWindow(historyTranscript(messages: messages, hasOlderMessages: false) { _ in false }
                .dynamicTypeSize(.accessibility2), size: size) { $0.userInterfaceStyle = style }
            let header = try await requireElement(in: window, label: "Assistant, 98,765,432 input tokens, 1,234,567 output tokens")
            let frame = header.accessibilityFrame
            let line = UIFont.preferredFont(forTextStyle: .footnote, compatibleWith: UITraitCollection(preferredContentSizeCategory: .accessibilityExtraLarge)).lineHeight
            XCTAssertLessThan(frame.height, line * 1.8, "\(name): the header wrapped")
            XCTAssertLessThanOrEqual(frame.maxX, window.bounds.maxX, "\(name): the header ran off the window")
            attachHostedScreenshot(window, name: "turn-usage-long-\(name)")
            window.isHidden = true
        }
    }
}

/// TAL-965: a settled reply shows one Copy button under its text that copies the reply's Markdown, and VoiceOver reaches
/// Copy there rather than also in the reply's actions; a streaming reply shows no button and keeps Copy in its actions.
@MainActor
extension TranscriptHostedTests {
    private func copyTranscript(streaming: Bool) throws -> UIWindow {
        let messages = [
            ChatMessage(role: "user", content: "Check the build.", timestamp: nil, messageId: "copy-q"),
            ChatMessage(role: "assistant", content: "The **build** passes.", timestamp: nil, messageId: "copy-a", copyButton: true),
        ]
        return try hostWindow(historyTranscript(
            messages: messages, hasOlderMessages: false, streamingAssistantMessageID: streaming ? "copy-a" : nil,
            actionContext: { MessageActionContext(message: $0, visibleIndex: $1, messagesOffset: nil) },
            onCopy: { PlatformHooks.copyText($0.copyText) }
        ) { _ in false })
    }

    private func replyCopyActions(in window: UIWindow) -> [UIAccessibilityCustomAction] {
        HostedAccessibility.elements(in: window, labelContaining: "The build passes")
            .flatMap { $0.accessibilityCustomActions ?? [] }
            .filter { $0.name == "Copy" }
    }

    func testSettledReplyShowsOneCopyButtonThatCopiesItsMarkdown() async throws {
        let copied = recordCopies()
        let window = try copyTranscript(streaming: false)
        _ = try await requireElement(in: window, "The reply never rendered") { $0.accessibilityLabel?.contains("The build passes") == true }
        let buttons = elements(named: "Copy", in: window)
        XCTAssertEqual(buttons.count, 1, "The settled reply shows no single Copy button")
        XCTAssertTrue(replyCopyActions(in: window).isEmpty, "VoiceOver offers Copy twice on the reply")
        attachHostedScreenshot(window, name: "reply-copy-settled")

        HostedAccessibility.activate(try XCTUnwrap(buttons.first))
        XCTAssertEqual(copied.last, "The **build** passes.", "Copy did not take the reply's Markdown")
    }

    func testStreamingReplyShowsNoCopyButton() async throws {
        let window = try copyTranscript(streaming: true)
        _ = try await requireElement(in: window, "The reply never rendered") { $0.accessibilityLabel?.contains("The build passes") == true }
        XCTAssertTrue(elements(named: "Copy", in: window).isEmpty, "A streaming reply shows a Copy button")
        XCTAssertFalse(replyCopyActions(in: window).isEmpty, "A streaming reply lost Copy from its actions")
    }
}

/// A code block wider than the reading column grows into the chat's margins before it scrolls (TAL-1487).
@MainActor
extension TranscriptHostedTests {
    private static let wideCodeLine = String(repeating: "wide_fixture ", count: 9)
    private static let widestCodeLine = String(repeating: "widest_fixture ", count: 16)

    /// The transcript's code blocks, top first, as their horizontal scroll views.
    private func hostCodeBlocks(size: CGSize) async throws -> (UIWindow, [UIScrollView]) {
        let content = "Code fixture.\n\n```text\n\(Self.wideCodeLine)\n```\n\n```text\n\(Self.widestCodeLine)\n```\n"
        let message = ChatMessage(role: "assistant", content: content, timestamp: nil, messageId: "code-width")
        let window = try hostWindow(historyTranscript(messages: [message], hasOlderMessages: false) { _ in false }, size: size)
        func blocks() -> [UIScrollView] {
            var found: [UIScrollView] = []
            func visit(_ view: UIView) {
                if let scroll = view as? UIScrollView, scroll.bounds.height < window.bounds.height / 2 { found.append(scroll) }
                view.subviews.forEach(visit)
            }
            visit(window)
            return found.sorted { $0.convert($0.bounds, to: window).minY < $1.convert($1.bounds, to: window).minY }
        }
        let mounted = await awaitCondition { blocks().count == 2 && blocks().allSatisfy { $0.contentSize.width > 0 } }
        XCTAssertTrue(mounted, "The code blocks never mounted")
        settle(0.2)
        return (window, blocks())
    }

    func testWideCodeBlocksUseTheChatMarginsBeforeScrolling() async throws {
        let size = HostedSize.padLandscape
        let (window, blocks) = try await hostCodeBlocks(size: size)
        let (wide, widest) = (try XCTUnwrap(blocks.first), try XCTUnwrap(blocks.last))
        let wideFrame = wide.convert(wide.bounds, to: window)
        let widestFrame = widest.convert(widest.bounds, to: window)
        let column = AdaptiveReadableContentWidth.chat - 32
        XCTAssertGreaterThan(wide.contentSize.width, column, "The fixture must be wider than the column")
        XCTAssertEqual(wideFrame.width, wide.contentSize.width, accuracy: 1, "A block that fits the chat shows whole")
        XCTAssertEqual(wideFrame.midX, size.width / 2, accuracy: 1, "The widened block stays centred on the column")
        XCTAssertEqual(widestFrame.width, size.width - 32, accuracy: 1, "The widest block takes the chat less its margins")
        XCTAssertEqual(widestFrame.midX, size.width / 2, accuracy: 1)
        XCTAssertGreaterThan(widest.contentSize.width, widestFrame.width + 1, "The widest block still scrolls")
        attachHostedScreenshot(window, name: "code-width-pad")

        let copied = recordCopies()
        let copy = HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == "Copy code" }
            .sorted { $0.accessibilityFrame.minY < $1.accessibilityFrame.minY }
        HostedAccessibility.activate(try XCTUnwrap(copy.last))
        XCTAssertEqual(copied.last?.trimmingCharacters(in: .newlines), Self.widestCodeLine, "Copy takes the whole block")
    }

    /// A chat no wider than the column, such as the Duo's inner display beside the sidebar, keeps the column.
    func testCodeBlocksKeepTheColumnWhenTheChatIsNoWider() async throws {
        for size in [HostedSize.phone, CGSize(width: 571, height: HostedSize.duoInnerLandscape.height)] {
            let (window, blocks) = try await hostCodeBlocks(size: size)
            for block in blocks {
                let frame = block.convert(block.bounds, to: window)
                XCTAssertEqual(frame.width, size.width - 32, accuracy: 1, "A block left the column at \(size)")
                XCTAssertGreaterThan(block.contentSize.width, frame.width + 1, "A wide block stopped scrolling at \(size)")
            }
            window.isHidden = true
        }
    }
}

/// Forced left-to-right content (code, math, tool rows, media) inside a right-to-left chat (TAL-2030).
@MainActor
extension TranscriptHostedTests {
    /// A forced-LTR code block must not stretch an RTL reply past its column, pushing its prose off-screen.
    func testRightToLeftReplyWithWideCodeStaysInsideTheWindow() async throws {
        let content = "שלום עולם, זו תשובה.\n\n```text\n\(String(repeating: "wide_fixture ", count: 9))\n```\n\nעוד טקסט בעברית.\n"
        let message = ChatMessage(role: "assistant", content: content, timestamp: nil, messageId: "rtl-code")
        let transcript = historyTranscript(messages: [message], hasOlderMessages: false) { _ in false }
        let window = try hostWindow(transcript.environment(\.layoutDirection, .rightToLeft))
        let reply = try await requireElement(in: window, "The Hebrew reply never rendered") {
            $0.accessibilityLabel?.contains("שלום עולם") == true
        }
        let bounds = window.bounds.insetBy(dx: -0.5, dy: 0)
        let replyFrame = window.convert(reply.accessibilityFrame, from: nil)
        XCTAssertTrue(bounds.minX <= replyFrame.minX && replyFrame.maxX <= bounds.maxX, "The RTL reply left the window: \(replyFrame)")
        let code = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Copy code"), "The code block never rendered")
        let copyFrame = window.convert(code.accessibilityFrame, from: nil)
        XCTAssertTrue(bounds.contains(copyFrame), "The code block's controls left the window: \(copyFrame)")
        attachHostedScreenshot(window, name: "rtl-reply-wide-code")
    }

    /// Narrow forced-LTR content sits at its parent's leading edge: the right in RTL, the left in LTR.
    func testNarrowForcedLeftToRightContentSitsAtTheLeadingEdge() async throws {
        for direction in [LayoutDirection.rightToLeft, .leftToRight] {
            var frame = CGRect.null
            let window = try hostWindow(VStack(alignment: .leading) {
                SwiftUI.Color.clear.frame(maxWidth: .infinity, maxHeight: 1)
                SwiftUI.Color.clear.frame(width: 100, height: 10)
                    .forcedLeftToRight()
                    .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame = $0 }
            }.environment(\.layoutDirection, direction))
            let measured = await awaitCondition { !frame.isNull }
            XCTAssertTrue(measured, "The narrow content never laid out in \(direction)")
            let expectedMinX = direction == .rightToLeft ? window.bounds.width - 100 : 0
            XCTAssertEqual(frame.minX, expectedMinX, accuracy: 0.5, "Narrow forced-LTR content left the \(direction) leading edge")
            window.isHidden = true
        }
    }
}

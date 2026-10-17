import SwiftData
import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The fixture chat's media, long bodies, background work and pending steers, hosted in process (TAL-856).
@MainActor
final class ChatHostedTests: XCTestCase {
    func testStreamingSendConsumesDraftWhileSteerIsHeldAndPreservesNewTyping() async throws {
        let fixture = try FixtureApp(["--ui-test-chat-controls", "--ui-test-hold-steer"], for: self)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("Held steering prompt", in: window)
        _ = try await requireElement(in: window, label: "Held steering prompt")
        let composer = await composerTextView(in: window)
        let draft = try XCTUnwrap(composer)
        XCTAssertEqual(draft.text, "", "A streaming send must consume its draft before the steer answers")
        attachHostedScreenshot(window, name: "streaming-send-pending-phone")
        try await typeIntoComposer("Newer draft", in: window)
        fixture.releaseHeldLoads()
        let waiting = await awaitElement(in: window, label: "Held steering prompt")
        XCTAssertNotNil(waiting)
        XCTAssertEqual(draft.text, "Newer draft")
    }

    func testCachedReopenKeepsLatestContentStationaryWhenSyncFinishes() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdTranscriptReloadsArgument], for: self)
        let response = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let messages = try XCTUnwrap(response.session?.messages)
        try CacheStore.cacheMessages(
            messages, serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext,
            messagesOffset: 0, hasOlderMessages: false
        )

        let reopened = try hostWindow(fixture.sessionList(), size: CGSize(width: 402, height: 874), animationsEnabled: true)
        let row = try await requireElement(in: reopened) { $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true }
        XCTAssertTrue(HostedAccessibility.activate(row))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        settle(0.5)
        let scroll = try transcriptScrollView(in: reopened)
        let beforeOffset = scroll.contentOffset.y
        let beforeHeight = scroll.contentSize.height
        let beforeInset = scroll.adjustedContentInset.bottom
        let anchor = try await requireElement(in: reopened, label: "Fixture link request")
        let beforeAnchorY = anchor.accessibilityFrame.minY
        attachHostedScreenshot(reopened, name: "cached-reopen-syncing-bottom")

        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced)
        settle(0.5)
        attachHostedScreenshot(reopened, name: "cached-reopen-after-sync")
        let afterAnchor = try await requireElement(in: reopened, label: "Fixture link request")
        let metrics = XCTAttachment(string: "offset: \(beforeOffset) -> \(scroll.contentOffset.y); height: \(beforeHeight) -> \(scroll.contentSize.height); bottom inset: \(beforeInset) -> \(scroll.adjustedContentInset.bottom); anchor Y: \(beforeAnchorY) -> \(afterAnchor.accessibilityFrame.minY)")
        metrics.name = "cache reopen scroll metrics"
        metrics.lifetime = .keepAlways
        add(metrics)
        XCTAssertEqual(afterAnchor.accessibilityFrame.minY, beforeAnchorY, accuracy: 3, "Sync completion moved an unchanged message on screen")
    }

    func testSyncingBesideGoalDoesNotReserveTranscriptSpaceInNarrowStack() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads", "--ui-test-goal"], for: self)
        let session = try await fixture.session()
        let window = try hostWindow(fixture.chat(session), size: CGSize(width: 320, height: 844))
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Goal parked") == true }
        NotificationCenter.default.post(name: .talariaReauthenticated, object: UITestFixtureEnvironment.serverURL)
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        settle(0.3)
        let scroll = try transcriptScrollView(in: window)
        let withSyncing = scroll.adjustedContentInset.bottom
        fixture.releaseHeldLoads()
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(cleared)
        settle(0.3)
        XCTAssertEqual(scroll.adjustedContentInset.bottom, withSyncing, accuracy: 1,
                       "The non-reserving syncing segment changed the transcript inset beside a goal")
    }

    func testWorkingAndQueueShareOneRowWithIndependentActions() async throws {
        continueAfterFailure = false
        let window = try await hostFixtureChat(["--ui-test-chat-controls"])
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
        let queue = try await requireElement(in: window, label: "2 queued")
        let status = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        settle(0.3)
        attachHostedScreenshot(window, name: "working-queue-phone")
        XCTAssertEqual(status.accessibilityFrame.midY, queue.accessibilityFrame.midY, accuracy: 1,
                       "Working and the queue must be segments of one row")
        XCTAssertLessThan(status.accessibilityFrame.maxX, queue.accessibilityFrame.minX)
        XCTAssertFalse(status.accessibilityTraits.contains(.button))
        XCTAssertTrue(queue.accessibilityTraits.contains(.button))
        XCTAssertGreaterThanOrEqual(queue.accessibilityFrame.height, 44)
        HostedAccessibility.activate(status)
        XCTAssertNil(window.rootViewController?.presentedViewController)
        HostedAccessibility.activate(queue)
        _ = try await requireElement(in: window, label: "First queued message")
        _ = try await requireElement(in: window, label: "Second queued message")
        for remaining in [1, 0] {
            let remove = try XCTUnwrap(elements(named: "Remove", in: window).first {
                $0.accessibilityTraits.contains(.button) && $0.accessibilityFrame.height > 0
                    && window.bounds.contains(window.convert($0.accessibilityFrame, from: nil))
            }, "The queue has no visible Remove button")
            XCTAssertTrue(HostedAccessibility.activate(remove))
            if remaining == 1 {
                // List retains removed rows in its hosted AX cache. Observe the live count and
                // reopen the sheet before targeting its remaining row.
                _ = try await requireElement(in: window, label: "1 queued")
                HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
            }
            let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
            XCTAssertTrue(closed)
            if remaining == 1 {
                HostedAccessibility.activate(try await requireElement(in: window, label: "1 queued"))
                _ = try await requireElement(in: window, label: "Second queued message")
            }
        }
        let drained = await awaitNoElement(in: window) { $0.accessibilityLabel == "1 queued" || $0.accessibilityLabel == "2 queued" }
        XCTAssertTrue(drained)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasSuffix("is working on the response") == true }
        try await sendFromComposer("/queue Re-added message", in: window)
        _ = try await requireElement(in: window, label: "1 queued")
    }

    /// Server-rewritten media renders inside the Markdown around it, audio follows as a tile, and its Export opens the
    /// file exporter (TAL-186). Saving through the exporter is the phone check's.
    func testServerMediaRendersInsideTheMarkdownAroundIt() async throws {
        let window = try await hostFixtureChat(["--ui-test-transcript-media"])
        _ = try await requireElement(in: window, label: "Linked chart", "The linked image did not render as a thumbnail")
        // Thumbnails show a spinner until their bytes load, then the image in its 132-point box or, on failure, a
        // shorter unavailable chip under the same alt-text name.
        // Every spinner counts, the audio tile's too, and a hosted CI simulator can take well over 10 s to start audio.
        let loaded = await awaitCondition(timeout: 30) { !window.containsView(ofType: UIActivityIndicatorView.self) }
        XCTAssertTrue(loaded, "The thumbnails never finished loading")
        for name in ["Linked chart", "chart.png", "Chart"] {
            let thumbnail = try XCTUnwrap(elements(named: name, in: window).first, "Missing the \(name) thumbnail")
            XCTAssertEqual(thumbnail.accessibilityFrame.height, 132, accuracy: 1, "The \(name) thumbnail shows no image")
        }
        let labels = HostedAccessibility.labels(in: window)
        XCTAssertTrue(labels.contains { $0.contains("narration.mp3") }, "The audio file did not render as a tile")
        XCTAssertFalse(labels.contains { $0.contains("**") }, "Bold text around an image rendered literally")
        XCTAssertFalse(labels.contains { $0.contains("MEDIA:") }, "A media token rendered as text")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Export audio narration.mp3"))
        let exporter = await presentedController(in: window)
        XCTAssertTrue(exporter is UIDocumentPickerViewController, "The audio's Export did not open the file exporter")
        exporter?.dismiss(animated: false)
    }

    /// Very long bodies open collapsed to the server's excerpts and expand and collapse in place (TAL-456).
    func testHistoryInsertionKeepsRenderedReaderStillInTheFullChat() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: false)
    }

    func testHistoryInsertionKeepsExpandedReaderStillInTheFullChat() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true)
    }

    func testTranscriptScrollViewWaitsForNativeAttachmentAfterTextAppears() throws {
        let window = try hostWindow(Text("History answer 1999."))
        let scroll = UIScrollView(frame: window.bounds)
        let host = ChatMessageMenuHostView(registry: ChatMessageMenuRegistry())
        let timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: false) { _ in
            MainActor.assumeIsolated {
                scroll.addSubview(host)
                window.addSubview(scroll)
            }
        }
        defer { timer.invalidate() }
        XCTAssertTrue(try transcriptScrollView(in: window) === scroll,
                      "Visible text can precede the transcript's native attachment")
    }

    func testHistoryInsideALongTurnPreservesTheExpandedWorkAndReader() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true)
    }

    private func nativeHistoryDragDirectory() throws -> URL {
        let runtime = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent(".codex-tmp/xctest")
        guard let token = try? String(contentsOf: runtime.appendingPathComponent("native-history-drag"), encoding: .utf8),
              let runID = UUID(uuidString: token) else {
            throw XCTSkip("Use scripts/test-history-drag to supply real native gestures")
        }
        return runtime.appendingPathComponent("history-drag/\(runID.uuidString.lowercased())")
    }

    func testExpandedMessageSurvivesRecyclingItsRenderedBody() async throws {
        let state = RecycledBodyFixture()
        let window = try hostWindow(RecycledBodyView(state: state))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show more"))
        _ = try await requireElement(in: window, label: "Show less")
        state.showsBody = false
        let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Show less" }
        XCTAssertTrue(removed)
        state.showsBody = true
        let restored = await awaitElement(in: window, label: "Show less")
        XCTAssertNotNil(restored, "A recycled message must retain its expanded body")
    }

    func testFetchedToolOutputSurvivesRecyclingItsRenderedBody() async throws {
        var tool = ToolCall(id: "retained-tool", name: "fixture_tool", preview: "Clipped output", args: nil,
                            isCompleted: true, startedAt: 0)
        tool.resultTruncated = true
        let state = RecycledBodyFixture(tool: tool)
        defer { state.releaseToolResult() }
        let suite = "TalariaTests.retained-tool.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let window = try hostWindow(RecycledBodyView(state: state).defaultAppStorage(defaults))
        if let header = HostedAccessibility.elements(in: window).first(where: {
            $0.accessibilityHint == "Double tap to expand details."
        }) { HostedAccessibility.activate(header) }
        HostedAccessibility.activate(try await requireElement(in: window, label: "Show full output"))
        let requested = await awaitCondition { state.isToolResultPending }
        XCTAssertTrue(requested)
        state.showsBody = false
        let loadingRemoved = await awaitNoElement(in: window) { $0.accessibilityLabel == "Loading…" }
        XCTAssertTrue(loadingRemoved)
        state.showsBody = true
        let loadingElement = await awaitElement(in: window, label: "Loading…")
        let loading = try XCTUnwrap(loadingElement, "Recycling must retain the expanded tool's in-flight fetch")
        XCTAssertTrue(loading.accessibilityTraits.contains(.notEnabled))
        state.releaseToolResult()
        _ = try await requireElement(in: window, label: "Full retained tool output")
        XCTAssertEqual(state.toolResultCalls, 1)
        state.showsBody = false
        let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Full retained tool output" }
        XCTAssertTrue(removed)
        state.showsBody = true
        let restored = await awaitElement(in: window, label: "Full retained tool output")
        XCTAssertNotNil(restored, "Recycling must retain the expanded tool's fetched output")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Show full output"))
    }

    /// Driven by scripts/test-history-drag; ordinary hosted runs have no external gesture driver.
    func testHistoryInsertionPreservesReaderDuringNativeDrag() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true)
    }

    func testLargeLoadedHistoryInsertionPreservesReaderDuringNativeDrag() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true, largeHistory: true)
    }

    func testHistoryInsertionPreservesNativeDeceleration() async throws {
        try await assertFullChatHistoryInsertion(expandDisclosure: true, boundaryTurn: true, nativeDrag: true, nativeFling: true)
    }

    private func assertFullChatHistoryInsertion(expandDisclosure: Bool, boundaryTurn: Bool = false, nativeDrag: Bool = false, largeHistory: Bool = false, nativeFling: Bool = false) async throws {
        let nativeRunDirectory = nativeDrag ? try nativeHistoryDragDirectory() : nil
        var scenario = [UITestFixtureEnvironment.historyPagingArgument,
                        UITestFixtureEnvironment.holdTranscriptReloadsArgument]
        if largeHistory { scenario.append(UITestFixtureEnvironment.largeHistoryWindowArgument) }
        let initialStart = largeHistory ? 1_000 : 1_950
        if boundaryTurn { scenario.append(UITestFixtureEnvironment.historyTurnBoundaryArgument) }
        else if expandDisclosure { scenario.append(UITestFixtureEnvironment.longPromptArgument) }
        let fixture = try FixtureApp(scenario, for: self)
        let window = try hostWindow(fixture.chat(try await fixture.session()))
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("History answer 1999.") == true }
        let scroll = try transcriptScrollView(in: window)
        let isVisible: (NSObject) -> Bool = { element in
            window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                .intersects(window.convert(element.accessibilityFrame, from: nil))
        }
        let coordinator = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator)
        let controller = try XCTUnwrap(coordinator.scrollPositionController)
        let entrySettled = await awaitCondition {
            !controller.isNavigating && !controller.isPreservingPosition && !controller.isRealizingRows
        }
        XCTAssertTrue(entrySettled, "Entry realization must settle before positioning the fixture reader")
        controller.userDidBeginDragging()
        coordinator.onFollowEvent(.userScrollBegin)
        let readerID = boundaryTurn ? "history-\(initialStart + 9)" : "history-1954"
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let initialPage = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(
            withJSONObject: UITestFixtureURLProtocol.historyMessages(from: initialStart, to: 2_000)))
        let readerRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: initialPage, messageOffset: initialStart)
            .first { $0.message.messageId == readerID })
        try await navigateTranscript(to: ChatTranscriptView.containerID(for: readerRow.renderID), anchor: boundaryTurn ? .top : .center, using: controller)
        let held = await awaitCondition { self.hasHeldHistoryPage(before: initialStart) }
        XCTAssertTrue(held, "The real view model must request its older page before measuring insertion")
        if expandDisclosure {
            if boundaryTurn {
                HostedAccessibility.activate(try await requireElement(in: window) {
                    $0.accessibilityLabel == "Worked" && $0.accessibilityHint == "Double tap to expand work."
                        && isVisible($0)
                })
                _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
            } else {
                HostedAccessibility.activate(try await requireElement(in: window) {
                    $0.accessibilityLabel == "Show more" && isVisible($0)
                })
                _ = try await requireElement(in: window, label: "Show less")
            }
            let settled = await awaitCondition { !controller.isHoldingPosition }
            XCTAssertTrue(settled)
        }
        try await Task.sleep(for: .milliseconds(200))
        let reader: NSObject
        if boundaryTurn {
            reader = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
        } else if expandDisclosure {
            reader = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Fixture prompt line 1\n") == true }
        } else {
            reader = try await requireElement(in: window, label: "History prompt 1954.")
        }
        let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
        let frame = window.convert(reader.accessibilityFrame, from: nil).intersection(viewport)
        XCTAssertFalse(frame.isEmpty, "The reader must be visibly on screen before releasing the page")
        let point = CGPoint(x: frame.midX, y: frame.midY)
        let registry = try messageMenuRegistry(in: window)
        let before = try XCTUnwrap(registry.hit(at: scroll.convert(point, from: window), in: scroll))
        XCTAssertEqual(before.content.messageID, readerID)
        let momentumReader: ChatMessageInteractionMarkerView?
        if nativeFling {
            momentumReader = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self) {
                $0.bounds.size == before.rowSize
                    && abs($0.convert(point, from: window).y - before.localPoint.y) < 0.5
            }, "Track the actual rendered reader even after momentum carries it away from the probe point")
        } else { momentumReader = nil }
        let oldHeight = scroll.contentSize.height
        let maximumFrameGapMilliseconds: Double = 100
        var samples: [[String: Double]] = []
        var largestMovement: CGFloat = 0
        var missingReader = false
        var previousTick = ProcessInfo.processInfo.systemUptime
        var initialTranslation: CGFloat?
        var dragSamples = 0
        var pageReleased = false
        var decelerationStarted: TimeInterval?
        var decelerationDuration: TimeInterval = 0
        var sawNativeFling = false
        var lostMomentumReader = false
        if let nativeRunDirectory {
            try FileManager.default.createDirectory(at: nativeRunDirectory, withIntermediateDirectories: true)
            try Data("ready".utf8).write(to: nativeRunDirectory.appendingPathComponent("ready"))
        }
        let updateLink = UIUpdateLink(windowScene: try XCTUnwrap(window.windowScene))
        updateLink.addAction(to: .afterUpdateComplete) { _, info in
            guard samples.count < (nativeFling ? 240 : 120) else { return }
            let now = ProcessInfo.processInfo.systemUptime
            let translation = scroll.panGestureRecognizer.translation(in: scroll).y
            // UIKit can keep isDragging true throughout deceleration. The pan's
            // actual touches distinguish a held finger from native momentum.
            let touchDragging = scroll.isDragging && scroll.panGestureRecognizer.numberOfTouches > 0
            var samplePoint = point
            if nativeDrag {
                if scroll.isDecelerating { sawNativeFling = true }
                if nativeFling, scroll.isDecelerating, !touchDragging {
                    if decelerationStarted == nil {
                        decelerationStarted = now
                    }
                    decelerationDuration = now - (decelerationStarted ?? now)
                }
                guard touchDragging || (nativeFling && sawNativeFling) else { return }
                if initialTranslation == nil {
                    // UIKit's translation already includes movement before the
                    // first display sample of a quick fling.
                    initialTranslation = 0
                    fixture.releaseHeldLoads()
                    pageReleased = true
                }
                samplePoint.y += translation - (initialTranslation ?? translation)
                if !nativeFling || touchDragging {
                    guard viewport.contains(samplePoint) else { return }
                    dragSamples += 1
                }
            }
            if nativeFling, momentumReader?.window !== window { lostMomentumReader = true }
            let hit = registry.hit(at: scroll.convert(samplePoint, from: window), in: scroll)
            let delta = (hit?.localPoint.y ?? 0) - before.localPoint.y
            if !nativeFling || touchDragging {
                if hit?.content.messageID != before.content.messageID { missingReader = true }
                else { largestMovement = max(largestMovement, abs(delta)) }
            }
            samples.append(["gapMilliseconds": (now - previousTick) * 1_000,
                            "time": now,
                            "modelTime": info.modelTime,
                            "completionDeadline": info.completionDeadlineTime,
                            "readerY": Double(momentumReader?.convert(.zero, to: window).y ?? 0),
                            "readerDelta": Double(delta), "offset": Double(scroll.contentOffset.y),
                            "height": Double(scroll.contentSize.height), "translation": Double(translation),
                            "pointY": Double(samplePoint.y),
                            "dragging": scroll.isDragging ? 1 : 0,
                            "touchDragging": touchDragging ? 1 : 0,
                            "touchCount": Double(scroll.panGestureRecognizer.numberOfTouches),
                            "panState": Double(scroll.panGestureRecognizer.state.rawValue),
                            "tracking": scroll.isTracking ? 1 : 0,
                            "decelerating": scroll.isDecelerating ? 1 : 0,
                            "messageIndex": Double(Int(hit?.content.messageID.replacingOccurrences(of: "history-", with: "") ?? "") ?? -1)])
            previousTick = now
        }
        updateLink.requiresContinuousUpdates = nativeDrag
        updateLink.isEnabled = true
        defer { updateLink.isEnabled = false }
        if nativeDrag {
            let started = await awaitCondition(timeout: 45) { pageReleased }
            XCTAssertTrue(started, "The reproduction requires a real native drag")
            try await Task.sleep(for: .seconds(3))
            XCTAssertGreaterThan(dragSamples, 3, "Sample the moving reader, not just its final position")
            let driverFinished = await awaitCondition(timeout: 15) {
                nativeRunDirectory.map { FileManager.default.fileExists(atPath: $0.appendingPathComponent("driver-finished").path) } ?? false
            }
            XCTAssertTrue(driverFinished, "The native driver must close before the simulator lease is released")
        } else {
            fixture.releaseHeldLoads()
            try await Task.sleep(for: .milliseconds(1_500))
        }
        XCTAssertGreaterThan(samples.count, 0, "The test must observe committed display frames")
        updateLink.isEnabled = false
        coordinator.onFollowEvent(.userScrollEnd(isAtBottom: false))
        let data = try JSONSerialization.data(withJSONObject: samples, options: [.prettyPrinted, .sortedKeys])
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "Full chat history insertion frames"; attachment.lifetime = .keepAlways; add(attachment)
        attachHistoryImage(window, name: "Full chat after history insertion")
        XCTAssertGreaterThan(scroll.contentSize.height, oldHeight + 500, "The older page must actually render")
        XCTAssertFalse(missingReader, "Insertion must keep the same rendered message under the reader throughout layout")
        XCTAssertLessThanOrEqual(largestMovement, 2, "Insertion must not visibly jump before settling")
        if nativeDrag {
            let largestGap = samples.dropFirst().map { $0["gapMilliseconds"] ?? 0 }.max() ?? 0
            XCTAssertLessThanOrEqual(largestGap, maximumFrameGapMilliseconds, "History insertion must not stall the moving display")
            if nativeFling {
                XCTAssertTrue(sawNativeFling, "The native driver must produce a fling")
                XCTAssertFalse(lostMomentumReader, "Observe the rendered reader throughout momentum")
                XCTAssertGreaterThan(decelerationDuration, 0.3,
                                     "History arrival must preserve native momentum after the finger lifts")
                let coasting = samples.filter { $0["decelerating"] == 1 && $0["touchDragging"] == 0 }
                let travel = (coasting.last?["readerY"] ?? 0) - (coasting.first?["readerY"] ?? 0)
                XCTAssertGreaterThan(travel, 60, "The rendered content must keep coasting, not merely report deceleration")
                if var progress = coasting.first, let endingY = coasting.last?["readerY"] {
                    var longestPause: TimeInterval = 0
                    for sample in coasting.dropFirst() {
                        guard let y = sample["readerY"], let time = sample["time"],
                              y - (progress["readerY"] ?? y) > 0.5 else { continue }
                        if endingY - y > 60 {
                            longestPause = max(longestPause, time - (progress["time"] ?? time))
                        }
                        progress = sample
                    }
                    XCTAssertLessThanOrEqual(longestPause * 1_000, maximumFrameGapMilliseconds,
                                             "History realization must not freeze native momentum before a forward jump")
                }
                let released = samples.filter { $0["touchDragging"] == 0 }
                let reversals = zip(released, released.dropFirst()).map {
                    ($0["readerY"] ?? 0) - ($1["readerY"] ?? 0)
                }
                XCTAssertLessThanOrEqual(reversals.max() ?? 0, 2, "History measurement must not pull a coasting reader backward")
                if let last = coasting.last, let time = last["time"],
                   let tail = coasting.last(where: { ($0["time"] ?? time) < time - 0.05 }),
                   let tailTime = tail["time"] {
                    let speed = abs((last["readerY"] ?? 0) - (tail["readerY"] ?? 0)) / (time - tailTime)
                    XCTAssertLessThan(speed, 40, "Momentum must slow naturally before stopping")
                }
                XCTAssertEqual(samples.last?["decelerating"], 0, "Observe the fling through its natural end")
                return
            }
        }
        if expandDisclosure {
            if boundaryTurn {
                XCTAssertNotNil(HostedAccessibility.elements(in: window).first {
                    $0.accessibilityLabel == "Worked" && $0.accessibilityHint == "Double tap to collapse work."
                }, "Paging inside a turn must retain its expanded work")
                // Recycle the actual rich row, then return to its stable native target.
                // Its disclosure belongs to the row slot, not the removed view body.
                let latestRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: initialPage, messageOffset: initialStart).last)
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: latestRow.renderID), anchor: .bottom, using: controller)
                let recycled = await awaitNoElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
                XCTAssertTrue(recycled, "The expanded row must actually leave realization before revisiting it")
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: readerRow.renderID), anchor: .top, using: controller)
                _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Boundary work 0.") == true }
                // Start another page after moving away and back: the window now
                // contains retained heights and state from the first prepend.
                let previousStart = initialStart - 50
                let previousPage = try decoder.decode([ChatMessage].self, from: JSONSerialization.data(
                    withJSONObject: UITestFixtureURLProtocol.historyMessages(from: previousStart, to: initialStart)))
                let nextReaderID = "history-\(previousStart + 1)"
                let nextReaderRow = try XCTUnwrap(ChatViewModel.transcriptMessages(from: previousPage, messageOffset: previousStart)
                    .first { $0.message.messageId == nextReaderID })
                try await navigateTranscript(to: ChatTranscriptView.containerID(for: nextReaderRow.renderID), anchor: .top, using: controller)
                _ = try await requireElement(in: window) {
                    $0.accessibilityLabel?.hasPrefix("History answer \(previousStart + 1).") == true
                }
                let secondHeld = await awaitCondition { self.hasHeldHistoryPage(before: previousStart) }
                XCTAssertTrue(secondHeld, "Revisiting the prefix must request a second older page")
                try await Task.sleep(for: .milliseconds(200))
                // A tall answer's first paragraph can be above the viewport;
                // measure an actually visible piece of that same message.
                let nextPoint = try XCTUnwrap(stride(from: viewport.minY + 80, to: viewport.maxY - 80, by: 10)
                    .map { CGPoint(x: viewport.midX, y: $0) }
                    .first { registry.hit(at: scroll.convert($0, from: window), in: scroll)?.content.messageID == nextReaderID })
                let nextBefore = try XCTUnwrap(registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll))
                XCTAssertEqual(nextBefore.content.messageID, nextReaderID)
                fixture.releaseHeldLoads()
                try await Task.sleep(for: .milliseconds(1_500))
                let nextAfter = try XCTUnwrap(registry.hit(at: scroll.convert(nextPoint, from: window), in: scroll))
                XCTAssertEqual(nextAfter.content.messageID, nextReaderID)
                XCTAssertEqual(nextAfter.localPoint.y, nextBefore.localPoint.y, accuracy: 2,
                               "A second prepend must preserve the revisited reader")
            } else {
                XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Show less"),
                                "A page must preserve the expanded disclosure state")
            }
        }
    }

    func testLongBodiesOpenCollapsedAndExpandInPlace() async throws {
        let window = try await hostFixtureChat(["--ui-test-long-bodies"])
        // Lazy layout exposes controls only near the viewport. Exercise the
        // actual route to the end of a 100k-character expanded body.
        for cycle in 1...3 {
            _ = try await requireElement(in: window, label: "Short reply 25.")
            let scroll = try transcriptScrollView(in: window)
            let controller = try XCTUnwrap(window.firstView(ofType: ChatScrollObserver.ObserverView.self)?.coordinator?.scrollPositionController)
            var previousTailFrame: CGRect?
            var stableEntrySamples = 0
            let entered = await awaitCondition {
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                guard !controller.isHoldingPosition,
                      let tail = self.elements(named: "Short reply 25.", in: window).first(where: {
                          viewport.intersects(window.convert($0.accessibilityFrame, from: nil))
                      }) else { stableEntrySamples = 0; return false }
                let frame = window.convert(tail.accessibilityFrame, from: nil)
                stableEntrySamples = frame == previousTailFrame ? stableEntrySamples + 1 : 0
                previousTailFrame = frame
                return stableEntrySamples >= 5
            }
            XCTAssertTrue(entered, "The latest row must finish entry before toggling the last body")
            let latestDisclosure = await awaitElement(in: window) { element in
                guard element.accessibilityLabel == "Show more" else { return false }
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return viewport.intersects(window.convert(element.accessibilityFrame, from: nil))
                    && (try? self.messageMenuHit(at: element, in: window)?.content.messageID) == "long-body-user-48"
            }
            let showMore = try XCTUnwrap(latestDisclosure, "The last 100k-character body must be visible at entry")
            XCTAssertEqual(try messageMenuTarget(at: showMore, in: window), .control, "A long press on Show more opens the message menu")
            let controlFrame = window.convert(showMore.accessibilityFrame, from: nil)
            let readerPoint = CGPoint(x: controlFrame.midX, y: controlFrame.midY)
            let beforeHit = try XCTUnwrap(messageMenuHit(at: readerPoint, in: window))
            let beforeHeight = beforeHit.rowSize.height
            HostedAccessibility.activate(showMore)
            let expanded = await awaitCondition {
                guard let hit = try? self.messageMenuHit(at: readerPoint, in: window), hit.content.messageID == beforeHit.content.messageID else { return false }
                return hit.rowSize.height > beforeHeight + 1_000
            }
            XCTAssertTrue(expanded, "Cycle \(cycle): the full body must expand beyond its excerpt")
            let settled = await awaitCondition { !controller.isHoldingPosition }
            XCTAssertTrue(settled)
            attachHistoryImage(window, name: "Expansion layout, cycle \(cycle)")
            let afterHit = try XCTUnwrap(messageMenuHit(at: readerPoint, in: window), "Expansion left no message under the reader; offset=\(scroll.contentOffset.y), height=\(scroll.contentSize.height), point=\(readerPoint)")
            XCTAssertEqual(afterHit.content.messageID, beforeHit.content.messageID)
            XCTAssertEqual(afterHit.localPoint.y, beforeHit.localPoint.y, accuracy: 2, "Cycle \(cycle): expansion moved the visible body")
            let expandedHeight = afterHit.rowSize.height
            attachHistoryImage(window, name: "Expanded large body, cycle \(cycle)")
            // The collapse control follows the full body; reach it as a user does.
            let jump = try await requireElement(in: window, label: "Scroll to latest message")
            XCTAssertTrue(HostedAccessibility.activate(jump))
            let visibleCollapse = await awaitElement(in: window) { element in
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return element.accessibilityLabel == "Show less"
                    && viewport.intersects(window.convert(element.accessibilityFrame, from: nil))
            }
            let showLess = try XCTUnwrap(visibleCollapse, "The collapse control must become visible after native scrolling")
            HostedAccessibility.activate(showLess)
            let collapsed = await awaitCondition {
                let viewport = window.convert(scroll.bounds, from: scroll).intersection(window.bounds)
                return self.elements(named: "Show more", in: window).contains { element in
                    guard viewport.intersects(window.convert(element.accessibilityFrame, from: nil)),
                          let hit = try? self.messageMenuHit(at: element, in: window),
                          hit.content.messageID == beforeHit.content.messageID else { return false }
                    return hit.rowSize.height < expandedHeight - 1_000 && abs(hit.rowSize.height - beforeHeight) <= 2
                }
            }
            XCTAssertTrue(collapsed, "The expanded body did not collapse again")
            let removed = await awaitNoElement(in: window) { $0.accessibilityLabel == "Show less" }
            XCTAssertTrue(removed)
        }
        // An unfocused composer is its collapsed "Message" shell.
        let composer = await awaitElement(in: window, label: "Message")
        XCTAssertNotNil(composer, "The composer went away")
    }

    /// Background work shows as one count chip above the composer (TAL-1001); its sheet lists the server's records, a
    /// delegation its subagents' progress, the full result on request, and a Dismiss that removes only finished work
    /// (TAL-372).
    func testBackgroundWorkChipOpensTheServersRecordsWithResultAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-background-updates"])
        let containing: (String) -> (NSObject) -> Bool = { text in { $0.accessibilityLabel?.contains(text) == true } }
        // A sheet row reads its title with its kind and status; the transcript names the same work in its own rows.
        let finishedRow: (NSObject) -> Bool = { containing("Summarize the repo")($0) && containing("Background task · ")($0) }
        let chip = await awaitElement(in: window, where: containing("Background tasks · 2"))
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains(where: finishedRow), "A task row shows outside the sheet")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Worked", "The delegation row has no Worked disclosure"))
        let progress = await awaitElement(in: window, where: containing("2 of 3 done · 1 failed"))
        XCTAssertNotNil(progress, "The delegation row does not show its subagents' progress")

        HostedAccessibility.activate(try XCTUnwrap(chip, "The background tasks chip is missing"))
        let running = await awaitElement(in: window, where: containing("Fix CI"))
        XCTAssertNotNil(running, "The running delegation is missing from the sheet")
        let finished = try XCTUnwrap(
            HostedAccessibility.elements(in: window).first(where: finishedRow),
            "The finished /background task is missing from the sheet"
        )

        HostedAccessibility.activate(finished)
        _ = try await requireElement(in: window, label: "The repo has three packages.", "The full result did not load")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Dismiss"))
        let dismissed = await awaitNoElement(in: window, where: finishedRow)
        XCTAssertTrue(dismissed, "Dismiss left the finished task in the sheet")
        let remaining = await awaitElement(in: window) { containing("Fix CI")($0) && containing("Agent · ")($0) }
        XCTAssertNotNil(remaining, "Dismiss removed running work")
    }

    /// The session's standing `/goal` shows as one chip above the composer, worded from the server's field (TAL-833).
    func testTheStandingGoalShowsAboveTheComposer() async throws {
        let window = try await hostFixtureChat(["--ui-test-goal"])
        let chip = await awaitElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Goal parked · 5/20 turns · until ") == true
                && $0.accessibilityLabel?.hasSuffix(" · CI running · Ship the release notes") == true
        }
        XCTAssertNotNil(chip, "The parked goal chip is missing")
    }

    /// Steers pending from another device offer only the actions the server allows; Send now explains a live
    /// requeue, and Edit appends the steer after the draft (TAL-300, TAL-1000).
    func testPendingSteerFromAnotherDeviceOffersSendNowEditAndCancel() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers"])
        try await sendFromComposer("Back up the cluster", in: window)

        _ = try await requireElement(in: window, label: "Check the backup logs too", "The pending steer from Web is missing")
        _ = try await requireElement(in: window, label: "Skip the cache", "The second pending steer is missing")
        let waiting = await awaitElement(in: window) { $0.accessibilityLabel?.contains("Waiting for agent") == true }
        XCTAssertNotNil(waiting)
        // Only the actions the server allows: the second steer offers no Send now.
        XCTAssertEqual(elements(named: "Send now", in: window).count, 1)
        XCTAssertEqual(elements(named: "Edit steering message", in: window).count, 2)
        XCTAssertEqual(elements(named: "Cancel steering message", in: window).count, 2)

        // TAL-1001: Send now explains itself in one short chip, however often it is tapped, that goes on its own.
        let isNotice: (NSObject) -> Bool = { $0.accessibilityLabel == "The agent takes it at its next step." }
        for _ in 0..<5 {
            HostedAccessibility.activate(try XCTUnwrap(elements(named: "Send now", in: window).first))
            _ = await awaitElement(in: window, where: isNotice)
        }
        let notice = await awaitElement(in: window, where: isNotice)
        XCTAssertNotNil(notice, "Send now did not explain the live requeue")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter(isNotice).count, 1, "Repeated Send now stacked notices")
        XCTAssertEqual(notice?.accessibilityValue, "Information", "The notice does not say its kind")
        attachHostedScreenshot(window, name: "send-now-phone")
        let dismissed = await awaitNoElement(in: window, timeout: 5, where: isNotice)
        XCTAssertTrue(dismissed, "The notice never went away on its own")

        // Edit appends the steer after the draft, a blank line between.
        try await typeIntoComposer("Draft", in: window)
        HostedAccessibility.activate(try XCTUnwrap(elements(named: "Edit steering message", in: window).first))
        let edited = await awaitNoElement(in: window) { $0.accessibilityLabel == "Check the backup logs too" }
        XCTAssertTrue(edited, "The edited steer is still pending")
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "Draft\n\nCheck the backup logs too")
    }

    /// Active approval bypass shows as a 44-point chip that asks before turning bypass off; Cancel keeps it, and it
    /// leaves once the server confirms (TAL-664).
    func testApprovalBypassChipTurnsBypassOffForTheSession() async throws {
        let window = try await hostFixtureChat(["--ui-test-approval-bypass"])
        let isChip: (NSObject) -> Bool = { $0.accessibilityLabel == "Approval bypass active" }
        let chip = try await requireElement(in: window, "The fixture never showed active bypass", where: isChip)
        XCTAssertTrue(chip.accessibilityTraits.contains(.button), "The bypass status is not an actionable button")
        XCTAssertGreaterThanOrEqual(chip.accessibilityFrame.height, 44)
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")

        HostedAccessibility.activate(chip)
        let asked = await presentedAlert(in: window)
        let cancelled = try XCTUnwrap(asked, "Tapping the chip did not ask before changing bypass")
        XCTAssertEqual(cancelled.title, "Turn off approval bypass")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: cancelled))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isChip), "Cancel turned bypass off")

        HostedAccessibility.activate(try await requireElement(in: window, where: isChip))
        let confirmed = await presentedAlert(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Turn off approval bypass", in: try XCTUnwrap(confirmed)))
        let removed = await awaitNoElement(in: window, where: isChip)
        XCTAssertTrue(removed, "A server-confirmed disabled bypass left the chip")
    }

    /// The Agent's notices show as chips above the composer with the server's text, and Dismiss hides one (TAL-831).
    func testTheAgentsNoticesShowAboveTheComposerAndDismiss() async throws {
        let window = try await hostFixtureChat(["--ui-test-session-notices"])
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
        let chip = try await requireElement(in: window, label: warning, "The Agent's warning is not above the composer")
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The warning is off screen")
        _ = try await requireElement(in: window, label: "You've used 90% of your credits.", "The Agent's credit notice is missing")

        let dismissals = elements(named: "Dismiss notice", in: window)
        XCTAssertEqual(dismissals.count, 2, "Each notice needs its own Dismiss")
        HostedAccessibility.activate(try XCTUnwrap(dismissals.first))
        let dismissed = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(dismissed, "Dismiss left the warning up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "Dismiss hid the other notice")
    }

    /// The Agent's notices arrive on the stream, and the one the Agent clears leaves its chip (TAL-831).
    func testANoticeTheServerClearsLeavesItsChip() async throws {
        let window = try await hostFixtureChat(["--ui-test-chat-pending-steers", "--ui-test-session-notices"])
        try await sendFromComposer("Back up the cluster", in: window)
        let warning = "Memory provider 'honcho' could not be loaded; memory is off."
        _ = try await requireElement(in: window, label: warning, "The stream's warning is not above the composer")
        // The fixture's Agent clears its warning after the steer's edit.
        HostedAccessibility.activate(try await requireElement(in: window, label: "Edit steering message"))
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == warning }
        XCTAssertTrue(cleared, "The warning the server cleared is still up")
        let kept = await awaitElement(in: window, label: "You've used 90% of your credits.")
        XCTAssertNotNil(kept, "The clear hid the notice the server kept")
    }

    /// A manual /compress shows in the run status chip, timed from the server's job start, leaves the composer's
    /// placeholder alone, and clears its draft as it starts (TAL-1006).
    func testManualCompressionShowsInTheRunStatusChip() async throws {
        let window = try await hostFixtureChat()
        try await sendFromComposer("/compress", in: window)
        // The chip shows as the command is sent; its elapsed time follows once the server's job start arrives.
        let chip = try await requireElement(in: window, "The chip never showed the time since the server's job start") {
            $0.accessibilityLabel?.hasSuffix("is compressing the context") == true
                && $0.accessibilityValue?.hasPrefix("running for 1 minute") == true
        }
        XCTAssertTrue(window.bounds.contains(window.convert(chip.accessibilityFrame, from: nil)), "The chip is off screen")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains("Compressing context..."), "The composer placeholder still says it")
        // A typed command leaves the composer when it is sent, not when it finishes (the job above is still running).
        let draft = await composerTextView(in: window)
        XCTAssertEqual(draft?.text, "", "The /compress draft stayed in the composer while the command ran")
    }

    /// An edit or regenerate the server holds asks with the server's count, the edit only once its sheet has closed;
    /// Cancel keeps the transcript (TAL-929).
    func testHeldEditAndRegenerateAskWithTheServersCount() async throws {
        let window = try await hostFixtureChat(["--ui-test-compression-reference"])
        func alert() -> UIAlertController? {
            var controller = window.rootViewController
            while let presented = controller?.presentedViewController { controller = presented }
            return controller as? UIAlertController
        }
        func choose(_ title: String, on label: String) async throws {
            let row = try await requireElement(in: window, label: label)
            let hit = try XCTUnwrap(try messageMenuHit(at: row, in: window), "\(label) has no message menu")
            try XCTUnwrap(hit.content.actions.first { $0.title == title }, "\(label) offers no \(title)").handler()
        }

        try await choose("Edit Message", on: "Plan the migration.")
        let presented = await presentedController(in: window)
        let sheet = try XCTUnwrap(presented, "Edit opened no sheet")
        let send = await awaitCondition { HostedAccessibility.element(in: sheet.view, label: "Send") != nil }
        XCTAssertTrue(send, "The edit sheet has no Send")
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: sheet.view, label: "Send")))
        let editAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(editAsked, "The held edit never asked")
        XCTAssertEqual(alert()?.title, "Discard Later Messages?")
        XCTAssertEqual(alert()?.message, "Editing this message will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let editCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(editCancelled, "Cancel left the confirmation up")

        try await choose("Regenerate Response", on: "Here is the plan.")
        let regenerateAsked = await awaitCondition { alert() != nil }
        XCTAssertTrue(regenerateAsked, "The held regenerate never asked")
        XCTAssertEqual(alert()?.message, "Regenerating this response will discard 5 later messages.")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: try XCTUnwrap(alert())))
        let regenerateCancelled = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(regenerateCancelled, "Cancel left the confirmation up")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Step one done."), "Cancel changed the transcript")
    }

    /// What the transcript's long press resolves to at `element`'s centre (TAL-485): the press handler's own registry
    /// and policy, read from the hosted transcript. The touch arbitration itself is the phone check's.
    private func messageMenuTarget(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuTarget? {
        guard let hit = try messageMenuHit(at: element, in: window) else { return nil }
        return ChatMessageMenuPolicy.target(
            at: hit.localPoint, linkRegions: hit.content.linkRegions, controlRegions: hit.content.controlRegions
        )
    }

    /// The message row a long press at `element`'s centre lands on, from the press handler's own registry.
    private func messageMenuHit(at element: NSObject, in window: UIWindow) throws -> ChatMessageMenuRegistry.Hit? {
        let frame = window.convert(element.accessibilityFrame, from: nil)
        return try messageMenuHit(at: CGPoint(x: frame.midX, y: frame.midY), in: window)
    }

    private func messageMenuHit(at point: CGPoint, in window: UIWindow) throws -> ChatMessageMenuRegistry.Hit? {
        let registry = try messageMenuRegistry(in: window)
        let scrollView = try transcriptScrollView(in: window)
        return registry.hit(at: scrollView.convert(point, from: window), in: scrollView)
    }

    private func messageMenuRegistry(in window: UIWindow) throws -> ChatMessageMenuRegistry {
        let host = try XCTUnwrap(window.firstView(ofType: ChatMessageMenuHostView.self), "The transcript has no long-press handler")
        let stored = Dictionary(uniqueKeysWithValues: Mirror(reflecting: host).children.compactMap { child in
            child.label.map { ($0, child.value) }
        })
        return try XCTUnwrap(stored["registry"] as? ChatMessageMenuRegistry)
    }

    private func hasHeldHistoryPage(before offset: Int) -> Bool {
        UITestFixtureHold.shared.pendingRequests.contains { request in
            guard let url = request.url, url.path == "/api/session" else { return false }
            return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.contains {
                $0.name == "msg_before" && $0.value == String(offset)
            } == true
        }
    }

    /// Mounting a buffered target is not arrival; wait before interacting with it.
    private func navigateTranscript(to id: String, anchor: UnitPoint, using controller: ChatScrollPositionController) async throws {
        controller.cancelPreservation()
        let navigate = try XCTUnwrap(controller.onHoldAnchor, "The transcript must register its navigation owner")
        navigate(id, anchor)
        let arrived = await awaitCondition {
            !controller.isNavigating && !controller.isPreservingPosition && !controller.isRealizingRows
        }
        XCTAssertTrue(arrived, "The requested reader must finish navigation and realization before fixture interaction; navigating \(controller.isNavigating), preserving \(controller.isPreservingPosition), realizing \(controller.isRealizingRows), top \(String(describing: controller.viewportTop))")
    }

    private func transcriptScrollView(in window: UIWindow) throws -> UIScrollView {
        var scroll: UIScrollView?
        waitUntil {
            scroll = window.firstView(ofType: ChatMessageMenuHostView.self)?.superview.flatMap {
                sequence(first: $0, next: \.superview).first { $0 is UIScrollView } as? UIScrollView
            }
            return scroll != nil
        }
        return try XCTUnwrap(scroll, "The transcript's native scroll handler did not attach")
    }
}

@MainActor @Observable
private final class RecycledBodyFixture {
    var showsBody = true
    let rowState = ChatTranscriptRowState()
    let tool: ToolCall?
    @ObservationIgnored private var toolResultContinuation: CheckedContinuation<Void, Never>?
    var toolResultCalls = 0
    var isToolResultPending: Bool { toolResultContinuation != nil }
    init(tool: ToolCall? = nil) { self.tool = tool }

    func toolResult() async -> ToolResultView {
        toolResultCalls += 1
        await withCheckedContinuation { toolResultContinuation = $0 }
        return ToolResultView(text: "Full retained tool output")
    }

    func releaseToolResult() {
        let continuation = toolResultContinuation
        toolResultContinuation = nil
        continuation?.resume()
    }
}

private struct RecycledBodyView: View {
    let state: RecycledBodyFixture
    var body: some View {
        if state.showsBody {
            Group {
                if let tool = state.tool {
                    ToolCallCardView(toolCall: tool)
                        .environment(\.chatFullToolResultLoader) { _ in await state.toolResult() }
                } else {
                    MessageBubbleView(message: ChatMessage(role: "user", content: "Full retained fixture body", timestamp: nil,
                                                          messageId: "retained-body", displayExcerpt: "Excerpt"))
                }
            }
            .environment(\.chatTranscriptRowState, state.rowState)
        }
    }
}

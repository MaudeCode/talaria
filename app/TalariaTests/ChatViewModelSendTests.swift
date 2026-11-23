import XCTest
import SwiftData
import SwiftUI
import UIKit
@testable import Talaria
@testable import TalariaKit

final class ChatViewModelSendTests: XCTestCase {
    override func tearDown() {
        ChatViewModel.resetActiveStreamSnapshotsForTesting()
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }
}

// Reloaded tool progress in the hosted chat window.
extension ChatViewModelSendTests {
    @MainActor
    func testReloadedToolProgressDisappearsWhenStreamEndsOnPhone() async throws {
        try await assertReloadedToolProgressDisappearsWhenStreamEnds(size: CGSize(width: 320, height: 844), name: "phone")
    }

    @MainActor
    func testReloadedToolProgressDisappearsWhenStreamEndsOnPad() async throws {
        try await assertReloadedToolProgressDisappearsWhenStreamEnds(size: HostedSize.padLandscape, name: "pad")
    }

    @MainActor
    private func assertReloadedToolProgressDisappearsWhenStreamEnds(size: CGSize, name: String) async throws {
        let fixture = try FixtureApp(for: self)
        let stream = SpySSEStreamingClient()
        let model = try makeReloadedToolProgressModel(stream: stream)
        defer {
            model.suspendStreamForNavigation()
            model.cleanupPollingTasks()
            stream.stop()
        }
        await model.loadMessages()
        await model.reconnectStreamIfNeeded()
        await model.loadComposerConfiguration()
        XCTAssertNil(model.lastError, "The progress fixture must start without an API error")
        let window = try hostWindow(NavigationStack {
            ChatView(session: SessionSummary(sessionId: "session-abc", title: "Reloaded tool progress"),
                server: URL(string: "https://example.test")!, onAPIError: { _ in },
                loadsInitialMessages: false, viewModel: model)
        }.modelContainer(fixture.cache), size: size)
        let hasProgress = { (element: NSObject) in element.accessibilityLabel?.contains("42% · indexing") == true }
        _ = try await requireElement(in: window, where: hasProgress)
        attachHostedScreenshot(window, name: "reloaded-progress-before-end-\(name)")
        stream.emit(.streamEnd)
        let cleared = await awaitNoElement(in: window, where: hasProgress)
        attachHostedScreenshot(window, name: "reloaded-progress-after-end-\(name)")
        XCTAssertTrue(cleared, "\(name) kept persisted tool progress after stream_end")
        _ = try await requireElement(in: window, where: { $0.accessibilityLabel?.contains("Calling a tool") == true })
        window.isHidden = true
        window.rootViewController = nil
    }
}

// Asserts AVAudioSession categories, which exist only on iOS.
extension ChatViewModelSendTests {
    func testListenAudioSessionRoutesToSpeakerNotEarpiece() {
        // `.playback` forces the speaker (not the receiver/earpiece) by default, and
        // `.spokenAudio` is Apple's recommended mode for synthesized speech. #252.
        XCTAssertEqual(ListenAudioSessionConfiguration.category, .playback)
        XCTAssertEqual(ListenAudioSessionConfiguration.mode, .spokenAudio)
        XCTAssertTrue(
            ListenAudioSessionConfiguration.deactivationOptions.contains(.notifyOthersOnDeactivation)
        )
    }
}

@MainActor
extension ChatViewModelSendTests {
    func testOrdinarySyncPillKeepsItsMinimumVisibleHold() async throws {
        let clock = DelayedStatusTestClock()
        let (viewModel, _, window, requests) = try await makeHeldSyncChat(
            host: "ordinary-sync-hold.test", timing: clock.timing)
        let started = clock.now
        let reload = Task { await viewModel.loadMessages() }
        let waitingToShow = await awaitCondition { clock.nextDeadline != nil }
        XCTAssertTrue(waitingToShow)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        let showDeadline = try XCTUnwrap(clock.nextDeadline)
        // The hold runs on the test clock, never the wall clock: a delay read from real time would land elsewhere.
        XCTAssertEqual(showDeadline, started.addingTimeInterval(DelayedStatusVisibility.showDelay))
        clock.advance(to: showDeadline.addingTimeInterval(-0.01))
        settle(0.05)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        clock.advance(to: showDeadline)
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
        XCTAssertFalse(viewModel.isSyncingTranscript)
        settle(0.05)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"),
                        "Ordinary completion must honor the minimum-visible hold instead of flashing the sync pill.")
        let waitingToHide = await awaitCondition { clock.nextDeadline != nil }
        XCTAssertTrue(waitingToHide)
        let holdDeadline = try XCTUnwrap(clock.nextDeadline)
        XCTAssertEqual(holdDeadline.timeIntervalSinceReferenceDate,
                       showDeadline.addingTimeInterval(DelayedStatusVisibility.minimumVisibleDuration).timeIntervalSinceReferenceDate,
                       accuracy: 0.0001)
        clock.advance(to: holdDeadline.addingTimeInterval(-0.01))
        settle(0.05)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        clock.advance(to: holdDeadline)
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(cleared)
    }

    func testFastFailedSendDoesNotRestoreHeldSyncPresentation() async throws {
        let (viewModel, _, window, requests) = try await makeHeldSyncChat(host: "fast-send-sync-hold.test")
        let reload = Task { await viewModel.loadMessages() }
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        let send = Task { await viewModel.sendMessage("Failed question") }
        let started = await awaitCondition { requests.count == 3 }
        XCTAssertTrue(started)
        requests.request(at: 2).complete(withJSON: #"{"error":"Send failed"}"#, statusCode: 500)
        let sent = await send.value
        XCTAssertFalse(sent)
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
        settle(0.05)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"),
                     "A fast failed send must cancel the previous sync hold, not reveal it again.")
    }

    func testSendProgressNeverShowsSyncingDuringAHeldReload() async throws {
        let (viewModel, stream, window, requests) = try await makeHeldSyncChat(host: "hosted-send-sync.test")
        let reload = Task { await viewModel.loadMessages() }
        _ = try await requireElement(in: window, label: "Syncing messages with the server")
        attachHostedScreenshot(window, name: "send-status-before-submission")
        let send = Task { await viewModel.sendMessage("Next question") }
        let sendStarted = await awaitCondition { requests.count == 3 }
        XCTAssertTrue(sendStarted)
        _ = try await requireElement(in: window, label: "Hermes is starting a response")
        requests.request(at: 2).complete(withJSON: #"{"session_id":"session-abc","stream_id":"stream-123"}"#)
        let sent = await send.value
        XCTAssertTrue(sent)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Hermes is working on the response") == true }
        settle(0.5)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        attachHostedScreenshot(window, name: "send-status-response-with-held-reload")
        stream.emit(.token("Live answer"))
        _ = try await requireElement(in: window, label: "Live answer")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Syncing messages with the server"))
        requests.request(at: 1).complete(withJSON: Self.hostedSyncTranscript)
        await reload.value
    }

    private static let hostedSyncTranscript = #"{"session":{"session_id":"session-abc","messages":[{"role":"user","content":"Earlier question","message_id":"earlier-user"},{"role":"assistant","content":"Earlier answer","message_id":"earlier-answer"}]}}"#

    private func makeHeldSyncChat(host: String, timing: DelayedStatusTiming = .live) async throws -> (ChatViewModel, SpySSEStreamingClient, UIWindow, DeferredRequests) {
        let fixture = try FixtureApp(for: self)
        let requests = DeferredRequests()
        DeferredMockURLProtocol.setOnRequest({ request in
            if ["/api/session", "/api/chat/start"].contains(request.request.url?.path ?? "") {
                _ = requests.append(request)
            } else {
                request.complete(withJSON: "{}")
            }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let stream = SpySSEStreamingClient()
        let summary = SessionSummary(sessionId: "session-abc", title: "Send status")
        let viewModel = try makeViewModel(streamClient: stream, sessionSummary: summary,
            server: URL(string: "https://\(host)")!, protocolClasses: [DeferredMockURLProtocol.self]) { _ in
            throw URLError(.badURL)
        }
        addTeardownBlock {
            await MainActor.run { viewModel.suspendStreamForNavigation(); viewModel.cleanupPollingTasks() }
        }
        let initial = Task { await viewModel.loadMessages() }
        let initialStarted = await awaitCondition { requests.count == 1 }
        XCTAssertTrue(initialStarted)
        requests.request(at: 0).complete(withJSON: Self.hostedSyncTranscript)
        await initial.value
        let window = try hostWindow(NavigationStack {
            ChatView(session: summary, server: URL(string: "https://\(host)")!, onAPIError: { _ in },
                     loadsInitialMessages: false, viewModel: viewModel)
        }.modelContainer(fixture.cache).environment(\.delayedStatusTiming, timing))
        return (viewModel, stream, window, requests)
    }
}

/// Extends the fixture's controlled-response approach to the status clock.
/// Cancellation removes sleepers when SwiftUI replaces an operation or view.
@MainActor
private final class DelayedStatusTestClock {
    private(set) var now = Date(timeIntervalSince1970: 1_770_000_000)
    private var sleepers: [UUID: (Date, CheckedContinuation<Void, Error>)] = [:]
    var nextDeadline: Date? { sleepers.values.map { $0.0 }.min() }
    var timing: DelayedStatusTiming {
        DelayedStatusTiming(now: { self.now }, sleepUntil: { try await self.sleep(until: $0) })
    }

    func advance(to date: Date) {
        precondition(date >= now)
        now = date
        let ready = sleepers.filter { $0.value.0 <= now }
        for (id, _) in ready {
            sleepers.removeValue(forKey: id)?.1.resume()
        }
    }

    private func sleep(until deadline: Date) async throws {
        try Task.checkCancellation()
        guard deadline > now else { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                sleepers[id] = (deadline, continuation)
            }
        } onCancel: {
            Task { @MainActor in
                self.sleepers.removeValue(forKey: id)?.1.resume(throwing: CancellationError())
            }
        }
    }
}

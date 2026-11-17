import Observation
import XCTest
@testable import TalariaKit

/// TAL-2388: with two windows, an event goes to the window already showing its chat, else to the most recently active
/// one, and exactly one window handles it.
@MainActor
final class WindowRoutingTests: XCTestCase {
    private let server = URL(string: "https://hermes.example.test")!
    private var shown: [SessionNotificationRefresh.ShownChat] = []

    override func tearDown() async throws {
        for chat in shown { SessionNotificationRefresh.updateVisibleChat(from: chat, to: nil) }
        try await super.tearDown()
    }

    private func show(_ sessionID: String, in window: String?, isActive: Bool = true) throws {
        let chat = try XCTUnwrap(SessionNotificationRefresh.VisibleChat(server: server, sessionID: sessionID))
        let entry = SessionNotificationRefresh.ShownChat(chat, window: window, isActive: isActive)
        SessionNotificationRefresh.updateVisibleChat(from: nil, to: entry)
        shown.append(entry)
    }

    private func router(windows: [String]) -> (AppIntentRouter, () -> [String]) {
        let router = AppIntentRouter()
        var broughtForward: [String] = []
        router.bringForward = { broughtForward.append($0) }
        windows.reversed().forEach(router.windowDidBecomeActive)
        return (router, { broughtForward })
    }

    func testTheRoutingRule() {
        XCTAssertEqual(AppIntentRouter.window(showing: ["B"], recency: ["A", "B"]), "B", "the window showing the chat, though A was active last")
        XCTAssertEqual(AppIntentRouter.window(showing: [], recency: ["A", "B"]), "A", "a chat shown nowhere goes to the most recently active window")
        XCTAssertEqual(AppIntentRouter.window(showing: ["A", "B"], recency: ["B", "A"]), "B", "of two windows showing it, the more recent")
        XCTAssertEqual(AppIntentRouter.window(showing: [], recency: ["A"]), "A")
        XCTAssertEqual(AppIntentRouter.window(showing: ["A"], recency: ["A"]), "A")
        XCTAssertNil(AppIntentRouter.window(showing: [], recency: []), "before any window is known, the first to drain takes it")
    }

    func testASessionShownInTheOtherWindowGoesThereOnceAndBringsItForward() throws {
        try show("s1", in: "B")
        let (router, broughtForward) = router(windows: ["A", "B"])
        let url = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: "s1"))

        router.requestDeepLink(url)

        XCTAssertNil(router.takeDeepLink(in: "A"))
        XCTAssertEqual(router.takeDeepLink(in: "B"), url)
        XCTAssertNil(router.takeDeepLink(in: "B"), "handled exactly once")
        XCTAssertEqual(broughtForward(), ["B"])
    }

    func testAnEventNamingNoShownChatGoesToTheMostRecentWindowWithoutActivation() throws {
        try show("s1", in: "B")
        let (router, broughtForward) = router(windows: ["A", "B"])

        for url in [TalariaDeepLink.newChatURL, TalariaDeepLink.sessionURL(sessionID: "s2")] {
            router.requestDeepLink(url)
            XCTAssertNil(router.takeDeepLink(in: "B"))
            XCTAssertEqual(router.takeDeepLink(in: "A"), url)
        }
        XCTAssertEqual(broughtForward(), [])
    }

    func testOneWindowHandlesEverythingItself() throws {
        try show("s1", in: "A")
        let (router, broughtForward) = router(windows: ["A"])

        for url in [TalariaDeepLink.newChatURL, TalariaDeepLink.sessionURL(sessionID: "s1"), TalariaDeepLink.sessionURL(sessionID: "s2")] {
            router.requestDeepLink(url)
            XCTAssertEqual(router.takeDeepLink(in: "A"), url)
        }
        XCTAssertEqual(broughtForward(), [])
    }

    func testAClosedWindowHandsItsPendingEventToTheMostRecentWindowAndWakesIt() throws {
        try show("s1", in: "B")
        let (router, _) = router(windows: ["A", "B"])
        let url = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: "s1"))
        router.requestDeepLink(url)
        XCTAssertNil(router.takeDeepLink(in: "A"))
        nonisolated(unsafe) var woke = false
        withObservationTracking { _ = router.pendingWindow } onChange: { woke = true }

        router.windowDidClose("B")

        XCTAssertTrue(woke, "A already passed on the link, so the handover must wake it")
        XCTAssertEqual(router.takeDeepLink(in: "A"), url)
    }

    func testSelectingAChatAnotherWindowShowsBringsThatWindowForward() throws {
        try show("s1", in: "A")
        try show("s2", in: "B")
        let (router, broughtForward) = router(windows: ["A", "B"])

        XCTAssertTrue(router.bringsForwardOtherWindow(showing: "s2", on: server, from: "A"))
        XCTAssertFalse(router.bringsForwardOtherWindow(showing: "s1", on: server, from: "A"), "its own chat stays its own")
        XCTAssertFalse(router.bringsForwardOtherWindow(showing: "s3", on: server, from: "A"), "a chat shown nowhere opens here")
        XCTAssertFalse(router.bringsForwardOtherWindow(showing: "s2", on: URL(string: "https://other.example.test")!, from: "A"))
        XCTAssertEqual(broughtForward(), ["B"])
    }

    // MARK: - Visible-chat registry

    func testTheRegistryNamesEachWindowsChatsAndSilencesOnlyActiveOnes() throws {
        // A shows two chats in its in-app split; B shows one in the background.
        try show("s1", in: "A")
        try show("s2", in: "A")
        try show("s3", in: "B", isActive: false)

        XCTAssertEqual(SessionNotificationRefresh.windows(showing: "s2", publisherID: nil), ["A"])
        XCTAssertEqual(SessionNotificationRefresh.windows(showing: "s3", publisherID: server.absoluteString), ["B"])
        XCTAssertEqual(SessionNotificationRefresh.windows(showing: "s3", publisherID: "https://other.example.test"), [])
        XCTAssertEqual(SessionNotificationRefresh.visibleChats.map(\.sessionID).sorted(), ["s1", "s2"],
                       "only a chat in an active window keeps its notifications silent")
    }

    func testAChatMovesBetweenWindowsAndLeaves() throws {
        try show("s1", in: "A")
        let moved = SessionNotificationRefresh.ShownChat(shown[0].chat, window: "B", isActive: true)

        SessionNotificationRefresh.updateVisibleChat(from: shown[0], to: moved)
        shown[0] = moved
        XCTAssertEqual(SessionNotificationRefresh.windows(showing: "s1", publisherID: nil), ["B"])

        SessionNotificationRefresh.updateVisibleChat(from: moved, to: nil)
        shown.removeAll()
        XCTAssertEqual(SessionNotificationRefresh.windows(showing: "s1", publisherID: nil), [])
    }
}

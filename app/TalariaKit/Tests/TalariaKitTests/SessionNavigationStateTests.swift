import XCTest
@testable import TalariaKit

final class SessionNavigationStateTests: XCTestCase {
    func testSelectingSessionUpdatesDestinationAndRestorationID() {
        let session = SessionSummary(sessionId: "session-1", title: "One")
        var state = SessionNavigationState()

        state.select(session)

        XCTAssertEqual(state.destination, .session(session))
        XCTAssertEqual(state.selectedSessionID, "session-1")
        XCTAssertEqual(state.lastSelectedSessionID, "session-1")
    }

    func testRestoreSelectsStoredSessionWhenItStillExists() {
        let first = SessionSummary(sessionId: "session-1", title: "One")
        let second = SessionSummary(sessionId: "session-2", title: "Two")
        var state = SessionNavigationState(lastSelectedSessionID: "session-2")

        let restored = state.sessionToRestore(from: [first, second])

        XCTAssertEqual(restored, second)
        // The caller opens the candidate through the import path; the state never
        // shows it directly.
        XCTAssertNil(state.destination)
        XCTAssertEqual(state.lastSelectedSessionID, "session-2")
    }

    func testRestoreLeavesCompactChatRootAtSessionList() {
        let stored = SessionSummary(sessionId: "stored")
        var state = SessionNavigationState(lastSelectedSessionID: "stored")

        let restored = state.sessionToRestore(from: [stored], allowsAutomaticRestore: false)

        XCTAssertNil(restored)
        XCTAssertEqual(state.lastSelectedSessionID, "stored")
    }

    func testRestoreClearsStoredSelectionWhenSessionNoLongerExists() {
        var state = SessionNavigationState(lastSelectedSessionID: "missing")

        let restored = state.sessionToRestore(from: [SessionSummary(sessionId: "session-1")])

        XCTAssertNil(restored)
        XCTAssertNil(state.lastSelectedSessionID)
    }

    func testRestorePreservesStoredSelectionWhenSessionListIsNotAuthoritative() {
        var state = SessionNavigationState(lastSelectedSessionID: "session-1")

        let restored = state.sessionToRestore(from: [], clearsMissingSelection: false)

        XCTAssertNil(restored)
        XCTAssertEqual(state.lastSelectedSessionID, "session-1")
    }

    func testRestoreSkipsWhileDeepLinkIsPendingAndKeepsStoredSelection() {
        let stored = SessionSummary(sessionId: "stored")
        var state = SessionNavigationState(lastSelectedSessionID: "stored")

        let restored = state.sessionToRestore(from: [stored], pendingDeepLinkedSessionID: "deep-linked")

        XCTAssertNil(restored)
        XCTAssertEqual(state.lastSelectedSessionID, "stored")
    }

    func testRestoreSkipsAfterPendingDeepLinkIsConsumedWhileLoadIsInFlight() {
        let stored = SessionSummary(sessionId: "stored")
        var state = SessionNavigationState(lastSelectedSessionID: "stored")

        let deepLinkedSessionID = state.beginDeepLinkedSessionLoad(id: "deep-linked")
        let blocked = state.sessionToRestore(from: [stored], pendingDeepLinkedSessionID: nil)

        XCTAssertEqual(deepLinkedSessionID, "deep-linked")
        XCTAssertNil(blocked)
        XCTAssertEqual(state.lastSelectedSessionID, "stored")

        state.finishDeepLinkedSessionLoad(id: deepLinkedSessionID)
        let restored = state.sessionToRestore(from: [stored], pendingDeepLinkedSessionID: nil)

        XCTAssertEqual(restored, stored)
    }

    func testRestoreProceedsWhenPendingDeepLinkIDIsBlank() {
        let stored = SessionSummary(sessionId: "stored")
        var state = SessionNavigationState(lastSelectedSessionID: "stored")

        let restored = state.sessionToRestore(from: [stored], pendingDeepLinkedSessionID: "   ")

        XCTAssertEqual(restored, stored)
    }

    func testInitialRefreshStartsBeforeDelayedDeepLinkFinishes() async {
        let recorder = SessionInitialLoadEventRecorder()

        await SessionListInitialLoad.run(
            resolvePendingDeepLink: {
                await recorder.record(.deepLinkStarted)
                // Finish only once the refresh has started, or after a deadline a serial load would hit. A fixed
                // 50 ms deep link could finish before a starved concurrent refresh began.
                let deadline = ContinuousClock.now + .seconds(10)
                while await !recorder.snapshot().contains(.refreshStarted), ContinuousClock.now < deadline {
                    try? await Task.sleep(for: .milliseconds(5))
                }
                await recorder.record(.deepLinkFinished)
            },
            refreshSessionsAndActiveProfile: {
                await recorder.record(.refreshStarted)
            }
        )

        let events = await recorder.snapshot()
        guard let refreshIndex = events.firstIndex(of: .refreshStarted),
              let deepLinkFinishIndex = events.firstIndex(of: .deepLinkFinished)
        else {
            return XCTFail("Expected both refresh and deep-link completion events")
        }

        XCTAssertLessThan(refreshIndex, deepLinkFinishIndex)
    }

    func testExplicitNewChatRouteOverridesStoredSelection() {
        let route = PendingNewChatRoute(initialDraft: "Shared draft")
        var state = SessionNavigationState(lastSelectedSessionID: "session-1")
        state.select(route)

        let restored = state.sessionToRestore(from: [SessionSummary(sessionId: "session-1")])

        XCTAssertNil(restored)
        XCTAssertEqual(state.destination, .newChat(route))
        XCTAssertEqual(state.lastSelectedSessionID, "session-1")
    }

    func testExplicitSessionRouteOverridesStoredSelection() {
        let stored = SessionSummary(sessionId: "stored")
        let deepLinked = SessionSummary(sessionId: "deep-linked")
        var state = SessionNavigationState(lastSelectedSessionID: "stored")
        state.select(deepLinked)

        let restored = state.sessionToRestore(from: [stored])

        XCTAssertNil(restored)
        XCTAssertEqual(state.destination, .session(deepLinked))
        XCTAssertEqual(state.lastSelectedSessionID, "deep-linked")
    }

    func testCreatedSessionRemainsSelectedWhileNewChatRouteOwnsItsDraft() {
        let route = PendingNewChatRoute(initialDraft: "Shared draft")
        let created = SessionSummary(sessionId: "created-session")
        var state = SessionNavigationState()
        state.select(route)
        XCTAssertTrue(state.isCreatingNewChat)

        state.remember(created)

        XCTAssertEqual(state.destination, .newChat(route))
        XCTAssertEqual(state.selectedSessionID, "created-session")
        XCTAssertEqual(state.lastSelectedSessionID, "created-session")
        XCTAssertFalse(state.isCreatingNewChat)
    }

    func testSelectingAnotherNewChatRouteStartsFreshCreationState() {
        let firstRoute = PendingNewChatRoute()
        let secondRoute = PendingNewChatRoute()
        var state = SessionNavigationState()
        state.select(firstRoute)
        state.remember(SessionSummary(sessionId: "created-session"))

        state.select(secondRoute)

        XCTAssertEqual(state.destination, .newChat(secondRoute))
        XCTAssertNil(state.selectedSessionID)
        XCTAssertTrue(state.isCreatingNewChat)
    }

    /// Work still resolving for a destination the user cleared — an external
    /// session import in flight — must not reinstate it, so clearing advances the
    /// revision that fences those opens just like selecting does.
    func testClearingTheDestinationAdvancesTheRootRevision() {
        var state = SessionNavigationState()
        state.select(SessionSummary(sessionId: "cli-1"))
        let revisionWhileOpen = state.rootRevision

        state.clearDestination()

        XCTAssertGreaterThan(state.rootRevision, revisionWhileOpen)
        XCTAssertNil(state.destination)
    }

    func testReturningFromContentfulNewChatSuppressesPlaceholdersThenRefreshesSessions() {
        let route = PendingNewChatRoute()
        var state = SessionNavigationState()
        state.select(route)
        state.remember(SessionSummary(sessionId: "created-session"))
        let oldDestination = state.destination
        state.clearDestination()
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: oldDestination,
            to: state.destination,
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertEqual(events, [.suppressedPlaceholders, .refreshedSessions])
    }

    func testReturningFromEmptyNewChatSuppressesPlaceholderThenRefreshesSessions() {
        let route = PendingNewChatRoute()
        var state = SessionNavigationState()
        state.select(route)
        let oldDestination = state.destination
        state.clearDestination()
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: oldDestination,
            to: state.destination,
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertEqual(events, [.suppressedPlaceholders, .refreshedSessions])
    }

    func testReplacingNewChatRouteDoesNotRefreshSessions() {
        let firstRoute = PendingNewChatRoute()
        let secondRoute = PendingNewChatRoute()
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: .newChat(firstRoute),
            to: .newChat(secondRoute),
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertTrue(events.isEmpty)
    }

    func testLeavingAnExistingSessionRefreshesWithoutSuppressingPlaceholders() {
        var state = SessionNavigationState()
        state.select(SessionSummary(sessionId: "session-1"))
        let oldDestination = state.destination
        state.clearDestination()
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: oldDestination,
            to: state.destination,
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertEqual(events, [.refreshedSessions])
    }

    /// Regular width switches straight from one session to another without ever
    /// passing through a nil destination, and the session being left can still
    /// have a newer title or message count on the server.
    func testSwitchingBetweenSessionsRefreshesSessions() {
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: .session(SessionSummary(sessionId: "session-1")),
            to: .session(SessionSummary(sessionId: "session-2")),
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertEqual(events, [.refreshedSessions])
    }

    func testLeavingAUtilityDestinationRefreshesSessions() {
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: .utility(.archived),
            to: nil,
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertEqual(events, [.refreshedSessions])
    }

    func testFirstDestinationOfALaunchDoesNotRefreshSessions() {
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: nil,
            to: .session(SessionSummary(sessionId: "session-1")),
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertTrue(events.isEmpty)
    }

    func testUnchangedDestinationDoesNotRefreshSessions() {
        let session = SessionSummary(sessionId: "session-1")
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: .session(session),
            to: .session(session),
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertTrue(events.isEmpty)
    }

    func testRemovingSelectedSessionClearsDestinationAndRestorationID() {
        let session = SessionSummary(sessionId: "session-1")
        var state = SessionNavigationState()
        state.select(session)

        state.remove(sessionID: "session-1")

        XCTAssertNil(state.destination)
        XCTAssertNil(state.lastSelectedSessionID)
    }

    func testRemovingRememberedSessionPreservesDifferentVisibleDestination() {
        var state = SessionNavigationState(lastSelectedSessionID: "session-1")
        state.select(SessionListUtilityDestination.tasks)

        state.remove(sessionID: "session-1")

        XCTAssertEqual(state.destination, .utility(.tasks))
        XCTAssertNil(state.lastSelectedSessionID)
    }

    func testUtilityDestinationRemainsSelectedAcrossLayoutReevaluation() {
        var state = SessionNavigationState()
        state.select(SessionListUtilityDestination.settings(nil))

        let reevaluatedState = state

        XCTAssertEqual(reevaluatedState.destination, .utility(.settings(nil)))
        XCTAssertNil(reevaluatedState.selectedSessionID)
    }

    func testKanbanIsSelectableAsAUtilityDestination() {
        var state = SessionNavigationState()

        state.select(SessionListUtilityDestination.kanban)

        XCTAssertEqual(state.destination, .utility(.kanban))
        XCTAssertNil(state.selectedSessionID)
    }

    func testCompactNavigationPresentsUtilitiesAsRootsAndChatsAsDetails() {
        let session = SessionNavigationDestination.session(
            SessionSummary(sessionId: "session-1")
        )
        let kanban = SessionNavigationDestination.utility(.kanban)
        let archived = SessionNavigationDestination.utility(.archived)
        let webhook = SessionNavigationDestination.utility(.webhook)

        XCTAssertEqual(session.compactPushedDestination, session)
        XCTAssertNil(session.compactRootUtility)
        XCTAssertNil(kanban.compactPushedDestination)
        XCTAssertEqual(kanban.compactRootUtility, .kanban)
        XCTAssertEqual(archived.compactPushedDestination, archived)
        XCTAssertNil(archived.compactRootUtility)
        XCTAssertEqual(webhook.compactPushedDestination, webhook)
        XCTAssertNil(webhook.compactRootUtility)
    }

    func testReselectingRootDestinationAdvancesNavigationRevision() {
        var state = SessionNavigationState()
        state.select(SessionListUtilityDestination.skills)
        let firstRevision = state.rootRevision

        state.select(SessionListUtilityDestination.skills)

        XCTAssertEqual(state.destination, .utility(.skills))
        XCTAssertGreaterThan(state.rootRevision, firstRevision)
    }

    func testReadableContentWidthsKeepSecondaryAndWorkspaceSurfacesDistinct() {
        XCTAssertEqual(AdaptiveReadableContentWidth.secondaryDestination, 800)
        XCTAssertEqual(AdaptiveReadableContentWidth.workspace, 1_000)
        XCTAssertLessThan(
            AdaptiveReadableContentWidth.secondaryDestination,
            AdaptiveReadableContentWidth.workspace
        )
    }

    func testSidebarGestureStartsAtEdgeAndTracksEitherDirectionOnceOpen() {
        XCTAssertTrue(
            AppSidebarGesturePolicy.accepts(
                isPresented: false,
                startX: 20,
                containerWidth: 390,
                translation: CGSize(width: 80, height: 4),
                isRightToLeft: false
            )
        )
        XCTAssertFalse(
            AppSidebarGesturePolicy.accepts(
                isPresented: false,
                startX: 100,
                containerWidth: 390,
                translation: CGSize(width: 80, height: 4),
                isRightToLeft: false
            )
        )
        XCTAssertEqual(
            AppSidebarGesturePolicy.progress(
                isPresented: true,
                translationWidth: -180,
                revealWidth: 360,
                isRightToLeft: false
            ),
            0.5
        )
    }

    func testPersistenceUsesIndependentKeysPerServer() throws {
        let suiteName = "SessionNavigationStateTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let firstServer = try XCTUnwrap(URL(string: "https://first.example.com"))
        let secondServer = try XCTUnwrap(URL(string: "https://second.example.com"))

        SessionNavigationPersistence.save("first-session", for: firstServer, defaults: defaults)
        SessionNavigationPersistence.save("second-session", for: secondServer, defaults: defaults)

        XCTAssertEqual(
            SessionNavigationPersistence.load(for: firstServer, defaults: defaults),
            "first-session"
        )
        XCTAssertEqual(
            SessionNavigationPersistence.load(for: secondServer, defaults: defaults),
            "second-session"
        )
    }
}

private enum ReturnRefreshEvent: Equatable {
    case suppressedPlaceholders
    case refreshedSessions
}

private actor SessionInitialLoadEventRecorder {
    enum Event: Equatable {
        case deepLinkStarted
        case refreshStarted
        case deepLinkFinished
    }

    private var events: [Event] = []

    func record(_ event: Event) {
        events.append(event)
    }

    func snapshot() -> [Event] {
        events
    }
}

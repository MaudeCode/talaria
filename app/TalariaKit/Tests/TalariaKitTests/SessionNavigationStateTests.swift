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

    func testCachedLaunchRestoreIsWidthIndependentAndConsumedOnce() {
        for _ in ["compact", "regular"] {
            let stored = SessionSummary(sessionId: "stored")
            var state = SessionNavigationState(lastSelectedSessionID: "stored")
            XCTAssertEqual(state.sessionToRestore(from: [stored]), stored)
            XCTAssertTrue(state.launchRestoreResolved)
            state.select(stored)
            XCTAssertNil(state.sessionToRestore(from: [stored]))
            XCTAssertEqual(state.destination, .session(stored))
        }
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

        XCTAssertNil(restored)
        XCTAssertTrue(state.launchRestoreResolved)
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

        state.remember(created)

        XCTAssertEqual(state.destination, .newChat(route))
        XCTAssertEqual(state.selectedSessionID, "created-session")
        XCTAssertEqual(state.lastSelectedSessionID, "created-session")
    }

    func testImplicitCreatedChatIsRememberedWithoutReplacingItsRoot() {
        var state = SessionNavigationState()
        let revision = state.chatRootRevision
        state.remember(SessionSummary(sessionId: "implicit-created"))
        XCTAssertNil(state.destination)
        XCTAssertEqual(state.selectedSessionID, "implicit-created")
        XCTAssertEqual(state.lastSelectedSessionID, "implicit-created")
        XCTAssertEqual(state.chatRootRevision, revision)
    }

    func testSelectingAnotherNewChatRouteReplacesTheUnsentRoot() {
        let firstRoute = PendingNewChatRoute()
        let secondRoute = PendingNewChatRoute()
        var state = SessionNavigationState()
        state.select(firstRoute)
        let revision = state.chatRootRevision

        state.select(secondRoute)

        XCTAssertEqual(state.destination, .newChat(secondRoute))
        XCTAssertNil(state.selectedSessionID)
        XCTAssertGreaterThan(state.chatRootRevision, revision)
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

    /// A section leaves no chat behind, and at regular width the list keeps polling beside
    /// every section, so returning to Chats from one must not reload the list while the
    /// sidebar slides closed (TAL-477).
    func testLeavingASectionDoesNotRefreshSessions() {
        var state = SessionNavigationState()
        state.select(.memory)
        let oldDestination = state.destination
        state.clearDestination()
        var events: [ReturnRefreshEvent] = []

        SessionListReturnRefresh.run(
            from: oldDestination,
            to: state.destination,
            suppressEmptyPlaceholders: { events.append(.suppressedPlaceholders) },
            refreshSessions: { events.append(.refreshedSessions) }
        )

        XCTAssertTrue(events.isEmpty, "Leaving a section refreshed the session list: \(events)")
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

    func testSettingsRoutingLeavesTheUnderlyingRootAndPagesUnchanged() {
        var state = SessionNavigationState()
        state.select(.memory)
        state.selectedItem = .memory(.section(.user))
        let root = state.destination
        let item = state.selectedItem
        let revision = state.beginOpen() // The modal routing chokepoint invalidates outstanding opens.
        XCTAssertEqual(state.destination, root)
        XCTAssertEqual(state.selectedItem, item)
        XCTAssertEqual(state.openRevision, revision)
        XCTAssertNil(AppSection(.settings(nil)))
        XCTAssertNil(AppSection(.providerQuotaWidgetSettings))
    }

    func testKanbanIsSelectableAsAUtilityDestination() {
        var state = SessionNavigationState()

        state.select(SessionListUtilityDestination.kanban)

        XCTAssertEqual(state.destination, .utility(.kanban))
        XCTAssertNil(state.selectedSessionID)
    }

    func testSidebarDestinationsReplaceTheRootAndClearInnerPages() {
        var state = SessionNavigationState()
        for utility: SessionListUtilityDestination in [.kanban, .archived, .webhook, .scheduled, .memory, .tasks, .skills, .insights] {
            state.select(SessionSummary(sessionId: "chat"))
            state.select(utility)
            XCTAssertEqual(state.destination, .utility(utility))
            XCTAssertEqual(state.section, AppSection(utility))
            XCTAssertNil(state.selectedItem)
            XCTAssertNil(state.selectedSectionSession)
            XCTAssertNil(state.selectedSessionID)
        }
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
        XCTAssertEqual(AdaptiveReadableContentWidth.chat, 800)
        XCTAssertLessThan(
            AdaptiveReadableContentWidth.secondaryDestination,
            AdaptiveReadableContentWidth.workspace
        )
    }

    func testSidebarGestureStartsAtEdgeAndTracksEitherDirectionOnceOpen() {
        XCTAssertTrue(
            AppSidebarGesturePolicy.accepts(
                isPresented: false,
                canPopVisibleStack: false,
                startX: 20,
                containerWidth: 390,
                translation: CGSize(width: 80, height: 4),
                isRightToLeft: false
            )
        )
        XCTAssertFalse(
            AppSidebarGesturePolicy.accepts(
                isPresented: false,
                canPopVisibleStack: false,
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

    /// A screen that can go back owns the edge swipe; only a stack root opens the sidebar, and
    /// an open sidebar always tracks its closing drag (TAL-462).
    func testSidebarGestureLeavesEdgeSwipeToAStackThatCanPop() {
        for isRightToLeft in [false, true] {
            let edgeX: CGFloat = isRightToLeft ? 380 : 10
            let opening = CGSize(width: isRightToLeft ? -80 : 80, height: 4)
            func accepts(isPresented: Bool, canPop: Bool, translation: CGSize) -> Bool {
                AppSidebarGesturePolicy.accepts(
                    isPresented: isPresented,
                    canPopVisibleStack: canPop,
                    startX: edgeX,
                    containerWidth: 390,
                    translation: translation,
                    isRightToLeft: isRightToLeft
                )
            }

            XCTAssertTrue(accepts(isPresented: false, canPop: false, translation: opening), "RTL \(isRightToLeft)")
            XCTAssertFalse(accepts(isPresented: false, canPop: true, translation: opening), "RTL \(isRightToLeft)")
            // The screen-edge pan asks before the touch has moved.
            XCTAssertTrue(accepts(isPresented: false, canPop: false, translation: .zero), "RTL \(isRightToLeft)")
            XCTAssertFalse(accepts(isPresented: false, canPop: true, translation: .zero), "RTL \(isRightToLeft)")
            XCTAssertFalse(accepts(isPresented: false, canPop: false, translation: CGSize(width: 4, height: 60)), "RTL \(isRightToLeft)")
            let closing = CGSize(width: -opening.width, height: 4)
            XCTAssertTrue(accepts(isPresented: true, canPop: false, translation: closing), "RTL \(isRightToLeft)")
            XCTAssertTrue(accepts(isPresented: true, canPop: true, translation: closing), "RTL \(isRightToLeft)")
        }
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

/// Section roots and inner pages are independent of the sidebar presentation.
final class AppSectionLayoutTests: XCTestCase {
    func testEachUtilityNamesItsRootWithoutAnImplicitPushedPage() {
        let expectations: [(SessionListUtilityDestination, AppSection)] = [
            (.memory, .memory), (.skills, .skills), (.tasks, .tasks), (.kanban, .kanban),
            (.insights, .insights), (.providers("source"), .insights), (.archived, .archived),
            (.scheduled, .scheduled), (.webhook, .webhook)
        ]
        for (utility, section) in expectations {
            var state = SessionNavigationState()
            state.select(utility)
            XCTAssertEqual(state.section, section)
            XCTAssertEqual(state.destination, .utility(utility))
            XCTAssertNil(state.selectedItem)
        }
        XCTAssertEqual(SessionNavigationState().section, .chats)
    }

    func testSettingsAnchorsNameModalCategoriesOutsideAppSections() {
        let anchors: [(SettingsScrollAnchor, SettingsCategory)] = [
            (.servers, .servers), (.system, .servers), (.providerQuotas, .providers)
        ]
        for (anchor, category) in anchors {
            XCTAssertEqual(anchor.category, category)
            XCTAssertNil(AppSection(.settings(anchor)))
        }
        XCTAssertNil(AppSection(.providerQuotaWidgetSettings))
    }

    func testEnteringASectionStartsAtItsRoot() {
        var state = SessionNavigationState()
        state.select(.memory)
        state.selectedItem = .memory(.section(.user))
        state.select(.skills)
        XCTAssertNil(state.selectedItem)
        state.select(.memory)
        XCTAssertNil(state.selectedItem)
    }

    /// Regular → compact pushes the page the detail column showed; compact → regular shows the
    /// pushed page beside the list.
    func testLayoutReevaluationKeepsTheRootInnerPageAndChatRevision() {
        var state = SessionNavigationState()
        state.select(.memory)
        state.selectedItem = .memory(.section(.user))
        let before = state
        for size in [CGSize(width: 466, height: 678), CGSize(width: 951, height: 669), CGSize(width: 669, height: 951)] {
            _ = SidebarPresentation(isRegularWidth: size.width > 600, splitSize: size,
                hasVerticalBar: size.width > size.height, storedChoice: true)
            XCTAssertEqual(state, before)
            XCTAssertEqual(state.selectedItem, .memory(.section(.user)))
            XCTAssertEqual(state.chatRootRevision, before.chatRootRevision)
        }
    }

    func testChatPushedFromASectionRemembersTheSessionAndPopsToThatRoot() {
        for section: SessionListUtilityDestination in [.archived, .scheduled, .webhook] {
            let session = SessionSummary(sessionId: "section-chat")
            var state = SessionNavigationState()
            state.select(section)
            let chatRevision = state.chatRootRevision
            state.pushSectionSession(session)
            XCTAssertEqual(state.section, AppSection(section))
            XCTAssertEqual(state.destination, .utility(section))
            XCTAssertEqual(state.selectedSectionSession, session)
            XCTAssertEqual(state.lastSelectedSessionID, session.sessionId)
            XCTAssertEqual(state.chatRootRevision, chatRevision)
            state.selectedSectionSession = nil
            XCTAssertEqual(state.destination, .utility(section))
            XCTAssertNil(state.selectedSectionSession)
            XCTAssertEqual(state.lastSelectedSessionID, session.sessionId)
        }
    }

    func testRemovingTheOpenChatKeepsItsListInTheSidebar() {
        let session = SessionSummary(sessionId: "webhook-chat")
        var state = SessionNavigationState()
        state.select(.webhook)
        state.pushSectionSession(session)
        state.remove(sessionID: "webhook-chat")
        XCTAssertEqual(state.section, .webhook)
        XCTAssertEqual(state.destination, .utility(.webhook))

        var chats = SessionNavigationState()
        chats.select(session)
        chats.remove(sessionID: "webhook-chat")
        XCTAssertEqual(chats.section, .chats)
        XCTAssertNil(chats.destination)
    }

    /// A section's item never outlives its root.
    func testLeavingASectionDropsItsSelectedItem() {
        let session = SessionSummary(sessionId: "chat")
        for leave: (inout SessionNavigationState) -> Void in [
            { $0.clearDestination() },
            { $0.select(session) },
            { $0.select(PendingNewChatRoute()) },
            { $0.select(.kanban) },
        ] {
            var state = SessionNavigationState()
            state.select(.memory)
            state.selectedItem = .memory(.section(.user))
            leave(&state)
            XCTAssertNil(state.selectedItem)
        }
    }

    func testNewChatAndClearingReturnToChats() {
        var state = SessionNavigationState()
        state.select(.memory)
        state.select(PendingNewChatRoute())
        XCTAssertEqual(state.section, .chats)
        state.select(.kanban)
        state.clearDestination()
        XCTAssertEqual(state.section, .chats)
    }

    /// The sidebar leaves the chat at least 320pt and otherwise keeps its 380pt width (TAL-1453).
    func testSidebarIdealWidthLeavesTheChatItsNarrowestTestedWidth() {
        let expected: [(CGFloat, CGFloat)] = [(669, 349), (700, 380), (951, 380), (1194, 380)]
        for (splitWidth, ideal) in expected {
            XCTAssertEqual(RegularSplitLayout.sidebarIdealWidth(splitWidth: splitWidth), ideal, "split \(splitWidth)")
        }
        for splitWidth in stride(from: CGFloat(0), through: 2000, by: 25) {
            let ideal = RegularSplitLayout.sidebarIdealWidth(splitWidth: splitWidth)
            XCTAssertGreaterThanOrEqual(ideal, RegularSplitLayout.sidebarMinWidth, "split \(splitWidth)")
            XCTAssertLessThanOrEqual(ideal, RegularSplitLayout.sidebarMaxWidth, "split \(splitWidth)")
        }
    }

    /// Files hides the sidebar only where that is what fits the inspector beside the chat (TAL-1453).
    func testFilesInspectorHidesTheSidebarOnlyWhereThatMakesRoom() {
        // iPhone Duo inner display, portrait: too narrow even without the sidebar, so Files pushes.
        XCTAssertFalse(RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: 669))
        // iPhone Duo inner display, landscape, and iPad portrait: room only without the sidebar.
        XCTAssertTrue(RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: 951))
        XCTAssertTrue(RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: 834))
        // iPad landscape: room beside the sidebar already.
        XCTAssertFalse(RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: 1194))
    }

    /// The companion page hides the sidebar only where that is what lets the arrangement split (TAL-1458).
    func testCompanionPageHidesTheSidebarOnlyWhereThatMakesRoom() {
        // iPhone Duo inner display, portrait, and iPad portrait: taller than wide, so the page never splits.
        XCTAssertFalse(RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: 669, splitHeight: 951))
        XCTAssertFalse(RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: 834, splitHeight: 1194))
        // iPhone Duo inner display and iPad, landscape: the detail beside the sidebar is taller than wide.
        XCTAssertTrue(RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: 951, splitHeight: 669))
        XCTAssertTrue(RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: 1194, splitHeight: 834))
        // A window wide enough for the sidebar and both pages keeps the sidebar.
        XCTAssertFalse(RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: 1600, splitHeight: 900))
        XCTAssertTrue(RegularSplitLayout.splitsCompanionPage(width: 700, height: 700))
        XCTAssertFalse(RegularSplitLayout.splitsCompanionPage(width: 700, height: 720))
    }

    func testRootReplacementClearsFilesReportsButModalInvalidationPreservesTheRoot() {
        var state = SessionNavigationState()
        let chat = SessionSummary(sessionId: "session-1")
        state.select(chat)
        state.filesInspectorPresented = true
        state.chatShowsFilesInspector = true
        state.chatShowsCompanionPage = true
        _ = state.beginOpen()
        XCTAssertEqual(state.destination, .session(chat))
        state.select(.memory)
        XCTAssertFalse(state.filesInspectorPresented)
        XCTAssertFalse(state.chatShowsFilesInspector)
        XCTAssertFalse(state.chatShowsCompanionPage)
        state.clearDestination()
        XCTAssertNil(state.destination)
    }
}

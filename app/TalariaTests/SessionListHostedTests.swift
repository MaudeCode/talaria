import SwiftData
import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// Overflow priorities must reach real bar items, not just an unused policy table (TAL-478).
@MainActor
final class ToolbarPriorityHostedTests: XCTestCase {
    func testHorizontalWorkBadgesKeepHighPriorityInANarrowChat() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires horizontal work-item priorities") }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        try XCTSkipUnless(scene.traitCollection.verticalBarEdge == .unspecified, "Requires a horizontal toolbar")
        let window = try await hostFixtureChat(
            ["--ui-test-background-updates", "--ui-test-chat-controls"],
            size: CGSize(width: 320, height: HostedSize.duoInner.height)
        ) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try XCTSkipUnless(window.traitCollection.verticalBarEdge == .unspecified, "Requires a horizontal toolbar")
        _ = try await requireElement(in: window, label: "Background tasks · 2")
        try await sendFromComposer("Run the deterministic fixture", in: window)
        _ = try await requireElement(in: window, label: "Waiting for control input.")
        try await sendFromComposer("/queue Queued fixture message", in: window)
        _ = try await requireElement(in: window, label: "1 queued")
        let titles = ["Background tasks", "Queued messages"]
        let ready = await awaitCondition { titles.allSatisfy { HostedAccessibility.toolbarItem($0, in: window) != nil } }
        XCTAssertTrue(ready)
        settle(0.3)
        attachHostedScreenshot(window, name: "narrow-horizontal-work-priorities")
        for title in titles {
            let item = try XCTUnwrap(HostedAccessibility.toolbarItem(title, in: window))
            XCTAssertEqual(item.visibilityPriority, .high, "\(title) must retain priority in a crowded horizontal bar")
        }
        XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Files", in: window)).visibilityPriority, .standard)
    }

    func testHorizontalBarsUseTheApprovedActionPriorities() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires bar-item visibility priorities") }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        try XCTSkipIf(scene.traitCollection.verticalBarEdge != .unspecified, "Covered by native vertical-bar tests")
        for size in [HostedSize.phone, HostedSize.padLandscape] {
            let fixture = try FixtureApp(for: self)
            let window = try hostWindow(fixture.sessionList(), size: size) {
                $0.horizontalSizeClass = size == HostedSize.phone ? .compact : .regular
            }
            try await openSidebar(in: window)
            for title in ["New Chat", "Search", "Settings"] {
                _ = try await requireElement(in: window, label: title)
                XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem(title, in: window)).visibilityPriority,
                    ["New Chat", "Search"].contains(title) ? .init(higherThan: .high) : .high, title)
            }
            XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Filters", in: window)).visibilityPriority, .standard)
            XCTAssertNil(HostedAccessibility.toolbarItem("Select Chats", in: window))
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    private func landscapeScene() async throws -> UIWindowScene {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        try XCTSkipUnless(scene.traitCollection.verticalBarEdge != .unspecified, "Requires the Duo cover's native vertical bar")
        scene.requestGeometryUpdate(.iOS(interfaceOrientations: .landscapeRight))
        let rotated = await awaitCondition { scene.interfaceOrientation == .landscapeRight }
        XCTAssertTrue(rotated)
        addTeardownBlock { @MainActor in
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
            let restored = await self.awaitCondition { scene.interfaceOrientation == .portrait }
            XCTAssertTrue(restored)
        }
        let vertical = await awaitCondition { scene.traitCollection.verticalBarEdge != .unspecified }
        XCTAssertTrue(vertical, "The landscape Duo did not expose its native vertical bar")
        return scene
    }

    func testChatPrioritiesReachTheNativeToolbar() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let fixture = try FixtureApp(["--ui-test-goal"], for: self)
        let session = try await fixture.session()
        let model = ChatViewModel(
            session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
            liveActivityManager: SpyChatLiveActivityManager()
        )
        let activated = await model.submitGoal(args: "status")
        XCTAssertTrue(activated)
        let window = try hostWindow(fixture.chat(session, viewModel: model), size: HostedSize.duoOuterLandscape)
        _ = try await requireElement(in: window, label: "Files")
        let ready = await awaitCondition { HostedAccessibility.toolbarItem("Goal", in: window) != nil }
        XCTAssertTrue(ready, "Items: \(HostedAccessibility.toolbarItems(in: window).map { $0.title ?? $0.accessibilityLabel ?? "?" })")
        attachHostedScreenshot(window, name: "duo-chat-priorities")
        XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Goal", in: window)).visibilityPriority, .high)
        XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Files", in: window)).visibilityPriority, .high)
    }

    /// The vertical bar's badged work items replace their chips above the composer (TAL-1542). The keyboard folds those
    /// items into the bar's overflow menu, so the chips return while the composer is focused.
    func testVerticalBarWorkItemsReplaceTheirComposerChips() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let fixture = try FixtureApp(["--ui-test-background-updates", "--ui-test-chat-controls"], for: self)
        let session = try await fixture.session()
        let model = ChatViewModel(
            session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
            liveActivityManager: SpyChatLiveActivityManager()
        )
        await model.refreshBackgroundTasks()
        await model.dismissBackgroundTask(taskID: "bg-ui")
        XCTAssertEqual(model.pinnedBackgroundTasks.count, 1)
        let window = try hostWindow(fixture.chat(session, viewModel: model), size: HostedSize.duoOuterLandscape)
        let started = await model.sendMessage("Run the deterministic fixture")
        XCTAssertTrue(started)
        _ = try await requireElement(in: window, label: "Stop response")
        try await sendFromComposer("/queue First queued message", in: window)
        try await sendFromComposer("/queue Second queued message", in: window)
        let badged = await awaitCondition {
            HostedAccessibility.toolbarItem("Background tasks", in: window)?.badge?.stringValue == "1"
                && HostedAccessibility.toolbarItem("Queued messages", in: window)?.badge?.stringValue == "2"
        }
        XCTAssertTrue(badged, "Items: \(HostedAccessibility.toolbarItems(in: window).map { $0.title ?? $0.accessibilityLabel ?? "?" })")
        _ = try await requireElement(in: window, label: "2 queued")
        window.endEditing(true)
        let stepped = await awaitNoElement(in: window) {
            $0.accessibilityLabel == "Background tasks · 1" || $0.accessibilityLabel == "2 queued"
        }
        settle(0.3)
        attachHostedScreenshot(window, name: "duo-work-items-without-chips")
        XCTAssertTrue(stepped, "The bar already shows background tasks and queued messages")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Message"))
        _ = try await requireElement(in: window, label: "Background tasks · 1")
        _ = try await requireElement(in: window, label: "2 queued")
        settle(0.3)
        attachHostedScreenshot(window, name: "duo-work-chips-while-typing")
        _ = await model.cancelActiveStream()
    }

    /// A badge cannot say "Outcome unknown", so that chip stays beside the vertical bar until the input settles.
    func testVerticalBarKeepsTheUnknownOutcomeChip() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let window = try await hostFixtureChat([UITestFixtureURLProtocol.ownerChatArgument], size: HostedSize.duoOuterLandscape)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Outcome unknown"))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Discard"))
        let reduced = await awaitCondition {
            HostedAccessibility.toolbarItem("Queued messages", in: window)?.badge?.stringValue == "1"
        }
        XCTAssertTrue(reduced, "Discard must reduce the owner queue badge")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Done"))
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed)
        let gone = await awaitNoElement(in: window) { $0.accessibilityLabel == "1 queued" || $0.accessibilityLabel == "Outcome unknown" }
        XCTAssertTrue(gone, "A settled queue shows only the bar's badge")
    }

    /// Only a split view's detail column moves into the vertical bar, so beside one the sidebar's actions join the detail
    /// column instead of keeping a horizontal row over the list (TAL-1528).
    func testSidebarActionsJoinTheDetailColumnBesideTheVerticalBar() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList(), size: HostedSize.duoInnerLandscape) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        let row = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true }
        HostedAccessibility.activate(row)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        try await openSidebar(in: window)
        let split = try XCTUnwrap(HostedAccessibility.splitViewController(under: window.rootViewController))
        let sidebar = try XCTUnwrap(split.viewController(for: .primary))
        let detail = try XCTUnwrap(split.viewController(for: .secondary))
        func titles(under column: UIViewController) -> Set<String> {
            Set(HostedAccessibility.toolbarItems(under: column).compactMap { $0.title ?? $0.accessibilityLabel })
        }
        let moved = await awaitCondition { Set(["Sidebar", "New Chat", "Notifications", "Settings"]).isSubset(of: titles(under: detail)) }
        XCTAssertTrue(moved, "detail=\(titles(under: detail)), sidebar=\(titles(under: sidebar))")
        XCTAssertTrue(titles(under: sidebar).contains("Search"))
        XCTAssertTrue(titles(under: sidebar).contains("Filters"))
        XCTAssertTrue(titles(under: sidebar).isDisjoint(with: ["New Chat", "Settings", "Notifications"]))
        attachHostedScreenshot(window, name: "duo-inner-toolbar-ownership")
    }

    func testChatMoreFoldsBeforeTheBellOnDuoInnerLandscape() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList(), size: HostedSize.duoInnerLandscape) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        func moreItem() -> UIBarButtonItem? {
            HostedAccessibility.toolbarItems(in: window).first { $0.accessibilityIdentifier == "chat-session-actions-more" }
        }
        let ready = await awaitCondition { moreItem() != nil }
        XCTAssertTrue(ready)
        let more = try XCTUnwrap(moreItem())
        let bell = try XCTUnwrap(HostedAccessibility.toolbarItem("Notifications", in: window))
        XCTAssertEqual(more.visibilityPriority, .low)
        XCTAssertEqual(bell.visibilityPriority, .init(higherThan: .high))
        XCTAssertLessThan(more.visibilityPriority.rawValue, bell.visibilityPriority.rawValue)
        _ = try await requireElement(in: window, label: "Notifications")
    }

    func testChatsPrioritiesReachTheNativeToolbar() async throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("Requires the vertical-bar SDK") }
        _ = try await landscapeScene()
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList(), size: HostedSize.duoOuterLandscape)
        _ = try await requireElement(in: window, label: "Notifications")
        XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Notifications", in: window)).visibilityPriority, .init(higherThan: .high))
        try await openSidebar(in: window)
        for title in ["New Chat", "Search", "Settings", "Close navigation"] {
            _ = try await requireElement(in: window, label: title)
            XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem(title, in: window)).visibilityPriority,
                    ["New Chat", "Search"].contains(title) ? .init(higherThan: .high) : .high, title)
        }
        XCTAssertEqual(try XCTUnwrap(HostedAccessibility.toolbarItem("Filters", in: window)).visibilityPriority, .standard)
        XCTAssertNil(HostedAccessibility.toolbarItem("Select Chats", in: window))
        attachHostedScreenshot(window, name: "duo-sidebar-priorities")
    }
}

/// The Chats list and a reopened chat, hosted in process against the UI fixture (TAL-856): the row actions and the
/// selection bar a user reaches, and what a reopen or relaunch paints from the offline cache before the server answers.
/// The row swipe that reveals Archive is a system gesture; the phone check covers it (`app/docs/phone-checks.md`).
@MainActor
final class SessionListHostedTests: XCTestCase {
    private let sessionTitle = UITestFixtureURLProtocol.sessionTitle

    private func isFixtureRow(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.hasPrefix(sessionTitle) == true
    }

    private func isSettingsAvatar(_ element: NSObject) -> Bool {
        // The hidden navigation drawer also has a Settings row.
        element.accessibilityLabel == "Settings" &&
            element.accessibilityHint == "Long press to switch servers."
    }

    func testSettingsAvatarJoinsTheDuoVerticalToolbar() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] == "iPhone19,4",
            "Requires the iPhone Duo simulator's native vertical toolbar"
        )
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let panel = scene.screen.nativeBounds.size
        let viewport = scene.coordinateSpace.bounds.size
        let cover = [HostedSize.duoOuter.width, HostedSize.duoOuter.height].sorted()
        try XCTSkipUnless(
            [panel.width, panel.height].sorted() == cover.map { $0 * scene.screen.nativeScale } &&
                [viewport.width, viewport.height].sorted() == cover,
            "Requires the active iPhone Duo outer display; close and verify the Duo posture before running"
        )
        let fixture = try FixtureApp(for: self)
        addTeardownBlock { @MainActor in
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait))
            let restored = await self.awaitCondition { scene.interfaceOrientation == .portrait }
            XCTAssertTrue(restored, "Portrait must be restored before the next hosted test starts")
        }
        for orientation: UIInterfaceOrientationMask in [.portrait, .landscapeRight] {
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: orientation))
            let rotated = await awaitCondition {
                orientation == .portrait ? scene.interfaceOrientation == .portrait : scene.interfaceOrientation == .landscapeRight
            }
            XCTAssertTrue(rotated, "The native scene must reach the requested orientation")
            let window = try hostWindow(fixture.sessionList(), size: scene.coordinateSpace.bounds.size)
            try await openSidebar(in: window)
            _ = try await requireElement(in: window, where: isSettingsAvatar)
            _ = try await requireElement(in: window, label: "Close navigation")
            // SwiftUI can publish toolbar accessibility before its native axis transition settles.
            _ = await awaitCondition {
                guard let settings = HostedAccessibility.elements(in: window).first(where: self.isSettingsAvatar),
                      let notifications = HostedAccessibility.element(in: window, label: "Close navigation") else { return false }
                return abs(settings.accessibilityFrame.midX - notifications.accessibilityFrame.midX) <= 1
            }
            let settings = try XCTUnwrap(HostedAccessibility.elements(in: window).first(where: isSettingsAvatar))
            let notifications = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Close navigation"))
            attachHostedScreenshot(window, name: orientation == .portrait ? "duo-settings-portrait" : "duo-settings-landscape")
            XCTAssertEqual(settings.accessibilityFrame.midX, notifications.accessibilityFrame.midX, accuracy: 1,
                "Settings must share the vertical bar with the drawer toggle instead of keeping a horizontal bar")
            XCTAssertGreaterThan(abs(settings.accessibilityFrame.midY - notifications.accessibilityFrame.midY), 20)
            XCTAssertEqual(settings.accessibilityHint, "Long press to switch servers.")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testCenteredStatesUseTheTrailingAndBottomPanes() throws {
        let size = CGSize(width: 900, height: 900)
        for (name, fold, center) in [
            ("book", CGRect(x: 430, y: 0, width: 40, height: 900), CGPoint(x: 685, y: 450)),
            ("tabletop", CGRect(x: 0, y: 330, width: 900, height: 40), CGPoint(x: 450, y: 635))
        ] {
            var geometry = DivisionRegionGeometry()
            geometry.frame = CGRect(origin: .zero, size: size)
            geometry.divisions = [fold]
            let window = try hostWindow(
                Button("Try Again") {}.foldAvoidingPlacement().ignoresSafeArea()
                    .environment(\.divisionRegionGeometry, geometry), size: size)
            let button = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Try Again"))
            let frame = window.convert(button.accessibilityFrame, from: nil)
            XCTAssertEqual(frame.midX, center.x, accuracy: 1)
            XCTAssertEqual(frame.midY, center.y, accuracy: 1)
            XCTAssertFalse(frame.intersects(fold))
            attachHostedScreenshot(window, name: "centered-state-\(name)")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testSettingsAvatarOpensSettings() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, where: isSettingsAvatar))
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-user-profile"
        }
    }

    func testResizingAnOpenOverlayIntoTilingConsumesDrawerIntentAndRotationCollapsesTheColumn() async throws {
        let fixture = try FixtureApp(for: self)
        UserDefaults.standard.set("all", forKey: SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey)
        let window = try hostWindow(fixture.sessionList(), size: CGSize(width: 850, height: 669)) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        _ = try await requireElement(in: window, label: "Close navigation")
        window.frame.size = HostedSize.duoInnerLandscape
        window.layoutIfNeeded()
        let tiled = await awaitCondition {
            HostedAccessibility.splitViewController(under: window.rootViewController)?.displayMode == .oneBesideSecondary
        }
        XCTAssertTrue(tiled, "An open overlay must not suppress a tiled column after resize")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Close navigation"))
        XCTAssertEqual(UserDefaults.standard.string(forKey: SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey), "all")
        window.frame.size = HostedSize.duoInner
        window.layoutIfNeeded()
        let collapsed = await awaitCondition {
            HostedAccessibility.splitViewController(under: window.rootViewController)?.displayMode == .secondaryOnly
        }
        XCTAssertTrue(collapsed, "Portrait must collapse the native primary column, including a late UIKit report")
        try await openSidebar(in: window)
        XCTAssertEqual(HostedAccessibility.splitViewController(under: window.rootViewController)?.displayMode, .secondaryOnly)
        window.frame.size = HostedSize.duoInnerLandscape
        window.layoutIfNeeded()
        let restored = await awaitCondition {
            HostedAccessibility.splitViewController(under: window.rootViewController)?.displayMode == .oneBesideSecondary
        }
        XCTAssertTrue(restored)
    }

    func testSidebarLayoutRejectsTransientDimensionsBeforePresentation() {
        let size = HostedSize.duoInnerLandscape
        var valid = SidebarLayoutInputs()
        valid.sizeClass = .regular
        valid.splitSize = size
        valid.geometry.frame = CGRect(origin: .zero, size: size)
        XCTAssertTrue(valid.isValid)
        // Exercise the admission input, not a zero-sized live UIKit split window.
        for dimension in [CGFloat.zero, -1] {
            for usesWidth in [false, true] {
                var split = valid
                if usesWidth { split.splitSize.width = dimension }
                else { split.splitSize.height = dimension }
                XCTAssertFalse(split.isValid)
                var geometry = valid
                if usesWidth { geometry.geometry.frame.size.width = dimension }
                else { geometry.geometry.frame.size.height = dimension }
                XCTAssertFalse(geometry.isValid)
            }
        }
        valid.sizeClass = nil
        XCTAssertFalse(valid.isValid)
    }

    func testForegroundReturnPreservesTheSettledColumnChoice() async throws {
        for isOpen in [false, true] {
            let fixture = try FixtureApp(for: self)
            UserDefaults.standard.set(isOpen ? "all" : "detailOnly", forKey: SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey)
            let scene = HostedScenePhase()
            let size = HostedSize.duoInnerLandscape
            let window = try hostWindow(ScenePhasedSessionList(fixture: fixture, scene: scene), size: size) {
                $0.horizontalSizeClass = .regular
                $0.verticalSizeClass = .regular
            }
            let ready = await awaitCondition {
                guard let split = HostedAccessibility.splitViewController(under: window.rootViewController) else { return false }
                return isOpen ? split.displayMode == .oneBesideSecondary : split.displayMode == .secondaryOnly
            }
            XCTAssertTrue(ready)
            let split = try XCTUnwrap(HostedAccessibility.splitViewController(under: window.rootViewController))
            let original = split.displayMode
            scene.phase = .background
            settle()
            scene.phase = .active
            settle(0.5)
            XCTAssertEqual(split.displayMode, original)
            XCTAssertEqual(UserDefaults.standard.string(forKey: SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey), isOpen ? "all" : "detailOnly")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testExplicitNewChatWaitsForSendAndFilesCreatesOnDemand() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))
        _ = try await requireElement(in: window, label: "Select model")
        try await typeIntoComposer("Unsent draft", in: window)
        try await openSidebar(in: window)
        let compose = try await requireElement(in: window, label: "New Chat")
        XCTAssertFalse(compose.accessibilityTraits.contains(.notEnabled))
        XCTAssertTrue(HostedAccessibility.activate(compose))
        let restored = await awaitCondition { self.composerDraftText(in: window) == "Unsent draft" }
        XCTAssertTrue(restored)
        func creates() -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session/new" }.count }
        }
        XCTAssertEqual(creates(), 0)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Starting chat…"))
        XCTAssertNil(HostedAccessibility.toolbarItem("New Chat", in: window), "An empty chat needs no detail compose item")
        let files = try await requireElement(in: window, label: "Files")
        XCTAssertTrue(HostedAccessibility.activate(files))
        _ = try await requireElement(in: window, label: "Search files")
        XCTAssertEqual(creates(), 1)
        XCTAssertEqual(UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/chat/start" }.count }, 0)
    }

    func testSectionPushedChatKeepsNotificationsAtBothWidths() async throws {
        for size in [HostedSize.phone, HostedSize.padLandscape] {
            let fixture = try FixtureApp(["--ui-test-scheduled-sessions"], for: self)
            let window = try hostWindow(fixture.sessionList(), size: size) {
                $0.horizontalSizeClass = size == HostedSize.phone ? .compact : .regular
            }
            let rootBell = await awaitCondition { HostedAccessibility.toolbarItem("Notifications", in: window) != nil }
            XCTAssertTrue(rootBell, "The root must have its notifications toolbar button")
            try await openSidebar(in: window)
            HostedAccessibility.activate(try await requireElement(in: window, label: "Expand scheduled sessions"))
            HostedAccessibility.activate(try await requireElement(in: window, label: "View all"))
            if size == HostedSize.phone {
                _ = try await requireElement(in: window, label: "Open navigation")
            } else {
                let sidebar = try XCTUnwrap(HostedAccessibility.toolbarItem("Sidebar", in: window))
                XCTAssertTrue(HostedAccessibility.activate(sidebar))
            }
            HostedAccessibility.activate(try await requireElement(in: window, where: isFixtureRow))
            _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
            let pushedBell = await awaitCondition { HostedAccessibility.toolbarItem("Notifications", in: window) != nil }
            XCTAssertTrue(pushedBell, "The section-pushed chat must keep its notifications toolbar button")
            XCTAssertNil(HostedAccessibility.toolbarItem("New Chat", in: window))
            XCTAssertNil(HostedAccessibility.toolbarItem("Settings", in: window))
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testSidebarSectionIsARootAndSettingsIsAModalOverIt() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Insights"))
        _ = try await requireElement(in: window, label: "Open navigation")
        func stacks() -> [UINavigationController] {
            var pending = window.rootViewController.map { [$0] } ?? []
            var result: [UINavigationController] = []
            while let current = pending.popLast() {
                if let nav = current as? UINavigationController { result.append(nav) }
                pending += current.children
            }
            return result
        }
        XCTAssertTrue(stacks().allSatisfy { $0.viewControllers.count == 1 }, "A sidebar section must not push over the previous chat")
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, where: isSettingsAvatar))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        let presented = await presentedController(in: window)
        XCTAssertNotNil(presented)
        _ = try await requireElement(in: window, label: "Close")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Appearance"))
        _ = try await requireElement(in: window, label: "Close", "Pushed Settings pages must retain Close")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Close"))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed)
        // Settings reopens its invoking panel; dismissing it reveals the unchanged Insights root.
        _ = try await requireElement(in: window, label: "Close navigation")
        let close = try XCTUnwrap(HostedAccessibility.toolbarItem("Close navigation", in: window))
        XCTAssertTrue(HostedAccessibility.activate(close))
        _ = try await requireElement(in: window, label: "Open navigation")
        XCTAssertTrue(stacks().allSatisfy { $0.viewControllers.count == 1 })
    }

    func testSessionDeepLinkDismissesSettingsAndSettingsLinksRetargetItsModalAtBothWidths() async throws {
        for size in [HostedSize.phone, HostedSize.padLandscape] {
            let fixture = try FixtureApp(for: self)
            let window = try hostWindow(fixture.sessionList(), size: size)
            try await openSidebar(in: window)
            HostedAccessibility.activate(try await requireElement(in: window, where: isSettingsAvatar))
            _ = try await requireElement(in: window, label: "Close")
            let presented = await presentedController(in: window)
            let modal = try XCTUnwrap(presented)
            fixture.opensQuotaWidgetSettings = true
            let consumed = await awaitCondition { !fixture.opensQuotaWidgetSettings }
            XCTAssertTrue(consumed)
            _ = try await requireElement(in: window, label: "Close")
            let retargeted = await presentedController(in: window)
            XCTAssertTrue(retargeted === modal, "A Settings link must retarget the current modal")
            fixture.pendingSessionID = UITestFixtureURLProtocol.sessionID
            let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
            XCTAssertTrue(dismissed, "A session route must not land behind Settings")
            _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
            XCTAssertNil(fixture.pendingSessionID)
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testSidebarToolbarHasNoNestedMoreMenu() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        _ = try await requireElement(in: window, label: "Filters")
        func assertNoMore(_ menu: UIMenu, file: StaticString = #filePath, line: UInt = #line) {
            XCTAssertNotEqual(menu.title, "More", file: file, line: line)
            for child in menu.children {
                if let nested = child as? UIMenu { assertNoMore(nested, file: file, line: line) }
            }
        }
        for item in HostedAccessibility.toolbarItems(in: window) {
            XCTAssertNotEqual(item.title, "More")
            if let menu = item.menu { assertNoMore(menu) }
        }
    }

    func testPendingPinIsVisibleBeforeTheServerAnswers() async throws {
        let arrived = expectation(description: "pin request held")
        let state = HeldRowMutationProtocol.State()
        HeldRowMutationProtocol.state = state
        state.onPin = { arrived.fulfill() }
        defer { HeldRowMutationProtocol.state = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [HeldRowMutationProtocol.self]
        let server = URL(string: "https://pending-row.test")!
        let viewModel = SessionListViewModel(server: server, client: APIClient(baseURL: server, session: URLSession(configuration: configuration)))
        _ = await viewModel.load()
        let session = try XCTUnwrap(viewModel.sessions.first)
        let actions = fixtureRowActions
        let window = try hostWindow(ObservedSessionRow(viewModel: viewModel, actions: actions))
        let before = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        before.name = "pending-pin-before"
        before.lifetime = .keepAlways
        add(before)
        let pin = Task { await viewModel.setPinned(true, for: session) }
        await fulfillment(of: [arrived], timeout: 5)
        let pending = await awaitElement(in: window) { $0.accessibilityLabel?.contains(", Pinned") == true }
        XCTAssertNotNil(pending, "The row must display the submitted pin while the write is unresolved")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains { $0.contains("Pending:") })
        let after = XCTAttachment(image: UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        })
        after.name = "pending-pin-after"
        after.lifetime = .keepAlways
        add(after)
        XCTAssertNotEqual(viewModel.sessions.first?.pinned, true, "The pending pin must not change canonical grouping")
        state.answerPin()
        _ = await pin.value
        let cleared = await awaitNoElement(in: window) { $0.accessibilityLabel?.contains("Pending: Pin") == true }
        XCTAssertTrue(cleared)
        XCTAssertEqual(viewModel.sessions.first?.pinned, true)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first { $0.accessibilityLabel?.contains(", Pinned") == true })
    }

    /// Archiving a chat removes it and offers Undo, which restores it from the server (TAL-443).
    func testUndoRestoresAnArchivedChat() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-archive-undo"], for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        let rowFound = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(rowFound, "Missing deterministic session fixture")
        let archive = try XCTUnwrap(
            row.accessibilityCustomActions?.first { $0.name == "Archive" },
            "The row offers no Archive action"
        )
        XCTAssertTrue(archive.actionHandler?(archive) ?? false, "Archive did not run")

        _ = try await requireElement(in: window, label: "Chat archived", "Archiving did not offer Undo")
        let archived = await awaitNoElement(in: window, timeout: 3, where: isFixtureRow)
        XCTAssertTrue(archived, "The archived chat stayed in the list")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Undo"))
        let restored = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(restored, "Undo did not restore the chat")
        let toastGone = await awaitNoElement(in: window, timeout: 5) { $0.accessibilityLabel == "Chat archived" }
        XCTAssertTrue(toastGone, "The toast stayed after Undo")
    }

    /// Select Chats picks rows, then one confirmed Delete removes them and ends the mode (TAL-627).
    func testSelectingChatsAndDeletingThemEndsSelectChats() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        let row = try await requireElement(in: window, where: isFixtureRow)
        let select = try XCTUnwrap(row.accessibilityCustomActions?.first { $0.name == "Select Chats…" },
            "The session context menu offers no Select Chats action")
        XCTAssertTrue(select.actionHandler?(select) ?? false)
        for title in ["Fixture Session 01", "Fixture Session 02"] {
            let rowFound = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix(title) == true }
            HostedAccessibility.activate(try XCTUnwrap(rowFound, title))
        }
        _ = try await requireElement(in: window, label: "2 selected")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Delete"))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented, "Delete asked for no confirmation")
        XCTAssertEqual(alert.title, "Delete 2 Chats?")
        XCTAssertTrue(HostedAccessibility.tap("Delete", in: alert), "The confirmation offers no Delete")

        let ended = await awaitNoElement(in: window) { $0.accessibilityLabel == "2 selected" }
        XCTAssertTrue(ended, "Select Chats kept its selection after every chat was deleted")
        _ = try await requireElement(in: window, "Select Chats did not end once every selected chat was deleted") {
            self.isFixtureRow($0) && $0.accessibilityCustomActions?.contains { $0.name == "Select Chats…" } == true
        }
    }

    /// A relaunch paints the chats the App saw last time before `/api/sessions` answers (TAL-437): a second list on the
    /// first one's cache, with the server's answer held.
    func testRelaunchShowsTheLastChatsBeforeTheServerAnswers() async throws {
        let fixture = try FixtureApp(for: self)
        let first = try hostWindow(fixture.sessionList())
        try await openSidebar(in: first)
        let cached = await awaitElement(in: first, where: isFixtureRow)
        XCTAssertNotNil(cached, "Missing deterministic session fixture")
        attachHostedScreenshot(first, name: "session-cache-before-repeat-refresh")
        // Exercise the incremental writer and foreground cleanup in the real build before
        // reopening offline. Neither may lose the last server-selected rows or their order.
        let sessions = try await fixture.client.sessions().sessions ?? []
        try CacheStore.cacheSessions(sessions, serverURL: UITestFixtureEnvironment.serverURL,
            in: fixture.cache.mainContext)
        try CacheStore.maintainCache(in: fixture.cache.mainContext)
        let restoreTarget = try await requireElement(in: first, where: isFixtureRow)
        XCTAssertTrue(HostedAccessibility.activate(restoreTarget))
        _ = try await requireElement(in: first, where: FixtureApp.isLoadedTranscriptRow)
        first.isHidden = true

        FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument)
        let relaunched = try hostWindow(fixture.sessionList())
        _ = try await requireElement(in: relaunched, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertNil(HostedAccessibility.element(in: relaunched, label: "Send a message to start the conversation."))
        try await openSidebar(in: relaunched)
        let painted = await awaitElement(in: relaunched, where: isFixtureRow)
        XCTAssertNotNil(painted, "The relaunch did not show the last chats before /api/sessions answered")
        attachHostedScreenshot(relaunched, name: "session-cache-after-repeat-refresh-offline")
        fixture.releaseHeldLoads()
    }

    func testLaunchCacheMissStaysNewChatAfterTheListAnswers() async throws {
        let fixture = try FixtureApp(for: self)
        SessionNavigationPersistence.save("unknown-cached-id", for: UITestFixtureEnvironment.serverURL)
        let window = try hostWindow(fixture.sessionList())
        _ = try await requireElement(in: window, label: "Send a message to start the conversation.")
        let loaded = await awaitCondition {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains("/api/sessions") }
        }
        XCTAssertTrue(loaded)
        settle(0.5)
        _ = try await requireElement(in: window, label: "Send a message to start the conversation.")
        XCTAssertEqual(UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session/new" }.count }, 0)
    }

    /// Reopening a chat paints its cached transcript and shows "Syncing messages" until the server answers, and no
    /// stream status competes with it (TAL-436).
    func testReopenedChatShowsSyncingUntilTheServerAnswers() async throws {
        let fixture = try FixtureApp(["--ui-test-hold-transcript-reloads"], for: self)
        let session = try await fixture.session()
        let first = try hostWindow(fixture.chat(session))
        let loaded = await awaitElement(in: first, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertNotNil(loaded, "The chat's first load never answered")
        first.isHidden = true

        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server", "The reopened chat never showed Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is checking the response stream"), "Checking stream competed with Syncing messages")
        XCTAssertNil(HostedAccessibility.element(in: reopened, label: "Hermes is reconnecting the response stream"), "Reconnecting stream competed with Syncing messages")

        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced, "Syncing messages stayed after the server answered")
    }

    func testReopenedToolHeavyChatPaintsItsCompleteRecentWindowWhileDetailIsHeld() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdTranscriptReloadsArgument], for: self)
        let session = try await fixture.session()
        // Consume the fixture's first detail; every subsequent detail stays held until release.
        _ = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let body = try ChatViewModelSendTests.toolHeavyRecentSessionJSON()
        let detail = try XCTUnwrap(decoder.decode(SessionResponse.self, from: Data(body.utf8)).session)
        // The legacy cache exercises the old raw-row crop in the same real build.
        try CacheStore.cacheMessages(
            detail.messages ?? [], serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext
        )
        let legacyWindow = try CacheStore.cachedTranscriptWindow(
            serverURL: UITestFixtureEnvironment.serverURL, sessionID: UITestFixtureURLProtocol.sessionID,
            in: fixture.cache.mainContext
        )
        XCTAssertEqual(legacyWindow.messages, Array((detail.messages ?? []).suffix(50)))
        XCTAssertEqual(legacyWindow.messagesOffset, 0)
        XCTAssertNil(legacyWindow.recentMessagesOffset)
        let legacy = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: legacy, label: "Syncing messages with the server")
        _ = try await requireElement(in: legacy, label: "Recent answer 24")
        attachHostedScreenshot(legacy, name: "legacy-cache-before-sync-phone")
        legacy.isHidden = true
        legacy.rootViewController = nil

        try CacheStore.cacheMessages(
            detail.messages ?? [], serverURL: UITestFixtureEnvironment.serverURL,
            sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext,
            messagesOffset: detail.messagesOffset, hasOlderMessages: detail.messagesTruncated == true
        )
        let recentWindow = try CacheStore.cachedTranscriptWindow(
            serverURL: UITestFixtureEnvironment.serverURL, sessionID: UITestFixtureURLProtocol.sessionID,
            in: fixture.cache.mainContext
        )
        XCTAssertEqual(recentWindow.messages, detail.messages)
        XCTAssertEqual(recentWindow.messagesOffset, 200)
        XCTAssertEqual(recentWindow.recentMessagesOffset, 200)
        XCTAssertTrue(recentWindow.hasOlderMessages)
        let reopened = try hostWindow(fixture.chat(session))
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        _ = try await requireElement(in: reopened, label: "Recent answer 24")
        let observer = try XCTUnwrap(reopened.firstView(ofType: ChatScrollObserver.ObserverView.self))
        let position = try XCTUnwrap(observer.coordinator?.scrollPositionController)
        var ancestor = observer.superview
        while ancestor != nil, !(ancestor is UIScrollView) { ancestor = ancestor?.superview }
        let recentScroll = try XCTUnwrap(ancestor as? UIScrollView)
        let settled = await awaitCondition { !position.isPreservingPosition }
        XCTAssertTrue(settled)
        position.onHoldAnchor?(ChatTranscriptView.containerID(for: "transcript:200"), .top)
        let oldestIsVisible = await awaitCondition {
            guard let question = HostedAccessibility.element(in: reopened, label: "Recent question 0") else { return false }
            return question.accessibilityFrame.intersects(recentScroll.convert(recentScroll.bounds, to: nil))
        }
        XCTAssertTrue(oldestIsVisible, "The first server row must remain reachable in the cached window before reconciliation")
        _ = try await requireElement(in: reopened, label: "Syncing messages with the server")
        attachHostedScreenshot(reopened, name: "recent-window-before-sync-phone")
        fixture.releaseHeldLoads()
        let synced = await awaitNoElement(in: reopened) { $0.accessibilityLabel == "Syncing messages with the server" }
        XCTAssertTrue(synced)
    }

    /// A server that reports the Agent's `state.db` as corrupt gets one notice above the Chats list that VoiceOver
    /// reads with the server's reason (TAL-830).
    func testChatsListShowsTheServersCorruptAgentStorageNotice() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.corruptAgentStorageArgument], for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)

        let found = await awaitElement(in: window) { $0.accessibilityLabel?.hasPrefix("Agent session storage is damaged") == true }
        let notice = try XCTUnwrap(found, "No storage notice. Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertTrue(
            notice.accessibilityLabel?.contains(UITestFixtureEnvironment.corruptAgentStorageReason) == true,
            "VoiceOver does not read the server's reason: \(notice.accessibilityLabel ?? "nil")"
        )
        XCTAssertEqual(HostedAccessibility.elements(in: window, labelContaining: "Agent session storage").count, 1)
    }

    /// Healthy storage shows no notice (TAL-830).
    func testChatsListShowsNoStorageNoticeWhenTheServerReportsOK() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        let listed = await awaitElement(in: window, where: isFixtureRow)
        XCTAssertNotNil(listed, "Missing deterministic session fixture")

        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "Agent session").isEmpty)
        XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "hermes-agent").isEmpty)
    }

    /// Each degraded state reads its own notice with the server's reason, and `ok` or no state shows none (TAL-830).
    func testAgentStorageBannerReadsEachDegradedState() throws {
        let notices: [(AgentStorage.State, String)] = [
            (.corrupt, "Agent session storage is damaged"),
            (.unavailable, "Agent sessions could not be read"),
            (.outdated, "Upgrade hermes-agent to list sessions"),
        ]
        for (state, title) in notices {
            let window = try hostWindow(AgentStorageBanner(storage: AgentStorage(state: state, reason: "Synthetic reason")))
            let labels = HostedAccessibility.labels(in: window)
            XCTAssertEqual(labels.count, 1, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.hasPrefix(title) == true, "\(state): \(labels)")
            XCTAssertTrue(labels.first?.contains("Synthetic reason") == true, "\(state): \(labels)")
        }
        for storage in [AgentStorage(state: .ok, reason: nil), nil] {
            let window = try hostWindow(AgentStorageBanner(storage: storage))
            XCTAssertEqual(HostedAccessibility.labels(in: window), [], "\(String(describing: storage))")
        }
    }

    /// A New Chat whose session fails to start says so in its composer, with Send off, and Retry starts it (TAL-636).
    func testNewChatReportsAFailedStartInItsComposerAndRetries() async throws {
        let fixture = try FixtureApp(["--ui-test-refuse-first-session-creation"], for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))
        XCTAssertEqual(UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session/new" }.count }, 0)
        try await sendFromComposer("Synthetic first prompt", in: window)

        let retry = try await requireElement(in: window, label: "Retry", "The composer does not offer Retry after a failed start")
        let send = HostedAccessibility.element(in: window, label: "Send")
        XCTAssertTrue(send?.accessibilityTraits.contains(.notEnabled) ?? true, "Send is enabled before the chat started")
        HostedAccessibility.activate(retry)
        _ = try await requireElement(in: window, label: "Select model", "Retry did not start the chat")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"))
    }

    func testUnconfirmedCreationDoesNotOfferNonIdempotentRetry() async throws {
        let fixture = try FixtureApp(["--ui-test-fail-first-session-creation"], for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "New Chat"))
        XCTAssertEqual(UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/session/new" }.count }, 0)
        try await sendFromComposer("Synthetic first prompt", in: window)
        let resolved = await awaitCondition {
            HostedAccessibility.elements(in: window).contains {
                $0.accessibilityLabel == "Retry" || $0.accessibilityLabel?.contains("Check Chats") == true
            }
        }
        XCTAssertTrue(resolved, "The creation result must have reached its failure strip")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Retry"), "A lost creation result cannot safely create another session")
    }

    func testFirstSendConsumesDraftAndShowsOneRowWhileCreationIsHeld() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: false)
    }

    /// TAL-1045: a chat New Chat started in Safe Mode takes on the server's created session: its header leads with the
    /// frozen mode, and its attached owner takes the first message.
    func testANewSafeModeChatShowsItsServerModeAndTakesInput() async throws {
        let fixture = try FixtureApp([], for: self)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let created = try decoder.decode(SessionResponse.self, from: Data(try executionModesFixture("created").utf8))
        let detail = try XCTUnwrap(created.session)
        let window = try hostWindow(NavigationStack {
            ChatView(
                session: SessionSummary(title: "New Chat"),
                server: UITestFixtureEnvironment.serverURL,
                onAPIError: { _ in },
                loadsInitialMessages: false,
                draftStore: fixture.environment.draftStore,
                startSession: { .started(SessionSummary(from: detail), detail: detail) }
            )
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))

        try await sendFromComposer("Safe mode first prompt", in: window)
        let header = await awaitElement(in: window) { ($0.accessibilityLabel ?? "").contains("Safe Mode") }
        XCTAssertNotNil(header, "The header shows the mode the server froze")
        let started = await awaitNoElement(in: window) { $0.accessibilityLabel == "Starting chat…" }
        XCTAssertTrue(started)
        XCTAssertNil(HostedAccessibility.element(in: window, label: "This session is read-only."), "The attached owner takes input")
        settle(0.3)
        attachHostedScreenshot(window, name: "safe-mode-new-chat-phone")
    }

    func testFirstSendKeepsImportedFilesDurableUntilTheServerAccepts() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true)
    }

    func testFirstSendWaitsForEveryImportedFileBeforePosting() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: true, partialImportFailure: true)
    }

    func testPendingSlashCommandWaitsForCreationBeforeStartingChat() async throws {
        try await assertFirstSendDuringCreation(withImportedFile: false, pendingSlash: true)
    }

    private func assertFirstSendDuringCreation(withImportedFile: Bool, partialImportFailure: Bool = false, pendingSlash: Bool = false) async throws {
        let submittedDraft = pendingSlash ? "/queue hello" : "First pending prompt"
        let message = pendingSlash ? "hello" : submittedDraft
        var scenario = withImportedFile || pendingSlash ? ["--ui-test-hold-chat-start"] : []
        if partialImportFailure { scenario.append("--ui-test-fail-first-upload") }
        let fixture = try FixtureApp(scenario, for: self)
        let session = try await fixture.session()
        let filenames = partialImportFailure ? ["first-fails.txt", "later-succeeds.txt"] : (withImportedFile ? ["intent.txt"] : [])
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationCount = 0
        let window = try hostWindow(NavigationStack {
            ChatView(
                session: SessionSummary(title: "New Chat"),
                server: UITestFixtureEnvironment.serverURL,
                onAPIError: { _ in },
                initialAttachments: filenames.map {
                    SharedAttachmentImport(filename: $0, typeIdentifier: "public.plain-text", data: Data("Synthetic file".utf8))
                },
                loadsInitialMessages: false,
                draftStore: fixture.environment.draftStore,
                startSession: {
                    creationCount += 1
                    return await withCheckedContinuation { creation = $0 }
                }
            )
        }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
        defer { creation?.resume(returning: .failed("Test ended")) }
        XCTAssertNil(creation, "Appearance must not create a session")
        XCTAssertEqual(creationCount, 0)
        try await typeIntoComposer(submittedDraft, in: window)
        let send = try await requireElement(in: window, label: "Send")
        XCTAssertFalse(send.accessibilityTraits.contains(.notEnabled), "Send must accept local intent during creation")
        HostedAccessibility.activate(send)
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        if withImportedFile {
            window.endEditing(true)
            _ = try await requireElement(in: window, label: "Message")
        }
        let consumed = await awaitCondition { self.composerDraftText(in: window) == "" }
        XCTAssertTrue(consumed, "The submitted draft must clear while creation is held")
        attachHostedScreenshot(window, name: "first-send-pending-phone")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == message }.count, 1)
        if pendingSlash {
            let heldDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
            XCTAssertEqual(heldDraft?.text, submittedDraft, "A pending slash send must keep its raw draft until acceptance")
            guard heldDraft?.text == submittedDraft else { return }
            try await typeIntoComposer("Newer draft", in: window)
        }
        XCTAssertEqual(creationCount, 1)
        creation?.resume(returning: .started(session))
        creation = nil
        if partialImportFailure {
            let settled = await awaitCondition {
                UITestFixtureHold.shared.pendingCount > 0 || HostedAccessibility.element(in: window, label: "Retry") != nil
            }
            XCTAssertTrue(settled)
            XCTAssertEqual(UITestFixtureHold.shared.pendingCount, 0, "A failed import followed by a success must not post a partial first message")
            guard UITestFixtureHold.shared.pendingCount == 0 else {
                fixture.releaseHeldLoads()
                return
            }
            XCTAssertEqual(UITestFixtureURLProtocol.initialUploadAttemptCount, 2)
            let restored = await awaitCondition { self.composerDraftText(in: window) == "First pending prompt" }
            XCTAssertTrue(restored)
            attachHostedScreenshot(window, name: "mixed-import-blocked-phone")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Retry"))
            let retried = await awaitCondition { UITestFixtureURLProtocol.initialUploadAttemptCount == 3 }
            XCTAssertTrue(retried, "Retry must upload the retained failed initial file")
            guard retried else { return }
            _ = try await requireElement(in: window, label: "Select model")
            XCTAssertEqual(creationCount, 1, "Retrying imports must reuse the created session")
            XCTAssertEqual(UITestFixtureURLProtocol.initialUploadAttemptCount, 3, "Only the failed import should retry")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Send"))
        }
        if withImportedFile || pendingSlash {
            let posted = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(posted)
            let held = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            XCTAssertEqual(held?.text, pendingSlash ? "Newer draft\n\n\(submittedDraft)" : submittedDraft)
            XCTAssertEqual(held?.attachments.count, filenames.count, "The submitted files must remain durable until startChat answers")
            if withImportedFile { XCTAssertNotNil(held?.attachments.first?.file) }
            if pendingSlash {
                let request = try XCTUnwrap(UITestFixtureHold.shared.pendingRequests.last)
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual(body["message"] as? String, message)
                XCTAssertEqual(body["session_id"] as? String ?? body["sessionId"] as? String, session.sessionId)
                XCTAssertEqual(creationCount, 1)
            }
            if partialImportFailure {
                let request = try XCTUnwrap(UITestFixtureHold.shared.pendingRequests.last)
                let body = try apiTestJSONBody(from: request)
                XCTAssertEqual((body["attachments"] as? [[String: Any]])?.count, 2)
                XCTAssertEqual(Set((body["attachments"] as? [[String: Any]] ?? []).compactMap { $0["name"] as? String }), Set(filenames))
            }
            fixture.releaseHeldLoads()
        }
        _ = try await requireElement(in: window, label: "Select model")
        if pendingSlash {
            let accepted = await awaitCondition {
                HostedAccessibility.element(in: window, label: "Send")?.accessibilityTraits.contains(.notEnabled) == false
            }
            XCTAssertTrue(accepted)
            let draft = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
            XCTAssertEqual(draft?.text, "Newer draft", "Acceptance must consume only the original slash draft")
            XCTAssertEqual(composerDraftText(in: window), "Newer draft")
        }
    }

    func testFailedFirstSendPreservesNewTypingAndRepeatedRetryJoinsCreation() async throws {
        try await assertFailedFirstSend(submittedDraft: "Submitted prompt", message: "Submitted prompt")
    }

    func testPendingSlashCommandSurvivesFailedSessionStartup() async throws {
        try await assertFailedFirstSend(submittedDraft: "/queue hello", message: "hello")
    }

    private func assertFailedFirstSend(submittedDraft: String, message: String) async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationCount = 0
        let window = try hostWindow(ChatView(
            session: SessionSummary(title: "New Chat"),
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
            loadsInitialMessages: false,
            draftStore: fixture.environment.draftStore,
            startSession: {
                creationCount += 1
                return await withCheckedContinuation { creation = $0 }
            }
        ).environment(\.scenePhase, .active).modelContainer(fixture.cache))
        defer { creation?.resume(returning: .failed("Test ended")) }
        XCTAssertNil(creation, "Appearance must not create a session")
        try await sendFromComposer(submittedDraft, in: window)
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        let consumed = await awaitCondition { self.composerDraftText(in: window) == "" }
        XCTAssertTrue(consumed)
        let durableDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
        XCTAssertEqual(durableDraft?.text, submittedDraft, "A pending send must stay durable until acceptance")
        guard durableDraft?.text == submittedDraft else { return }
        let pending = await awaitElement(in: window, label: message)
        XCTAssertNotNil(pending)
        try await typeIntoComposer("Newer draft", in: window)
        let heldDraft = await fixture.environment.draftStore.draft(for: .newChat(server: UITestFixtureEnvironment.serverURL))
        XCTAssertEqual(heldDraft?.text, "Newer draft\n\n\(submittedDraft)", "Both drafts must stay durable while creation is unresolved")
        creation?.resume(returning: .failed("Synthetic refusal"))
        creation = nil
        let retry = try await requireElement(in: window, label: "Retry")
        let restored = await awaitCondition { self.composerDraftText(in: window) == "Newer draft\n\n\(submittedDraft)" }
        XCTAssertTrue(restored)
        HostedAccessibility.activate(retry)
        HostedAccessibility.activate(retry)
        let retried = await awaitCondition { creation != nil }
        XCTAssertTrue(retried)
        XCTAssertEqual(creationCount, 2, "Repeated Retry must join the one replacement creation")
        creation?.resume(returning: .started(session))
        creation = nil
        _ = try await requireElement(in: window, label: "Select model")
        XCTAssertEqual(composerDraftText(in: window), "Newer draft\n\n\(submittedDraft)")
    }

    func testLeavingAnUncreatedChatFencesLateAdoptionAndDraftMigration() async throws {
        let fixture = try FixtureApp(for: self)
        let session = try await fixture.session()
        var creation: CheckedContinuation<ChatSessionStartResult, Never>?
        var creationReturned = false
        var didDisappear = false
        let window = try hostWindow(ChatView(
            session: SessionSummary(title: "New Chat"),
            server: UITestFixtureEnvironment.serverURL,
            onAPIError: { _ in },
            initialDraft: "Abandoned prompt",
            loadsInitialMessages: false,
            draftStore: fixture.environment.draftStore,
            startSession: {
                let result = await withCheckedContinuation { creation = $0 }
                XCTAssertTrue(Task.isCancelled, "Leaving the view must cancel its creation owner")
                creationReturned = true
                return result
            }
        ).environment(\.scenePhase, .active).modelContainer(fixture.cache)
            .onDisappear { didDisappear = true })
        defer { creation?.resume(returning: .failed("Test ended")) }
        XCTAssertNil(creation)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send"))
        let started = await awaitCondition { creation != nil }
        XCTAssertTrue(started)
        window.rootViewController = UIHostingController(rootView: Color.clear)
        // Hosting-controller replacement can defer SwiftUI's disappearance transaction.
        let disappeared = await awaitCondition { didDisappear }
        XCTAssertTrue(disappeared)
        guard disappeared else { return }
        let newKey = ChatDraftKey.newChat(server: UITestFixtureEnvironment.serverURL)
        fixture.environment.draftStore.setDraft("Replacement draft", for: newKey)
        creation?.resume(returning: .started(session))
        creation = nil
        let returned = await awaitCondition { creationReturned }
        XCTAssertTrue(returned)
        let migrated = await fixture.environment.draftStore.draft(for: .session(server: UITestFixtureEnvironment.serverURL, session: session))
        let current = await fixture.environment.draftStore.draft(for: newKey)
        XCTAssertNil(migrated, "A closed chat must not adopt a late session or move another chat's draft")
        XCTAssertEqual(current?.text, "Replacement draft")
    }

    func testAcceptedSendAfterLeavingConsumesOnlyItsOwnedDraft() async throws {
        for (newerTyping, replacementDraft, movesDraft) in [
            (nil as String?, nil as String?, false),
            ("Newer typing", nil, false),
            (nil, "Replacement draft", false),
            (nil, nil, true),
        ] {
            let fixture = try FixtureApp(["--ui-test-hold-chat-start"], for: self)
            let session = try await fixture.session()
            let server = UITestFixtureEnvironment.serverURL
            let defaultsName = "TAL1080.LateAcceptance.\(UUID().uuidString)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: defaultsName))
            defer { defaults.removePersistentDomain(forName: defaultsName) }
            let stream = SpySSEStreamingClient()
            let viewModel = ChatViewModel(
                session: session, server: server, client: fixture.client,
                streamClient: stream, approvalStreamClient: SpySSEStreamingClient(),
                clarifyStreamClient: SpySSEStreamingClient(), liveActivityManager: SpyChatLiveActivityManager(),
                listenAudioSession: SpyListenAudioSession(), userDefaults: defaults
            )
            var accepted = false
            let window = try hostWindow(NavigationStack {
                ChatView(
                    session: session, server: server, onAPIError: { _ in },
                    loadsInitialMessages: false, draftStore: fixture.environment.draftStore,
                    viewModel: viewModel, onConversationStarted: { accepted = true }
                )
            }.environment(\.scenePhase, .active).modelContainer(fixture.cache))
            try await sendFromComposer("Submitted prompt", in: window)
            let posted = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(posted)
            if let newerTyping { try await typeIntoComposer(newerTyping, in: window) }
            window.rootViewController = UIHostingController(rootView: Color.clear)
            // Deliver the same navigation cleanup explicitly before releasing the transport;
            // UIKit may defer the hosting controller's disappearance transaction.
            viewModel.suspendStreamForNavigation()
            let sessionKey = ChatDraftKey.session(server: server, session: session)
            let key = movesDraft ? ChatDraftKey.newChat(server: server) : sessionKey
            if movesDraft { fixture.environment.draftStore.moveDraft(from: sessionKey, to: key) }
            if let replacementDraft { fixture.environment.draftStore.setDraft(replacementDraft, for: key) }
            fixture.releaseHeldLoads()
            let finished = await awaitCondition { !viewModel.isStartingChat }
            XCTAssertTrue(finished)
            let draft = await fixture.environment.draftStore.draft(for: key)
            XCTAssertTrue(accepted, "The server-accepted send must settle even after its view leaves")
            XCTAssertEqual(draft?.text ?? "", replacementDraft ?? newerTyping ?? "", "An accepted prompt must not return as an unsent draft or clear newer input")
            XCTAssertNil(viewModel.activeStreamID)
            XCTAssertTrue(stream.startedURLs.isEmpty)
        }
    }
}


/// The regular-width split view at the iPhone Duo inner display's sizes and at iPad landscape (TAL-1453): the sidebar
/// leaves the chat at least 320 pt, and Files hides the sidebar when that is what puts the browser beside the chat.
@MainActor
final class RegularSplitHostedTests: XCTestCase {
    private struct Split {
        let fixture: FixtureApp
        let window: UIWindow
        let controller: UISplitViewController

        var showsSidebar: Bool { controller.displayMode == .oneBesideSecondary }
        var detailWidth: CGFloat { controller.view.bounds.width - controller.primaryColumnWidth }
    }

    /// The fixture chat opened from the Chats sidebar in a regular-width window of `size`.
    private func openChat(size: CGSize, divisions: [CGRect]? = nil) async throws -> Split {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList().environment(\.chatDivisionFramesForTesting, divisions), size: size) {
            $0.horizontalSizeClass = .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        let row = try await requireElement(in: window, "Missing deterministic session fixture") {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        HostedAccessibility.activate(row)
        _ = try await requireElement(in: window, "The chat never opened beside the list", where: FixtureApp.isLoadedTranscriptRow)
        let controller = try XCTUnwrap(HostedAccessibility.splitViewController(under: window.rootViewController))
        let split = Split(fixture: fixture, window: window, controller: controller)
        var previous: [CGRect] = []
        var stable = 0
        let laidOut = await awaitCondition {
            let frames = [controller.viewController(for: .primary)?.view.frame ?? .null,
                          controller.viewController(for: .secondary)?.view.frame ?? .null,
                          HostedAccessibility.element(in: window, label: "Send")?.accessibilityFrame ?? .null]
            stable = frames == previous ? stable + 1 : 0
            previous = frames
            return stable >= 5 && !frames.contains(.null)
        }
        XCTAssertTrue(laidOut, "The native column and composer did not finish their entry")
        XCTAssertEqual(split.showsSidebar, divisions?.isEmpty == false || (size.width >= 900 && size.width > size.height))
        return split
    }

    func testSectionLoadingAndErrorStatesStayInTheFoldPane() async throws {
        let size = HostedSize.duoInnerLandscape
        let poses = [
            ("book", CGRect(x: 455, y: -100, width: 40, height: 2000)),
            ("tabletop", CGRect(x: -100, y: 300, width: 2000, height: 40))
        ]
        for (section, flag, label) in [
            ("Kanban", UITestFixtureEnvironment.panelLoadingArgument, "Loading Kanban"),
            ("Kanban", UITestFixtureEnvironment.panelUnavailableArgument, "The Kanban server is unavailable."),
            ("Insights", UITestFixtureEnvironment.panelLoadingArgument, "Loading analytics…"),
            ("Insights", UITestFixtureEnvironment.panelUnavailableArgument, "Could Not Load Analytics")
        ] {
            for (pose, fold) in poses {
                let fixture = try FixtureApp([flag], for: self)
                let window = try hostWindow(fixture.sessionList()
                    .environment(\.chatDivisionFramesForTesting, [fold]).ignoresSafeArea(), size: size) {
                    $0.horizontalSizeClass = .regular
                    $0.verticalSizeClass = .regular
                }
                try await openSidebar(in: window)
                HostedAccessibility.activate(try await requireElement(in: window, label: section))
                // A native progress element may prepend its spoken state ("In progress, …").
                let state = try await requireElement(in: window, "Missing \(label)") {
                    $0.accessibilityLabel == label || $0.accessibilityLabel?.hasSuffix(", \(label)") == true
                }
                let stateFrame = window.convert(state.accessibilityFrame, from: nil)
                if pose == "book" {
                    XCTAssertGreaterThanOrEqual(stateFrame.minX, fold.maxX, "\(section) \(label) still crosses the book fold")
                } else {
                    XCTAssertGreaterThanOrEqual(stateFrame.minY, fold.maxY, "\(section) \(label) still crosses the tabletop fold")
                }
                for control in HostedAccessibility.elements(in: window) where control.accessibilityTraits.contains(.button)
                    && ["Try Again", "Open provider quota settings", "Refresh all provider quotas"].contains(control.accessibilityLabel ?? "") {
                    let frame = window.convert(control.accessibilityFrame, from: nil)
                    guard !frame.isEmpty else { continue }
                    if pose == "book" { XCTAssertGreaterThanOrEqual(frame.minX, fold.maxX) }
                    else { XCTAssertGreaterThanOrEqual(frame.minY, fold.maxY) }
                }
                attachHostedScreenshot(window, name: "\(section.lowercased())-\(flag.hasSuffix("loading") ? "loading" : "error")-\(pose)")
                window.isHidden = true
                window.rootViewController = nil
                fixture.releaseHeldLoads()
                settle()
            }
        }
    }

    /// Every element in the window, including the bar buttons and inspector each split-view column keeps out of the
    /// window's own element list.
    private func elements(in window: UIWindow) -> [NSObject] {
        var found: [NSObject] = []
        collectElements(window, into: &found)
        return found
    }

    private func element(_ label: String, in window: UIWindow, timeout: TimeInterval = 10) async -> NSObject? {
        await barButton(label, in: window, timeout: timeout)
    }

    /// Taps a bar button the way a finger does; its accessibility activation does nothing in a hosted window.
    private func press(_ element: NSObject) {
        HostedAccessibility.activate(element)
        settle()
    }

    /// Both an object's accessibility children and its subviews: a column's element list leaves out its bar buttons.
    private func collectElements(_ object: NSObject, into found: inout [NSObject]) {
        if object.isAccessibilityElement { found.append(object) }
        (object.accessibilityElements as? [NSObject])?.forEach { collectElements($0, into: &found) }
        (object as? UIView)?.subviews.forEach { collectElements($0, into: &found) }
    }

    private func barButton(
        _ label: String,
        in window: UIWindow,
        timeout: TimeInterval = 10,
        where match: @escaping (CGRect) -> Bool = { _ in true }
    ) async -> NSObject? {
        var found: NSObject?
        _ = await awaitCondition(timeout: timeout) {
            found = self.elements(in: window).first { $0.accessibilityLabel == label && match($0.accessibilityFrame) }
            return found != nil
        }
        return found
    }

    private func filesButton(in window: UIWindow) async throws -> NSObject {
        // The open inspector's "Files" title matches too.
        var found: NSObject?
        _ = await awaitCondition {
            found = self.elements(in: window).first {
                $0.accessibilityLabel == "Files" && $0 is UIControl && window.bounds.contains($0.accessibilityFrame)
            }
            return found != nil
        }
        return try XCTUnwrap(found ?? HostedAccessibility.toolbarAction("Files", in: window), "The chat has no Files button")
    }

    private func frame(_ element: NSObject?) -> CGRect { element?.accessibilityFrame ?? .null }

    private func filesInspector(in window: UIWindow) -> FilesInspectorContent.NavigationController? {
        guard #available(iOS 26, *),
              let controller = window.rootViewController?.firstDescendant(ofType: FilesInspectorContent.NavigationController.self),
              controller.view.window != nil, controller.splitViewController?.isShowing(.inspector) == true else { return nil }
        return controller
    }

    private func browserFrame(in window: UIWindow) async -> CGRect {
        let shown = await awaitCondition { self.filesInspector(in: window) != nil }
        guard shown, let controller = filesInspector(in: window) else { return .null }
        return controller.view.convert(controller.view.bounds, to: nil)
    }

    func testDuoInnerPortraitUsesAFullWidthChatAndOverlaySidebar() async throws {
        let split = try await openChat(size: HostedSize.duoInner)
        XCTAssertFalse(split.showsSidebar)
        let send = try await requireElement(in: split.window, label: "Send")
        let frame = split.window.convert(send.accessibilityFrame, from: nil)
        XCTAssertLessThanOrEqual(frame.maxX, HostedSize.duoInner.width)
        try await openSidebar(in: split.window)
        XCTAssertFalse(split.showsSidebar, "Opening the overlay must not admit a native column")
        _ = try await requireElement(in: split.window, label: "Close navigation")
        attachHostedScreenshot(split.window, name: "duo-inner-portrait-overlay")
    }

    func testBookFoldAlignsTheSharedSidebarToTheDivision() async throws {
        let split = try await openChat(size: HostedSize.duoInnerLandscape,
            divisions: [CGRect(x: 470, y: -100, width: 10, height: 2000)])
        XCTAssertEqual(split.controller.primaryColumnWidth, 480, accuracy: 1,
            "The native boundary includes the hinge gap so the detail begins in the right pane")
        let panel = try XCTUnwrap(split.controller.viewController(for: .primary)?.view.firstView(ofType: UICollectionView.self))
        XCTAssertLessThanOrEqual(panel.convert(panel.bounds, to: split.window).maxX, 470 + 1,
            "The visible sidebar content must end before the book division")
        let send = try await requireElement(in: split.window, label: "Send")
        XCTAssertGreaterThanOrEqual(split.window.convert(send.accessibilityFrame, from: nil).minX, 480)
        attachHostedScreenshot(split.window, name: "book-shared-sidebar")
    }

    func testDuoInnerLandscapeHidesTheSidebarToShowFilesBesideTheChat() async throws {
        let split = try await openChat(size: HostedSize.duoInnerLandscape)
        XCTAssertEqual(split.controller.primaryColumnWidth, 380, accuracy: 1)

        press(try await filesButton(in: split.window))
        let hidden = await awaitCondition { !split.showsSidebar }
        XCTAssertTrue(hidden, "Files did not hide the sidebar column")
        let browser = await browserFrame(in: split.window)
        let transcript = frame(await awaitElement(in: split.window, where: FixtureApp.isLoadedTranscriptRow))
        XCTAssertFalse(browser.isEmpty, "The file browser has no frame")
        XCTAssertFalse(transcript.isEmpty, "Files covered the chat instead of opening beside it")
        XCTAssertLessThanOrEqual(transcript.maxX, browser.minX + 1, "The file browser overlaps the chat")
        let drawer = await barButton("Sidebar", in: split.window) { split.window.bounds.contains($0) }
        XCTAssertNotNil(drawer, "The chat lost the drawer button with the sidebar hidden")
        attachHostedScreenshot(split.window, name: "duo-inner-landscape-files")

        press(try await filesButton(in: split.window))
        let restored = await awaitCondition { split.showsSidebar }
        XCTAssertTrue(restored, "Closing Files did not bring the sidebar back")
        XCTAssertEqual(split.controller.primaryColumnWidth, 380, accuracy: 1)
        let row = await awaitElement(in: split.window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true && $0.accessibilityFrame.maxX <= 381
        }
        XCTAssertNotNil(row, "The restored sidebar shows no chats")
        // Beside a vertical bar the drawer button joins it instead (TAL-1528).
        let restoredDrawer = await barButton("Sidebar", in: split.window) {
            split.window.bounds.contains($0)
        }
        XCTAssertNotNil(restoredDrawer, "The restored split lost the drawer button")
    }

    func testDuoInnerPortraitPushesFiles() async throws {
        let split = try await openChat(size: HostedSize.duoInner)
        press(try await filesButton(in: split.window))
        let browser = await element("Search files", in: split.window)
        XCTAssertNotNil(browser, "Files did not open")
        let covered = await awaitNoElement(in: split.window, timeout: 5, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertTrue(covered, "Files did not push over the chat")
        XCTAssertFalse(split.showsSidebar, "Portrait never tiles the sidebar")
    }

    func testPadLandscapeShowsFilesBesideTheChatWithTheSidebar() async throws {
        let split = try await openChat(size: HostedSize.padLandscape)
        XCTAssertEqual(split.controller.primaryColumnWidth, 380, accuracy: 1)

        press(try await filesButton(in: split.window))
        let browser = await browserFrame(in: split.window)
        let transcript = frame(await awaitElement(in: split.window, where: FixtureApp.isLoadedTranscriptRow))
        XCTAssertFalse(transcript.isEmpty, "Files covered the chat instead of opening beside it")
        XCTAssertLessThanOrEqual(transcript.maxX, browser.minX + 1, "The file browser overlaps the chat")
        XCTAssertTrue(split.showsSidebar, "Files hid the sidebar where the chat already had room")
        XCTAssertEqual(split.controller.primaryColumnWidth, 380, accuracy: 1)

        press(try await filesButton(in: split.window))
        let closed = await awaitCondition(timeout: 5) { self.filesInspector(in: split.window) == nil }
        XCTAssertTrue(closed, "Files did not close")
    }
}

/// TAL-1458: the companion page, the file the agent is working on, beside the chat where iOS 27.1's arrangement can
/// split: iPhone Duo inner display and iPad in landscape. Elsewhere only the chat shows.
extension RegularSplitHostedTests {
    private func requireArrangement() throws {
        guard #available(iOS 27.1, *) else { throw XCTSkip("The companion page needs iOS 27.1's ArrangementView") }
    }

    /// The fixture chat opened from the sidebar in a window of `size`, with the companion run started when `writes`.
    /// A `display` lets the test fold the Duo; `reducesMotion` forces Reduce Motion on.
    private func openCompanionChat(
        _ scenario: [String],
        size: CGSize,
        compact: Bool = false,
        writes: Bool = true,
        display: HostedDuoDisplay? = nil,
        reducesMotion: Bool = false
    ) async throws -> UIWindow {
        let fixture = try FixtureApp(scenario, for: self)
        let list = AnyView(fixture.sessionList().environment(\._accessibilityReduceMotion, reducesMotion))
        let content = display.map { AnyView(FoldingDisplay(display: $0, content: list)) } ?? list
        let window = try hostWindow(content, size: size) {
            $0.horizontalSizeClass = compact ? .compact : .regular
            $0.verticalSizeClass = .regular
        }
        try await openSidebar(in: window)
        let row = try await requireElement(in: window, "Missing deterministic session fixture") {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        HostedAccessibility.activate(row)
        if writes {
            try await sendFromComposer("Write the demo files", in: window)
            _ = try await requireElement(in: window, "The run never streamed") { $0.accessibilityLabel?.contains("Writing Alpha.swift.") == true }
        }
        return window
    }

    /// The companion page's title naming `file`, on the page's own bar right of the chat.
    private func companionTitle(_ file: String, in window: UIWindow, timeout: TimeInterval = 10) async -> NSObject? {
        var found: NSObject?
        _ = await awaitCondition(timeout: timeout) {
            found = self.elements(in: window).first {
                $0.accessibilityLabel == file && !($0 is UIControl) && $0.accessibilityFrame.minX > window.bounds.width / 3
            }
            return found != nil
        }
        return found
    }

    private func transcriptText(_ text: String, in window: UIWindow) async -> NSObject? {
        await awaitElement(in: window) { $0.accessibilityLabel?.contains(text) == true }
    }

    /// The companion page: the navigation controller beside the chat that keeps the page's own bar (TAL-1458).
    private func companionPage(in window: UIWindow) -> UIView? {
        var stack = window.rootViewController.map { [$0] } ?? []
        while let controller = stack.popLast() {
            if let navigation = controller as? UINavigationController, navigation.delegate is ChatCompanionPage.Coordinator,
               let view = navigation.viewIfLoaded, view.window != nil {
                return view
            }
            stack += controller.children
        }
        return nil
    }

    /// The page's opacity as drawn, every layer above it included.
    private func companionPageOpacity(in window: UIWindow) -> Float? {
        guard let page = companionPage(in: window) else { return nil }
        return sequence(first: page, next: \.superview).reduce(Float(1)) { $0 * ($1.layer.presentation() ?? $1.layer).opacity }
    }

    /// The chat's Companion Page item among the detail column's bar items.
    private func companionPageItem(in window: UIWindow) -> UIBarButtonItem? {
        guard let detail = HostedAccessibility.splitViewController(under: window.rootViewController)?.viewController(for: .secondary)
        else { return nil }
        return HostedAccessibility.toolbarItems(under: detail).first {
            $0.title == "Companion Page" || $0.accessibilityLabel == "Companion Page" || $0.primaryAction?.title == "Companion Page"
        }
    }

    private func pressCompanionPageButton(in window: UIWindow) async throws {
        // The keyboard the send left up would cover the bar's lower items.
        window.endEditing(true)
        // A crowded bar folds the item into its overflow menu, as it does Files.
        let button = await element("Companion Page", in: window, timeout: 2)
        press(try XCTUnwrap(button ?? HostedAccessibility.toolbarAction("Companion Page", in: window), "The chat has no Companion Page button"))
    }

    func testDuoInnerLandscapeShowsTheFileTheAgentWritesBesideTheChat() async throws {
        try requireArrangement()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.duoInnerLandscape)
        let alpha = frame(await companionTitle("Alpha.swift", in: window))
        let transcript = frame(await transcriptText("Writing Alpha.swift.", in: window))
        XCTAssertFalse(alpha.isEmpty, "The companion page never showed the first file")
        XCTAssertFalse(transcript.isEmpty, "The page covered the chat")
        XCTAssertLessThanOrEqual(transcript.maxX, alpha.minX + 1, "The companion page overlaps the chat")
        attachHostedScreenshot(window, name: "duo-inner-landscape-companion-alpha")

        UITestFixtureURLProtocol.advanceCompanionRun()
        let beta = frame(await companionTitle("Beta.swift", in: window))
        XCTAssertFalse(beta.isEmpty, "The page did not turn to the next file")
        let streamed = frame(await transcriptText("Writing Beta.swift.", in: window))
        XCTAssertFalse(streamed.isEmpty, "The transcript stopped streaming")
        XCTAssertLessThanOrEqual(streamed.maxX, beta.minX + 1, "The companion page overlaps the chat")
        attachHostedScreenshot(window, name: "duo-inner-landscape-companion-beta")
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    /// TAL-1539: the bar's Companion Page button hides the page and shows it again; neither a new file nor a fold
    /// reopens a page the reader hid.
    func testTheCompanionPageButtonHidesThePageUntilPressedAgain() async throws {
        try requireArrangement()
        let display = HostedDuoDisplay()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.duoInnerLandscape, display: display)
        let alpha = frame(await companionTitle("Alpha.swift", in: window))
        XCTAssertFalse(alpha.isEmpty, "The companion page never showed the first file")
        let ready = await awaitCondition { self.companionPageItem(in: window) != nil }
        XCTAssertTrue(ready, "Detail items: \(HostedAccessibility.toolbarItems(in: window).map { $0.title ?? $0.accessibilityLabel ?? "?" })")
        XCTAssertEqual(companionPageItem(in: window)?.isSelected, true, "The button does not read pressed while the page shows")

        try await pressCompanionPageButton(in: window)
        let hidden = await awaitCondition { self.companionPage(in: window) == nil }
        XCTAssertTrue(hidden, "The button did not hide the page")
        let prompt = frame(await transcriptText("Write the demo files", in: window))
        XCTAssertGreaterThan(prompt.maxX, alpha.minX + 50, "The chat did not fill the pane the page left")
        XCTAssertEqual(companionPageItem(in: window)?.isSelected, false, "The button reads pressed with the page hidden")
        attachHostedScreenshot(window, name: "duo-inner-landscape-companion-hidden")

        UITestFixtureURLProtocol.advanceCompanionRun()
        _ = try await requireElement(in: window, "The run stopped") { $0.accessibilityLabel?.contains("Writing Beta.swift.") == true }
        settle(0.5)
        XCTAssertNil(companionPage(in: window), "A new file reopened the hidden page")

        foldDuo(window, display: display, inner: HostedSize.duoInnerLandscape, closed: true)
        foldDuo(window, display: display, inner: HostedSize.duoInnerLandscape, closed: false)
        _ = try await requireElement(in: window, "Opening the Duo lost the chat") { $0.accessibilityLabel?.contains("Writing Beta.swift.") == true }
        settle(0.5)
        XCTAssertNil(companionPage(in: window), "Folding reopened the hidden page")

        try await pressCompanionPageButton(in: window)
        let beta = await companionTitle("Beta.swift", in: window)
        XCTAssertNotNil(beta, "Pressing the button again did not show the page")
        XCTAssertEqual(companionPageItem(in: window)?.isSelected, true, "The button does not read pressed once the page shows")
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    /// TAL-1539: with Open the Agent's File Automatically off, a chat opens without its page until the button.
    func testWithAutoOpenOffAChatShowsNoPageUntilTheButton() async throws {
        try requireArrangement()
        let key = ChatTranscriptDisplaySettings.opensCompanionPageKey
        UserDefaults.standard.set(false, forKey: key)
        addTeardownBlock { UserDefaults.standard.removeObject(forKey: key) }
        let window = try await openCompanionChat([UITestFixtureEnvironment.companionFocusArgument], size: HostedSize.duoInnerLandscape, writes: false)
        _ = try await requireElement(in: window, "The transcript never loaded", where: FixtureApp.isLoadedTranscriptRow)
        let offered = await awaitCondition { self.companionPageItem(in: window) != nil }
        XCTAssertTrue(offered, "The chat offers no Companion Page button")
        XCTAssertNil(companionPage(in: window), "The chat opened its page with the setting off")
        XCTAssertEqual(companionPageItem(in: window)?.isSelected, false)

        try await pressCompanionPageButton(in: window)
        let gamma = await companionTitle("Gamma.swift", in: window)
        XCTAssertNotNil(gamma, "The button did not show the page")
    }

    /// TAL-1539: the page fades in rather than popping in on its first frame.
    func testTheCompanionPageFadesIn() async throws {
        try requireArrangement()
        let window = try await openCompanionChat([UITestFixtureEnvironment.companionFocusArgument], size: HostedSize.duoInnerLandscape, writes: false)
        var first: Float?
        _ = await awaitCondition(timeout: 10) {
            first = self.companionPageOpacity(in: window)
            return first != nil
        }
        XCTAssertLessThan(try XCTUnwrap(first, "The companion page never showed"), 1, "The page popped in at full opacity")
        let opaque = await awaitCondition(timeout: 3) { (self.companionPageOpacity(in: window) ?? 0) >= 0.999 }
        XCTAssertTrue(opaque, "The page never finished fading in: \(String(describing: companionPageOpacity(in: window)))")
    }

    /// TAL-1539: under Reduce Motion the page appears at full opacity.
    func testUnderReduceMotionTheCompanionPageAppearsWithoutFading() async throws {
        try requireArrangement()
        let window = try await openCompanionChat([UITestFixtureEnvironment.companionFocusArgument], size: HostedSize.duoInnerLandscape,
                                                 writes: false, reducesMotion: true)
        var first: Float?
        _ = await awaitCondition(timeout: 10) {
            first = self.companionPageOpacity(in: window)
            return first != nil
        }
        XCTAssertEqual(try XCTUnwrap(first, "The companion page never showed"), 1, accuracy: 0.001, "The page faded under Reduce Motion")
    }

    func testAFileChosenInTheBrowserHoldsUntilFollowResumes() async throws {
        try requireArrangement()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.duoInnerLandscape)
        _ = await companionTitle("Alpha.swift", in: window)
        UITestFixtureURLProtocol.advanceCompanionRun()
        let beta = await companionTitle("Beta.swift", in: window)
        XCTAssertNotNil(beta)

        // Files opens inside the companion page, not as a third column over it. The keyboard the send left up would
        // keep the browser's lower rows out of view.
        window.endEditing(true)
        press(try await filesButton(in: window))
        let search = frame(await element("Search files", in: window))
        XCTAssertGreaterThan(search.minX, window.bounds.width / 3, "Files did not open in the companion page")
        let transcript = await transcriptText("Writing Beta.swift.", in: window)
        XCTAssertNotNil(transcript, "Files covered the chat")
        let gamma = try await requireElement(in: window, "The browser does not list the fixture file") {
            $0.accessibilityLabel?.contains("Gamma.swift") == true
        }
        HostedAccessibility.activate(gamma)
        let pinned = await companionTitle("Gamma.swift", in: window)
        XCTAssertNotNil(pinned, "Choosing a file did not show it")

        UITestFixtureURLProtocol.advanceCompanionRun()
        _ = try await requireElement(in: window, "The run stopped") { $0.accessibilityLabel?.contains("Writing Delta.swift.") == true }
        settle(0.3)
        let found1 = await companionTitle("Gamma.swift", in: window, timeout: 1)
        XCTAssertNotNil(found1, "A write moved the pinned page")
        let found2 = await companionTitle("Delta.swift", in: window, timeout: 1)
        XCTAssertNil(found2, "A write moved the pinned page")
        attachHostedScreenshot(window, name: "duo-inner-landscape-companion-pinned")

        let follow = await element("Follow", in: window)
        press(try XCTUnwrap(follow, "The pinned page has no Follow toggle"))
        let followed = await companionTitle("Delta.swift", in: window)
        XCTAssertNotNil(followed, "Follow did not show the agent's latest file")
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    func testDuoInnerPortraitShowsOnlyTheChatAndPushesFiles() async throws {
        try requireArrangement()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.duoInner)
        settle(0.5)
        let found3 = await companionTitle("Alpha.swift", in: window, timeout: 1)
        XCTAssertNil(found3, "A portrait chat split for its companion page")
        XCTAssertNil(HostedAccessibility.toolbarAction("Companion Page", in: window), "A portrait chat offered a companion page")
        press(try await filesButton(in: window))
        let found4 = await element("Search files", in: window)
        XCTAssertNotNil(found4, "Files did not open")
        let covered = await awaitNoElement(in: window, timeout: 5) { $0.accessibilityLabel?.contains("Writing Alpha.swift.") == true }
        XCTAssertTrue(covered, "Files did not push over the chat")
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    func testPhoneShowsOnlyTheChat() async throws {
        try requireArrangement()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.phone, compact: true)
        settle(0.5)
        let found5 = await element("Follow", in: window, timeout: 1)
        XCTAssertNil(found5, "A phone chat offered a companion page")
        let found6 = await companionTitle("Alpha.swift", in: window, timeout: 1)
        XCTAssertNil(found6, "A phone chat showed a companion page")
        XCTAssertNil(HostedAccessibility.toolbarAction("Companion Page", in: window), "A phone chat offered a companion page")
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    func testPadLandscapeShowsTheCompanionPageBesideTheChat() async throws {
        try requireArrangement()
        let window = try await openCompanionChat(["--ui-test-chat-companion"], size: HostedSize.padLandscape)
        let alpha = frame(await companionTitle("Alpha.swift", in: window))
        let transcript = frame(await transcriptText("Writing Alpha.swift.", in: window))
        XCTAssertFalse(alpha.isEmpty, "The companion page never showed the file")
        XCTAssertLessThanOrEqual(transcript.maxX, alpha.minX + 1, "The companion page overlaps the chat")
        attachHostedScreenshot(window, name: "pad-landscape-companion")
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
        UITestFixtureURLProtocol.advanceCompanionRun()
    }

    func testAReopenedChatShowsItsLastFileBeforeAnyStreamEvent() async throws {
        try requireArrangement()
        let window = try await openCompanionChat([UITestFixtureEnvironment.companionFocusArgument], size: HostedSize.duoInnerLandscape, writes: false)
        let gamma = await companionTitle("Gamma.swift", in: window)
        XCTAssertNotNil(gamma, "The session's last file did not show on open")
        attachHostedScreenshot(window, name: "duo-inner-landscape-companion-reopened")

        // The composer takes the keyboard beside the page.
        try await sendFromComposer("Keep going", in: window)
        let sent = await transcriptText("Keep going", in: window)
        XCTAssertNotNil(sent, "Typing beside the companion page did not send")
    }
}



/// The row's owner passes a fresh server summary after reconciliation, as the list does.
private struct ObservedSessionRow: View {
    let viewModel: SessionListViewModel
    let actions: SessionListRowActions
    var body: some View {
        if let session = viewModel.sessions.first {
            SessionInteractiveRow(viewModel: viewModel, session: session, selectedSessionID: nil, actions: actions)
        }
    }
}

private final class HeldRowMutationProtocol: URLProtocol {
    final class State: @unchecked Sendable {
        var onPin: (() -> Void)?
        private let lock = NSLock()
        private var pin: HeldRowMutationProtocol?
        private var pinned = false
        var sessionsJSON: String {
            lock.lock(); defer { lock.unlock() }
            return "{\"sessions\":[{\"session_id\":\"pending-row\",\"title\":\"Pending fixture\",\"pinned\":\(pinned),\"can_pin\":true,\"source_kind\":\"webui\"}]}"
        }
        func hold(_ request: HeldRowMutationProtocol) {
            lock.lock(); pin = request; lock.unlock()
            onPin?()
        }
        func answerPin() {
            lock.lock(); let request = pin; pin = nil; pinned = true; lock.unlock()
            request?.answer(#"{"ok": true}"#)
        }
    }
    nonisolated(unsafe) static var state: State?
    override class func canInit(with request: URLRequest) -> Bool { request.url?.host == "pending-row.test" }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        if request.url?.path == "/api/session/pin" { Self.state?.hold(self) }
        else { answer(Self.state?.sessionsJSON ?? #"{"sessions":[]}"#) }
    }
    override func stopLoading() {}
    func answer(_ json: String) {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type":"application/json"])!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(json.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
}

/// TAL-1195: what the Chats list says about its saved rows when a reload fails. Only a failure that shows the device has
/// no network says Offline; one cut off by backgrounding, or a server that is down, says so instead, and the next answer
/// clears it.
extension SessionListHostedTests {
    func testAReloadCutOffByBackgroundingIsNotShownAsOffline() async throws {
        let fixture = try FixtureApp(for: self)
        let scene = HostedScenePhase()
        let window = try hostWindow(ScenePhasedSessionList(fixture: fixture, scene: scene))
        try await openSidebar(in: window)
        let listed = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(listed, "Missing deterministic session fixture")
        await awaitInitialLoad(scene)

        holdSessionList(true)
        try await openChat(row, in: window)
        try await openSidebar(in: window)
        let reloading = await awaitHeldSessionList()
        XCTAssertTrue(reloading, "Returning to the list started no reload")

        // The reload is still in flight when the App leaves the foreground, and the suspended connection drops.
        scene.phase = .background
        settle()
        UITestFixtureURLProtocol.sessionListFailures.withLock { $0 = [.transport(.networkConnectionLost)] }
        fixture.releaseHeldLoads()
        let fellBack = await awaitElement(in: window, where: isCachedDataNotice)
        XCTAssertNotNil(fellBack, "The dropped reload did not fall back to the saved rows")

        scene.phase = .active
        let returned = await awaitHeldSessionList()
        XCTAssertTrue(returned, "Returning to the foreground started no list reload")
        let found = await awaitElement(in: window, where: isCachedDataNotice)
        let notice = try XCTUnwrap(found?.accessibilityLabel, "No saved-rows notice. Elements: \(HostedAccessibility.labels(in: window))")
        attachHostedScreenshot(window, name: "dropped-reload-on-return")
        XCTAssertFalse(notice.contains("Offline"), "A dropped connection is not a lost network: \(notice)")
        XCTAssertTrue(notice.hasPrefix("Reconnecting"), notice)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The saved rows left the list")
        XCTAssertEqual(isSelectChatsEnabled(in: window), false, "Saved rows must keep their action gates")

        holdSessionList(false)
        fixture.releaseHeldLoads()
        let live = await awaitCondition { self.isSelectChatsEnabled(in: window) == true }
        XCTAssertTrue(live, "The server's answer did not end the saved-rows mode")
    }

    func testReturningFromAChatWhileTheListReloadsMakesNoOfflineClaim() async throws {
        let fixture = try FixtureApp(for: self)
        let scene = HostedScenePhase()
        let window = try hostWindow(ScenePhasedSessionList(fixture: fixture, scene: scene))
        try await openSidebar(in: window)
        let listed = await awaitElement(in: window, where: isFixtureRow)
        let row = try XCTUnwrap(listed, "Missing deterministic session fixture")
        await awaitInitialLoad(scene)

        // A plain return: the reload is held, and a pending reload says nothing about the connection.
        holdSessionList(true)
        try await openChat(row, in: window)
        try await openSidebar(in: window)
        let reloading = await awaitHeldSessionList()
        XCTAssertTrue(reloading, "Returning to the list started no reload")
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The rows left during the reload")
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains(where: isCachedDataNotice), "\(HostedAccessibility.labels(in: window))")

        // That reload answers 503 while a chat covers the list; the return shows the server's state, not Offline.
        let reopened = await awaitElement(in: window, where: isFixtureRow)
        try await openChat(try XCTUnwrap(reopened), in: window)
        UITestFixtureURLProtocol.sessionListFailures.withLock { $0 = [.status(503)] }
        fixture.releaseHeldLoads()
        try await openSidebar(in: window)
        let returned = await awaitHeldSessionList()
        XCTAssertTrue(returned, "Returning to the list started no reload")
        let found = await awaitElement(in: window, where: isCachedDataNotice)
        let notice = try XCTUnwrap(found?.accessibilityLabel, "No saved-rows notice. Elements: \(HostedAccessibility.labels(in: window))")
        attachHostedScreenshot(window, name: "server-unavailable-on-return")
        XCTAssertFalse(notice.contains("Offline"), "A 503 is not a lost network: \(notice)")
        XCTAssertTrue(notice.hasPrefix("Server unavailable"), notice)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first(where: isFixtureRow), "The saved rows left the list")
        XCTAssertEqual(isSelectChatsEnabled(in: window), false, "Saved rows must keep their action gates")

        holdSessionList(false)
        fixture.releaseHeldLoads()
        let live = await awaitCondition { self.isSelectChatsEnabled(in: window) == true }
        XCTAssertTrue(live, "The server's answer did not end the saved-rows mode")
    }

    /// Each reason reads its own notice at phone width, and only a lost network says Offline.
    func testCachedDataBannerReadsEachReason() throws {
        let notices: [(CacheFallbackReason, String)] = [
            (.offline, "Offline - viewing cached version"),
            (.serverUnreachable, "Server unreachable - cached version"),
            (.serverUnavailable, "Server unavailable - cached version"),
            (.connectionInterrupted, "Reconnecting - cached version"),
        ]
        for (reason, title) in notices {
            let window = try hostWindow(CachedDataBanner(reason: reason).frame(width: HostedSize.phone.width).fixedSize(horizontal: false, vertical: true))
            XCTAssertEqual(HostedAccessibility.labels(in: window), [title], "\(reason)")
            attachHostedScreenshot(window, name: "cached-data-banner-\(reason)")
        }
    }

    /// The Duo propped like a tent: the running chats become run cards with Stop, the waiting one says it needs you, the
    /// idle ones keep their list rows, and Stop shows the run stopped before the server answers (TAL-1460). The hinge is the
    /// fixture's; no hinge API runs in tests.
    func testTentPoseShowsRunCardsAndStopsARunAtOnce() async throws {
        let titles = UITestFixtureURLProtocol.monitorSessionTitles
        let (fixture, window) = try await hostRunMonitorList(
            [UITestFixtureEnvironment.tentHingeArgument, UITestFixtureEnvironment.holdChatCancelArgument],
            size: HostedSize.duoOuterLandscape,
            verticalSizeClass: .compact
        )
        let firstCard = try await requireElement(in: window, "The first running chat shows no run card") { self.isRunCard($0, titled: titles[0]) }
        let secondCard = try await requireElement(in: window, "The second running chat shows no run card") { self.isRunCard($0, titled: titles[1]) }
        attachHostedScreenshot(window, name: "tent-run-monitor")
        XCTAssertTrue(firstCard.accessibilityLabel?.hasPrefix("\(titles[0]), Working, running for 1 minute") == true, firstCard.accessibilityLabel ?? "")
        XCTAssertTrue(secondCard.accessibilityLabel?.hasPrefix("\(titles[1]), Working, running for 2 minutes") == true, secondCard.accessibilityLabel ?? "")
        XCTAssertGreaterThanOrEqual(firstCard.accessibilityFrame.height, 150, "A run card reads from arm's length")
        let stops = HostedAccessibility.elements(in: window).filter { HostedAccessibility.identifier(of: $0) == "session-run-stop" }
        XCTAssertEqual(stops.map(\.accessibilityLabel), ["Stop", "Stop"], "Each running card offers Stop")
        let firstStop = try XCTUnwrap(stops.first { firstCard.accessibilityFrame.minY...firstCard.accessibilityFrame.maxY ~= $0.accessibilityFrame.midY })

        HostedAccessibility.activate(firstStop)
        let held = await awaitCondition {
            UITestFixtureHold.shared.pendingRequests.contains {
                $0.url?.path == "/api/chat/cancel" && $0.url?.query?.contains(UITestFixtureURLProtocol.monitorStreamID(1)) == true
            }
        }
        XCTAssertTrue(held, "Stop sent no stop request for the first card's run")
        let cardGone = await awaitNoElement(in: window, timeout: 2) { self.isRunCard($0, titled: titles[0]) }
        XCTAssertTrue(cardGone, "The stopped chat must leave its run card before the server answers: " + HostedAccessibility.elements(in: window).filter { self.isRunCard($0, titled: titles[0]) }.map { "\($0.accessibilityLabel ?? "nil") / \(HostedAccessibility.identifier(of: $0) ?? "nil")" }.joined(separator: "; "))
        XCTAssertEqual(UITestFixtureHold.shared.pendingCount, 1, "The stop request is still unanswered")
        attachHostedScreenshot(window, name: "tent-run-monitor-stopped")

        fixture.releaseHeldLoads()
        // The server lists it with the idle chats again.
        _ = try await scrollList(in: window, toFind: "The stopped chat did not return to its list row") {
            $0.accessibilityLabel?.hasPrefix(titles[0]) == true && HostedAccessibility.identifier(of: $0) != "session-run-card"
        }
        window.firstView(ofType: UICollectionView.self).map { $0.setContentOffset(CGPoint(x: 0, y: -$0.adjustedContentInset.top), animated: false) }

        let waiting = try await scrollList(in: window, toFind: "The waiting chat shows no run card") { self.isRunCard($0, titled: titles[2]) }
        XCTAssertTrue(waiting.accessibilityLabel?.hasPrefix("\(titles[2]), Needs approval, running for 3 minutes") == true, waiting.accessibilityLabel ?? "")
        XCTAssertTrue(waiting.accessibilityLabel?.hasSuffix(", Needs you") == true, waiting.accessibilityLabel ?? "")
        let idle = try await scrollList(in: window, toFind: "The idle chat lost its list row") {
            $0.accessibilityLabel?.hasPrefix(self.sessionTitle) == true && HostedAccessibility.identifier(of: $0) != "session-run-card"
        }
        XCTAssertLessThan(idle.accessibilityFrame.height, 150)
        attachHostedScreenshot(window, name: "tent-run-monitor-idle-rows")
    }

    /// Without the tent pose the running chats keep their list rows (TAL-1460).
    func testRunningChatsKeepListRowsWithoutTheTentHinge() async throws {
        let (_, window) = try await hostRunMonitorList([], size: HostedSize.duoOuterLandscape, verticalSizeClass: .compact)
        try await assertRunningChatsKeepListRows(in: window)
    }

    /// The outer display in portrait never shows run cards, whatever the hinge says (TAL-1460).
    func testDuoOuterPortraitKeepsListRowsWithTheHingePartlyOpen() async throws {
        let (_, window) = try await hostRunMonitorList([UITestFixtureEnvironment.tentHingeArgument], size: HostedSize.duoOuter, verticalSizeClass: .regular)
        try await assertRunningChatsKeepListRows(in: window)
    }

    private func hostRunMonitorList(
        _ scenario: [String],
        size: CGSize,
        verticalSizeClass: UIUserInterfaceSizeClass
    ) async throws -> (FixtureApp, UIWindow) {
        let fixture = try FixtureApp([UITestFixtureEnvironment.runMonitorArgument] + scenario, for: self)
        let window = try hostWindow(fixture.sessionList(), size: size) {
            $0.horizontalSizeClass = .compact
            $0.verticalSizeClass = verticalSizeClass
        }
        try await openSidebar(in: window)
        if scenario.contains(UITestFixtureEnvironment.tentHingeArgument), verticalSizeClass == .compact {
            _ = try await scrollList(in: window, toFind: "The run monitor's first card never became visible") {
                self.isRunCard($0, titled: UITestFixtureURLProtocol.monitorSessionTitles[0])
            }
        }
        return (fixture, window)
    }

    private func assertRunningChatsKeepListRows(in window: UIWindow, file: StaticString = #filePath, line: UInt = #line) async throws {
        let title = UITestFixtureURLProtocol.monitorSessionTitles[0]
        _ = try await requireElement(in: window, "The running chat lost its list row", file: file, line: line) {
            $0.accessibilityLabel?.hasPrefix("\(title), Streaming") == true
        }
        let monitorElements = HostedAccessibility.elements(in: window).filter {
            ["session-run-card", "session-run-stop"].contains(HostedAccessibility.identifier(of: $0))
        }
        XCTAssertTrue(monitorElements.isEmpty, "Run cards showed outside the tent pose", file: file, line: line)
    }

    private func isRunCard(_ element: NSObject, titled title: String) -> Bool {
        HostedAccessibility.identifier(of: element) == "session-run-card" && element.accessibilityLabel?.hasPrefix("\(title), ") == true
    }

    /// Scrolls the list a screen at a time until `match` is on screen: the list builds only the rows near the screen.
    private func scrollList(in window: UIWindow, toFind message: String, where rawMatch: @escaping (NSObject) -> Bool) async throws -> NSObject {
        let list = try XCTUnwrap(window.firstView(ofType: UICollectionView.self), "No list")
        let match = { (element: NSObject) in rawMatch(element) && window.bounds.contains(element.accessibilityFrame) }
        for _ in 0..<8 {
            if let found = await awaitElement(in: window, timeout: 1, where: match) { return found }
            let maxY = max(0, list.contentSize.height - list.bounds.height + list.adjustedContentInset.bottom)
            list.setContentOffset(CGPoint(x: 0, y: min(maxY, list.contentOffset.y + list.bounds.height * 0.6)), animated: false)
            settle()
        }
        return try XCTUnwrap(HostedAccessibility.elements(in: window).first(where: match), message)
    }

    /// Select Chats is off while the list shows saved rows. A removed list row can linger in the accessibility tree, so
    /// this live control, not the notice's absence, shows that the list is the server's again.
    private func isSelectChatsEnabled(in window: UIWindow) -> Bool? {
        let rows = HostedAccessibility.elements(in: window).filter(isFixtureRow)
        guard !rows.isEmpty else { return nil }
        return rows.contains { $0.accessibilityCustomActions?.contains { $0.name == "Select Chats…" } == true }
    }

    private func isCachedDataNotice(_ element: NSObject) -> Bool {
        element.accessibilityLabel?.contains("cached version") == true
    }

    private func holdSessionList(_ holds: Bool) {
        FixtureLaunchArguments.scenario.removeAll { $0 == UITestFixtureEnvironment.holdSessionListArgument }
        if holds { FixtureLaunchArguments.scenario.append(UITestFixtureEnvironment.holdSessionListArgument) }
    }

    private func awaitHeldSessionList(timeout: TimeInterval = 10) async -> Bool {
        await awaitCondition(timeout: timeout) {
            UITestFixtureHold.shared.pendingRequests.contains { $0.url?.path == "/api/sessions" }
        }
    }

    /// Returns to the foreground until the return reloads the list at once, which it does only once the list's first
    /// load has finished; before that, the restarted automatic refresh waits out its interval.
    private func awaitInitialLoad(_ scene: HostedScenePhase) async {
        func answeredLists() -> Int {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/sessions" }.count }
        }
        let deadline = Date().addingTimeInterval(35)
        while Date() < deadline {
            let answered = answeredLists()
            scene.phase = .inactive
            settle()
            scene.phase = .active
            if await awaitCondition(timeout: 1, { answeredLists() > answered }) { return }
        }
        XCTFail("The list's first load never finished")
    }

    private func openChat(_ row: NSObject, in window: UIWindow) async throws {
        let current = try await requireElement(in: window) {
            self.isFixtureRow($0) && $0.accessibilityTraits.contains(.button)
        }
        XCTAssertTrue(HostedAccessibility.activate(current), "The current row did not open")
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
    }

}

/// The scene phase a hosted test moves, standing in for the App leaving the foreground and returning (TAL-1195).
@MainActor
@Observable
private final class HostedScenePhase {
    var phase: ScenePhase = .active
}

private struct ScenePhasedSessionList: View {
    let fixture: FixtureApp
    let scene: HostedScenePhase

    var body: some View {
        fixture.sessionList(scenePhase: scene.phase)
    }
}

@MainActor
extension SessionListHostedTests {
    private var fixtureRowActions: SessionListRowActions {
        SessionListRowActions(retryLoad: {}, open: { _ in }, togglePinned: { _ in }, archive: { _ in }, delete: { _ in }, rename: { _ in }, duplicate: { _ in }, move: { _, _ in }, createProject: { _ in }, refreshProjects: {}, export: { _, _ in }, stopRun: { _ in })
    }

    private func titleMenu(in window: UIWindow) -> UIMenu? {
        HostedAccessibility.titleMenuController(in: window)?.navigationItem.titleMenuProvider?([])
    }

    private func actions(in menu: UIMenu) -> [UIAction] {
        HostedAccessibility.menuActions(in: menu)
    }

    private func openChat(_ fixture: FixtureApp, size: CGSize, chats: ChatViewModelCache? = nil) async throws -> UIWindow {
        let window = try hostWindow(fixture.sessionList(chats: chats), size: size)
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let ready = await awaitCondition { self.titleMenu(in: window) != nil }
        XCTAssertTrue(ready, "The open chat has no title menu")
        return window
    }

    func testSwipePlacementsFilterTheSharedMenu() async throws {
        let fixture = try FixtureApp(for: self)
        let model = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        let row = SessionInteractiveRow(viewModel: model, session: try await fixture.session(), selectedSessionID: nil, actions: fixtureRowActions)
        var titles: [[String]] = []
        for placement in [SessionRowContextMenu.Placement.menu, .leadingSwipe, .trailingSwipe] {
            let window = try hostWindow(NavigationStack {
                Color.clear.navigationTitle("Fixture")
                    .toolbarTitleMenu { row.sessionActions(placement: placement) }
            })
            let ready = await awaitCondition { self.titleMenu(in: window) != nil }
            XCTAssertTrue(ready)
            let menuActions = actions(in: try XCTUnwrap(titleMenu(in: window)))
            titles.append(menuActions.map(\.title))
            if let delete = menuActions.first(where: { $0.title == "Delete" }) {
                XCTAssertEqual(delete.attributes.contains(.destructive), placement == .menu)
            }
            window.isHidden = true
            window.rootViewController = nil
        }
        XCTAssertEqual(titles[1], ["Pin"])
        XCTAssertEqual(titles[2], ["Archive", "Delete"])
        XCTAssertTrue(Set(titles[1] + titles[2]).isSubset(of: Set(titles[0])))
    }

    func testChatTitleAndRowContextContentExposeIdenticalActions() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try await openChat(fixture, size: HostedSize.phone)
        let chatTitles = actions(in: try XCTUnwrap(titleMenu(in: window))).map(\.title)
        XCTAssertFalse(chatTitles.isEmpty)
        let model = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        _ = await model.load()
        await model.loadProjects()
        let row = SessionInteractiveRow(viewModel: model, session: try await fixture.session(), selectedSessionID: nil, actions: fixtureRowActions)
        // Project the real row contextMenu call site, including its row-only Select prefix.
        // contextMenuContent composes sessionActions(placement: .menu), exactly as the chat does.
        let rowWindow = try hostWindow(NavigationStack {
            Color.clear.navigationTitle("Fixture")
                .toolbarTitleMenu { row.contextMenuContent(includesSelection: true) }
        })
        let ready = await awaitCondition { self.titleMenu(in: rowWindow) != nil }
        XCTAssertTrue(ready)
        let rowMenu = try XCTUnwrap(titleMenu(in: rowWindow))
        let rowTitles = actions(in: rowMenu).map(\.title)
        XCTAssertEqual(rowTitles.first, "Select Chats…")
        XCTAssertEqual(chatTitles, Array(rowTitles.dropFirst()))
    }

    func testArchiveAndDeleteImmediatelyReplaceTheOpenChatAtBothWidths() async throws {
        for size in [HostedSize.phone, HostedSize.duoInnerLandscape] {
            for title in ["Archive", "Delete"] {
                let fixture = try FixtureApp([UITestFixtureEnvironment.holdSessionRemovalArgument], for: self)
                let window = try await openChat(fixture, size: size)
                let action = try XCTUnwrap(actions(in: try XCTUnwrap(titleMenu(in: window))).first { $0.title == title })
                HostedAccessibility.activate(action)
                if title == "Delete" {
                    let presented = await presentedAlert(in: window)
                    let alert = try XCTUnwrap(presented)
                    XCTAssertTrue(HostedAccessibility.tap("Delete", in: alert))
                }
                _ = try await requireElement(in: window, label: "Send", "The removal left no New Chat composer")
                let removed = await awaitNoElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
                XCTAssertTrue(removed, "The open chat waited for the server's \(title) response")
                XCTAssertNil(titleMenu(in: window), "An idle New Chat offers session actions")
                if size == HostedSize.duoInnerLandscape {
                    let split = try XCTUnwrap(HostedAccessibility.splitViewController(under: window.rootViewController))
                    let columnVisible = await awaitCondition { split.displayMode == .oneBesideSecondary }
                    XCTAssertTrue(columnVisible, "Removal hid the column beside New Chat")
                    let primary = try XCTUnwrap(split.viewController(for: .primary))
                    let detail = try XCTUnwrap(split.viewController(for: .secondary))
                    XCTAssertTrue(primary.view.window === window)
                    XCTAssertTrue(detail.view.window === window)
                    XCTAssertLessThanOrEqual(primary.view.convert(primary.view.bounds, to: window).maxX,
                                             detail.view.convert(detail.view.bounds, to: window).minX + 1)
                }
                XCTAssertGreaterThan(UITestFixtureHold.shared.pendingCount, 0)
                fixture.releaseHeldLoads()
                let answered = await awaitCondition { UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains(title == "Archive" ? "/api/session/archive" : "/api/session/delete") } }
                XCTAssertTrue(answered)
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }

    func testLocallyPushedForkMenuTargetsTheForkAndRemovalReturnsToItsParent() async throws {
        for (holdsRemoval, refusesRemoval) in [(true, false), (true, true), (false, false)] {
            var scenario = [UITestFixtureEnvironment.forkSessionArgument]
            if holdsRemoval { scenario.append(UITestFixtureEnvironment.holdSessionRemovalArgument) }
            if refusesRemoval { scenario.append(UITestFixtureEnvironment.refuseSessionRemovalArgument) }
            let fixture = try FixtureApp(scenario, for: self)
            let window = try await openChat(fixture, size: HostedSize.phone)
            let listed = try await fixture.client.sessions().sessions ?? []
            XCTAssertFalse(listed.contains { $0.sessionId == UITestFixtureURLProtocol.forkSessionID },
                           "A fresh branch must not already be listed")
            try await sendFromComposer("/branch", in: window)
            _ = try await requireElement(in: window, label: "Fork fixture reply")
            let ready = await awaitCondition {
                self.titleMenu(in: window)?.children.contains { ($0 as? UIMenu)?.title == "Full Title" } == true
            }
            XCTAssertTrue(ready)
            let menu = try XCTUnwrap(titleMenu(in: window))
            let copyLink = try XCTUnwrap(actions(in: menu).first { $0.title == "Copy Deeplink" })
            HostedAccessibility.activate(copyLink)
            XCTAssertTrue(UIPasteboard.general.string?.contains(UITestFixtureURLProtocol.forkSessionID) == true,
                          "The fork's title menu still targets the parent")

            HostedAccessibility.activate(try XCTUnwrap(actions(in: menu).first { $0.title == "Archive" }))
            let popped = await awaitNoElement(in: window) { $0.accessibilityLabel == "Fork fixture reply" }
            XCTAssertTrue(popped, "Removing a local fork must pop it before the response")
            _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
            fixture.releaseHeldLoads()
            if refusesRemoval {
                _ = try await requireElement(in: window, label: "Fork fixture reply")
            } else {
                let answered = await awaitCondition {
                    UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains("/api/session/archive") }
                }
                XCTAssertTrue(answered)
                XCTAssertNil(HostedAccessibility.element(in: window, label: "Fork fixture reply"))
            }
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testSidebarRemovalOfTheParentKeepsItsDisplayedFork() async throws {
        for refused in [false, true] {
            var scenario = [UITestFixtureEnvironment.forkSessionArgument, UITestFixtureEnvironment.holdSessionRemovalArgument]
            if refused { scenario.append(UITestFixtureEnvironment.refuseSessionRemovalArgument) }
            let fixture = try FixtureApp(scenario, for: self)
            let chats = ChatViewModelCache()
            let window = try await openChat(fixture, size: HostedSize.duoInnerLandscape, chats: chats)
            let summary = try await fixture.session()
            func retainedParent() -> RetainedChat {
                chats.chat(for: summary, server: UITestFixtureEnvironment.serverURL) {
                    XCTFail("The mounted parent's view model was created again")
                    return ChatView.makeViewModel(session: summary, server: UITestFixtureEnvironment.serverURL)
                }
            }
            let retained = retainedParent()
            XCTAssertEqual(chats.count, 1)
            try await sendFromComposer("/branch", in: window)
            _ = try await requireElement(in: window, label: "Fork fixture reply")
            try await openSidebar(in: window)
            let parent = try await requireElement(in: window) {
                $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
                    && $0.accessibilityCustomActions?.contains { $0.name == "Archive" } == true
            }
            let archive = try XCTUnwrap(parent.accessibilityCustomActions?.first { $0.name == "Archive" })
            XCTAssertTrue(archive.actionHandler?(archive) ?? false)
            let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
            XCTAssertTrue(held)
            _ = try await requireElement(in: window, label: "Fork fixture reply")
            XCTAssertEqual(chats.count, 1, "Removing a parent under its fork must not create another retained chat")
            XCTAssertTrue(retainedParent() === retained, "The fork still depends on its mounted parent's retained chat")
            fixture.releaseHeldLoads()
            let answered = await awaitCondition {
                UITestFixtureURLProtocol.answeredPaths.withLock { $0.contains("/api/session/archive") }
            }
            XCTAssertTrue(answered)
            _ = try await requireElement(in: window, label: "Fork fixture reply")
            XCTAssertEqual(chats.count, 1)
            XCTAssertTrue(retainedParent().viewModel === retained.viewModel, "The archive response replaced the parent's view model")
            if refused {
                _ = try await requireElement(in: window) {
                    $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
                        && $0.accessibilityCustomActions?.contains { $0.name == "Archive" } == true
                }
            } else {
                let gone = await awaitNoElement(in: window) {
                    $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
                        && $0.accessibilityCustomActions?.contains { $0.name == "Archive" } == true
                }
                XCTAssertTrue(gone)
                HostedAccessibility.activate(try await requireElement(in: window, label: "Memory"))
                let released = await awaitCondition { chats.count == 0 }
                XCTAssertTrue(released, "Replacing the parent root must release its archived retained chat")
            }
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testPoppingAForkMakesParentRemovalReplaceTheRoot() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.forkSessionArgument,
                                      UITestFixtureEnvironment.holdSessionRemovalArgument], for: self)
        let window = try await openChat(fixture, size: HostedSize.phone)
        try await sendFromComposer("/branch", in: window)
        _ = try await requireElement(in: window, label: "Fork fixture reply")
        let navigation = try XCTUnwrap(HostedAccessibility.titleMenuController(in: window)?.navigationController)
        XCTAssertEqual(navigation.viewControllers.count, 2)
        navigation.popViewController(animated: false)
        let popped = await awaitNoElement(in: window) { $0.accessibilityLabel == "Fork fixture reply" }
        XCTAssertTrue(popped)
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let ready = await awaitCondition { self.titleMenu(in: window) != nil }
        XCTAssertTrue(ready)
        let menu = try XCTUnwrap(titleMenu(in: window))
        HostedAccessibility.activate(try XCTUnwrap(actions(in: menu).first { $0.title == "Archive" }))
        let removed = await awaitNoElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertTrue(removed, "Popping a fork must stop reporting it as displayed before removing the parent")
        _ = try await requireElement(in: window, label: "Send")
        XCTAssertNil(titleMenu(in: window))
        fixture.releaseHeldLoads()
    }

    func testSidebarRemovalOfAnUndisplayedRememberedChatClearsRestoreAndRetainedChat() async throws {
        let fixture = try FixtureApp(for: self)
        let chats = ChatViewModelCache()
        let window = try hostWindow(fixture.sessionList(chats: chats))
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        })
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertEqual(chats.count, 1)
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Memory"))
        _ = try await requireElement(in: window, label: "User Profile")
        try await openSidebar(in: window)
        let parent = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        let archive = try XCTUnwrap(parent.accessibilityCustomActions?.first { $0.name == "Archive" })
        XCTAssertTrue(archive.actionHandler?(archive) ?? false)
        let cleared = await awaitCondition {
            SessionNavigationPersistence.load(for: UITestFixtureEnvironment.serverURL) == nil && chats.count == 0
        }
        XCTAssertTrue(cleared, "The removed chat stayed retained or eligible for launch restore")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Close navigation"))
        _ = try await requireElement(in: window, label: "User Profile")
    }

    func testRefusedArchiveRestoresTheOpenChat() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdSessionRemovalArgument, UITestFixtureEnvironment.refuseSessionRemovalArgument], for: self)
        let window = try await openChat(fixture, size: HostedSize.phone)
        let archive = try XCTUnwrap(actions(in: try XCTUnwrap(titleMenu(in: window))).first { $0.title == "Archive" })
        HostedAccessibility.activate(archive)
        let removed = await awaitNoElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        XCTAssertTrue(removed)
        fixture.releaseHeldLoads()
        _ = try await requireElement(in: window, where: FixtureApp.isLoadedTranscriptRow)
        let restored = await awaitCondition { self.titleMenu(in: window) != nil }
        XCTAssertTrue(restored)
    }
}

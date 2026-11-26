import SwiftUI
import SwiftData
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The hosted-test harness itself (TAL-856): a hosted SwiftUI screen exposes its controls through the accessibility
/// tree, activating one runs its action, and the in-process fixture answers the App's requests.
@MainActor
final class HostedViewTests: XCTestCase {
    func testDeferredRootReplacementDoesNotPopANewerPage() async throws {
        let root = NavigationAppearanceObserverViewController(action: {})
        let navigation = UINavigationController(rootViewController: root)
        let window = try hostWindow(Color.clear)
        window.rootViewController = navigation
        let outgoing = UIViewController()
        navigation.pushViewController(outgoing, animated: false)
        window.layoutIfNeeded()
        settle()
        root.replaceRootIfNeeded(revision: 0)
        root.replaceRootIfNeeded(revision: 1)
        navigation.popToRootViewController(animated: false)
        let newer = UIViewController()
        navigation.pushViewController(newer, animated: false)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertTrue(navigation.topViewController === newer,
                      "A delayed root reset must not pop a page pushed after UIKit already removed the old path")
        root.replaceRootIfNeeded(revision: 2)
        root.replaceRootIfNeeded(revision: 2, pathIsEmpty: false)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        XCTAssertTrue(navigation.topViewController === newer,
                      "A queued reset must yield when the model restores a pushed page")
    }

    func testControlActivationUsesItsRegisteredEventOnceAndHonorsDisabledState() {
        let eventSets: [UIControl.Event] = [.touchUpInside, .primaryActionTriggered, [.touchUpInside, .primaryActionTriggered]]
        for events in eventSets {
            var invocations = 0
            let control = UIControl()
            control.addAction(UIAction { _ in invocations += 1 }, for: events)
            XCTAssertTrue(HostedAccessibility.activate(control))
            XCTAssertEqual(invocations, 1, "The control's default action must run exactly once for \(events)")
            control.isEnabled = false
            XCTAssertFalse(HostedAccessibility.activate(control))
            XCTAssertEqual(invocations, 1, "A disabled control must not run its action")
        }
    }

    func testNativePrimaryActionRunsOnceAndDisabledItemsDoNotRun() {
        var invocations = 0
        let item = UIBarButtonItem(primaryAction: UIAction(title: "Fixture action") { _ in invocations += 1 })
        XCTAssertTrue(HostedAccessibility.activate(item))
        XCTAssertEqual(invocations, 1)
        item.isEnabled = false
        XCTAssertFalse(HostedAccessibility.activate(item))
        XCTAssertEqual(invocations, 1)
    }

    func testCoveredNavigationPagesDoNotSupplyToolbarActions() throws {
        let root = UIViewController()
        root.navigationItem.rightBarButtonItem = UIBarButtonItem(primaryAction: UIAction(title: "Covered action") { _ in })
        let top = UIViewController()
        var invocations = 0
        top.navigationItem.rightBarButtonItem = UIBarButtonItem(primaryAction: UIAction(title: "Visible action") { _ in invocations += 1 })
        let window = try hostWindow(Color.clear)
        let navigation = UINavigationController(rootViewController: root)
        window.rootViewController = navigation
        navigation.pushViewController(top, animated: false)
        window.layoutIfNeeded()
        settle()
        XCTAssertNil(HostedAccessibility.toolbarItem("Covered action", in: window))
        let action = try XCTUnwrap(HostedAccessibility.toolbarItem("Visible action", in: window))
        XCTAssertTrue(HostedAccessibility.activate(action))
        XCTAssertEqual(invocations, 1)
    }

    func testAlertActionWaitsForManualDismissalBeforeRequestingAnotherWarning() throws {
        let alert = UIAlertController(title: "Model warning", message: nil, preferredStyle: .alert)
        var refreshRequests = 0
        alert.addAction(UIAlertAction(title: "Refresh warning", style: .default) { _ in refreshRequests += 1 })
        var finishDismissal: (() -> Void)?
        XCTAssertTrue(HostedAccessibility.tap("Refresh warning", in: alert, dismiss: { _, completion in
            finishDismissal = completion
        }))
        XCTAssertEqual(refreshRequests, 0, "A refreshed warning must not race the harness's unfinished dismissal")
        try XCTUnwrap(finishDismissal)()
        XCTAssertEqual(refreshRequests, 1, "Completing dismissal must dispatch the selected action exactly once")
    }

    func testHostedWindowDisablesExplicitSwiftUIAnimations() async throws {
        // Reuse the real message marker to observe committed SwiftUI geometry.
        struct AnimatedMarker: View {
            @State private var expanded = false
            var body: some View {
                VStack {
                    Button("Expand test marker") {
                        withAnimation(.linear(duration: 2)) { expanded = true }
                    }
                    Text(expanded ? "Expanded marker" : "Collapsed marker")
                    ChatMessageInteractionMarker(registry: nil, content: { nil })
                        .frame(width: 100, height: expanded ? 200 : 20)
                }
            }
        }
        let window = try hostWindow(AnimatedMarker())
        let marker = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self))
        XCTAssertEqual(marker.bounds.height, 20, accuracy: 0.5)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Expand test marker"))
        _ = try await requireElement(in: window, label: "Expanded marker")
        window.layoutIfNeeded()
        XCTAssertEqual(marker.bounds.height, 200, accuracy: 0.5,
                       "A non-animated hosted window must clear explicit SwiftUI animations before measuring")

        let animatedWindow = try hostWindow(AnimatedMarker(), animationsEnabled: true)
        let animatedMarker = try XCTUnwrap(animatedWindow.firstView(ofType: ChatMessageInteractionMarkerView.self))
        HostedAccessibility.activate(try await requireElement(in: animatedWindow, label: "Expand test marker"))
        _ = try await requireElement(in: animatedWindow, label: "Expanded marker")
        animatedWindow.layoutIfNeeded()
        XCTAssertLessThan(animatedMarker.bounds.height, 200,
                          "Opting into animations must keep the explicit transition")
    }

    func testViewLookupVisitsEachBranchOnce() {
        final class Probe: UIView {
            var reads = 0
            override var subviews: [UIView] { reads += 1; return super.subviews }
        }
        let root = Probe()
        let child = Probe()
        let target = UIButton()
        root.addSubview(child)
        child.addSubview(target)
        root.reads = 0
        child.reads = 0
        XCTAssertTrue(root.firstView(ofType: UIButton.self) === target)
        XCTAssertEqual(root.reads, 1)
        XCTAssertEqual(child.reads, 1, "Nested view lookup must not repeat the same subtree")
    }

    func testMessageMenuRegistryRetainsAMarkerAcrossTemporaryDetachment() throws {
        let window = try hostWindow(Color.clear)
        let marker = UIView(frame: CGRect(x: 16, y: 16, width: 100, height: 100))
        let registry = ChatMessageMenuRegistry()
        registry.register(marker) {
            ChatMessageMenuContent(messageID: "remounted-reader", actions: [], linkRegions: [], controlRegions: [])
        }
        let point = CGPoint(x: 32, y: 32)
        XCTAssertNil(registry.hit(at: point, in: window), "An unmounted row must never route an action")
        window.addSubview(marker)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "remounted-reader")
        marker.removeFromSuperview()
        XCTAssertNil(registry.hit(at: point, in: window))
        window.addSubview(marker)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "remounted-reader")
    }

    func testMessageMenuMarkerReregistersAfterReparentingWithoutAnUpdate() throws {
        let registry = ChatMessageMenuRegistry()
        let content = { ChatMessageMenuContent(messageID: "reparented-reader", actions: [], linkRegions: [], controlRegions: []) }
        let window = try hostWindow(ChatMessageInteractionMarker(registry: registry, content: content).frame(width: 100, height: 100))
        let marker = try XCTUnwrap(window.firstView(ofType: ChatMessageInteractionMarkerView.self))
        let parent = try XCTUnwrap(marker.superview)
        let index = try XCTUnwrap(parent.subviews.firstIndex(of: marker))
        registry.register(marker, content: content)
        let point = marker.convert(CGPoint(x: 50, y: 50), to: window)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "reparented-reader")
        marker.removeFromSuperview()
        XCTAssertNil(registry.hit(at: point, in: window))
        parent.insertSubview(marker, at: index)
        XCTAssertEqual(try XCTUnwrap(registry.hit(at: point, in: window)).content.messageID, "reparented-reader")
        ChatMessageInteractionMarker.dismantleUIView(marker, coordinator: ())
        marker.removeFromSuperview()
        parent.insertSubview(marker, at: index)
        XCTAssertNil(registry.hit(at: point, in: window), "Dismantling must prevent stale actions from returning")
    }

    func testTypingFindsAnExpandedComposerThatAppearsAfterTheFirstProbe() async throws {
        let window = try hostWindow(Color.clear)
        let editor = UITextView(frame: CGRect(x: 16, y: 100, width: 300, height: 44))
        let insertion = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(2_400))
            guard !Task.isCancelled else { return }
            window.addSubview(editor)
        }
        defer {
            insertion.cancel()
            editor.resignFirstResponder()
            editor.removeFromSuperview()
        }
        try await typeIntoComposer("Delayed editor input", in: window)
        XCTAssertEqual(editor.text, "Delayed editor input")
    }

    /// A loaded CI runner can keep the main actor busy for longer than any wall-clock deadline before the chat shows its
    /// composer; typing still reaches the composer once it shows (TAL-1665).
    func testTypingWaitsOutAMainActorBusyPastTenSeconds() async throws {
        let window = try hostWindow(Color.clear)
        let editor = UITextView(frame: CGRect(x: 16, y: 100, width: 300, height: 44))
        let shell = UIButton(frame: CGRect(x: 16, y: 100, width: 300, height: 44))
        shell.accessibilityLabel = "Message"
        shell.addAction(UIAction { [weak shell] _ in
            shell?.removeFromSuperview()
            window.addSubview(editor)
        }, for: .primaryActionTriggered)
        // The stall starts once the helper is polling, the way a loaded runner's other work lands mid-wait.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            Thread.sleep(forTimeInterval: 10.5)
            window.addSubview(shell)
        }
        defer {
            editor.resignFirstResponder()
            editor.removeFromSuperview()
            shell.removeFromSuperview()
        }
        try await typeIntoComposer("Typed after a busy main actor", in: window)
        XCTAssertEqual(editor.text, "Typed after a busy main actor")
    }

    func testAHostedButtonIsFoundByItsIdentifierAndActivates() throws {
        var taps = 0
        let window = try hostWindow(
            VStack {
                Text("Heading")
                Button("Do It") { taps += 1 }
                    .accessibilityIdentifier("hosted-button")
            }
        )
        let button = try XCTUnwrap(
            HostedAccessibility.element(in: window, identifier: "hosted-button"),
            "Elements: \(HostedAccessibility.labels(in: window))"
        )
        XCTAssertEqual(button.accessibilityLabel, "Do It")
        XCTAssertTrue(button.accessibilityTraits.contains(.button))
        HostedAccessibility.activate(button)
        XCTAssertEqual(taps, 1)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Heading"))
    }
}

/// A fixture's teardown ends the work its screens left pending before its cache goes (TAL-1097). SwiftData traps on a
/// context whose container is gone, so a queued reload or chat load that outlives its fixture must never reach it.
@MainActor
final class FixtureTeardownTests: XCTestCase {
    private struct SetupFailure: Error {}

    /// The session list's reload runs in a task its queue owns, which cancelling the screen does not cancel.
    func testTeardownDrainsAHeldSessionListReloadAndTheNextFixtureStartsClean() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdSessionListArgument], for: self)
        weak let firstCache = fixture.cache
        let list = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        let window = try hostWindow(fixture.sessionList(viewModel: list))
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
        XCTAssertTrue(held, "The list's reload never reached the fixture")
        HostedScene.dismantle(window)
        XCTAssertTrue(list.hasCacheWorkInFlight, "The list's reload ended with its screen")
        await fixture.tearDown()
        XCTAssertFalse(list.hasCacheWorkInFlight, "The list's queued reload was still pending when teardown returned")
        XCTAssertEqual(UITestFixtureURLProtocol.openLoadCount, 0, "A fixture load was still open when teardown returned")
        XCTAssertNil(firstCache, "The outgoing fixture's cache outlived its teardown")

        let next = try FixtureApp(for: self)
        weak let secondCache = next.cache
        XCTAssertEqual(try next.cache.mainContext.fetchCount(FetchDescriptor<CachedSession>()), 0,
                       "The outgoing fixture's reload wrote into the next fixture's cache")
        XCTAssertEqual(UITestFixtureURLProtocol.answeredPaths.withLock { $0 }, [],
                       "The outgoing fixture's reload was answered under the next fixture's scenario")
        await next.tearDown()
        XCTAssertNil(secondCache, "A repeated fixture's cache outlived its teardown")
    }

    /// The chat paints its cached transcript, then reloads; teardown lands while that reload is held.
    func testTeardownDrainsAHeldChatReloadAfterItsCachedPaint() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdTranscriptReloadsArgument], for: self)
        weak let cache = fixture.cache
        let session = try await fixture.session()
        // The first detail read is answered; it seeds the cache the chat paints before its held reload.
        let detail = try await fixture.client.session(id: UITestFixtureURLProtocol.sessionID)
        let messages = try XCTUnwrap(detail.session?.messages)
        try CacheStore.cacheMessages(messages, serverURL: UITestFixtureEnvironment.serverURL,
                                     sessionID: UITestFixtureURLProtocol.sessionID, in: fixture.cache.mainContext,
                                     messagesOffset: 0, hasOlderMessages: false)
        let chat = ChatViewModel(session: session, server: UITestFixtureEnvironment.serverURL, client: fixture.client,
                                 liveActivityManager: SpyChatLiveActivityManager(), networkPath: nil)
        let window = try hostWindow(fixture.chat(session, viewModel: chat))
        // The held request can be the transcript the chat prefetches before its load starts and awaits.
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 && chat.hasCacheWorkInFlight }
        XCTAssertTrue(held, "The chat's reload never reached the fixture")
        HostedScene.dismantle(window)
        XCTAssertTrue(chat.hasCacheWorkInFlight, "The chat's reload ended with its screen")
        await fixture.tearDown()
        XCTAssertFalse(chat.hasCacheWorkInFlight, "The chat's reload was still pending when teardown returned")
        XCTAssertEqual(UITestFixtureURLProtocol.openLoadCount, 0, "A fixture load was still open when teardown returned")
        XCTAssertNil(cache, "The outgoing fixture's cache outlived its teardown")
    }

    /// A test that throws leaves its work to the fixture's own teardown block. The reload needs no screen: the queue's
    /// task outlives its caller either way.
    func testTeardownAfterAThrownErrorDrainsTheWorkItLeft() async throws {
        weak var list: SessionListViewModel?
        // Registered before the fixture's, so it runs after the fixture's teardown.
        addTeardownBlock { @MainActor in
            XCTAssertFalse(list?.hasCacheWorkInFlight ?? false, "The list's queued reload outlived the fixture's teardown")
            XCTAssertEqual(UITestFixtureURLProtocol.openLoadCount, 0, "A fixture load outlived the fixture's teardown")
        }
        let thrown = XCTExpectedFailure.Options()
        thrown.issueMatcher = { $0.type == .thrownError }
        XCTExpectFailure("The test throws while its reload is held", options: thrown)
        let fixture = try FixtureApp([UITestFixtureEnvironment.holdSessionListArgument], for: self)
        let model = SessionListViewModel(server: UITestFixtureEnvironment.serverURL, client: fixture.client)
        list = model
        _ = Task { await model.load(modelContext: fixture.cache.mainContext) }
        let held = await awaitCondition { UITestFixtureHold.shared.pendingCount > 0 }
        XCTAssertTrue(held, "The list's reload never reached the fixture")
        throw SetupFailure()
    }
}

/// Settings placement is a user-facing navigation contract, shared with the Web taxonomy.
@MainActor
final class SettingsPlacementHostedTests: XCTestCase {
    func testPickerKeepsItsValueAtTheTrailingEdgeOnPhone() async throws {
        for size in [DynamicTypeSize.large, .accessibility5] {
            let window = try hostWindow(
                VStack {
                    SettingsPickerRow(title: "Send While Responding", systemImage: "paperplane",
                                      selection: .constant("Queue after response")) {
                        Text("Queue after response").tag("Queue after response")
                    }
                    Spacer()
                }.padding(.horizontal, 16).dynamicTypeSize(size), size: CGSize(width: 390, height: 844))
            let found = await awaitElement(in: window) {
                $0.accessibilityLabel?.contains("Send While Responding") == true
            }
            let value = try XCTUnwrap(found, "Picker missing: \(HostedAccessibility.labels(in: window))")
            if !size.isAccessibilitySize {
                XCTAssertLessThan(value.accessibilityFrame.minY, window.safeAreaInsets.top + 30,
                                  "The picker value must stay beside its title, rather than below it")
                XCTAssertGreaterThan(value.accessibilityFrame.midX, window.bounds.midX,
                                     "The selected value belongs at the trailing edge")
            }
            XCTAssertGreaterThan(value.accessibilityFrame.maxX, window.bounds.maxX - 40,
                                 "The selected value must align to the trailing edge at every text size")
            XCTAssertLessThanOrEqual(value.accessibilityFrame.maxX, window.bounds.maxX,
                                     "The selected value must remain inside the phone at the largest text size")
            XCTAssertLessThan(value.accessibilityFrame.maxY, window.bounds.maxY,
                              "Wrapping the title must not push the selected value off the phone")
            attachHostedScreenshot(window, name: "settings-picker-\(size)")
            attachFailureScreenshot(window, name: "settings-picker-\(size)-failure")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testAppIconDisclosureKeepsItsOwnHitTargetWhenExpanded() async throws {
        try XCTSkipUnless(UIApplication.shared.supportsAlternateIcons)
        let window = try hostWindow(NavigationStack {
            SettingsPage(title: "Appearance") {
                SettingsSection(title: "App Icon") { AppIconSettingsSection() }
            }
        }, size: CGSize(width: 390, height: 844))
        func header() -> NSObject? {
            HostedAccessibility.elements(in: window).first { $0.accessibilityLabel?.hasPrefix("App Icon,") == true }
        }
        let collapsed = try XCTUnwrap(header(), HostedAccessibility.labels(in: window).description)
        XCTAssertTrue(HostedAccessibility.activate(collapsed))
        let expanded = await awaitElement(in: window) {
            $0.accessibilityLabel == "System"
        }
        let firstChoice = try XCTUnwrap(expanded, "Opening the disclosure must reveal its choices")
        XCTAssertLessThan(firstChoice.accessibilityFrame.height, 100,
                          "An icon choice must have its own hit target, separate from the other choices")
        let expandedHeader = try XCTUnwrap(header())
        XCTAssertLessThan(expandedHeader.accessibilityFrame.height, 100,
                          "The disclosure hit target must cover its header, not the icon choices below it")
        attachFailureScreenshot(window, name: "app-icon-disclosure-hit-target")
    }

    func testSharedSettingsRowsExposeTheirLabelValueAndIdentifierTogether() async throws {
        let stepperValue = LockedTestValue(5)
        let rows: [(String, String, AnyView)] = [
            ("slider", "25%", AnyView(SettingsSliderRow(title: "Fixture slider", value: .constant(25),
                in: 0...100, format: { "\(Int($0))%" }, accessibilityIdentifier: "fixture-slider"))),
            ("stepper", "5", AnyView(SettingsStepperRow(title: "Fixture stepper", value: Binding(get: { stepperValue.value }, set: { stepperValue.value = $0 }),
                in: 0...6, accessibilityIdentifier: "fixture-stepper"))),
            ("color", "red", AnyView(SettingsColorRow(title: "Fixture color", selection: .constant(.red),
                accessibilityIdentifier: "fixture-color"))),
            ("status", "Connected", AnyView(SettingsStatusRow(title: "Fixture status", systemImage: "checkmark",
                status: "Connected", accessibilityIdentifier: "fixture-status"))),
            ("item", "Ready", AnyView(SettingsItemRow(title: "Fixture item", subtitle: "Ready",
                accessibilityIdentifier: "fixture-item")))
        ]
        for (kind, expectedValue, row) in rows {
            let window = try hostWindow(row.padding(), size: CGSize(width: 390, height: 300))
            let found = await awaitElement(in: window) {
                HostedAccessibility.identifier(of: $0) == "fixture-\(kind)" && $0.isAccessibilityElement
            }
            let element = try XCTUnwrap(found, "Missing \(kind): \(HostedAccessibility.labels(in: window))")
            let speech = [element.accessibilityLabel, element.accessibilityValue].compactMap { $0 }.joined(separator: ", ")
            XCTAssertTrue(speech.contains("Fixture \(kind)"), speech)
            XCTAssertTrue(speech.contains(expectedValue), speech)
            if kind == "color" { XCTAssertFalse(element.accessibilityValue?.isEmpty ?? true) }
            let matches = HostedAccessibility.elements(in: window).filter {
                HostedAccessibility.identifier(of: $0) == "fixture-\(kind)" && $0.isAccessibilityElement
            }
            XCTAssertEqual(matches.count, 1, "Each row must have one accessible control, not duplicated labels")
            if kind == "stepper" {
                element.accessibilityIncrement()
                XCTAssertEqual(stepperValue.value, 6)
                settle()
                element.accessibilityIncrement()
                XCTAssertEqual(stepperValue.value, 6, "VoiceOver must honor the upper bound")
                element.accessibilityDecrement()
                XCTAssertEqual(stepperValue.value, 5)
            }
            attachHostedScreenshot(window, name: "settings-row-\(kind)")
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    // The rendered list, rather than the SwiftUI type, owns Settings' chrome contract.
    // One test per page over `assertChatsListChrome`'s fixture (TAL-2535).
    func testRootUsesChatsListChrome() async throws { try await assertChatsListChrome("root") }
    func testAppearanceUsesChatsListChrome() async throws { try await assertChatsListChrome("appearance") }
    func testChatUsesChatsListChrome() async throws { try await assertChatsListChrome("chat") }
    func testNavigationUsesChatsListChrome() async throws { try await assertChatsListChrome("navigation") }
    func testNotificationsUsesChatsListChrome() async throws { try await assertChatsListChrome("notifications") }
    func testSpeechUsesChatsListChrome() async throws { try await assertChatsListChrome("speech") }
    func testModelsUsesChatsListChrome() async throws { try await assertChatsListChrome("models") }
    func testProvidersUsesChatsListChrome() async throws { try await assertChatsListChrome("providers") }
    func testToolsUsesChatsListChrome() async throws { try await assertChatsListChrome("tools") }
    func testProfilesUsesChatsListChrome() async throws { try await assertChatsListChrome("profiles") }
    func testWorkspacesUsesChatsListChrome() async throws { try await assertChatsListChrome("workspaces") }
    func testSystemUsesChatsListChrome() async throws { try await assertChatsListChrome("system") }
    func testLogsUsesChatsListChrome() async throws { try await assertChatsListChrome("logs") }
    func testServersUsesChatsListChrome() async throws { try await assertChatsListChrome("servers") }
    func testLiveActivitiesAndWidgetsUsesChatsListChrome() async throws { try await assertChatsListChrome("liveActivitiesAndWidgets") }
    func testSiriAndShortcutsUsesChatsListChrome() async throws { try await assertChatsListChrome("siriAndShortcuts") }
    func testDataAndStorageUsesChatsListChrome() async throws { try await assertChatsListChrome("dataAndStorage") }
    func testAboutUsesChatsListChrome() async throws { try await assertChatsListChrome("about") }
    func testDeveloperUsesChatsListChrome() async throws { try await assertChatsListChrome("developer") }
    func testAppleAccountUsesChatsListChrome() async throws { try await assertChatsListChrome("apple-account") }
    func testRelayUsesChatsListChrome() async throws { try await assertChatsListChrome("relay") }
    func testWidgetAppearanceUsesChatsListChrome() async throws { try await assertChatsListChrome("widget-appearance") }
    func testWidgetOverallUsesChatsListChrome() async throws { try await assertChatsListChrome("widget-overall") }
    func testWidgetProfilesUsesChatsListChrome() async throws { try await assertChatsListChrome("widget-profiles") }
    func testProvidersOfflineUsesChatsListChrome() async throws { try await assertChatsListChrome("providers-offline") }
    func testSidebarQuotasUsesChatsListChrome() async throws { try await assertChatsListChrome("sidebar-quotas") }
    func testProvidersListUsesChatsListChrome() async throws { try await assertChatsListChrome("providers-list") }
    func testUserProfileUsesChatsListChrome() async throws { try await assertChatsListChrome("user-profile") }
    func testServerDetailUsesChatsListChrome() async throws { try await assertChatsListChrome("server-detail") }
    func testConnectionHeadersUsesChatsListChrome() async throws { try await assertChatsListChrome("connection-headers") }
    func testDefaultModelUsesChatsListChrome() async throws { try await assertChatsListChrome("default-model") }
    func testAuxiliaryModelsUsesChatsListChrome() async throws { try await assertChatsListChrome("auxiliary-models") }

    /// The Settings page `name` draws Chats' plain list chrome in light and dark: its rows' insets and width, its
    /// background, help behind each section's About row, and no explanation outside it.
    private func assertChatsListChrome(_ name: String) async throws {
        let fixture = try FixtureApp(for: self)
        let server = UITestFixtureEnvironment.serverURL
        let defaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        let keys = [ProviderQuotaWidgetArcColor.storageKey, ProviderQuotaWidgetColorBasis.storageKey,
                    ProviderQuotaThresholds.cacheKey]
        let saved = keys.map { defaults.object(forKey: $0) }
        defer { for (key, value) in zip(keys, saved) { defaults.set(value, forKey: key) } }
        defaults.set(ProviderQuotaWidgetArcColor.automatic.rawValue, forKey: ProviderQuotaWidgetArcColor.storageKey)
        ProviderQuotaThresholds(warningRemainingPercent: 20, criticalRemainingPercent: 5, paceTolerancePercent: 5,
                                paceWarningBurnRatePercent: 120, paceCriticalBurnRatePercent: 150,
                                paceMinimumElapsedHours: 2).cache(defaults: defaults)
        let liveStore = ServerSettingsStore(client: fixture.client)
        await liveStore.loadIfNeeded()
        let offlineHost = "settings-chrome-offline-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest({ $0.complete(withJSON: "{}", statusCode: 503) }, forHost: offlineHost)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: offlineHost) }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let offlineStore = ServerSettingsStore(client: APIClient(
            baseURL: try XCTUnwrap(URL(string: "https://\(offlineHost)")), session: URLSession(configuration: configuration)
        ))
        await offlineStore.loadIfNeeded()
        let pages: [(String, AnyView)] = [("root", AnyView(SettingsView(server: server, selection: .constant(nil))))]
            + SettingsCategory.rootCategories.map { category in
                (category.rawValue, AnyView(SettingsPaneView(authManager: fixture.environment.authManager,
                                                            server: server, pane: .category(category))))
            } + [
                ("apple-account", AnyView(AppleAccountSettingsView(authManager: fixture.environment.authManager, server: server))),
                ("relay", AnyView(RelayConnectionManagementView(authManager: fixture.environment.authManager))),
                ("widget-appearance", AnyView(ProviderQuotaWidgetAppearanceView())),
                ("widget-overall", AnyView(ProviderQuotaWidgetAppearanceView())),
                ("widget-profiles", AnyView(ProviderQuotaWidgetProfilesView())),
                ("providers-offline", AnyView(ProvidersSettingsView(server: server).environment(offlineStore))),
                ("sidebar-quotas", AnyView(ProviderQuotaSidebarDisplayView())),
                ("providers-list", AnyView(ProvidersView(server: server))),
                ("user-profile", AnyView(UserProfileSettingsView(authManager: fixture.environment.authManager))),
                ("server-detail", AnyView(ServerDetailView(authManager: fixture.environment.authManager,
                                                          account: fixture.environment.authManager.servers[0]))),
                ("connection-headers", AnyView(CustomHeadersSettingsView(authManager: fixture.environment.authManager))),
                ("default-model", AnyView(DefaultModelPicker(server: server, currentDefaultModel: nil, onSave: { _ in }))),
                ("auxiliary-models", AnyView(AuxiliaryModelsSettingsView(server: server)))
            ]
        let page = try XCTUnwrap(pages.first { $0.0 == name }?.1, "No Settings page named \(name)")
        for style in [UIUserInterfaceStyle.light, .dark] {
            let reference = try hostWindow(NavigationStack {
                SidebarList { Text("Chat").sidebarRowPadding().sidebarRow(isSelected: false) }
                    .navigationTitle("Chats")
            }, size: CGSize(width: 390, height: 844)) { $0.userInterfaceStyle = style }
            let referenceList = try XCTUnwrap(reference.firstView(ofType: UICollectionView.self))
            let referenceFrame = try XCTUnwrap(referenceList.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: 0, section: 0))).frame
            let referenceBackground = windowPixels(reference, at: [CGPoint(x: 2, y: 400)])[0]
            XCTAssertFalse(referenceBackground.isEmpty, "The baseline background must render")
            reference.isHidden = true
            reference.rootViewController = nil
            do {
                defaults.set(name == "widget-overall" ? "overall" : "pace", forKey: ProviderQuotaWidgetColorBasis.storageKey)
                if name == "providers-offline" {
                    XCTAssertNotNil(ProviderQuotaThresholds.cached(defaults: defaults), "The offline page owns a readable cached threshold fixture")
                }
                let window = try hostWindow(NavigationStack { page.modelContainer(fixture.cache).environment(liveStore) },
                                            size: CGSize(width: 390, height: 844)) { $0.userInterfaceStyle = style }
                await settleSettingsFixture(in: window)
                if name == "providers-offline" {
                    _ = try await requireElementScrolling(in: window, "Cached breakpoint status must stay visible") {
                        $0.accessibilityLabel?.contains("Offline: showing the breakpoints last read from the server.") == true
                    }
                }
                let helpSections = [
                    "chat": ["Composer", "Conversation"], "notifications": ["Provider Quotas"], "speech": ["Speech"],
                    "servers": ["Server Access"], "navigation": ["Quota Display"],
                    "providers": ["Pace Breakpoints", "Overall Breakpoints"],
                    "providers-offline": ["Pace Breakpoints", "Overall Breakpoints"],
                    "liveActivitiesAndWidgets": ["Live Activities"], "siriAndShortcuts": ["Siri & Shortcuts"],
                    "dataAndStorage": ["Offline Data"], "developer": ["Developer"],
                    "relay": ["Talaria Relay"], "widget-profiles": ["Widget Profiles"],
                    "providers-list": ["Providers"], "auxiliary-models": ["Tasks"],
                    "user-profile": ["User Profile"], "server-detail": ["Identity", "Account"],
                    "connection-headers": ["Connection Headers"], "default-model": ["Custom"]
                ]
                // A page that loads its rows shows no "Loading" row first (auxiliary models), so wait for the help the
                // page owns before reading its rows once (rule `snapshot`).
                let expectedHelp = (helpSections[name] ?? []).map { "About \($0)" }
                let helpShown = await awaitCondition { expectedHelp.allSatisfy(self.allSettingsRows(in: window).labels.contains) }
                let labels = allSettingsRows(in: window).labels
                let rows = labels.joined(separator: "\n")
                for help in expectedHelp {
                    XCTAssertTrue(helpShown && labels.contains(help), "\(name) must expose help for \(help.dropFirst(6))")
                }
                if name == "providers-offline" {
                    XCTAssertTrue(rows.contains("Offline: showing the breakpoints last read from the server."),
                                  "Cached breakpoint status must stay visible")
                }
                for explanation in [
                    "Hardware keyboard only.", "Choose which session controls", "Lays out messages and the composer",
                    "Covers the git menu", "Time Sensitive applies", "Run Talaria actions like New Chat",
                    "Cached sessions and messages are kept", "Debug builds only.", "Signs out of the active server",
                    "Controls refresh while Talaria is active", "Shows short response text",
                    "Signing out stops remote Live Activities", "Profiles are named snapshots",
                    "Provider keys are managed on the server", "Models for side tasks such as",
                    "Stored on this device only.", "Sent with every request to your server",
                    "Type a model ID exactly", "Signs out and returns to onboarding.",
                    "Signs out and switches to another configured server.", "Pace compares quota remaining",
                    "Overall Percentage ignores reset time", "On-device only keeps composer dictation audio",
                    "Makes this the active server.", "Removes this server and its saved settings"
                ] {
                    XCTAssertFalse(rows.contains(explanation), "\(name) renders an explanation outside section help: \(explanation)")
                }
                attachHostedScreenshot(window, name: "settings-chrome-\(name)-\(style == .light ? "light" : "dark")")
                let list = window.firstView(ofType: UICollectionView.self)
                XCTAssertNotNil(list, "\(name) must render a list like Chats")
                if let list {
                    let frame = try XCTUnwrap(list.visibleCells.first?.frame, "\(name) must have a rendered row to inspect")
                    XCTAssertEqual(frame.minX, referenceFrame.minX, accuracy: 1, "\(name) must use plain list insets")
                    XCTAssertEqual(frame.width, referenceFrame.width, accuracy: 1, "\(name) must use plain list width")
                }
                if let table = window.firstView(ofType: UITableView.self) {
                    XCTAssertEqual(table.style, .plain, name)
                }
                XCTAssertEqual(windowPixels(window, at: [CGPoint(x: 2, y: 400)])[0], referenceBackground, "\(name) must use Chats' system background")
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }

    func testSectionHelpOpensTheComposerExplanation() async throws {
        let window = try hostWindow(NavigationStack { ChatsSettingsView() }, size: HostedSize.phone)
        defer { window.isHidden = true; window.rootViewController = nil }
        let help = await awaitElement(in: window) { $0.accessibilityLabel == "About Composer" }
        let button = try XCTUnwrap(help, "Composer must expose its section help to VoiceOver")
        XCTAssertGreaterThanOrEqual(button.accessibilityFrame.height, 44)
        XCTAssertTrue(HostedAccessibility.activate(button))
        let appeared = await awaitCondition {
            window.rootViewController?.presentedViewController is UIAlertController
        }
        XCTAssertTrue(appeared, "Section help must open an alert")
        let alert = try XCTUnwrap(window.rootViewController?.presentedViewController as? UIAlertController)
        XCTAssertEqual(alert.title, "Composer")
        XCTAssertTrue(alert.message?.contains("Control-Return") == true)
        XCTAssertTrue(alert.message?.contains("They hide while you type or read older messages.") == true)
        attachHostedScreenshot(window, name: "settings-composer-help")
        XCTAssertTrue(HostedAccessibility.tap("OK", in: alert))
    }

    func testProfileSwitchConvergesOnTheServerSelectionAfterForegroundRefresh() async throws {
        let previousHook = UITestURLSessionHook.configure
        defer { UITestURLSessionHook.configure = previousHook }
        let active = LockedTestValue("alpha")
        let reads = LockedTestValue(0)
        let saves = LockedTestValue(0)
        let scope = MockURLProtocol.register { request in
            if request.url?.path == "/api/profile/switch" {
                active.value = "beta"
            } else if request.url?.path == "/api/profiles" {
                reads.value += 1
            }
            let data = try JSONSerialization.data(withJSONObject: [
                "active": active.value,
                "profiles": [["name": "alpha"], ["name": "beta"]],
                "single_profile_mode": false
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!, data)
        }
        UITestURLSessionHook.configure = { configuration in
            configuration.protocolClasses = [MockURLProtocol.self]
            configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: scope]
        }
        let server = URL(string: "https://profile-settings-\(UUID().uuidString.lowercased()).example.test")!
        defer {
            ActiveServerProfile.record(nil, for: server)
            ServerCookieStore.shared.clear(for: server)
        }
        let window = try hostWindow(NavigationStack {
            DefaultProfilePickerView(server: server, currentDefaultProfileName: nil) { _ in saves.value += 1 }
        }.environment(\.scenePhase, .active))
        let beta = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-row-beta" }
        XCTAssertTrue(HostedAccessibility.activate(beta))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name" }
        let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
        let useAction = try XCTUnwrap(actions.first { $0.title == "Use This Profile" })
        XCTAssertTrue(HostedAccessibility.activate(useAction))
        let saved = await awaitCondition { saves.value == 1 }
        XCTAssertTrue(saved, "The profile switch must complete before an external change")
        let navigation = try XCTUnwrap(window.navigationStacks.first { $0.viewControllers.count > 1 })
        navigation.popToRootViewController(animated: false)
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-row-beta" }
        // A second client switches back while this page remains mounted.
        active.value = "alpha"
        let before = reads.value
        NotificationCenter.default.post(name: .talariaReturnedToForeground, object: nil)
        let refreshed = await awaitCondition {
            reads.value > before && HostedAccessibility.element(in: window, identifier: "settings-profile-row-alpha")?.accessibilityLabel?.contains("Active") == true
        }
        XCTAssertTrue(refreshed, "Foreground refresh must adopt the server's current profile")
        XCTAssertFalse(HostedAccessibility.element(in: window, identifier: "settings-profile-row-beta")?.accessibilityLabel?.contains("Active") == true,
                       "The completed optimistic selection must not survive a server refresh")
        attachHostedScreenshot(window, name: "profiles-refreshed-server-selection")
    }

    func testProfileBotIdentityAndOpenChatUseTheSwitchResponsesTip() async throws {
        let previousHook = UITestURLSessionHook.configure
        defer { UITestURLSessionHook.configure = previousHook }
        let switchedNames = LockedTestValue([String]())
        let opened = LockedTestValue([URL]())
        let saves = LockedTestValue(0)
        let returnedTip = LockedTestValue<String?>("bot-current-tip")
        let scope = MockURLProtocol.register { request in
            let switching = request.url?.path == "/api/profile/switch"
            if switching {
                let body = try JSONSerialization.jsonObject(with: apiTestBodyData(from: request) ?? Data()) as? [String: String]
                switchedNames.value.append(body?["name"] ?? "")
            }
            let canonical: Any
            if let tip = switching || !switchedNames.value.isEmpty ? returnedTip.value : "bot-old-tip" {
                canonical = ["session_id": "bot-root", "tip_session_id": tip]
            } else {
                canonical = NSNull()
            }
            var bot: [String: Any] = ["name": "alpha", "display_name": "Research Bot", "description": switching ? "Switch snapshot." : "Finds primary sources.",
                                      "canonical_session": canonical]
            // Only the list endpoint carries the server's row presentation fields.
            if !switching { bot["name_differs"] = true }
            let data = try JSONSerialization.data(withJSONObject: [
                "active": switchedNames.value.isEmpty ? "beta" : "alpha",
                "profiles": [
                    bot,
                    ["name": "beta", "display_name": "beta", "name_differs": false, "canonical_session": NSNull()],
                    ["name": "gamma"]
                ],
                "single_profile_mode": false
            ])
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil,
                                    headerFields: ["Content-Type": "application/json"])!, data)
        }
        UITestURLSessionHook.configure = { configuration in
            configuration.protocolClasses = [MockURLProtocol.self]
            configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: scope]
        }
        let server = URL(string: "https://profile-bot-\(UUID().uuidString.lowercased()).example.test")!
        defer {
            ActiveServerProfile.record(nil, for: server)
            ServerCookieStore.shared.clear(for: server)
        }
        func screen() -> some View {
            NavigationStack {
                DefaultProfilePickerView(server: server, currentDefaultProfileName: nil) { _ in saves.value += 1 }
            }.environment(\.openURL, OpenURLAction { opened.value.append($0); return .handled })
        }
        func openDetail(_ name: String, in window: UIWindow) async throws {
            let row = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-row-\(name)" }
            XCTAssertTrue(HostedAccessibility.activate(row))
            _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-detail-name" }
        }
        let window = try hostWindow(screen())
        let beta = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-profile-row-beta" }
        XCTAssertEqual(beta.accessibilityLabel?.components(separatedBy: "beta").count, 2,
                       "A server name_differs=false row must not repeat its title as a slug")
        attachHostedScreenshot(window, name: "profiles-bot-identity")
        for name in ["beta", "gamma"] {
            try await openDetail(name, in: window)
            let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
            XCTAssertFalse(actions.contains { $0.title == "Open Bot Chat" })
            let navigation = try XCTUnwrap(window.navigationStacks.first { $0.viewControllers.count > 1 })
            navigation.popToRootViewController(animated: false)
        }
        try await openDetail("alpha", in: window)
        let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
        let action = try XCTUnwrap(actions.first { $0.title == "Open Bot Chat" }, "Missing Open Bot Chat for a canonical profile")
        let labels = HostedAccessibility.labels(in: window).joined(separator: " | ")
        for text in ["Research Bot", "alpha", "Finds primary sources."] {
            XCTAssertTrue(labels.contains(text), "The detail must expose its server identity: \(labels)")
        }
        XCTAssertTrue(HostedAccessibility.activate(action))
        let didOpen = await awaitCondition { !opened.value.isEmpty }
        XCTAssertTrue(didOpen)
        XCTAssertEqual(switchedNames.value, ["alpha"])
        XCTAssertEqual(saves.value, 1)
        let url = try XCTUnwrap(opened.value.first)
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "bot-current-tip")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), server.absoluteString)
        _ = try await requireElement(in: window, "The switch snapshot must reconcile through the list's server projection") {
            $0.accessibilityLabel == "Finds primary sources."
        }
        attachHostedScreenshot(window, name: "profiles-bot-selected")

        // The canonical chat can disappear between listing and switching. Never reuse the list's old tip.
        returnedTip.value = nil
        let retryActions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
        let retry = try XCTUnwrap(retryActions.first { $0.title == "Open Bot Chat" })
        XCTAssertTrue(HostedAccessibility.activate(retry))
        _ = try await requireElement(in: window, label: "Bot Chat is no longer available for this profile.")
        XCTAssertEqual(opened.value.count, 1)
        XCTAssertEqual(saves.value, 2, "The successful profile switch still updates Settings")
        let remainingActions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: window)
        XCTAssertFalse(remainingActions.contains { $0.title == "Open Bot Chat" })
        attachHostedScreenshot(window, name: "profiles-bot-no-longer-available")
        window.isHidden = true
        window.rootViewController = nil

        returnedTip.value = "bot-current-tip"
        let layouts: [(String, CGSize, DynamicTypeSize, UIUserInterfaceStyle)] = [
            ("landscape", HostedSize.phoneLandscape, .large, .light),
            ("wide", HostedSize.padLandscape, .large, .light),
            ("duo-outer", HostedSize.duoOuter, .large, .light),
            ("duo-inner", HostedSize.duoInner, .large, .light),
            ("accessibility-dark", HostedSize.phone, .accessibility5, .dark)
        ]
        for (name, size, type, style) in layouts {
            let layout = try hostWindow(screen().dynamicTypeSize(type), size: size) { $0.userInterfaceStyle = style }
            try await openDetail("alpha", in: layout)
            let actions = try await hostedMenuActions("Actions", readyAction: "Use This Profile", in: layout)
            XCTAssertTrue(actions.contains { $0.title == "Open Bot Chat" })
            attachHostedScreenshot(layout, name: "profiles-bot-\(name)")
            layout.isHidden = true
            layout.rootViewController = nil
        }
    }

    private func settleSettingsFixture(in window: UIWindow) async {
        await Task.yield()
        let loaded = await awaitCondition {
            !HostedAccessibility.elements(in: window).contains {
                $0.accessibilityLabel?.contains("Loading") == true
            }
        }
        XCTAssertTrue(loaded, "The Settings fixture must finish loading before inspecting its rows")
    }

    /// Every row the page's list realizes, paged half a screen at a time. Each step lays the list out and runs one
    /// run-loop pass instead of drawing the window: a drawn frame per step was most of this class's window
    /// snapshots, and the run that hung here had the simulator's render server at 6.4 GB on a 7 GB runner
    /// (TAL-2542). The scan ends at the list's end, or once a step neither moves the list nor finds a new row, so a
    /// list that keeps growing cannot hold it.
    private func allSettingsRows(in window: UIWindow) -> (labels: Set<String>, identifiers: Set<String>) {
        var labels = Set<String>()
        var identifiers = Set<String>()
        let scroll = window.firstView(ofType: UICollectionView.self)
        let top = -(scroll?.adjustedContentInset.top ?? 0)
        func show(_ offset: CGFloat) {
            scroll?.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            window.layoutIfNeeded()
            RunLoop.current.run(until: Date())
        }
        var offset = top
        var reached: CGFloat?
        while true {
            show(offset)
            let found = labels.count + identifiers.count
            for element in HostedAccessibility.elements(in: window) {
                if let label = element.accessibilityLabel { labels.insert(label) }
                if let identifier = HostedAccessibility.identifier(of: element) { identifiers.insert(identifier) }
            }
            guard let scroll else { break }
            let stalled = reached == scroll.contentOffset.y && labels.count + identifiers.count == found
            reached = scroll.contentOffset.y
            let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            if offset >= bottom || stalled { break }
            offset = min(bottom, offset + max(1, scroll.bounds.height / 2))
        }
        show(top)
        return (labels, identifiers)
    }

    func testSettingsSearchOpensTheMatchingRow() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList(), size: CGSize(width: 390, height: 844))
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window) {
            $0.accessibilityLabel == "Settings" && $0.accessibilityHint == "Long press to switch servers."
        })
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        let field = try await openSettingsSearch(in: window)
        field.text = "not-a-real-setting-87321"
        field.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.contains("No Results") == true }
        attachHostedScreenshot(window, name: "settings-search-empty")
        field.text = ""
        field.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        field.text = "git actions"
        field.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window, label: "Git Actions")
        let result = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-search-settings-chat-git-actions"
        }
        XCTAssertEqual(result.accessibilityLabel, "Git Actions")
        XCTAssertEqual(result.accessibilityValue, "Chats")
        XCTAssertTrue(result.accessibilityTraits.contains(.button))
        XCTAssertTrue(HostedAccessibility.activate(result), "VoiceOver must activate a search result")
        let target = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-chat-git-actions"
        }
        XCTAssertTrue(window.bounds.contains(window.convert(target.accessibilityFrame, from: window.screen.coordinateSpace)),
                      "A chosen search result must be visible without another scroll")
        XCTAssertNil(settingsSearchButton(in: window), "Only the Settings root offers search")
        attachHostedScreenshot(window, name: "settings-search-opened-row")
    }

    // One test per size over `assertSettingsSearchPlacement(size:)` (TAL-2405): together they ran over 20 s on CI.
    func testSettingsSearchButtonSitsInTheBottomBarOnPhone() async throws {
        try await assertSettingsSearchPlacement(size: HostedSize.phone)
    }

    func testSettingsSearchButtonSitsTopTrailingOnPad() async throws {
        try await assertSettingsSearchPlacement(size: HostedSize.padLandscape)
    }

    private func assertSettingsSearchPlacement(size: CGSize) async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList(), size: size)
        try await openSidebar(in: window)
        let opened = await awaitCondition { self.settingsAvatar(in: window) != nil }
        XCTAssertTrue(opened, "The sidebar must offer Settings")
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(settingsAvatar(in: window))))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        let sheet = try XCTUnwrap(window.rootViewController?.presentedViewController)
        _ = await awaitCondition { self.settingsSearchButton(in: window) != nil }
        attachHostedScreenshot(window, name: size == HostedSize.phone ? "settings-search-closed-phone" : "settings-search-closed-pad")
        if size == HostedSize.phone {
            let button = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-search-button" }
            let frame = window.convert(button.accessibilityFrame, from: window.screen.coordinateSpace)
            XCTAssertGreaterThan(frame.minY, window.bounds.height * 0.8, "iPhone puts Settings search in the bottom bar")
        } else {
            XCTAssertEqual(sheet.traitCollection.horizontalSizeClass, .regular)
            let bar = try XCTUnwrap(sheet.view.firstView(ofType: UINavigationBar.self))
            let trailing = (bar.topItem?.trailingItemGroups.flatMap(\.barButtonItems) ?? []) + (bar.topItem?.rightBarButtonItems ?? [])
            XCTAssertTrue(trailing.contains { $0.accessibilityIdentifier == "settings-search-button" },
                          "iPad puts Settings search at the top bar's trailing edge")
        }
        let field = try await openSettingsSearch(in: window)
        field.text = "thinking"
        field.sendActions(for: .editingChanged)
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-search-settings-chat-expand-thinking-by-default"
        }
        attachHostedScreenshot(window, name: size == HostedSize.phone ? "settings-search-open-phone" : "settings-search-open-pad")
        let close = try await requireElement(in: window, label: "Close search")
        XCTAssertTrue(HostedAccessibility.activate(close))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        let restored = await awaitCondition { self.settingsSearchButton(in: window) != nil }
        XCTAssertTrue(restored, "Closing search brings the button back")
        XCTAssertNil(window.firstView(ofType: UITextField.self), "Closing search hides the field")
        // Leave search open, dismiss Settings and reopen it: search starts closed again.
        _ = try await openSettingsSearch(in: window)
        let dismiss = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Close")
            ?? HostedAccessibility.toolbarItem("Close", in: window))
        XCTAssertTrue(HostedAccessibility.activate(dismiss))
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed, "Close must dismiss Settings")
        try await openSidebar(in: window)
        _ = await awaitCondition { self.settingsAvatar(in: window) != nil }
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(settingsAvatar(in: window))))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-user-profile" }
        _ = try await openSettingsSearch(in: window)
        window.isHidden = true
        window.rootViewController = nil
    }

    func testServerSettingsOnlyExposeFieldsTheServerSent() async throws {
        _ = try FixtureApp(for: self)
        for (payload, showsTools, showsMaximum) in [
            ("{}", false, false),
            (#"{"agent_approvals":null,"compression_prepare_ahead":null,"max_tokens":null}"#, false, true),
            (#"{"agent_approvals":false}"#, true, false)
        ] {
            let host = "settings-visibility-\(UUID().uuidString).test"
            DeferredMockURLProtocol.setOnRequest({ request in
                if request.request.url?.path == "/api/settings" {
                    request.complete(withJSON: payload)
                } else {
                    request.complete(withJSON: "{}", statusCode: 404)
                }
            }, forHost: host)
            addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [DeferredMockURLProtocol.self]
            let server = try XCTUnwrap(URL(string: "https://\(host)"))
            let model = ServerSettingsStore(client: APIClient(baseURL: server, session: URLSession(configuration: config)))
            await model.loadIfNeeded()
            let root = try hostWindow(NavigationStack {
                SettingsView(server: server, selection: .constant(nil)).environment(model)
            })
            XCTAssertEqual(allSettingsRows(in: root).identifiers.contains("settings-category-tools"), showsTools)
            root.isHidden = true
            root.rootViewController = nil
            let chat = try hostWindow(NavigationStack {
                ModelsSettingsView(server: server).environment(model)
            })
            let rows = allSettingsRows(in: chat).identifiers
            XCTAssertEqual(rows.contains("settings-chat-max-tokens"), showsMaximum)
            XCTAssertFalse(rows.contains("settings-chat-compression-ahead"))
            XCTAssertFalse(rows.contains("settings-chat-title-refresh"))
            chat.isHidden = true
            chat.rootViewController = nil
        }
    }

    func testServerSettingsControlsAppearFromFixtureState() async throws {
        let fixture = try FixtureApp(for: self)
        let pages: [(SettingsCategory, [String])] = [
            (.models, ["settings-chat-max-tokens", "settings-chat-compression-ahead"]),
            (.system, ["settings-chat-title-refresh", "settings-system-check-updates", "settings-system-auto-apply", "settings-system-continue-interrupted", "settings-system-summarize",
                        "settings-system-web-channel", "settings-system-agent-channel", "settings-system-ignore-agent"]),
            (.tools, ["settings-tools-agent-approvals"])
        ]
        for (category, identifiers) in pages {
            let window = try await hostServerSettings(category, fixture: fixture)
            defer {
                window.isHidden = true
                window.rootViewController = nil
            }
            // The server-settings rows carry no "Loading" label of their own, so the settle can pass before they arrive.
            var rows = allSettingsRows(in: window)
            _ = await awaitCondition {
                rows = self.allSettingsRows(in: window)
                return Set(identifiers).isSubset(of: rows.identifiers)
            }
            for identifier in identifiers {
                XCTAssertTrue(rows.identifiers.contains(identifier), "Missing server setting: \(identifier)")
            }
            attachHostedScreenshot(window, name: "server-settings-\(category.rawValue)")
        }
    }

    func testDefaultModelPickerUsesSettingsNavigationAndKeepsSelection() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try await hostDefaultModelPicker(fixture: fixture)
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Filter Models"),
                        "Both Settings model pickers must expose provider and Favorites filters")
        let heading = try await requireElement(in: window) {
            $0.accessibilityTraits.contains(.header) && $0.accessibilityLabel?.hasPrefix("Fixture Provider") == true
        }
        let selectedDefault = await awaitCondition {
            HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-model")?.accessibilityTraits.contains(.selected) == true
        }
        XCTAssertTrue(selectedDefault, "The server-selected default must retain its check after the shared catalog loads")
        XCTAssertTrue(HostedAccessibility.activate(heading))
        let collapsed = await awaitCondition { HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-alternative") == nil }
        XCTAssertTrue(collapsed, "The provider header must collapse its provider-only rows")
        XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-model"),
                        "Favorites stay visible when their provider is collapsed")
        XCTAssertTrue(HostedAccessibility.activate(heading))
        let star = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-star-fixture-model" }
        XCTAssertTrue(HostedAccessibility.activate(star))
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-model-star-fixture-model" && $0.accessibilityLabel?.hasPrefix("Add ") == true
        }
        XCTAssertTrue(HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-model")?.accessibilityTraits.contains(.selected) == true,
                      "Starring must not change the selected default")
        attachHostedScreenshot(window, name: "settings-default-model-navigation")
        XCTAssertNil(window.rootViewController?.presentedViewController,
                     "Default Model must push inside Settings, never present a sheet")
        let navigation = try XCTUnwrap(window.navigationStacks.first { $0.viewControllers.count > 1 },
                                      "The model picker must share Settings' back stack")
        XCTAssertEqual(navigation.topViewController?.navigationItem.title, "Default Model")
        XCTAssertNil(HostedAccessibility.toolbarItem("Cancel", in: window))
        navigation.popViewController(animated: false)
        _ = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Default Model") == true
        }
    }

    func testDefaultModelPickerCanHideAndUnhideAModel() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try await hostDefaultModelPicker(fixture: fixture)
        let hide = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-model-visibility-fixture-model"
        }
        XCTAssertEqual(hide.accessibilityLabel, "Hide Model")
        XCTAssertEqual(hide.accessibilityValue, "Fixture Model")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Actions for Fixture Model, Fixture Provider"))
        XCTAssertTrue(HostedAccessibility.activate(hide))
        let hidden = await awaitCondition { HostedAccessibility.element(in: window, identifier: "settings-model-option-fixture-model") == nil }
        XCTAssertTrue(hidden, "Hide must remove the model from the visible catalog")
        let filters = try await hostedMenuActions("Filter Models", readyAction: "Show Hidden", in: window)
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(filters.first { $0.title == "Show Hidden" })))
        let restored = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-model" }
        XCTAssertTrue(restored.accessibilityLabel?.contains("Hidden") == true)
        let unhide = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-model-visibility-fixture-model" && $0.accessibilityLabel == "Unhide Model"
        }
        XCTAssertTrue(HostedAccessibility.activate(unhide))
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-model" && $0.accessibilityLabel?.contains("Hidden") == false
        }
    }

    func testAuxiliaryModelPickerReplacesAnOffCatalogTaskSelection() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try await hostServerSettings(.models, fixture: fixture)
        let auxiliary = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Auxiliary Models") == true
        }
        XCTAssertTrue(HostedAccessibility.activate(auxiliary))
        let vision = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Vision") == true }
        XCTAssertTrue(HostedAccessibility.activate(vision))
        let modelRow = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "auxiliary-edit-model" }
        XCTAssertNotNil(HostedAccessibility.toolbarItem("Save", in: window))
        XCTAssertTrue(HostedAccessibility.activate(modelRow))
        _ = try await requireElement(in: window, label: "Auto")
        let offCatalog = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("legacy/vision-model") == true
        }
        XCTAssertTrue(offCatalog.accessibilityTraits.contains(.selected),
                      "The Auxiliary leading section must announce the saved off-catalog model as selected")
        XCTAssertEqual(HostedAccessibility.elements(in: window).filter { $0.accessibilityTraits.contains(.selected) }.count, 1)
        XCTAssertNil(window.rootViewController?.presentedViewController,
                     "Auxiliary task model pickers must also push inside Settings")
        let navigation = try XCTUnwrap(window.navigationStacks.first { $0.viewControllers.count > 1 })
        XCTAssertEqual(navigation.viewControllers.count, 4)
        XCTAssertEqual(navigation.topViewController?.navigationItem.title, "Model")
        XCTAssertNil(HostedAccessibility.toolbarItem("Cancel", in: window))
        attachHostedScreenshot(window, name: "settings-auxiliary-model-navigation")
        let selected = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-model-option-fixture-model" }
        XCTAssertTrue(HostedAccessibility.activate(selected))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "auxiliary-edit-model" }
        XCTAssertNotNil(HostedAccessibility.toolbarItem("Cancel", in: window))
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == "auxiliary-edit-reasoning" }
        settle(0.3)
        attachHostedScreenshot(window, name: "settings-auxiliary-task-draft")
        let save = try XCTUnwrap(HostedAccessibility.toolbarAction("Save", in: window))
        XCTAssertTrue(HostedAccessibility.activate(save))
        let returned = await awaitCondition { navigation.viewControllers.count == 2 }
        XCTAssertTrue(returned, "Save returns from the task editor to the task list")
        _ = try await requireElement(in: window) { $0.accessibilityLabel?.hasPrefix("Vision") == true && $0.accessibilityLabel?.contains("fixture-model") == true }
        settle(0.3)
        attachHostedScreenshot(window, name: "settings-auxiliary-model-saved")
    }

    func testToolsShowsProfileToolsetsWithoutAgentApprovals() async throws {
        let fixture = try FixtureApp(for: self)
        let (server, store) = try await loadToolsetsSettingsFixture()
        var selectedPane: SettingsPane?
        let selection = Binding(get: { selectedPane }, set: { selectedPane = $0 })
        let root = try hostWindow(NavigationStack {
            SettingsView(server: server, selection: selection).environment(store)
        })
        let tools = try await requireElementScrolling(in: root, "Tools must appear with only toolset settings") {
            HostedAccessibility.identifier(of: $0) == "settings-category-tools"
        }
        attachHostedScreenshot(root, name: "settings-root-toolsets-without-approvals")
        XCTAssertTrue(HostedAccessibility.activate(tools))
        let pane = try XCTUnwrap(selectedPane)
        XCTAssertEqual(pane, .category(.tools))
        root.isHidden = true
        root.rootViewController = nil

        let window = try hostWindow(NavigationStack {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: pane)
                .environment(store)
        })
        for (name, enabled) in [("file", false), ("web", true)] {
            let row = try await requireElement(in: window) {
                HostedAccessibility.identifier(of: $0) == "settings-tools-toolset-\(name)"
            }
            XCTAssertEqual(!row.accessibilityTraits.contains(.notEnabled), enabled, name)
        }
        let unavailable = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-tools-toolset-todo"
        }
        XCTAssertTrue(unavailable.accessibilityTraits.contains(.notEnabled))
    }

    func testToolsLetsAnUnavailableSavedToolsetBeTurnedOff() async throws {
        let fixture = try FixtureApp(for: self)
        let (server, store) = try await loadToolsetsSettingsFixture(savedUnavailable: true)
        let window = try hostWindow(NavigationStack {
            SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .category(.tools))
                .environment(store)
        })
        let row = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "settings-tools-toolset-todo"
        }
        XCTAssertFalse(row.accessibilityTraits.contains(.notEnabled),
                       "A saved unavailable toolset must be removable when the server allows it")
    }

    func testToolsSettingsGallery() async throws {
        let fixture = try FixtureApp(for: self)
        let (server, store) = try await loadToolsetsSettingsFixture(savedUnavailable: true)
        try await renderHostedPage("settings-tools-defaults") {
            NavigationStack {
                SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .category(.tools))
                    .environment(store)
            }
        } inspect: { window, _ in
            _ = try await self.requireElement(in: window) {
                HostedAccessibility.identifier(of: $0) == "settings-tools-toolset-file"
            }
        }
    }

    private func loadToolsetsSettingsFixture(savedUnavailable: Bool = false) async throws -> (URL, ServerSettingsStore) {
        let host = "toolset-defaults-\(UUID().uuidString).test"
        let catalog = """
        {"toolsets":[
          {"name":"file","selected":true,"available":true,"group":"available","can_deselect":\(savedUnavailable)},
          {"name":"web","selected":false,"available":true,"group":"available","can_deselect":true},
          {"name":"todo","selected":\(savedUnavailable),"available":false,"group":"not_available","can_deselect":\(savedUnavailable),"unavailable_reason":"disabled"}
        ],"selected_toolsets":[\(savedUnavailable ? #""file","todo""# : #""file""#)]}
        """
        DeferredMockURLProtocol.setOnRequest({ request in
            switch request.request.url?.path {
            case "/api/settings": request.complete(withJSON: #"{"agent_approvals":null}"#)
            case "/api/toolsets/defaults": request.complete(withJSON: catalog)
            default: request.complete(withJSON: "{}", statusCode: 404)
            }
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let server = try XCTUnwrap(URL(string: "https://\(host)"))
        let store = ServerSettingsStore(client: APIClient(baseURL: server, session: URLSession(configuration: config)))
        await store.loadIfNeeded()
        return (server, store)
    }

    func testToolsAgentApprovalToggleWritesServerSettings() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try await hostServerSettings(.tools, fixture: fixture)
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == SettingsIndex.toolsAgentApprovals.id
        }
        let toggle = try XCTUnwrap(window.firstView(ofType: UISwitch.self))
        XCTAssertTrue(toggle.isOn)
        let reads = UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/settings" }.count }
        toggle.setOn(false, animated: false)
        toggle.sendActions(for: .valueChanged)
        XCTAssertFalse(toggle.isOn)
        let saved = await awaitCondition {
            UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == "/api/settings" }.count > reads }
        }
        XCTAssertTrue(saved)
        let response = try await fixture.client.settings()
        XCTAssertEqual(response.agentApprovals, false, "The visible Tools control must reach the shared settings writer")
        attachHostedScreenshot(window, name: "server-settings-tools-approvals-disabled")
    }

    private func hostDefaultModelPicker(fixture: FixtureApp) async throws -> UIWindow {
        let window = try await hostServerSettings(.models, fixture: fixture)
        let row = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix("Default Model") == true
        }
        XCTAssertTrue(HostedAccessibility.activate(row))
        _ = try await requireElement(in: window, label: "Save Custom Model")
        return window
    }

    private func hostServerSettings(_ category: SettingsCategory, fixture: FixtureApp) async throws -> UIWindow {
        let window = try hostWindow(NavigationStack {
            SettingsPaneView(authManager: fixture.environment.authManager,
                             server: UITestFixtureEnvironment.serverURL, pane: .category(category))
        })
        await settleSettingsFixture(in: window)
        return window
    }

    /// TAL-2341: Chats' Transcript opens Tool Calls with a row that counts the switches the server sent.
    func testChatsLinksToolCallsWithItsRowCount() async throws {
        let fixture = try FixtureApp(for: self)
        let store = ServerSettingsStore(client: fixture.client)
        await store.loadIfNeeded()
        let window = try hostWindow(NavigationStack { ChatsSettingsView().environment(store) }, size: HostedSize.phone)
        defer { window.isHidden = true; window.rootViewController = nil }
        let link = try await requireElementScrolling(in: window, "Chats must link Tool Calls") {
            HostedAccessibility.identifier(of: $0) == SettingsIndex.chatToolCalls.id
        }
        let read = [link.accessibilityLabel, link.accessibilityValue].compactMap { $0 }.joined(separator: " ")
        XCTAssertTrue(read.contains("Tool Calls") && read.contains("9"), read)
        attachHostedScreenshot(window, name: "settings-chats-tool-calls-link")
    }

    /// TAL-2341, TAL-2022: Tool Calls shows its switches in two groups, the tool rows' six then the three around the chat.
    func testToolCallsPageGroupsItsSwitches() async throws {
        let fixture = try FixtureApp(for: self)
        let store = ServerSettingsStore(client: fixture.client)
        await store.loadIfNeeded()
        let window = try hostWindow(NavigationStack { ToolCallsSettingsView().environment(store) }, size: HostedSize.phone)
        defer { window.isHidden = true; window.rootViewController = nil }
        _ = try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == SettingsIndex.toolCallsTurnSummary.id }
        let rows = allSettingsRows(in: window)
        XCTAssertTrue(rows.labels.isSuperset(of: ["Tool Rows", "Around the Chat"]), "\(rows.labels)")
        XCTAssertEqual(rows.identifiers.filter { $0.hasPrefix("settings-tool-calls-") }, Set(ToolCallSetting.allCases.map(\.index.id)))
        attachHostedScreenshot(window, name: "settings-tool-calls")
    }

    // One test per indexed page over `assertIndexedRowsAtOneHome`'s fixture (TAL-2535).
    func testAppearanceKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.appearance)) }
    func testChatsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.chats)) }
    func testToolCallsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.toolCalls) }
    func testNavigationKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.navigation)) }
    func testNotificationsAndHapticsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.notificationsAndHaptics)) }
    func testSpeechKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.speech)) }
    func testModelsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.models)) }
    func testSystemKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.system)) }
    func testProvidersKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.providers)) }
    func testToolsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.tools)) }
    func testProfilesKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.profiles)) }
    func testWorkspacesKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.workspaces)) }
    func testLogsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.logs)) }
    func testServersKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.servers)) }
    func testLiveActivitiesAndWidgetsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.liveActivitiesAndWidgets)) }
    func testSiriAndShortcutsKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.siriAndShortcuts)) }
    func testDataAndStorageKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.dataAndStorage)) }
    func testAboutKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.about)) }
    func testDeveloperKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.category(.developer)) }
    func testSidebarQuotasKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.sidebarQuotas) }
    // The widget page's conditional rows each need their own host, so its sections split further.
    func testProviderQuotaWidgetKeepsItsGaugeRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) { $0.section == "Gauge" }
    }
    func testProviderQuotaWidgetKeepsItsSurfaceRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) { $0.section == "Surface" }
    }
    func testProviderQuotaWidgetKeepsItsStateRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) { $0.section == "Automatic Colors" && !$0.title.hasPrefix("Custom") }
    }
    func testProviderQuotaWidgetKeepsItsCustomHealthyAndWarningColorRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) { [.widgetCustomHealthyColor, .widgetCustomWarningColor].contains($0) }
    }
    func testProviderQuotaWidgetKeepsItsCustomCriticalStaleAndUnavailableColorRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) {
            [.widgetCustomCriticalColor, .widgetCustomStaleColor, .widgetCustomUnavailableColor].contains($0)
        }
    }
    func testProviderQuotaWidgetKeepsItsOtherRowsAtOneHome() async throws {
        try await assertIndexedRowsAtOneHome(.providerQuotaWidget) { !["Gauge", "Surface", "Automatic Colors"].contains($0.section) }
    }
    func testUserProfileKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.userProfile) }
    func testAppleAccountKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.appleAccount) }
    func testWidgetProfilesKeepsItsIndexedRowsAtOneHome() async throws { try await assertIndexedRowsAtOneHome(.widgetProfiles) }

    /// `page` shows only rows its Settings index entries own, and every one of `entries`, a conditional row through its
    /// targeted link.
    private func assertIndexedRowsAtOneHome(_ page: SettingsPane, entries: (SettingsIndex) -> Bool = { _ in true }) async throws {
        let fixture = try FixtureApp(for: self)
        let store = ServerSettingsStore(client: fixture.client)
        await store.loadIfNeeded()
        let saved = try XCTUnwrap(ProviderQuotaWidgetProfileStore.saveCurrent(name: "Fixture Search Profile"))
        defer { ProviderQuotaWidgetProfileStore.delete(id: saved.id) }

        func identifiers(on page: SettingsPane, target: SettingsIndex? = nil) async throws -> Set<String> {
            let entries = SettingsIndex.allCases.filter { $0.page == page }
            let first = try XCTUnwrap(entries.first)
            let pane: SettingsPane
            if let target { pane = .indexed(.setting(target)) }
            else if case .category(let category) = page { pane = .category(category) }
            else { pane = .indexed(.setting(first)) }
            let loadingPath = page.category == .logs ? "/api/logs" : "/api/updates/check"
            let readsBefore = UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == loadingPath }.count }
            let window = try hostWindow(NavigationStack {
                SettingsPaneView(authManager: fixture.environment.authManager,
                                 server: UITestFixtureEnvironment.serverURL, pane: pane)
                    .environment(store)
                    .modelContainer(fixture.cache)
                    .environment(\.scenePhase, .active)
            }, size: CGSize(width: 390, height: 844))
            defer { window.isHidden = true; window.rootViewController = nil }
            await settleSettingsFixture(in: window)
            if page.category == .logs || page.category == .system {
                let loaded = await awaitCondition {
                    UITestFixtureURLProtocol.answeredPaths.withLock { $0.filter { $0 == loadingPath }.count > readsBefore }
                }
                XCTAssertTrue(loaded, "\(page) must load its fixture before checking its rows")
                await Task.yield()
            }
            let identifiers = allSettingsRows(in: window).identifiers.filter { $0.hasPrefix("settings-") }
            for identifier in identifiers {
                XCTAssertTrue(entries.contains { $0.owns(identifier: identifier) }, "\(page) has an unindexed row: \(identifier)")
            }
            return Set(identifiers)
        }

        let found = try await identifiers(on: page)
        for entry in SettingsIndex.allCases where entry.page == page && entries(entry)
            && !found.contains(where: entry.owns(identifier:)) {
            // Conditional controls must be reachable without changing their stored parent preference or signing in.
            let targeted = try await identifiers(on: page, target: entry)
            XCTAssertTrue(targeted.contains(where: entry.owns(identifier:)), "\(page) is missing indexed row \(entry.id)")
        }
    }
}

extension XCTestCase {
    /// The sidebar's Settings avatar, or the toolbar item that stands in for it; the hidden drawer's Settings row is not it.
    @MainActor
    func settingsAvatar(in window: UIWindow) -> NSObject? {
        HostedAccessibility.elements(in: window).first {
            $0.accessibilityLabel == "Settings" && $0.accessibilityHint == "Long press to switch servers."
        } ?? HostedAccessibility.toolbarItems(in: window).first { $0.accessibilityLabel == "Settings" }
    }

    /// The Settings search button as VoiceOver reaches it: a hosted element in a bottom bar, a bar button item on top.
    @MainActor
    func settingsSearchButton(in window: UIWindow) -> NSObject? {
        HostedAccessibility.element(in: window, identifier: "settings-search-button")
            ?? HostedAccessibility.toolbarItems(in: window).first { $0.accessibilityIdentifier == "settings-search-button" }
    }

    /// Settings opens with search closed; its toolbar button opens a focused field and hides itself.
    @MainActor
    func openSettingsSearch(in window: UIWindow, file: StaticString = #filePath, line: UInt = #line) async throws -> UITextField {
        XCTAssertNil(window.firstView(ofType: UITextField.self), "Settings must open with search closed", file: file, line: line)
        _ = await awaitCondition { self.settingsSearchButton(in: window) != nil }
        let button = try XCTUnwrap(settingsSearchButton(in: window), "Settings must offer a search button", file: file, line: line)
        XCTAssertEqual(button.accessibilityLabel, "Search settings", file: file, line: line)
        XCTAssertTrue(HostedAccessibility.activate(button), file: file, line: line)
        let focused = await awaitCondition {
            window.firstView(ofType: UITextField.self) { $0.placeholder == "Search settings" }?.isFirstResponder == true
        }
        XCTAssertTrue(focused, "The opened Settings search field must take the keyboard", file: file, line: line)
        let hidden = await awaitCondition { self.settingsSearchButton(in: window) == nil }
        XCTAssertTrue(hidden, "The search button hides while its field is open", file: file, line: line)
        return try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Search settings" }, file: file, line: line)
    }
}

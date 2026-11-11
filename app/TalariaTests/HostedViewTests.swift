import SwiftUI
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

    func testAboutOffersSendFeedback() async throws {
        let window = try hostWindow(NavigationStack { AboutSettingsView() })
        let row = await awaitElement(in: window) { $0.accessibilityLabel == "Send Feedback" }
        XCTAssertNotNil(row, "About must offer the native Send Feedback action")
        attachHostedScreenshot(window, name: "about-feedback-after")
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

    func testTheInProcessFixtureAnswersTheSessionList() async throws {
        let fixture = try FixtureApp(for: self)
        let response = try await fixture.client.sessions()
        XCTAssertTrue(response.sessions?.contains { $0.sessionId == UITestFixtureURLProtocol.sessionID } == true)
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
            $0.accessibilityLabel?.hasPrefix("System. Matches device appearance") == true
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
    func testSettingsPagesUseChatsListChrome() async throws {
        let fixture = try FixtureApp(for: self)
        let server = UITestFixtureEnvironment.serverURL
        let pages: [(String, AnyView)] = [("root", AnyView(SettingsView(server: server, selection: .constant(nil))))]
            + SettingsCategory.rootCategories.map { category in
                (category.rawValue, AnyView(SettingsPaneView(authManager: fixture.environment.authManager,
                                                            server: server, pane: .category(category))))
            } + [
                ("apple-account", AnyView(AppleAccountSettingsView(authManager: fixture.environment.authManager, server: server))),
                ("relay", AnyView(RelayConnectionManagementView(authManager: fixture.environment.authManager))),
                ("widget-appearance", AnyView(ProviderQuotaWidgetAppearanceView())),
                ("widget-profiles", AnyView(ProviderQuotaWidgetProfilesView())),
                ("sidebar-quotas", AnyView(ProviderQuotaSidebarDisplayView())),
                ("providers-list", AnyView(ProvidersView(server: server))),
                ("auxiliary-models", AnyView(AuxiliaryModelsSettingsView(server: server)))
            ]
        for style in [UIUserInterfaceStyle.light, .dark] {
            let reference = try hostWindow(NavigationStack {
                SidebarList { Text("Chat").sidebarRowPadding().sidebarRow(isSelected: false) }
                    .navigationTitle("Chats")
            }, size: CGSize(width: 390, height: 844)) { $0.userInterfaceStyle = style }
            let referenceList = try XCTUnwrap(reference.firstView(ofType: UICollectionView.self))
            let referenceFrame = try XCTUnwrap(referenceList.collectionViewLayout.layoutAttributesForItem(at: IndexPath(item: 0, section: 0))).frame
            let referenceBackground = edgePixel(in: reference)
            XCTAssertFalse(referenceBackground.isEmpty, "The baseline background must render")
            reference.isHidden = true
            reference.rootViewController = nil
            for (name, page) in pages {
                let window = try hostWindow(NavigationStack { page.modelContainer(fixture.cache) },
                                            size: CGSize(width: 390, height: 844)) { $0.userInterfaceStyle = style }
                await settleSettingsFixture(in: window)
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
                XCTAssertEqual(edgePixel(in: window), referenceBackground, "\(name) must use Chats' system background")
                window.isHidden = true
                window.rootViewController = nil
            }
        }
    }

    private func edgePixel(in window: UIWindow) -> [UInt8] {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: CGSize(width: 1, height: 1), format: format).image { context in
            context.cgContext.translateBy(x: -2, y: -400)
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let data = image.cgImage?.dataProvider?.data else { return [] }
        return Array(UnsafeBufferPointer(start: CFDataGetBytePtr(data), count: CFDataGetLength(data)))
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
        let beta = try await requireElement(in: window, label: "beta")
        XCTAssertTrue(HostedAccessibility.activate(beta))
        let saved = await awaitCondition { saves.value == 1 }
        XCTAssertTrue(saved, "The profile switch must complete before an external change")
        // A second client switches back while this page remains mounted.
        active.value = "alpha"
        let before = reads.value
        NotificationCenter.default.post(name: .talariaReturnedToForeground, object: nil)
        let refreshed = await awaitCondition {
            reads.value > before && HostedAccessibility.element(in: window, label: "alpha")?.accessibilityValue == "Selected"
        }
        XCTAssertTrue(refreshed, "Foreground refresh must adopt the server's current profile")
        XCTAssertNotEqual(HostedAccessibility.element(in: window, label: "beta")?.accessibilityValue, "Selected",
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
            if let tip = switching ? returnedTip.value : "bot-old-tip" {
                canonical = ["session_id": "bot-root", "tip_session_id": tip]
            } else {
                canonical = NSNull()
            }
            let data = try JSONSerialization.data(withJSONObject: [
                "active": switching ? "alpha" : "beta",
                "profiles": [
                    ["name": "alpha", "display_name": "Research Bot", "description": "Finds primary sources.",
                     "canonical_session": canonical],
                    ["name": "beta", "canonical_session": NSNull()],
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
        let window = try hostWindow(screen())
        _ = try await requireElement(in: window, label: "gamma")
        attachHostedScreenshot(window, name: "profiles-bot-identity")
        let action = try await requireElement(in: window, "Missing Open Bot Chat for a canonical profile") {
            HostedAccessibility.identifier(of: $0) == "profile-open-bot-chat-alpha"
        }
        let labels = HostedAccessibility.labels(in: window).joined(separator: " | ")
        for text in ["Research Bot", "alpha", "Finds primary sources."] {
            XCTAssertTrue(labels.contains(text), "The row must expose its server identity: \(labels)")
        }
        for name in ["beta", "gamma"] {
            XCTAssertNil(HostedAccessibility.element(in: window, identifier: "profile-open-bot-chat-\(name)"))
        }
        XCTAssertTrue(HostedAccessibility.activate(action))
        let didOpen = await awaitCondition { !opened.value.isEmpty }
        XCTAssertTrue(didOpen)
        XCTAssertEqual(switchedNames.value, ["alpha"])
        XCTAssertEqual(saves.value, 1)
        let url = try XCTUnwrap(opened.value.first)
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), "bot-current-tip")
        XCTAssertEqual(TalariaDeepLink.publisherID(from: url), server.absoluteString)
        attachHostedScreenshot(window, name: "profiles-bot-selected")

        // The canonical chat can disappear between listing and switching. Never reuse the list's old tip.
        returnedTip.value = nil
        let retry = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "profile-open-bot-chat-alpha"
                && !$0.accessibilityTraits.contains(.notEnabled)
        }
        XCTAssertTrue(HostedAccessibility.activate(retry))
        _ = try await requireElement(in: window, label: "Bot Chat is no longer available for this profile.")
        XCTAssertEqual(opened.value.count, 1)
        XCTAssertEqual(saves.value, 2, "The successful profile switch still updates Settings")
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "profile-open-bot-chat-alpha"))
        attachHostedScreenshot(window, name: "profiles-bot-no-longer-available")
        window.isHidden = true
        window.rootViewController = nil

        let layouts: [(String, CGSize, DynamicTypeSize, UIUserInterfaceStyle)] = [
            ("landscape", HostedSize.phoneLandscape, .large, .light),
            ("wide", HostedSize.padLandscape, .large, .light),
            ("duo-outer", HostedSize.duoOuter, .large, .light),
            ("duo-inner", HostedSize.duoInner, .large, .light),
            ("accessibility-dark", HostedSize.phone, .accessibility5, .dark)
        ]
        for (name, size, type, style) in layouts {
            let layout = try hostWindow(screen().dynamicTypeSize(type), size: size) { $0.userInterfaceStyle = style }
            _ = try await requireElement(in: layout) {
                HostedAccessibility.identifier(of: $0) == "profile-open-bot-chat-alpha"
            }
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

    private func allSettingsRows(in window: UIWindow) -> (labels: Set<String>, identifiers: Set<String>) {
        var labels = Set<String>()
        var identifiers = Set<String>()
        let scroll = window.firstView(ofType: UICollectionView.self)
        let top = -(scroll?.adjustedContentInset.top ?? 0)
        var offset = top
        repeat {
            scroll?.setContentOffset(CGPoint(x: 0, y: offset), animated: false)
            settle(window: window)
            for element in HostedAccessibility.elements(in: window) {
                if let label = element.accessibilityLabel { labels.insert(label) }
                if let identifier = HostedAccessibility.identifier(of: element) { identifiers.insert(identifier) }
            }
            guard let scroll else { break }
            let bottom = max(top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            if offset >= bottom { break }
            offset = min(bottom, offset + max(1, scroll.bounds.height / 2))
        } while true
        scroll?.setContentOffset(CGPoint(x: 0, y: top), animated: false)
        settle(window: window)
        return (labels, identifiers)
    }

    func testCategoryPagesKeepTheirRowsAndIdentifiersAtOneHome() async throws {
        let fixture = try FixtureApp(for: self)
        let pages: [(SettingsCategory, [String], [String])] = [
            (.appearance, ["Theme", "Tint New Chat & Send"], []),
            (.chats, ["Send While Responding", "Send With", "Workspace", "Profile", "Git Branch", "Context Usage",
                      "Thinking & Tools", "Expand Thinking by Default", "Expand Tools by Default", "Streamed Text Animation",
                      "Response Timestamps", "Response Speed", "Wrap Code Block Lines", "Scroll Button Side",
                      "Right-to-Left Chat Layout", "Files Button", "Open the Agent's File Automatically", "Git Actions"], []),
            (.navigation, ["Tasks", "Kanban", "Skills", "Memory", "Insights", "Feedback Button", "Cron Sessions",
                           "Webhook Sessions", "CLI Sessions", "Claude Code Sessions", "Subagent Sessions", "Sidebar Quotas"],
             ["settings-sidebar-feedback-toggle"] + ["tasks", "kanban", "skills", "memory", "insights"].map { "settings-navigation-section-\($0)" }),
            (.notificationsAndHaptics, ["Haptic Feedback", "Response Complete Alerts", "Approval and Question Alerts",
                                       "Approval & Input Alerts", "Provider Quota Alerts", "Warning Alerts", "Critical Alerts", "Time Sensitive"], []),
            (.speech, ["Dictation Provider"], []),
            (.models, ["Default Model", "Auxiliary Models"], []),
            (.providers, ["Provider Icons", "Quota Percentage", "Quota Refresh"], []),
            (.profiles, ["Search profiles", "New Profile"], []),
            (.workspaces, ["Add Workspace"], []),
            (.system, ["Status", "Version", "Check for updates"], []),
            (.servers, ["Add Server", "Connection Headers", "Sign Out of This Server"], []),
            (.liveActivitiesAndWidgets, ["Display", "Live Activity Excerpts"], []),
            (.dataAndStorage, ["Clear Offline Cache"], ["settings-app-lock"]),
            (.about, ["Send Feedback"], ["settings-send-feedback"])
        ]
        // Version also describes the installed App on About.
        let exclusiveRows = pages.flatMap { $0.1 }.filter { $0 != "Version" }
        let rowIdentifiers = Set(pages.flatMap { $0.2 })
        var homes: [String: [SettingsCategory]] = [:]
        var identifierHomes: [String: [SettingsCategory]] = [:]
        for size in [CGSize(width: 390, height: 844), CGSize(width: 669, height: 867)] {
            for style in [UIUserInterfaceStyle.light, .dark] {
                for (category, labels, identifiers) in pages {
                    let window = try hostWindow(NavigationStack {
                        SettingsPaneView(authManager: fixture.environment.authManager,
                                         server: UITestFixtureEnvironment.serverURL, pane: .category(category))
                            .modelContainer(fixture.cache)
                    }, size: size) { $0.userInterfaceStyle = style }
                    await settleSettingsFixture(in: window)
                    var rows = allSettingsRows(in: window)
                    for label in labels {
                        if HostedAccessibility.toolbarAction(label, in: window) != nil { rows.labels.insert(label) }
                        XCTAssertTrue(rows.labels.contains { $0 == label || $0.hasPrefix(label + ",") }, label)
                    }
                    for identifier in identifiers {
                        XCTAssertTrue(rows.identifiers.contains(identifier), identifier)
                    }
                    if style == .light && size.width == 390 {
                        for identifier in rowIdentifiers where rows.identifiers.contains(identifier) {
                            identifierHomes[identifier, default: []].append(category)
                        }
                        for row in exclusiveRows where rows.labels.contains(where: {
                            $0 == row || $0.hasPrefix(row + ",")
                        }) { homes[row, default: []].append(category) }
                    }
                    XCTAssertFalse(rows.labels.contains("Archived Chats"))
                    if [.liveActivitiesAndWidgets, .dataAndStorage].contains(category) {
                        XCTAssertFalse(rows.labels.contains("Privacy"))
                    }
                    let theme = "\(style == .light ? "light" : "dark")-\(Int(size.width))"
                    attachHostedScreenshot(window, name: "settings-\(category.rawValue)-\(theme)")
                    if let scroll = window.firstView(ofType: UIScrollView.self, where: { $0.contentSize.height > $0.bounds.height }) {
                        scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
                    }
                    settle()
                    attachHostedScreenshot(window, name: "settings-\(category.rawValue)-\(theme)-bottom")
                    window.isHidden = true
                    window.rootViewController = nil
                }
                let window = try hostWindow(NavigationStack {
                    SettingsView(server: UITestFixtureEnvironment.serverURL, profileName: "Fixture profile",
                                 serverName: "Fixture server", selection: .constant(nil))
                }, size: size) { $0.userInterfaceStyle = style }
                _ = try await requireElement(in: window, label: "Fixture profile")
                _ = try await requireElement(in: window, label: "Fixture server")
                attachHostedScreenshot(window, name: "settings-root-\(style == .light ? "light" : "dark")-\(Int(size.width))")
                if let scroll = window.firstView(ofType: UIScrollView.self, where: { $0.contentSize.height > $0.bounds.height }) {
                    scroll.setContentOffset(CGPoint(x: 0, y: max(0, scroll.contentSize.height - scroll.bounds.height)), animated: false)
                }
                settle()
                attachHostedScreenshot(window, name: "settings-root-\(style == .light ? "light" : "dark")-\(Int(size.width))-bottom")
                window.isHidden = true
                window.rootViewController = nil
                let editor = try hostWindow(AddServerView(authManager: fixture.environment.authManager), size: size) {
                    $0.userInterfaceStyle = style
                }
                let editorRows = allSettingsRows(in: editor)
                XCTAssertTrue(editorRows.labels.contains("URL"), "The server editor keeps its URL field")
                attachHostedScreenshot(editor, name: "settings-add-server-\(style == .light ? "light" : "dark")-\(Int(size.width))")
                editor.isHidden = true
                editor.rootViewController = nil
            }
        }
        for (category, _, identifiers) in pages {
            for identifier in identifiers {
                XCTAssertEqual(identifierHomes[identifier], [category], "\(identifier) must have exactly one owning page")
            }
        }
        for row in exclusiveRows {
            XCTAssertEqual(homes[row]?.count, 1, "\(row) must have exactly one owning category")
        }
    }
}

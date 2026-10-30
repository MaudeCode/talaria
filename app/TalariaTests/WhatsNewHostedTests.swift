import SwiftData
import SwiftUI
import UIKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// The What's New sheet an App update offers once (TAL-182): its layout, acknowledgement, launch queue and replay.
@MainActor
final class WhatsNewHostedTests: XCTestCase {
    private var defaults: UserDefaults!

    override func setUp() async throws {
        let name = "WhatsNewHostedTests.\(UUID())"
        defaults = UserDefaults(suiteName: name)
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: name) }
    }

    private func announcement(_ version: String = "1.1.0", rows: Int = 4) -> WhatsNewAnnouncement {
        let authored: [(String, String, String)] = [
            ("chat", "Pinned chats", "Keep the conversations you use most at the top of the list."),
            ("voice", "Dictation", "Speak your message and Talaria types it for you."),
            ("attachment", "Attach any file", "Add documents from Files to a message."),
            ("notifications", "Calmer notifications", "Alerts from the same chat now arrive together."),
        ]
        return WhatsNewAnnouncement(
            schemaVersion: 1, id: "app-\(version)", component: "app", version: version,
            sourceCommit: String(repeating: "a", count: 40),
            rows: authored.prefix(rows).enumerated().map { index, row in
                .init(id: "TAL-\(index + 1)-1", icon: row.0, title: row.1, description: row.2)
            }
        )
    }

    private var acknowledged: [String] {
        defaults.stringArray(forKey: WhatsNewAnnouncement.acknowledgedKey) ?? []
    }

    @discardableResult
    private func requireHeading(in window: UIWindow, _ message: String = "What's New is presented",
                                file: StaticString = #filePath, line: UInt = #line) async throws -> NSObject {
        let heading = await awaitElement(in: window, label: WhatsNewSheet.title)
        return try XCTUnwrap(heading, message, file: file, line: line)
    }

    // MARK: - Layout

    func testSheetReadsHeadingThenAuthoredRowsThenOneContinue() throws {
        let announcement = announcement()
        let window = try hostWindow(WhatsNewSheet(announcement: announcement, defaults: defaults))
        let elements = HostedAccessibility.elements(in: window)
        let labels = elements.compactMap(\.accessibilityLabel)
        // Exactly the heading, one element per row (its decorative icon folded away) and Continue: no category
        // headings, cards, pager, rating or Try It actions.
        XCTAssertEqual(labels.count, announcement.rows.count + 2, "\(labels)")
        XCTAssertEqual(labels.first, WhatsNewSheet.title)
        XCTAssertTrue(elements.first?.accessibilityTraits.contains(.header) == true)
        for (index, row) in announcement.rows.enumerated() {
            let label = labels[index + 1]
            XCTAssertTrue(label.contains(row.title) && label.contains(row.description), "Row \(index) reads \(label)")
        }
        XCTAssertEqual(labels.last, "Continue")
        XCTAssertEqual(elements.filter { $0.accessibilityTraits.contains(.button) }.count, 1)
        for absent in ["Added", "Changed", "Fixed", "Security", "Try It", "Rate"] {
            XCTAssertFalse(labels.contains { $0.hasPrefix(absent) }, absent)
        }
        XCTAssertFalse(window.containsView(ofType: UIPageControl.self))
        attachHostedScreenshot(window, name: "whats-new-phone-light")
    }

    func testOneRowAndUnknownIconStillRender() throws {
        let one = WhatsNewAnnouncement(
            schemaVersion: 1, id: "app-1.2.0", component: "app", version: "1.2.0",
            sourceCommit: String(repeating: "a", count: 40),
            rows: [.init(id: "TAL-1-1", icon: "future-icon", title: "Something new", description: "Synthetic.")]
        )
        let window = try hostWindow(WhatsNewSheet(announcement: one, defaults: defaults))
        XCTAssertEqual(HostedAccessibility.labels(in: window).count, 3)
        XCTAssertEqual(WhatsNewSheet.symbol(for: "future-icon"), "sparkles")
    }

    func testLargestTextScrollsAndKeepsContinueOnScreenAcrossLayouts() throws {
        let layouts: [(String, CGSize, UIUserInterfaceStyle, UIContentSizeCategory)] = [
            ("phone-dark", HostedSize.phone, .dark, .large),
            ("phone-ax5", HostedSize.phone, .light, .accessibilityExtraExtraExtraLarge),
            ("duo-outer", HostedSize.duoOuter, .dark, .large),
            ("duo-inner", HostedSize.duoInner, .light, .large),
        ]
        for (name, size, style, category) in layouts {
            let window = try hostWindow(WhatsNewSheet(announcement: announcement(), defaults: defaults), size: size) {
                $0.userInterfaceStyle = style
                $0.preferredContentSizeCategory = category
            }
            let scroll = try XCTUnwrap(window.firstView(ofType: UIScrollView.self), name)
            let continueButton = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Continue"), name)
            let frame = continueButton.accessibilityFrame
            XCTAssertTrue(window.bounds.contains(frame), "\(name): Continue at \(frame) leaves \(window.bounds)")
            if category.isAccessibilityCategory {
                XCTAssertGreaterThan(scroll.contentSize.height, scroll.bounds.height, "\(name): the rows scroll")
            }
            attachHostedScreenshot(window, name: "whats-new-\(name)")
        }
    }

    func testOnboardingRowsKeepTheirLook() throws {
        let window = try hostWindow(OnboardingFeaturesPage().background(Color.black))
        XCTAssertNotNil(HostedAccessibility.elements(in: window, labelContaining: "Chat with your Hermes agent").first)
        attachHostedScreenshot(window, name: "onboarding-features")
    }

    // MARK: - Acknowledgement

    func testContinueAndSwipeAcknowledgeButAnOpenSheetDoesNot() async throws {
        let presenter = WhatsNewPresenter(pending: nil, defaults: defaults)
        let window = try hostWindow(WhatsNewHost(presenter: presenter))

        presenter.presented = announcement("1.1.0")
        try await requireHeading(in: window)
        XCTAssertEqual(acknowledged, [], "Showing it is not seeing it: a process ending here offers it again")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        let closed = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(closed)
        XCTAssertEqual(acknowledged, ["app-1.1.0"])
        XCTAssertNil(presenter.presented)

        presenter.presented = announcement("1.2.0")
        try await requireHeading(in: window)
        // A swipe ends in the same dismissal of the presented controller.
        window.rootViewController?.presentedViewController?.dismiss(animated: false)
        let swiped = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(swiped)
        XCTAssertEqual(acknowledged, ["app-1.1.0", "app-1.2.0"])
    }

    // MARK: - Launch queue

    func testPendingAnnouncementWaitsForAnotherPresentationToClose() async throws {
        let presenter = WhatsNewPresenter(pending: announcement(), defaults: defaults)
        let host = WhatsNewHost(presenter: presenter)
        let window = try hostWindow(host)
        host.state.showsOther = true
        _ = try await requireElement(in: window, label: "Synthetic dialog")

        let offer = Task { await presenter.offerWhenNothingIsPresented(interval: .milliseconds(50)) }
        addTeardownBlock { offer.cancel() }
        settle(0.5)
        XCTAssertNil(presenter.presented, "What's New never covers a sheet, alert or sign-in already up")
        XCTAssertNil(HostedAccessibility.element(in: window, label: WhatsNewSheet.title))

        host.state.showsOther = false
        try await requireHeading(in: window, "Offered once the other presentation closed")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        await offer.value
        settle(0.2)
        XCTAssertNil(presenter.presented, "It is offered once per launch")
    }

    func testUnconfiguredLaunchOffersItOverOnboarding() async throws {
        let keychain = EmptyKeychain()
        let registryDefaults = try XCTUnwrap(UserDefaults(suiteName: "WhatsNewHostedTests.registry.\(UUID())"))
        let authManager = AuthManager(
            keychain: keychain,
            headerStore: .shared,
            cookieStorage: URLSessionConfiguration.ephemeral.httpCookieStorage!,
            profileEntityCache: ProfileEntityCache(defaults: nil),
            serverRegistry: ServerRegistry(keychain: keychain, identityDefaults: registryDefaults)
        )
        XCTAssertEqual(authManager.state, .unconfigured)
        let window = try hostLaunch(authManager: authManager, presenter: WhatsNewPresenter(pending: announcement(), defaults: defaults))

        try await requireHeading(in: window)
        attachHostedScreenshot(window, name: "whats-new-over-onboarding")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertEqual(authManager.state, .unconfigured)
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Control your Hermes agent").isEmpty,
                       "Onboarding is still where it was")
        XCTAssertEqual(acknowledged, ["app-1.1.0"])
    }

    func testSignedInAndSignedOutLaunchesOfferIt() async throws {
        let fixture = try FixtureApp(for: self)
        let authManager = fixture.environment.authManager
        guard case .loggedIn = authManager.state else { return XCTFail("The fixture starts signed in") }
        let signedIn = try hostLaunch(authManager: authManager, cache: fixture.cache,
                                      presenter: WhatsNewPresenter(pending: announcement("1.1.0"), defaults: defaults))
        try await requireHeading(in: signedIn)
        HostedAccessibility.activate(try await requireElement(in: signedIn, label: "Continue"))
        _ = await awaitNoElement(in: signedIn) { $0.accessibilityLabel == WhatsNewSheet.title }
        guard case .loggedIn = authManager.state else { return XCTFail("Closing it leaves the session alone") }
        signedIn.isHidden = true

        await authManager.signOut()
        // Signing out of the only server returns to onboarding.
        XCTAssertEqual(authManager.state, .unconfigured)
        let loggedOut = try hostLaunch(authManager: authManager, cache: fixture.cache,
                                       presenter: WhatsNewPresenter(pending: announcement("1.2.0"), defaults: defaults))
        try await requireHeading(in: loggedOut)
        HostedAccessibility.activate(try await requireElement(in: loggedOut, label: "Continue"))
        _ = await awaitNoElement(in: loggedOut) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertEqual(acknowledged, ["app-1.1.0", "app-1.2.0"])
    }

    // MARK: - Settings replay

    func testAboutReplaysTheSameSheetOnlyWhenTheBuildHasOne() async throws {
        let none = try hostWindow(NavigationStack { AboutSettingsView(whatsNew: nil, defaults: defaults) })
        _ = try await requireElement(in: none, label: "Version")
        XCTAssertNil(HostedAccessibility.element(in: none, identifier: "settings-whats-new"))
        none.isHidden = true

        let window = try hostWindow(NavigationStack { AboutSettingsView(whatsNew: announcement(), defaults: defaults) })
        let found = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-whats-new" }
        let row = try XCTUnwrap(found)
        HostedAccessibility.activate(row)
        try await requireHeading(in: window)
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Pinned chats").isEmpty)
        attachHostedScreenshot(window, name: "whats-new-settings-replay")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        // A replay counts as seen, so it never comes back on its own.
        XCTAssertEqual(acknowledged, ["app-1.1.0"])
    }

    private func hostLaunch(authManager: AuthManager, cache: ModelContainer? = nil,
                            presenter: WhatsNewPresenter) throws -> UIWindow {
        let container = try cache ?? ModelContainer(
            for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        )
        return try hostWindow(
            ContentView(authManager: authManager, whatsNew: presenter)
                .environment(\.scenePhase, .active)
                .modelContainer(container)
        )
    }
}

/// A screen that can hold another sheet up while the presenter's announcement waits.
@MainActor
private struct WhatsNewHost: View {
    @Observable
    final class Other {
        var showsOther = false
    }

    @Bindable var presenter: WhatsNewPresenter
    let state = Other()

    var body: some View {
        @Bindable var other = state
        Color.clear
            .sheet(isPresented: $other.showsOther) { Text("Synthetic dialog") }
            .whatsNewPresentation($presenter.presented, defaults: presenter.defaults)
    }
}

/// A keychain with no saved server: a fresh, unconfigured install.
private final class EmptyKeychain: KeychainStoring {
    private var values: [String: String] = [:]
    func save(_ value: String, forKey key: KeychainStore.Key) throws { values[key.rawValue] = value }
    func load(_ key: KeychainStore.Key) throws -> String? { values[key.rawValue] }
    func delete(_ key: KeychainStore.Key) throws { values[key.rawValue] = nil }
    func save(_ value: String, forKey key: KeychainStore.Key, scope: String) throws {
        values[KeychainStore.scopedKey(key, scope: scope)] = value
    }
    func load(_ key: KeychainStore.Key, scope: String) throws -> String? { values[KeychainStore.scopedKey(key, scope: scope)] }
    func delete(_ key: KeychainStore.Key, scope: String) throws { values[KeychainStore.scopedKey(key, scope: scope)] = nil }
}

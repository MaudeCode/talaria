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

    /// A synthetic announcement whose rows are tickets `firstTicket` onward.
    private func announcement(_ version: String = "1.1.0", rows: Int = 4, firstTicket: Int = 1) -> WhatsNewAnnouncement {
        let authored: [(String, String, String)] = [
            ("chat", "Pinned chats", "Keep the conversations you use most at the top of the list."),
            ("voice", "Dictation", "Speak your message and Talaria types it for you."),
            ("attachment", "Attach any file", "Add documents from Files to a message."),
            ("notifications", "Calmer notifications", "Alerts from the same chat now arrive together."),
        ]
        return WhatsNewAnnouncement(
            schemaVersion: 1, id: "app-\(version)", component: "app", version: version,
            sourceCommit: String(repeating: "a", count: 40),
            rows: (0..<rows).map { index in
                let row = index < authored.count ? authored[index] : ("chat", "Feature \(index + 1)", "Synthetic row \(index + 1).")
                return .init(id: "TAL-\(firstTicket + index)-1", icon: row.0, title: row.1, description: row.2)
            }
        )
    }

    private var acknowledged: [String] {
        defaults.stringArray(forKey: WhatsNewAnnouncement.acknowledgedRowsKey) ?? []
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
        // One page, then three pages of a nine-row announcement (TAL-2173), whose controls all stay on screen too.
        for (rows, controls) in [(4, ["Continue"]), (9, ["Continue", Self.skip, "Previous page", "Next page", "Page 1 of 3"])] {
            for (name, size, style, category) in layouts {
                let name = "\(name)-\(rows)-rows"
                let window = try hostWindow(WhatsNewSheet(announcement: announcement(rows: rows), defaults: defaults), size: size) {
                    $0.userInterfaceStyle = style
                    $0.preferredContentSizeCategory = category
                }
                for label in controls {
                    let control = try XCTUnwrap(HostedAccessibility.element(in: window, label: label), "\(name): \(label)")
                    let frame = control.accessibilityFrame
                    XCTAssertTrue(window.bounds.contains(frame), "\(name): \(label) at \(frame) leaves \(window.bounds)")
                }
                if category.isAccessibilityCategory {
                    // A page's own vertical scroll, not the pager's horizontal one.
                    let scroll = window.firstView(ofType: UIScrollView.self) { $0.contentSize.height > $0.bounds.height }
                    XCTAssertNotNil(scroll, "\(name): the rows scroll")
                }
                attachHostedScreenshot(window, name: "whats-new-\(name)")
            }
        }
    }

    // MARK: - Pages (TAL-2173)

    private static let skip = "Skip, I like surprises"

    /// The row titles on the page in view: the pager keeps its neighbours mounted beside the window.
    private func visibleRowTitles(in window: UIWindow, of announcement: WhatsNewAnnouncement) -> [String] {
        let elements = HostedAccessibility.elements(in: window).filter { window.bounds.intersects($0.accessibilityFrame) }
        return announcement.rows.map(\.title).filter { title in
            elements.contains { $0.accessibilityLabel?.hasPrefix(title) == true }
        }
    }

    func testMoreThanFourRowsPageFourAtATimeWithDotsAndArrows() throws {
        // The sheet's safe area on the Duo outer screen, measured on the phone: its status column at the right edge
        // narrows every row (TAL-2173 phone check). nil keeps the host's own.
        let outerScreen = UIEdgeInsets(top: 8, left: 0, bottom: 35, right: 77)
        let layouts: [(String, CGSize, UIUserInterfaceStyle, UIEdgeInsets?)] = [
            ("phone-light", HostedSize.phone, .light, nil), ("phone-dark", HostedSize.phone, .dark, nil),
            ("duo-outer-light", HostedSize.duoOuter, .light, outerScreen),
            ("duo-outer-dark", HostedSize.duoOuter, .dark, outerScreen),
        ]
        let nine = announcement(rows: 9)
        let titles = nine.rows.map(\.title)
        for (name, size, style, insets) in layouts {
            func host(_ announcement: WhatsNewAnnouncement) throws -> UIWindow {
                let window = try hostWindow(WhatsNewSheet(announcement: announcement, defaults: defaults), size: size) {
                    $0.userInterfaceStyle = style
                }
                if let insets, let root = window.rootViewController {
                    // The host simulator's own insets differ from the Duo's; top them up, or take them back, to the Duo's.
                    let host = root.view.safeAreaInsets
                    root.additionalSafeAreaInsets = UIEdgeInsets(top: insets.top - host.top, left: insets.left - host.left,
                                                                 bottom: insets.bottom - host.bottom, right: insets.right - host.right)
                    window.layoutIfNeeded()
                    settle()
                    XCTAssertEqual(root.view.safeAreaInsets, insets, "\(name): the modelled safe area")
                }
                return window
            }
            // Paging leaves the heading where a one-page sheet has it.
            let onePage = try host(announcement(rows: 4))
            let onePageHeading = try XCTUnwrap(HostedAccessibility.element(in: onePage, label: WhatsNewSheet.title), name)
                .accessibilityFrame
            onePage.isHidden = true
            let window = try host(nine)
            XCTAssertEqual(visibleRowTitles(in: window, of: nine), Array(titles[0..<4]), "\(name): it opens on the first page")
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Page 1 of 3"), name)
            let previous = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Previous page"), name)
            let next = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Next page"), name)
            // A full page reads whole above the controls, without scrolling.
            let lastRow = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: titles[3])
                .first { window.bounds.intersects($0.accessibilityFrame) }, name)
            XCTAssertLessThanOrEqual(lastRow.accessibilityFrame.maxY, previous.accessibilityFrame.minY,
                                     "\(name): the fourth row runs under the page controls")
            // Frames come back as 43.99999999999997 for a 44pt target; hit areas are checked to the whole point.
            for arrow in [previous, next] {
                XCTAssertGreaterThanOrEqual(arrow.accessibilityFrame.width.rounded(), 44, "\(name): \(arrow.accessibilityLabel ?? "")")
                XCTAssertGreaterThanOrEqual(arrow.accessibilityFrame.height.rounded(), 44, "\(name): \(arrow.accessibilityLabel ?? "")")
            }
            let continueFrame = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Continue"), name).accessibilityFrame
            let headings = { HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == WhatsNewSheet.title } }
            XCTAssertEqual(headings().count, 1, "\(name): one heading over every page")
            let headingFrame = try XCTUnwrap(headings().first, name).accessibilityFrame
            XCTAssertEqual(headingFrame, onePageHeading, "\(name): the heading sits where a one-page sheet has it")
            XCTAssertTrue(previous.accessibilityTraits.contains(.notEnabled), "\(name): no page before the first")
            XCTAssertFalse(next.accessibilityTraits.contains(.notEnabled), name)
            attachHostedScreenshot(window, name: "whats-new-pages-first-\(name)")

            HostedAccessibility.activate(next)
            settle(0.3)
            XCTAssertEqual(visibleRowTitles(in: window, of: nine), Array(titles[4..<8]), name)
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Page 2 of 3"), "\(name): the current dot moved")
            XCTAssertEqual(headings().map(\.accessibilityFrame), [headingFrame], "\(name): the heading stays put as the rows turn")

            HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Next page"), name))
            settle(0.3)
            XCTAssertEqual(visibleRowTitles(in: window, of: nine), [titles[8]], name)
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Page 3 of 3"), name)
            let last = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Next page"), name)
            XCTAssertTrue(last.accessibilityTraits.contains(.notEnabled), "\(name): no page after the last")
            XCTAssertEqual(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Continue"), name).accessibilityFrame,
                           continueFrame, "\(name): Continue stays under the thumb on the last page")
            XCTAssertFalse(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Previous page"), name)
                .accessibilityTraits.contains(.notEnabled), name)
            attachHostedScreenshot(window, name: "whats-new-pages-last-\(name)")
            window.isHidden = true
        }
    }

    func testContinueTurnsThePageAndTheSkipLineSitsUnderItUntilTheLast() async throws {
        let presenter = WhatsNewPresenter(pending: nil, defaults: defaults)
        let window = try hostWindow(WhatsNewHost(presenter: presenter))
        let nine = announcement(rows: 9)
        presenter.presented = nine
        try await requireHeading(in: window)

        for page in 1...2 {
            _ = try await requireElement(in: window, label: "Page \(page) of 3")
            let continueButton = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Continue"))
            let skip = try XCTUnwrap(HostedAccessibility.element(in: window, label: Self.skip), "Page \(page)")
            XCTAssertGreaterThan(skip.accessibilityFrame.minY, continueButton.accessibilityFrame.minY, "Under Continue")
            XCTAssertGreaterThanOrEqual(skip.accessibilityFrame.height.rounded(), 44)
            HostedAccessibility.activate(continueButton)
        }
        _ = try await requireElement(in: window, label: "Page 3 of 3")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: WhatsNewSheet.title), "Continue kept it open")
        XCTAssertNil(HostedAccessibility.element(in: window, label: Self.skip), "No skip line on the last page")
        XCTAssertEqual(acknowledged, [])
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Continue")))
        let closed = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(closed, "Continue on the last page closes it")
        XCTAssertEqual(acknowledged, nine.rows.map(\.id))
    }

    func testSkipAndSwipeFromTheFirstPageAcknowledgeEveryRow() async throws {
        let presenter = WhatsNewPresenter(pending: nil, defaults: defaults)
        let window = try hostWindow(WhatsNewHost(presenter: presenter))
        let skipped = announcement("1.1.0", rows: 9)
        presenter.presented = skipped
        try await requireHeading(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: Self.skip))
        let closed = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(closed, "The skip line closes it")
        XCTAssertEqual(acknowledged, skipped.rows.map(\.id), "Every row, shown or not")

        let swiped = announcement("1.2.0", rows: 9, firstTicket: 10)
        presenter.presented = swiped
        try await requireHeading(in: window)
        window.rootViewController?.presentedViewController?.dismiss(animated: false)
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertEqual(acknowledged, (skipped.rows + swiped.rows).map(\.id))
        XCTAssertTrue(skipped.isAcknowledged(defaults: defaults) && swiped.isAcknowledged(defaults: defaults),
                      "A later launch offers none of them")
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

        let first = announcement("1.1.0", rows: 2)
        presenter.presented = first
        try await requireHeading(in: window)
        XCTAssertEqual(acknowledged, [], "Showing it is not seeing it: a process ending here offers it again")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        let closed = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(closed)
        XCTAssertEqual(acknowledged, first.rows.map(\.id), "Closing it acknowledges the rows it showed")
        XCTAssertNil(presenter.presented)

        let second = announcement("1.2.0", rows: 2, firstTicket: 3)
        presenter.presented = second
        try await requireHeading(in: window)
        // A swipe ends in the same dismissal of the presented controller.
        window.rootViewController?.presentedViewController?.dismiss(animated: false)
        let swiped = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertTrue(swiped)
        XCTAssertEqual(acknowledged, (first.rows + second.rows).map(\.id))
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

    func testAReplayWhileTheOfferWaitsCancelsIt() async throws {
        let queued = announcement()
        let presenter = WhatsNewPresenter(pending: queued, defaults: defaults)
        let host = WhatsNewHost(presenter: presenter)
        let window = try hostWindow(host)
        host.state.showsOther = true
        _ = try await requireElement(in: window, label: "Synthetic dialog")
        let offer = Task { await presenter.offerWhenNothingIsPresented(interval: .milliseconds(50)) }
        addTeardownBlock { offer.cancel() }
        settle(0.2)

        // Settings is open over the launch, and its About replay closes with every packaged row acknowledged.
        queued.acknowledge(defaults: defaults)
        host.state.showsOther = false
        let offered = await awaitCondition(timeout: 2) { presenter.presented != nil }
        XCTAssertFalse(offered, "Rows acknowledged by a replay are not offered again")
        XCTAssertNil(HostedAccessibility.element(in: window, label: WhatsNewSheet.title))
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
        let offered = announcement()
        let window = try hostLaunch(authManager: authManager, presenter: WhatsNewPresenter(pending: offered, defaults: defaults))

        try await requireHeading(in: window)
        attachHostedScreenshot(window, name: "whats-new-over-onboarding")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertEqual(authManager.state, .unconfigured)
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Control your Hermes agent").isEmpty,
                       "Onboarding is still where it was")
        XCTAssertEqual(acknowledged, offered.rows.map(\.id))
    }

    func testSignedInAndSignedOutLaunchesOfferIt() async throws {
        let fixture = try FixtureApp(for: self)
        let authManager = fixture.environment.authManager
        guard case .loggedIn = authManager.state else { return XCTFail("The fixture starts signed in") }
        let first = announcement("1.1.0", rows: 2)
        let signedIn = try hostLaunch(authManager: authManager, cache: fixture.cache,
                                      presenter: WhatsNewPresenter(pending: first, defaults: defaults))
        try await requireHeading(in: signedIn)
        HostedAccessibility.activate(try await requireElement(in: signedIn, label: "Continue"))
        _ = await awaitNoElement(in: signedIn) { $0.accessibilityLabel == WhatsNewSheet.title }
        guard case .loggedIn = authManager.state else { return XCTFail("Closing it leaves the session alone") }
        signedIn.isHidden = true

        await authManager.signOut()
        // Signing out of the only server returns to onboarding.
        XCTAssertEqual(authManager.state, .unconfigured)
        let second = announcement("1.2.0", rows: 2, firstTicket: 3)
        let loggedOut = try hostLaunch(authManager: authManager, cache: fixture.cache,
                                       presenter: WhatsNewPresenter(pending: second, defaults: defaults))
        try await requireHeading(in: loggedOut)
        HostedAccessibility.activate(try await requireElement(in: loggedOut, label: "Continue"))
        _ = await awaitNoElement(in: loggedOut) { $0.accessibilityLabel == WhatsNewSheet.title }
        XCTAssertEqual(acknowledged, (first.rows + second.rows).map(\.id))
    }

    // MARK: - Settings replay

    func testAboutReplaysTheSameSheetOnlyWhenTheBuildHasOne() async throws {
        let none = try hostWindow(NavigationStack { AboutSettingsView(whatsNew: nil, defaults: defaults) })
        _ = try await requireElement(in: none, label: "Version")
        XCTAssertNil(HostedAccessibility.element(in: none, identifier: "settings-whats-new"))
        none.isHidden = true

        let installed = announcement()
        let window = try hostWindow(NavigationStack { AboutSettingsView(whatsNew: installed, defaults: defaults) })
        let found = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "settings-whats-new" }
        let row = try XCTUnwrap(found)
        HostedAccessibility.activate(row)
        try await requireHeading(in: window)
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Pinned chats").isEmpty)
        attachHostedScreenshot(window, name: "whats-new-settings-replay")
        HostedAccessibility.activate(try await requireElement(in: window, label: "Continue"))
        _ = await awaitNoElement(in: window) { $0.accessibilityLabel == WhatsNewSheet.title }
        // A replay shows and acknowledges every packaged row, so none comes back on its own.
        XCTAssertEqual(acknowledged, installed.rows.map(\.id))
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

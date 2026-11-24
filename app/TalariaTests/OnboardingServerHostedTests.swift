import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// First-run sign-in and server switching on the App's real root (TAL-70). Server actions run through the Settings
/// server views in a second window on the same `AuthManager`, the calls the Settings cog's server menu makes; the root
/// window shows the outcome in its sidebar. The menu's own presentation is a phone check (`docs/phone-checks.md`).
@MainActor
final class OnboardingServerHostedTests: XCTestCase {
    private let firstServerTitle = UITestFixtureURLProtocol.sessionTitle
    private let secondServerTitle = UITestFixtureURLProtocol.secondServerSessionTitle

    func testFirstRunSignInLandsOnNewChatWithTheServersChats() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.authRequiredArgument], configured: false, for: self)
        let window = try hostWindow(fixture.root())
        try await connect(in: window, password: UITestFixtureEnvironment.fixturePassword)

        _ = try await requireElement(in: window, "Signing in did not land on New Chat") {
            $0.accessibilityLabel?.hasPrefix("New Chat,") == true
        }
        XCTAssertEqual(fixture.environment.authManager.state, .loggedIn(server: UITestFixtureEnvironment.serverURL))
        try await expectSidebar(in: window, lists: firstServerTitle, notListing: secondServerTitle)
    }

    func testWrongPasswordStaysOnConnectWithTheError() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.authRequiredArgument], configured: false, for: self)
        let window = try hostWindow(fixture.root())
        try await connect(in: window, password: "not-the-password")

        let message = APIError.unauthorized.localizedDescription
        _ = try await requireElement(in: window, "The connect page showed no sign-in error") {
            $0.accessibilityLabel?.contains(message) == true
        }
        XCTAssertNotNil(connectButton(in: window), "A refused password left the connect page")
        XCTAssertEqual(fixture.environment.authManager.state, .unconfigured)
        XCTAssertEqual(fixture.environment.authManager.servers, [], "A refused password registered a server")
    }

    func testAddingAServerSwitchesToItsChats() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.root())
        try await expectSidebar(in: window, lists: firstServerTitle, notListing: secondServerTitle)

        let add = try hostWindow(AddServerView(authManager: fixture.environment.authManager))
        // The URL row's field is labelled by its placeholder.
        try await enter(UITestFixtureEnvironment.secondServerURL.absoluteString, intoField: "100.64.0.1:8787", in: add)
        try await press("Add", in: add)

        let switched = await awaitCondition {
            fixture.environment.authManager.state == .loggedIn(server: UITestFixtureEnvironment.secondServerURL)
        }
        XCTAssertTrue(switched, "Adding a server did not make it active")
        try await expectSidebar(in: window, lists: secondServerTitle, notListing: firstServerTitle)
    }

    func testSwitchingBackShowsOnlyThatServersChats() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.root())
        let first = try await addSecondServer(to: fixture)
        try await expectSidebar(in: window, lists: secondServerTitle, notListing: firstServerTitle)

        let detail = try hostWindow(NavigationStack { ServerDetailView(authManager: fixture.environment.authManager, account: first) })
        try await press("Switch to This Server", in: detail)

        try await expectSidebar(in: window, lists: firstServerTitle, notListing: secondServerTitle)
        XCTAssertEqual(fixture.environment.authManager.activeServerID, first.id)
    }

    func testSignOutAsksFirstThenMovesToTheOtherServer() async throws {
        let fixture = try FixtureApp(for: self)
        let auth = fixture.environment.authManager
        let window = try hostWindow(fixture.root())
        let first = try await addSecondServer(to: fixture)
        let second = try XCTUnwrap(auth.servers.first { $0.id == auth.activeServerID })
        let detail = try hostWindow(NavigationStack { ServerDetailView(authManager: auth, account: second) })

        try await confirm("Sign Out of This Server", alertTitle: "Sign out of this server?", answer: "Cancel", in: detail)
        XCTAssertEqual(auth.servers.map(\.id), [first.id, second.id], "Cancel signed out")
        XCTAssertEqual(auth.activeServerID, second.id, "Cancel switched servers")
        try await expectSidebar(in: window, lists: secondServerTitle, notListing: firstServerTitle)

        try await confirm("Sign Out of This Server", alertTitle: "Sign out of this server?",
                          answer: "Sign Out of This Server", in: detail)
        // The App tears this page down with the signed-out server's screens, so it never resets its button's spinner.
        // Left up, the spinner commits every frame, which grew a CI runner's render server past a gigabyte over
        // repeated attempts.
        HostedScene.dismantle(detail)
        try await expectSidebar(in: window, lists: firstServerTitle, notListing: secondServerTitle)
        XCTAssertEqual(auth.servers.map(\.id), [first.id], "The signed-out server is still listed")
        XCTAssertEqual(auth.activeServerID, first.id)
    }

    func testRemovingAServerAsksFirstAndKeepsTheActiveOne() async throws {
        let fixture = try FixtureApp(for: self)
        let auth = fixture.environment.authManager
        let window = try hostWindow(fixture.root())
        let first = try await addSecondServer(to: fixture)
        let secondID = try XCTUnwrap(auth.activeServerID)
        let detail = try hostWindow(NavigationStack { ServerDetailView(authManager: auth, account: first) })

        try await confirm("Remove Server", alertTitle: "Remove this server?", answer: "Cancel", in: detail)
        XCTAssertEqual(auth.servers.map(\.id), [first.id, secondID], "Cancel removed the server")
        try await expectSidebar(in: window, lists: secondServerTitle, notListing: firstServerTitle)

        try await confirm("Remove Server", alertTitle: "Remove this server?", answer: "Remove Server", in: detail)
        let removed = await awaitCondition { auth.servers.map(\.id) == [secondID] }
        XCTAssertTrue(removed, "The removed server is still listed: \(auth.servers.map(\.id))")
        XCTAssertEqual(auth.activeServerID, secondID, "Removing another server changed the active one")
        try await expectSidebar(in: window, lists: secondServerTitle, notListing: firstServerTitle)
    }

    func testUnauthorizedListAsksToSignInAndRecovers() async throws {
        let fixture = try FixtureApp([UITestFixtureEnvironment.authRequiredArgument], for: self)
        let auth = fixture.environment.authManager
        let window = try hostWindow(fixture.root())

        let asked = await awaitCondition { auth.pendingReauthentication == UITestFixtureEnvironment.serverURL }
        XCTAssertTrue(asked, "A 401 from the session list did not ask to sign in again")
        _ = try await requireElement(in: window, label: "Your session expired. Sign in again.")
        try await enter(UITestFixtureEnvironment.fixturePassword, intoField: "Password", in: window)
        let signIn = try await requireElement(in: window, "The sheet offers no Sign In") {
            HostedAccessibility.identifier(of: $0) == "ReauthenticateSignIn"
                && !$0.accessibilityTraits.contains(.notEnabled)
        }
        XCTAssertTrue(HostedAccessibility.activate(signIn))

        let recovered = await awaitCondition { auth.pendingReauthentication == nil }
        XCTAssertTrue(recovered, "Signing in did not close the sheet")
        let closed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(closed, "The sign-in sheet stayed up")
        try await expectSidebar(in: window, lists: firstServerTitle, notListing: secondServerTitle)
    }

    // MARK: - Helpers

    /// Opens the connect page from the welcome page and submits the fixture server with `password`.
    private func connect(in window: UIWindow, password: String) async throws {
        try await press("Already have a server?", in: window)
        try await enter(UITestFixtureEnvironment.serverURL.absoluteString, intoField: "Server URL", in: window)
        try await enter(password, intoField: "Password", in: window)
        let enabled = await awaitCondition {
            self.connectButton(in: window)?.accessibilityTraits.contains(.notEnabled) == false
        }
        XCTAssertTrue(enabled, "Connect never enabled")
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(connectButton(in: window))))
    }

    /// The connect page's Connect button, not its "Connect" heading.
    private func connectButton(in window: UIWindow) -> NSObject? {
        HostedAccessibility.elements(in: window).first {
            $0.accessibilityLabel == "Connect" && $0.accessibilityTraits.contains(.button)
        }
    }

    /// Activates the button labelled `label`, not a heading or section title with the same words.
    private func press(_ label: String, in window: UIWindow, file: StaticString = #filePath, line: UInt = #line) async throws {
        let button = try await requireElement(in: window, "Missing the \(label) button", file: file, line: line) {
            $0.accessibilityLabel == label && $0.accessibilityTraits.contains(.button)
        }
        XCTAssertTrue(HostedAccessibility.activate(button), "\(label) did not run", file: file, line: line)
    }

    /// Fills the field labelled `label` through its text and editing-changed action, never by focusing it: a focused
    /// password field that leaves the screen makes the keyboard offer to save the password, and that offer stays
    /// presented in the keyboard's window, so a later test that waits for nothing to be presented waits forever.
    private func enter(_ text: String, intoField label: String, in window: UIWindow,
                       file: StaticString = #filePath, line: UInt = #line) async throws {
        // SwiftUI labels the field's accessibility element, not the text field under it, so the field is the one that
        // holds that element, or whose placeholder reads `label`.
        func field() -> UITextField? {
            let labelled = HostedAccessibility.elements(in: window).filter { $0.accessibilityLabel == label }
                .map { CGPoint(x: $0.accessibilityFrame.midX, y: $0.accessibilityFrame.midY) }
            return window.views(ofType: UITextField.self) { field in
                field.placeholder == label || labelled.contains { field.accessibilityFrame.contains($0) }
            }.first
        }
        let found = await awaitCondition { field() != nil }
        let fields = window.views(ofType: UITextField.self).map { "\($0.placeholder ?? "nil") \($0.accessibilityFrame)" }
        XCTAssertTrue(found, "Missing the \(label) field among \(fields)", file: file, line: line)
        let input = try XCTUnwrap(field(), file: file, line: line)
        input.text = text
        input.sendActions(for: .editingChanged)
        // The field's binding reaches SwiftUI's state on its next render.
        if let scene = window.windowScene { await awaitDisplayUpdates(2, in: scene) }
    }

    /// Activates `button` on a server page, checks its alert's title, then answers it with `answer`.
    private func confirm(_ button: String, alertTitle: String, answer: String, in window: UIWindow,
                         file: StaticString = #filePath, line: UInt = #line) async throws {
        try await press(button, in: window, file: file, line: line)
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented, "\(button) asked for no confirmation", file: file, line: line)
        XCTAssertEqual(alert.title, alertTitle, file: file, line: line)
        XCTAssertTrue(HostedAccessibility.tap(answer, in: alert), "The alert offers no \(answer)", file: file, line: line)
        let dismissed = await awaitCondition { window.rootViewController?.presentedViewController == nil }
        XCTAssertTrue(dismissed, "The alert stayed up", file: file, line: line)
    }

    /// Adds the second fixture server, which becomes active, and returns the first server's account.
    private func addSecondServer(to fixture: FixtureApp) async throws -> ServerAccount {
        let auth = fixture.environment.authManager
        let first = try XCTUnwrap(auth.servers.first)
        let outcome = await auth.addServer(serverURLString: UITestFixtureEnvironment.secondServerURL.absoluteString, password: "")
        XCTAssertEqual(outcome, .added(UITestFixtureEnvironment.secondServerURL), auth.lastErrorMessage ?? "")
        return first
    }

    /// Opens the root window's sidebar and checks it lists `title` and no row titled `other`: one server's chats never
    /// appear under another. A server change rebuilds the root, closing a sidebar opened before it, sometimes after a
    /// sign-out's logout request; so the sidebar is opened again inside the wait for the row.
    private func expectSidebar(in window: UIWindow, lists title: String, notListing other: String,
                               file: StaticString = #filePath, line: UInt = #line) async throws {
        // Each toggle is pressed once: a rebuilt root brings a new one, and pressing one still opening could close it.
        var pressed: ObjectIdentifier?
        let listed = await awaitCondition {
            let labels = HostedAccessibility.labels(in: window)
            if labels.contains(where: { $0.hasPrefix(title) }) { return true }
            if !labels.contains("Close navigation"),
               let toggle: NSObject = window.firstView(ofType: UIControl.self, where: { $0.accessibilityLabel == "Open navigation" })
                ?? HostedAccessibility.toolbarItem("Open navigation", in: window),
               pressed != ObjectIdentifier(toggle) {
                pressed = ObjectIdentifier(toggle)
                _ = HostedAccessibility.activate(toggle)
            }
            return false
        }
        XCTAssertTrue(listed, "The sidebar does not list \(title): \(HostedAccessibility.labels(in: window))",
                      file: file, line: line)
        let leaked = HostedAccessibility.elements(in: window).compactMap(\.accessibilityLabel).filter { $0.hasPrefix(other) }
        XCTAssertEqual(leaked, [], "The sidebar lists the other server's chats", file: file, line: line)
    }
}

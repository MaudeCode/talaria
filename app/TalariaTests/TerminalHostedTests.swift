import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1997: a `terminal_open` card and the read-only terminal view its Open pushes, drawn from the shared
/// `contracts/fixtures/terminal-view.json` on the phone and both Duo displays.
@MainActor
final class TerminalHostedTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func fixture() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("terminal-view")) as? [String: Any])
    }

    /// A transcript card for the fixture's terminal in a navigation stack whose Open pushes the terminal view, its reads
    /// answered from the fixture by cursor.
    private func transcript(stream: ScriptedSSEStreamingClient) throws -> some View {
        let root = try fixture()
        var bodies: [String: Data] = [:]
        for read in try XCTUnwrap(root["reads"] as? [[String: Any]]) {
            bodies[String(describing: try XCTUnwrap(read["after_event_id"]))] = try JSONSerialization.data(withJSONObject: XCTUnwrap(read["result"]))
        }
        MockURLProtocol.requestHandler = { request in
            let after = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "after_event_id" }?.value ?? ""
            return (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, bodies[after] ?? Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://terminal.test")!, session: URLSession(configuration: configuration))
        let reference = try DecisionReview.decoder.decode(TerminalRef.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(root["ref"])))
        let call = ToolCall(id: "call-terminal", name: "terminal_open", preview: nil, args: nil, resultView: ToolResultView(terminal: reference), isCompleted: true)
        return TerminalTranscript(call: call) { TerminalFollowModel(sessionID: "synthetic-session", reference: $0, client: client, stream: stream) }
    }

    func testOpenPushesTheTerminalWhichFollowsTheServersTextUntilTheShellExits() throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            let stream = ScriptedSSEStreamingClient(connectionScripts: [[.init(.ignored, lastEventID: "3"), .init(.ignored, lastEventID: "4")]])
            let window = try hostWindow(transcript(stream: stream), size: size)
            XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "Run the tests").isEmpty }, name)
            XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "npm test").isEmpty, name)
            attachHostedScreenshot(window, name: "terminal-card-\(name)")

            let open = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "terminal-open-term_0a1b2c3d4e5f6071"), name)
            XCTAssertTrue(HostedAccessibility.activate(open), name)
            XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "40%").isEmpty }, name)
            XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Running").isEmpty, name)
            let first = try XCTUnwrap(HostedAccessibility.elements(in: window, labelContaining: "> vitest run").first, name)
            XCTAssertLessThan(first.accessibilityFrame.minY, window.bounds.height / 3, "\(name): short output starts at the top")
            attachHostedScreenshot(window, name: "terminal-running-\(name)")

            XCTAssertTrue(waitUntil { !stream.startedURLs.isEmpty }, name)
            stream.playArmedConnectionScript()
            XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "Exited with code 0").isEmpty }, name)
            for line in ["> vitest run", "100% done", "PASS"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: line).isEmpty, "\(name): \(line)")
            }
            XCTAssertTrue(HostedAccessibility.elements(in: window, labelContaining: "40%").isEmpty, "\(name): the restated line replaced its old text")
            attachHostedScreenshot(window, name: "terminal-exited-\(name)")
        }
    }

    func testProfileBoundChatShowsTerminalDetailsWithoutOfferingOpen() async throws {
        let window = try await openChatWithTerminal(UITestFixtureEnvironment.terminalMemberArgument)
        attachHostedScreenshot(window, name: "terminal-profile-bound")
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "terminal-open-term_fixture"),
                     "A profile-bound session offered Open terminal")
        let terminalRequests = UITestFixtureURLProtocol.answeredPaths.withLock { paths in
            paths.filter { $0 == "/api/terminal/read" || $0 == "/api/terminal/output" }
        }
        XCTAssertTrue(terminalRequests.isEmpty, "The card started terminal requests: \(terminalRequests)")
    }

    func testOwnerChatCanOpenReadOnlyTerminal() async throws {
        let window = try await openChatWithTerminal(UITestFixtureEnvironment.terminalOwnerArgument)
        let open = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "terminal-open-term_fixture"
        }
        attachHostedScreenshot(window, name: "terminal-owner-card")
        XCTAssertTrue(HostedAccessibility.activate(open))
        _ = try await requireElement(in: window, label: "Checks passed.")
        attachHostedScreenshot(window, name: "terminal-owner-output")
    }

    func testLegacyServerChatStillOffersOpenTerminal() async throws {
        let window = try await openChatWithTerminal(UITestFixtureEnvironment.terminalLegacyArgument)
        _ = try await requireElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "terminal-open-term_fixture"
        }
    }

    private func openChatWithTerminal(_ scenario: String) async throws -> UIWindow {
        let fixture = try FixtureApp([scenario], for: self)
        await fixture.environment.authManager.refreshActivePerson()
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        let chat = try await requireElement(in: window) {
            $0.accessibilityLabel?.hasPrefix(UITestFixtureURLProtocol.sessionTitle) == true
        }
        XCTAssertTrue(HostedAccessibility.activate(chat))
        _ = try await requireElement(in: window, label: "Run fixture checks")
        _ = try await requireElement(in: window, label: "npm run check")
        return window
    }
}

/// The chat's push of an opened terminal (`ChatView.openedTerminal`), around one tool card.
private struct TerminalTranscript: View {
    let call: ToolCall
    let makeModel: (TerminalRef) -> TerminalFollowModel
    @State private var opened: TerminalFollowModel?

    var body: some View {
        NavigationStack {
            ScrollView { ToolCallCardView(toolCall: call).padding() }
                .chatEnvironmentAction(\.chatOpenTerminal) { opened = makeModel($0) }
                .navigationDestination(isPresented: Binding(get: { opened != nil }, set: { if !$0 { opened = nil } })) {
                    if let opened { TerminalOutputView(model: opened) }
                }
        }
    }
}

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

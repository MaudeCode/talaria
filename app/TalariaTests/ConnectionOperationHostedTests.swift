import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-1321: a chat's connection operation renders from the shared contract example alone, with accessible fields, a
/// masked credential, the server's links and moves, and pending and terminal feedback.
@MainActor
final class ConnectionOperationHostedTests: XCTestCase {
    private struct Sent: Equatable {
        let move: ConnectorOperationMove
        let env: [String: String]?
    }

    private func hostOperation(
        _ edit: (inout [String: Any]) -> Void = { _ in },
        running: Set<String> = [],
        error: String? = nil,
        onOpen: @escaping (URL) -> Void = { _ in },
        onDismiss: @escaping () -> Void = {},
        onMove: @escaping (Sent) -> Void = { _ in }
    ) throws -> UIWindow {
        try hostWindow(
            ConnectionOperationContent(
                operation: try operation(edit),
                runningTargets: running,
                errorMessage: error,
                onMove: { onMove(Sent(move: $0, env: $1)) },
                onDismiss: onDismiss
            )
            .environment(\.openURL, OpenURLAction { onOpen($0); return .handled })
        )
    }

    func testEveryTargetStateRendersWithItsServerMoves() throws {
        let window = try hostOperation()
        for label in ["Connect Apps", "Continue", "Gmail, Waiting for authorization", "Authorize Gmail", "Skip Gmail",
                      "Linear, Starting", "Approve Linear", "Skip Linear", "Notion, Failed", "The link expired",
                      "Try again Notion", "Skip Notion", "Slack, Connected", "Jira, Skipped"] {
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: label), "\(label): \(HostedAccessibility.labels(in: window))")
        }
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Skip Slack"), "A connected row offers nothing")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Authorize Linear"), "Only a server link is a link")
        attachHostedScreenshot(window, name: "connection-mixed-targets")
    }

    func testAuthorizeOpensTheServersLinkThroughThePlatform() throws {
        var opened: [URL] = []
        var moves: [Sent] = []
        let window = try hostOperation(onOpen: { opened.append($0) }, onMove: { moves.append($0) })
        let authorize = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Authorize Gmail"))
        XCTAssertTrue(authorize.accessibilityTraits.contains(.link))
        HostedAccessibility.activate(authorize)
        XCTAssertEqual(opened.map(\.absoluteString), ["https://vendor.example.test/authorize/conn-native?state=opaque-state"])
        XCTAssertEqual(moves, [], "Opening a link answers nothing")
    }

    func testACredentialIsMaskedRequiredAndForgottenOnceSent() async throws {
        var moves: [Sent] = []
        let window = try hostOperation(onMove: { moves.append($0) })
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [true])
        XCTAssertEqual(fields.map(\.textContentType), [nil], "AutoFill never offers Talaria's own credentials")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "API key"), "VoiceOver names the field by the server's label")
        let approve = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Approve Linear"))
        XCTAssertTrue(approve.accessibilityTraits.contains(.notEnabled), "A required credential comes first")

        let field = try XCTUnwrap(fields.first)
        field.becomeFirstResponder()
        field.insertText("synthetic-secret")
        settle()
        let ready = await awaitElement(in: window) {
            $0.accessibilityLabel == "Approve Linear" && !$0.accessibilityTraits.contains(.notEnabled)
        }
        HostedAccessibility.activate(try XCTUnwrap(ready, "Approve never enabled after typing"))
        settle()

        XCTAssertEqual(moves, [Sent(move: .row(.approve, target: "linear"), env: ["LINEAR_API_KEY": "synthetic-secret"])])
        XCTAssertEqual(textFields(in: window).map { $0.text ?? "" }, [""], "The sent credential is not kept in the panel")
        attachHostedScreenshot(window, name: "connection-credential-sent")
    }

    func testSkipRetryAndContinueSendTheExactMove() throws {
        var moves: [Sent] = []
        let window = try hostOperation(onMove: { moves.append($0) })
        for label in ["Skip Gmail", "Try again Notion", "Continue"] {
            HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: label)))
        }
        XCTAssertEqual(moves, [
            Sent(move: .row(.skip, target: "gmail"), env: nil),
            Sent(move: .row(.retry, target: "notion"), env: nil),
            Sent(move: .continueWithoutTheRest, env: nil)
        ])
    }

    func testARunningMoveShowsBusyOnItsOwnControlAndItsErrorShows() throws {
        let message = "That move is not open on this connection."
        let window = try hostOperation(running: ["notion"], error: message)
        let retry = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Try again Notion"))
        XCTAssertTrue(retry.accessibilityTraits.contains(.notEnabled))
        XCTAssertEqual(retry.accessibilityValue, "In progress")
        let skipGmail = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Skip Gmail"))
        XCTAssertFalse(skipGmail.accessibilityTraits.contains(.notEnabled), "Busy stays on the control that started it")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: message))
        attachHostedScreenshot(window, name: "connection-pending-and-error")
    }

    func testASettledOperationShowsItsResultAndCloses() throws {
        var closed = 0
        let window = try hostOperation({ view in
            view["settled"] = true
            view["outcome"] = "not_connected"
            view["can_continue"] = false
            view["targets"] = (view["targets"] as? [[String: Any]])?.map { target in
                target.merging(["connect_url": NSNull(), "actions": [], "env_fields": []]) { $1 }
            }
        }, onDismiss: { closed += 1 })
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Not Connected"), "\(HostedAccessibility.labels(in: window))")
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Continue"))
        XCTAssertTrue(textFields(in: window).isEmpty, "A settled operation asks for nothing")
        attachHostedScreenshot(window, name: "connection-terminal-result")
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Close connection result")))
        XCTAssertEqual(closed, 1)
    }

    /// TAL-1907's consent line renders unchanged when the server sends it; an older server's row simply has none.
    func testAnInstallShowsWhatItRunsOnlyWhenTheServerSaysSo() throws {
        let withLaunch = try hostOperation()
        let line = "npx -y mcp-linear --api-key=*** 'two  spaces' sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"
        for label in ["Runs: \(line)", "Working dir: /workspace/linear", "Env: LINEAR_API_KEY"] {
            XCTAssertNotNil(HostedAccessibility.element(in: withLaunch, label: label), "\(label): \(HostedAccessibility.labels(in: withLaunch))")
        }
        attachHostedScreenshot(withLaunch, name: "connection-launch")
        withLaunch.isHidden = true

        let without = try hostOperation({ view in
            view["targets"] = (view["targets"] as? [[String: Any]])?.map { $0.filter { $0.key != "launch" } }
        })
        XCTAssertTrue(HostedAccessibility.elements(in: without, labelContaining: "Runs:").isEmpty)
        XCTAssertNotNil(HostedAccessibility.element(in: without, label: "Approve Linear"), "The row is the same without it")
    }

    private func operation(_ edit: (inout [String: Any]) -> Void) throws -> ConnectorOperationView {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/connectors.json"))) as? [String: Any])
        var view = try XCTUnwrap((fixture["native_connection"] as? [String: Any])?["view"] as? [String: Any])
        edit(&view)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ConnectorOperationView.self, from: JSONSerialization.data(withJSONObject: view))
    }

    private func textFields(in view: UIView) -> [UITextField] {
        (view as? UITextField).map { [$0] } ?? view.subviews.flatMap(textFields(in:))
    }
}

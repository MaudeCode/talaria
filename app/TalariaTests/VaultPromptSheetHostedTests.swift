import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-887: the Agent's password-manager prompts render from the shared contract examples alone: masked secrets,
/// visible identifier and code, and Submit or Skip.
@MainActor
final class VaultPromptSheetHostedTests: XCTestCase {
    func testUnlockMasksTheMasterPasswordAndSendsIt() async throws {
        var responses: [[String: String]?] = []
        let window = try hostWindow(VaultPromptSheet(vault: try vault("unlock"), isResponding: false, errorMessage: nil) { responses.append($0) })
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Unlock Bitwarden"), "\(HostedAccessibility.labels(in: window))")
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [true])
        // Relay fields never ask AutoFill for the credentials iOS keeps for Talaria itself.
        XCTAssertEqual(fields.map(\.textContentType), [nil])
        let submit = try XCTUnwrap(HostedAccessibility.element(in: window, label: "Unlock"), "\(HostedAccessibility.labels(in: window))")
        XCTAssertTrue(submit.accessibilityTraits.contains(.notEnabled), "Nothing typed, nothing to send")

        type("correct horse", into: try XCTUnwrap(fields.first))
        let current = await awaitElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "vault-prompt-submit"
                && !$0.accessibilityTraits.contains(.notEnabled)
        }
        HostedAccessibility.activate(try XCTUnwrap(current, "Unlock never enabled after typing"))
        XCTAssertEqual(responses, [["master_password": "correct horse"]])
    }

    func testSaveLoginShowsTheIdentifierAndMasksThePassword() throws {
        var responses: [[String: String]?] = []
        let window = try hostWindow(VaultPromptSheet(vault: try vault("save_login"), isResponding: false, errorMessage: nil) { responses.append($0) })
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Save Login"), "\(HostedAccessibility.labels(in: window))")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "login.example.com"))
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [false, true])
        XCTAssertEqual(fields.map(\.textContentType), [nil, nil])
        type("me@example.com", into: fields[0])
        type("s3cret", into: fields[1])
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Save")))
        XCTAssertEqual(responses, [["identifier": "me@example.com", "password": "s3cret"]])
    }

    func testCodeIsShownAsTypedAndSkipDeclines() throws {
        var responses: [[String: String]?] = []
        let window = try hostWindow(VaultPromptSheet(vault: try vault("code"), isResponding: false, errorMessage: nil) { responses.append($0) })
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Verification Code"), "\(HostedAccessibility.labels(in: window))")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "login.example.com"))
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [false])
        XCTAssertEqual(fields.first?.textContentType, .oneTimeCode)
        // Codes can have letters.
        XCTAssertEqual(fields.first?.keyboardType, .asciiCapable)
        type("4815", into: fields[0])
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Skip")))
        XCTAssertEqual(responses, [nil])
    }

    /// TAL-1046: a skill's missing secret uses the same sheet: masked, labeled by its variable, with the server's
    /// help and required-for wording, Save or Skip, and nothing kept once it is sent.
    func testSkillSecretMasksTheValueShowsServerWordingAndClearsOnSave() async throws {
        var responses: [[String: String]?] = []
        let window = try hostWindow(VaultPromptSheet(vault: try vault("skill_secret"), isResponding: false, errorMessage: nil) { responses.append($0) })
        for label in ["Set Up example", "Enter the test key", "https://example.com/keys", "Required for example setup", "Skip"] {
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: label), "\(label): \(HostedAccessibility.labels(in: window))")
        }
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [true])
        XCTAssertEqual(fields.map(\.textContentType), [nil])
        // VoiceOver names the masked field by the variable it sets.
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "EXAMPLE_API_KEY"), "\(HostedAccessibility.labels(in: window))")

        type("synthetic-skill-secret", into: try XCTUnwrap(fields.first))
        let save = await awaitElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "vault-prompt-submit" && !$0.accessibilityTraits.contains(.notEnabled)
        }
        HostedAccessibility.activate(try XCTUnwrap(save, "Save never enabled after typing"))
        settle()
        XCTAssertEqual(responses, [["secret": "synthetic-skill-secret"]])
        XCTAssertEqual(textFields(in: window).map { $0.text ?? "" }, [""], "The sent secret is not kept in the sheet")

        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Skip")))
        XCTAssertEqual(responses, [["secret": "synthetic-skill-secret"], nil])
    }

    /// TAL-1969: an agent's secret request names its variable and purpose, says a save replaces the current value, and
    /// sends the masked value once.
    func testAgentSecretShowsItsPurposeAndReplacementAndSendsTheValue() async throws {
        var responses: [[String: String]?] = []
        let window = try hostWindow(VaultPromptSheet(vault: try vault("agent_secret"), isResponding: false, errorMessage: nil) { responses.append($0) })
        for label in ["Set FOO_API_KEY", "Read your Foo dashboards to build the weekly report.", "Saving replaces the current value.", "FOO_API_KEY", "Skip"] {
            XCTAssertNotNil(HostedAccessibility.element(in: window, label: label), "\(label): \(HostedAccessibility.labels(in: window))")
        }
        let fields = textFields(in: window)
        XCTAssertEqual(fields.map(\.isSecureTextEntry), [true])
        type("synthetic-agent-secret", into: try XCTUnwrap(fields.first))
        let save = await awaitElement(in: window) {
            HostedAccessibility.identifier(of: $0) == "vault-prompt-submit" && !$0.accessibilityTraits.contains(.notEnabled)
        }
        HostedAccessibility.activate(try XCTUnwrap(save, "Save never enabled after typing"))
        settle()
        XCTAssertEqual(responses, [["secret": "synthetic-agent-secret"]])
    }

    /// TAL-1969: a viewer the server lets read but not answer the request sees it without an input, Save or Skip, and
    /// can only close the sheet.
    func testAgentSecretForAViewerWhoCannotAnswerOnlyCloses() throws {
        var responses: [[String: String]?] = []
        var closed = 0
        let window = try hostWindow(VaultPromptSheet(vault: try vault("agent_secret", fields: [], canAnswer: false), isResponding: false, errorMessage: nil, onRespond: { responses.append($0) }, onClose: { closed += 1 }))
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "Read your Foo dashboards to build the weekly report."))
        XCTAssertEqual(textFields(in: window), [])
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Skip"))
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "vault-prompt-submit"))
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.element(in: window, label: "Close")))
        XCTAssertEqual(closed, 1)
        XCTAssertEqual(responses, [])
    }

    private func vault(_ name: String, fields: [Any]? = nil, canAnswer: Bool? = nil) throws -> VaultPrompt {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/vault-prompts.json"))) as? [String: Any])
        var entry = try XCTUnwrap(fixture[name] as? [String: Any])
        var pending = try XCTUnwrap(entry["pending"] as? [String: Any])
        var raw = try XCTUnwrap(pending["vault"] as? [String: Any])
        if let fields { raw["fields"] = fields }
        if let canAnswer { raw["can_answer"] = canAnswer }
        pending["vault"] = raw
        entry["pending"] = pending
        let envelope = try JSONDecoder().decode(ClarificationPendingResponse.self, from: JSONSerialization.data(withJSONObject: entry))
        return try XCTUnwrap(envelope.pending?.vault)
    }

    private func textFields(in view: UIView) -> [UITextField] {
        (view as? UITextField).map { [$0] } ?? view.subviews.flatMap(textFields(in:))
    }

    private func type(_ text: String, into field: UITextField) {
        field.becomeFirstResponder()
        field.insertText(text)
        settle()
    }
}

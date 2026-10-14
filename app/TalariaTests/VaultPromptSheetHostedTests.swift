import SwiftUI
import UIKit
import XCTest
@testable import Talaria
import TalariaKit

/// TAL-887: the Agent's password-manager prompts render from the shared contract examples alone: masked secrets,
/// visible identifier and code, and Submit or Skip.
@MainActor
final class VaultPromptSheetHostedTests: XCTestCase {
    func testUnlockMasksTheMasterPasswordAndSendsIt() throws {
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
        XCTAssertFalse(submit.accessibilityTraits.contains(.notEnabled))
        HostedAccessibility.activate(submit)
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

    private func vault(_ name: String) throws -> VaultPrompt {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/vault-prompts.json"))) as? [String: Any])
        let envelope = try JSONDecoder().decode(ClarificationPendingResponse.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(fixture[name])))
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

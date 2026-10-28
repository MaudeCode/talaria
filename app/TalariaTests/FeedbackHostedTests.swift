import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class FeedbackHostedTests: XCTestCase {
    private func model(
        connected: Bool = true,
        submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil
    ) -> FeedbackComposer {
        let name = "FeedbackHostedTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return FeedbackComposer(
            server: connected ? URL(string: "https://feedback.example.test")! : nil,
            defaults: defaults, clientMetadata: .current, submit: submit,
            diagnostics: { FeedbackDiagnostics(text: "Web: synthetic\n  Exact diagnostics <redacted>", bytes: 45) }
        )
    }

    func testDisconnectedAboutDisablesFeedback() async throws {
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model(connected: false)) })
        let row = try await requireElement(in: window, label: "Send Feedback")
        XCTAssertTrue(row.accessibilityTraits.contains(.notEnabled))
    }

    func testUnavailableFeedbackShowsTheServiceError() async throws {
        let model = model(submit: { _ in
            throw APIError.http(statusCode: 503, body: "{\"error\":\"feedback_unavailable\"}")
        })
        model.edit { $0.title = "Synthetic report"; $0.body = "Synthetic details" }
        try await XCTUnwrap(model.send()).value
        let window = try hostWindow(FeedbackSheet(model: model))
        attachHostedScreenshot(window, name: "feedback-service-unavailable")
        let message = await awaitElement(in: window) {
            ($0.accessibilityLabel ?? "").contains("The feedback service is unavailable. Try again later.")
        }
        XCTAssertNotNil(message, "The service refusal must not blame the Mac, Hermes WebUI, or Cloudflare")
    }

    func testSendClosesBeforeHeldResponseAndRefusalReopensTheSameDraft() async throws {
        var finish: CheckedContinuation<FeedbackResult, Error>?
        var requests: [FeedbackRequest] = []
        let model = model(submit: { request in
            requests.append(request)
            return try await withCheckedThrowingContinuation { finish = $0 }
        })
        model.edit { $0.title = "Synthetic report"; $0.body = "Synthetic details" }
        let id = model.draft.requestId
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
        _ = try await requireElement(in: window, label: "Include Diagnostics")
        let send = try XCTUnwrap(HostedAccessibility.toolbarItem("Send", in: window))
        HostedAccessibility.activate(send)
        XCTAssertFalse(model.isPresented)
        let closed = await awaitNoElement(in: window) { HostedAccessibility.identifier(of: $0) == "feedback-title" }
        XCTAssertTrue(closed)
        let confirmation = await awaitElement(in: window) { $0.accessibilityLabel == "Feedback sent" }
        XCTAssertNotNil(confirmation)
        let started = await awaitCondition { finish != nil }
        XCTAssertTrue(started)
        finish?.resume(throwing: APIError.http(statusCode: 429, body: "{\"error\":\"rate_limited\",\"retryAfterSeconds\":60}"))
        _ = try await requireElement(in: window, label: "Include Diagnostics")
        XCTAssertTrue(model.isPresented)
        XCTAssertEqual(model.draft.requestId, id)
        XCTAssertEqual(model.draft.title, "Synthetic report")
        XCTAssertNotNil(model.error)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(requests[0].client?.platform, "ios")
        XCTAssertEqual(requests[0].client?.osVersion, UIDevice.current.systemVersion)
        XCTAssertFalse(try XCTUnwrap(requests[0].client?.deviceModel).isEmpty)
        XCTAssertTrue(try XCTUnwrap(requests[0].client?.appVersion).contains("("))
        attachHostedScreenshot(window, name: "feedback-refusal-phone")
    }

    func testFormAndVerbatimDiagnosticsOnPhoneAndDuoInner() async throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-inner", HostedSize.duoInner)] {
            let model = model()
            model.edit { $0.title = "A clearer activity history"; $0.body = "Please keep completed background work easy to find."; $0.kind = "feature" }
            let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) }, size: size)
            HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
            _ = try await requireElement(in: window, label: "Include Diagnostics")
            HostedAccessibility.activate(try await requireElement(in: window, label: "Diagnostics"))
            let preview = await awaitElement(in: window) { $0.accessibilityLabel == "Web: synthetic\n  Exact diagnostics <redacted>" }
            XCTAssertNotNil(preview)
            XCTAssertEqual(model.diagnosticsText, "Web: synthetic\n  Exact diagnostics <redacted>")
            attachHostedScreenshot(window, name: "feedback-\(name)")
            HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarItem("Cancel", in: window)))
            XCTAssertFalse(model.isPresented)
            XCTAssertEqual(model.draft.kind, "feature")
            window.isHidden = true
        }
    }
}

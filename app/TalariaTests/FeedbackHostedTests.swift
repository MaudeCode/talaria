import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class FeedbackHostedTests: XCTestCase {
    private func model(
        connected: Bool = true,
        attachments: Bool = false,
        submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil
    ) -> FeedbackComposer {
        let name = "FeedbackHostedTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: name)
            try? FileManager.default.removeItem(at: staging)
        }
        return FeedbackComposer(
            server: connected ? URL(string: "https://feedback.example.test")! : nil,
            defaults: defaults, clientMetadata: .current, stagingRoot: staging, submit: submit,
            diagnostics: { FeedbackDiagnostics(text: "Web: synthetic\n  Exact diagnostics <redacted>", bytes: 45) },
            options: {
                FeedbackOptions(attachments: .init(enabled: attachments, videoAllowed: true, maxCount: 5, maxImageBytes: 10_000_000,
                                                   maxVideoBytes: 20_000_000, maxVideoSeconds: 120,
                                                   acceptedTypes: ["image/png", "image/jpeg", "video/mp4"]))
            },
            upload: { data, type, _ in FeedbackAttachmentStaged(attachmentId: UUID(), contentType: type, bytes: data.count) }
        )
    }

    private func syntheticPhoto() -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: 120, height: 80)).jpegData(withCompressionQuality: 0.9) { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 120, height: 80))
        }
    }

    func testOpeningTheSheetOffersNoScreenCapture() async throws {
        let model = model(attachments: true)
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
        _ = try await requireElement(in: window, label: "Add Photo or Video")
        attachHostedScreenshot(window, name: "feedback-no-screen-offer")
        let offer = await awaitElement(in: window, timeout: 1) {
            $0.accessibilityLabel == "Add Current screen" || HostedAccessibility.identifier(of: $0) == "composer-attachment-strip"
        }
        XCTAssertNil(offer, "The sheet must not offer the screen behind it, nor show an empty attachment strip")
        XCTAssertTrue(model.attachments.isEmpty)
    }

    func testAttachingIsHiddenWhenTheServerDisablesIt() async throws {
        let model = model(attachments: false)
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
        _ = try await requireElement(in: window, label: "Include Diagnostics")
        let loaded = await awaitCondition { model.attachmentOptions != nil }
        XCTAssertTrue(loaded)
        let attachControl = await awaitElement(in: window, timeout: 1) {
            ($0.accessibilityLabel ?? "").hasPrefix("Add Photo")
        }
        XCTAssertNil(attachControl)
    }

    func testTappingAnAttachedPhotoPreviewsTheCompressedFile() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        await model.addImage(syntheticPhoto())?.value
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Open attachment Photo"))
        _ = try await requireElement(in: window, label: "Photo")
        let done = await awaitCondition { HostedAccessibility.toolbarItem("Done", in: window) != nil }
        XCTAssertTrue(done, "The preview sheet opens over the feedback form")
        attachHostedScreenshot(window, name: "feedback-photo-preview")
    }

    func testRefusedAttachmentConfirmsSentWithoutAttachments() async throws {
        let model = model(attachments: true, submit: { request in
            FeedbackResult(status: "sent", reportId: "synthetic-report",
                           attachments: (request.attachmentIds ?? []).map { .init(attachmentId: $0, status: "refused", reason: "tier") })
        })
        await model.loadAttachmentOptions()
        await model.addImage(syntheticPhoto())?.value
        model.edit { $0.title = "Synthetic report"; $0.body = "Synthetic details" }
        let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) })
        HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
        _ = try await requireElement(in: window, label: "Remove attachment Photo")
        attachHostedScreenshot(window, name: "feedback-photo-attached")
        HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarItem("Send", in: window)))
        let confirmation = await awaitElement(in: window) { $0.accessibilityLabel == "Sent without attachments" }
        XCTAssertNotNil(confirmation)
        attachHostedScreenshot(window, name: "feedback-sent-without-attachments")
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

import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class FeedbackHostedTests: XCTestCase {
    private func model(
        connected: Bool = true,
        attachments: Bool = false,
        deviceDiagnostics: Bool = false,
        submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil
    ) -> FeedbackComposer {
        let name = "FeedbackHostedTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        let staging = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        let diagnosticStore = deviceDiagnostics ? FeedbackDiagnosticStore(directory: staging.appending(path: "Diagnostics")) : nil
        if let diagnosticStore {
            let now = Date.now
            diagnosticStore.record([.init(kind: .hang, start: (now - 60).ISO8601Format(),
                                          end: now.ISO8601Format(), build: "42", frames: [])])
        }
        addTeardownBlock {
            defaults.removePersistentDomain(forName: name)
            try? FileManager.default.removeItem(at: staging)
        }
        return FeedbackComposer(
            server: connected ? URL(string: "https://feedback.example.test")! : nil,
            defaults: defaults, clientMetadata: .current, stagingRoot: staging, diagnosticStore: diagnosticStore, submit: submit,
            diagnostics: { FeedbackDiagnostics(text: "Web: synthetic\n  Exact diagnostics <redacted>", bytes: 45) },
            options: {
                FeedbackOptions(attachments: .init(enabled: attachments, videoAllowed: true, maxCount: 5, maxImageBytes: 10_000_000,
                                                   maxVideoBytes: 20_000_000, maxVideoSeconds: 120,
                                                   acceptedTypes: ["image/png", "image/jpeg", "video/mp4"]),
                                diagnosticReportsSupported: deviceDiagnostics)
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

    /// Pastes `count` synthetic photos through the sheet's paste control, as its PasteButton hands them over. The
    /// providers are the test's own: the simulator's general pasteboard is a shared service, and on a loaded runner it
    /// once failed to load the image it held, so the paste reached the sheet with nothing to attach (TAL-2546).
    private func paste(_ count: Int, in window: UIWindow) throws {
        let paste = try XCTUnwrap(window.firstView(ofType: UIPasteControl.self),
                                 "Feedback must offer a native image paste action")
        let providers = (0..<count).map { _ in
            NSItemProvider(item: syntheticPhoto() as NSData, typeIdentifier: UTType.jpeg.identifier)
        }
        try XCTUnwrap(paste.target).paste?(itemProviders: providers)
    }

    func testPastingClipboardPhotosUsesTheFeedbackAttachmentPipeline() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        let window = try hostWindow(FeedbackSheet(model: model))
        _ = try await requireElement(in: window, label: "Add Photo or Video")
        attachHostedScreenshot(window, name: "feedback-before-paste")
        try paste(1, in: window)
        let uploaded = await awaitCondition { model.attachments.first?.attachmentId != nil }
        XCTAssertTrue(uploaded, "The clipboard image must pass through compression and staging")
        XCTAssertEqual(model.attachments.count, 1)
        XCTAssertEqual(model.attachments.first?.contentType, "image/jpeg")
        _ = try await requireElement(in: window, label: "Remove attachment Photo")
        attachHostedScreenshot(window, name: "feedback-after-paste")

        try paste(2, in: window)
        let batchUploaded = await awaitCondition {
            model.attachments.count == 3 && model.attachments.allSatisfy { $0.attachmentId != nil }
        }
        XCTAssertTrue(batchUploaded, "Every clipboard image must become a staged photo")
    }

    func testPlainTextStillPastesIntoTitleAndDetails() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        let previousItems = UIPasteboard.general.items
        defer { UIPasteboard.general.items = previousItems }
        let window = try hostWindow(FeedbackSheet(model: model))
        _ = try await requireElement(in: window, label: "Add Photo or Video")
        let text = "  Copied text & punctuation!  "
        UIPasteboard.general.string = text
        let title = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Title (optional)" })
        title.becomeFirstResponder()
        title.paste(nil)
        let titlePasted = await awaitCondition { model.draft.title == text }
        XCTAssertTrue(titlePasted)
        if let details = window.firstView(ofType: UITextView.self) {
            details.becomeFirstResponder()
            details.paste(nil)
        } else {
            let details = try XCTUnwrap(window.firstView(ofType: UITextField.self) { $0.placeholder == "Details" })
            details.becomeFirstResponder()
            details.paste(nil)
        }
        let detailsPasted = await awaitCondition { model.draft.body == text }
        XCTAssertTrue(detailsPasted)
        XCTAssertTrue(model.attachments.isEmpty)
        window.endEditing(true)
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
        XCTAssertNil(window.firstView(ofType: UIPasteControl.self), "Disabled attachments must not offer image paste")
    }

    func testPastingTooManyPhotosKeepsTheDraftAndShowsTheLimit() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        await model.addImage(syntheticPhoto())?.value
        let original = model.attachments
        let window = try hostWindow(FeedbackSheet(model: model))
        _ = try await requireElement(in: window, label: "Add Photo or Video")
        try paste(5, in: window)
        _ = try await requireElement(in: window, label: "Attach up to 5 files.")
        XCTAssertEqual(model.attachments, original, "An oversized paste must not partially add its images")
        attachHostedScreenshot(window, name: "feedback-paste-limit")
    }

    func testPastedPhotoLayoutAcrossTheGallery() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        await model.addImage(syntheticPhoto())?.value
        try await renderHostedPage("feedback-paste") {
            FeedbackSheet(model: model)
        } inspect: { window, _ in
            _ = try await self.requireElementScrolling(in: window, "The pasted photo must remain reachable") {
                $0.accessibilityLabel == "Remove attachment Photo"
            }
            _ = try await self.requireElementScrolling(in: window, "Image paste must remain reachable") {
                HostedAccessibility.identifier(of: $0) == "feedback-paste-attachment"
            }
            let paste = try XCTUnwrap(window.firstView(ofType: UIPasteControl.self))
            let scroll = try XCTUnwrap(window.firstView(ofType: UIScrollView.self) { $0.bounds.height > 300 })
            scroll.scrollRectToVisible(paste.convert(paste.bounds, to: scroll).insetBy(dx: 0, dy: -16), animated: false)
            self.settle(window: window)
            XCTAssertTrue(window.bounds.contains(paste.convert(paste.bounds, to: window)),
                          "The entire Paste action must be visible after scrolling")
        }
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

    func testAPickedItemThatFailsToLoadShowsAnInlineError() async throws {
        let model = model(attachments: true)
        await model.loadAttachmentOptions()
        let sheet = FeedbackSheet(model: model)
        let window = try hostWindow(sheet)
        await sheet.attach([PhotosPickerItem(itemIdentifier: "synthetic-missing")])
        let message = await awaitElement(in: window) { $0.accessibilityLabel == "This file could not be attached." }
        attachHostedScreenshot(window, name: "feedback-attachment-load-failed")
        XCTAssertNotNil(message, "A picked item that cannot be loaded must not disappear silently")
        XCTAssertTrue(model.attachments.isEmpty)
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
        for variant in HostedVariant.gallery {
            let model = model()
            model.edit { $0.body = "Please keep completed background work easy to find."; $0.kind = "feature" }
            let window = try hostWindow(NavigationStack { AboutSettingsView(feedback: model) }, size: variant.size) {
                $0.userInterfaceStyle = variant.style
                $0.preferredContentSizeCategory = variant.textSize
            }
            HostedAccessibility.activate(try await requireElement(in: window, label: "Send Feedback"))
            _ = try await requireElement(in: window, label: "Include Diagnostics")
            attachHostedScreenshot(window, name: "feedback-form-\(variant.name)")
            HostedAccessibility.activate(try await requireElementScrolling(in: window, "Diagnostics") { $0.accessibilityLabel == "Diagnostics" })
            _ = try await requireElementScrolling(in: window, "Diagnostics preview") { $0.accessibilityLabel == "Web: synthetic\n  Exact diagnostics <redacted>" }
            XCTAssertEqual(model.diagnosticsText, "Web: synthetic\n  Exact diagnostics <redacted>")
            attachHostedScreenshot(window, name: "feedback-\(variant.name)")
            HostedAccessibility.activate(try XCTUnwrap(HostedAccessibility.toolbarItem("Cancel", in: window)))
            XCTAssertFalse(model.isPresented)
            XCTAssertEqual(model.draft.kind, "feature")
            window.isHidden = true
        }
    }

    func testDeviceDiagnosticsOnPhoneInLightMode() async throws { try await checkDeviceDiagnostics("phone-light") }
    func testDeviceDiagnosticsOnPhoneInDarkMode() async throws { try await checkDeviceDiagnostics("phone-dark") }
    func testDeviceDiagnosticsAtAccessibilityTextSize() async throws { try await checkDeviceDiagnostics("phone-ax5") }
    func testDeviceDiagnosticsOnDuoOuter() async throws { try await checkDeviceDiagnostics("duo-outer") }
    func testDeviceDiagnosticsOnDuoInner() async throws { try await checkDeviceDiagnostics("duo-inner") }

    func testOptingOutHidesTheDeviceDiagnosticsPreview() async throws {
        let model = model(deviceDiagnostics: true)
        let window = try hostWindow(FeedbackSheet(model: model))
        HostedAccessibility.activate(try await requireElement(in: window, label: "Diagnostics"))
        _ = try await requireElementScrolling(in: window, "Hang Report") { $0.accessibilityLabel?.contains("Hang Report") == true }
        let toggle = try XCTUnwrap(window.firstView(ofType: UISwitch.self))
        toggle.setOn(false, animated: false)
        toggle.sendActions(for: .valueChanged)
        commitDisplay(of: window)
        XCTAssertFalse(model.draft.includeDiagnostics)
        XCTAssertFalse(HostedAccessibility.elements(in: window).contains { $0.accessibilityLabel?.contains("Hang Report") == true })
        attachHostedScreenshot(window, name: "feedback-device-diagnostics-opt-out")
    }

    private func checkDeviceDiagnostics(_ name: String) async throws {
        let variant = try XCTUnwrap(HostedVariant.gallery.first { $0.name == name })
        let model = model(deviceDiagnostics: true)
        let window = try hostWindow(FeedbackSheet(model: model), size: variant.size) {
            $0.userInterfaceStyle = variant.style
            $0.preferredContentSizeCategory = variant.textSize
        }
        HostedAccessibility.activate(try await requireElementScrolling(in: window, "Diagnostics") { $0.accessibilityLabel == "Diagnostics" })
        _ = try await requireElementScrolling(in: window, "Hang Report") { $0.accessibilityLabel?.contains("Hang Report") == true }
        _ = try await requireElementScrolling(in: window, "Build 42") { element in
            element.accessibilityLabel?.contains("Build 42") == true
                && window.bounds.contains(window.convert(element.accessibilityFrame, from: window.screen.coordinateSpace))
        }
        attachHostedScreenshot(window, name: "feedback-device-diagnostics-\(name)")
    }
}

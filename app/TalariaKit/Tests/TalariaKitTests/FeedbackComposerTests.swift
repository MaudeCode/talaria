import XCTest
import ImageIO
import SwiftData
@testable import TalariaKit

@MainActor
final class FeedbackComposerTests: XCTestCase {
    private let server = URL(string: "https://feedback.example.test")!
    private let metadata = FeedbackClient(appVersion: "1.2 (3)", osVersion: "27.0", deviceModel: "iPhone99,1")

    private func defaults() -> UserDefaults {
        let name = "FeedbackComposerTests.\(UUID())"
        let defaults = UserDefaults(suiteName: name)!
        addTeardownBlock { defaults.removePersistentDomain(forName: name) }
        return defaults
    }

    private func fill(_ model: FeedbackComposer) {
        model.edit { $0.title = "Synthetic report"; $0.body = "Synthetic details" }
        model.isPresented = true
    }

    func testSendDismissesBeforeResponseAndClearsOnlyAfterConfirmation() async throws {
        let storage = defaults()
        let started = expectation(description: "Submission reached the held transport")
        var finish: CheckedContinuation<FeedbackResult, Error>?
        let model = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata, submit: { _ in
            try await withCheckedThrowingContinuation { finish = $0; started.fulfill() }
        })
        fill(model)
        let id = model.draft.requestId
        let task = try XCTUnwrap(model.send())
        XCTAssertFalse(model.isPresented)
        XCTAssertNotNil(model.confirmation.success)
        XCTAssertEqual(model.draft.requestId, id)
        XCTAssertNil(model.send(), "Repeated taps cannot submit concurrently")
        await fulfillment(of: [started], timeout: 5)
        let restored = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata)
        XCTAssertEqual(restored.draft, model.draft, "An unconfirmed send must survive relaunch")
        finish?.resume(returning: FeedbackResult(status: "sent", reportId: "synthetic-report"))
        await task.value
        XCTAssertTrue(model.draft.title.isEmpty)
        XCTAssertNotEqual(model.draft.requestId, id)
        XCTAssertTrue(FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata).draft.title.isEmpty)
    }

    func testRefusalsRestoreTheDraftAndRetryKeepsTheRequestID() async throws {
        for (status, code) in [(429, "rate_limited"), (503, "feedback_unavailable"), (400, "invalid")] {
            var requests: [FeedbackRequest] = []
            let model = FeedbackComposer(server: server, defaults: defaults(), clientMetadata: metadata, submit: { request in
                requests.append(request)
                throw APIError.http(statusCode: status, body: "{\"error\":\"\(code)\"}")
            })
            fill(model)
            let draft = model.draft
            try await XCTUnwrap(model.send()).value
            XCTAssertTrue(model.isPresented)
            XCTAssertEqual(model.draft.title, draft.title)
            XCTAssertEqual(model.draft.requestId, draft.requestId)
            XCTAssertNotNil(model.error)
            XCTAssertNil(model.confirmation.success)
            XCTAssertEqual(requests.count, 1, "Definitive refusals must not auto-retry")
            try await XCTUnwrap(model.send()).value
            XCTAssertEqual(requests.count, 2)
            XCTAssertEqual(requests[0], requests[1])
        }
    }

    func testUnknownOutcomesRetryOnceWithIdenticalPayloadThenRollBack() async throws {
        var requests: [FeedbackRequest] = []
        let storage = defaults()
        let model = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata, submit: { request in
            requests.append(request)
            throw APIError.network(underlying: URLError(.timedOut))
        })
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0], requests[1])
        XCTAssertTrue(model.isPresented)
        XCTAssertTrue(model.hasUnknownOutcome)
        let previous = model.draft
        model.edit { $0.title = "Changed" }
        XCTAssertEqual(model.draft, previous, "An uncertain submission cannot become a different report")
        let restored = FeedbackComposer(server: server, defaults: storage, clientMetadata: .init(appVersion: "updated", osVersion: "new", deviceModel: "new"))
        XCTAssertEqual(restored.draft, previous, "Retries preserve metadata across an app update")
        XCTAssertTrue(restored.hasUnknownOutcome)
    }

    func testDiagnosticsAreVerbatimAndDraftsAreServerScoped() async {
        let text = "Web: synthetic\n  exact spacing\n<redacted>\n"
        let storage = defaults()
        let model = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata, diagnostics: {
            FeedbackDiagnostics(text: text, bytes: text.utf8.count)
        })
        fill(model)
        await model.loadDiagnostics()
        XCTAssertEqual(model.diagnosticsText, text)
        XCTAssertEqual(FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata).draft, model.draft)
        XCTAssertTrue(FeedbackComposer(server: URL(string: "https://other.example.test")!, defaults: storage, clientMetadata: metadata).draft.title.isEmpty)
    }

    func testDisconnectedComposerCannotSend() {
        let model = FeedbackComposer(server: nil, defaults: defaults(), clientMetadata: metadata)
        fill(model)
        XCTAssertFalse(model.canSend)
        XCTAssertNil(model.send())
        XCTAssertTrue(model.isPresented)
    }

    func testFormLimitsMatchTheContractsUTF16Bounds() {
        let model = FeedbackComposer(server: server, defaults: defaults(), clientMetadata: metadata)
        fill(model)
        XCTAssertTrue(model.canSend)
        model.edit { $0.title = String(repeating: "🙂", count: 60); $0.body = String(repeating: "a", count: 8000) }
        XCTAssertTrue(model.canSend)
        model.edit { $0.title += "a" }
        XCTAssertFalse(model.canSend)
        model.edit { $0.title = "valid"; $0.body += "a" }
        XCTAssertFalse(model.canSend)
        model.edit { $0.title = " \n"; $0.body = "valid" }
        XCTAssertFalse(model.canSend)
    }

    func testSuccessfulAutomaticRetrySendsTheSameRequestAndClearsTheDraft() async throws {
        var requests: [FeedbackRequest] = []
        let model = FeedbackComposer(server: server, defaults: defaults(), clientMetadata: metadata, submit: { request in
            requests.append(request)
            if requests.count == 1 { throw URLError(.networkConnectionLost) }
            return FeedbackResult(status: "sent", reportId: "synthetic-report")
        })
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests.first, requests.last)
        XCTAssertTrue(model.draft.title.isEmpty)
        XCTAssertFalse(model.isPresented)
    }

    func testRelayFailureKeepsUncertaintyAndShowsTheServiceError() async throws {
        let model = FeedbackComposer(server: server, defaults: defaults(), clientMetadata: metadata, submit: { _ in
            throw APIError.http(statusCode: 502, body: "{\"error\":\"relay_unreachable\"}")
        })
        fill(model)
        let requestID = model.draft.requestId
        try await XCTUnwrap(model.send()).value
        XCTAssertTrue(model.hasUnknownOutcome)
        XCTAssertEqual(model.draft.requestId, requestID)
        let message = try XCTUnwrap(model.error?.message)
        XCTAssertTrue(message.contains("The Relay feedback service could not complete the request. Try again later."),
                      "The rollback must retain the actual Relay error alongside its safe-retry guidance")
        XCTAssertTrue(message.contains("The send could not be confirmed. Retry to check the same report."))
    }

    func testRefusalAfterAnUnknownAttemptKeepsTheOriginalPayloadLocked() async throws {
        for refusal in [APIError.http(statusCode: 503, body: "{\"error\":\"feedback_unavailable\"}"), .unauthorized] {
            let storage = defaults()
            var requests: [FeedbackRequest] = []
            let model = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata, submit: { request in
                requests.append(request)
                if requests.count == 1 { throw URLError(.networkConnectionLost) }
                throw refusal
            })
            fill(model)
            try await XCTUnwrap(model.send()).value
            XCTAssertEqual(requests.count, 2)
            XCTAssertTrue(model.hasUnknownOutcome, "A retry's refusal cannot reject the earlier unknown attempt")
            let original = model.draft
            model.edit { $0.title = "Another report" }
            XCTAssertEqual(model.draft, original)
            try await XCTUnwrap(model.send()).value
            XCTAssertEqual(requests.count, 3)
            XCTAssertTrue(model.hasUnknownOutcome, "A later manual retry must preserve the earlier uncertainty too")
            XCTAssertTrue(requests.allSatisfy { $0 == original })
            let restored = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata)
            XCTAssertEqual(restored.draft, original)
            XCTAssertTrue(restored.hasUnknownOutcome)
        }
    }

    func testServerResetPurgesAndInvalidatesDraftsAndHeldCompletions() async throws {
        for succeeds in [true, false] {
            let storage = defaults()
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("feedback-reset-\(UUID())")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let container = try ModelContainer(for: CachedSession.self, CachedMessage.self,
                configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
            let reset = AuthManager.serverScopedStateReset(cacheContainer: container,
                draftStore: ChatDraftStore(persistence: ChatDraftFilePersistence(directoryURL: root)),
                defaults: storage, responseCacheRoot: root)
            let started = expectation(description: "Old identity submission held")
            var finish: CheckedContinuation<FeedbackResult, Error>?
            var attempts = 0
            let old = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata, submit: { _ in
                attempts += 1
                guard attempts == 1 else { throw APIError.unauthorized }
                return try await withCheckedThrowingContinuation { finish = $0; started.fulfill() }
            }, diagnostics: { FeedbackDiagnostics(text: "old identity diagnostics", bytes: 24) })
            fill(old)
            await old.loadDiagnostics()
            let task = try XCTUnwrap(old.send())
            await fulfillment(of: [started], timeout: 5)
            let other = FeedbackComposer(server: URL(string: "https://kept-feedback.example.test")!, defaults: storage, clientMetadata: metadata)
            fill(other)
            let kept = other.draft
            try await reset(server)
            XCTAssertTrue(old.draft.title.isEmpty, "Reset must erase a live composer's previous identity")
            XCTAssertNil(old.diagnosticsText)
            XCTAssertFalse(old.isPresented)
            XCTAssertNil(old.confirmation.success)
            old.edit { $0.title = "Stale write" }
            XCTAssertTrue(old.draft.title.isEmpty)
            XCTAssertNil(old.send(), "An invalidated composer cannot submit with the new identity")
            let current = FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata)
            XCTAssertTrue(current.draft.title.isEmpty, "The previous identity's durable draft must be removed")
            fill(current)
            let currentDraft = current.draft
            if succeeds { finish?.resume(returning: FeedbackResult(status: "sent", reportId: "old-report")) }
            else { finish?.resume(throwing: URLError(.timedOut)) }
            await task.value
            XCTAssertEqual(attempts, 1, "A retired identity must not start an automatic retry")
            XCTAssertFalse(old.isPresented)
            XCTAssertTrue(old.draft.title.isEmpty)
            XCTAssertEqual(FeedbackComposer(server: server, defaults: storage, clientMetadata: metadata).draft, currentDraft,
                           "An old completion must neither restore nor erase the new identity's draft")
            XCTAssertEqual(other.draft, kept)
        }
    }

    // MARK: Attachments (TAL-1597)

    private func options(enabled: Bool = true, videoAllowed: Bool = true, maxCount: Int = 5) -> FeedbackOptions {
        FeedbackOptions(attachments: .init(enabled: enabled, videoAllowed: videoAllowed, maxCount: maxCount, maxImageBytes: 10_000_000,
                                           maxVideoBytes: 20_000_000, maxVideoSeconds: 120,
                                           acceptedTypes: ["image/png", "image/jpeg", "video/mp4"]))
    }

    private func stagingRoot() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("FeedbackComposerTests-\(UUID())")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func stagedFiles(in root: URL) -> [String] {
        (FileManager.default.enumerator(atPath: root.path)?.allObjects as? [String] ?? []).filter { $0.contains(".") }
    }

    private func attachmentComposer(
        storage: UserDefaults? = nil, root: URL, options: FeedbackOptions? = nil,
        submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil,
        upload: ((Data, String, String) async throws -> FeedbackAttachmentStaged)? = nil
    ) async -> FeedbackComposer {
        let resolved = options ?? self.options()
        let model = FeedbackComposer(server: server, defaults: storage ?? defaults(), clientMetadata: metadata, stagingRoot: root,
                                     submit: submit, options: { resolved },
                                     upload: upload ?? { data, type, _ in .init(attachmentId: UUID(), contentType: type, bytes: data.count) })
        await model.loadAttachmentOptions()
        return model
    }

    func testAttachingFollowsTheServersOptions() async throws {
        let root = try stagingRoot()
        let photo = try XCTUnwrap(TestImages.jpegData(width: 40, height: 30))
        let clip = root.appendingPathComponent("unused.mov")

        let unloaded = FeedbackComposer(server: server, defaults: defaults(), clientMetadata: metadata, stagingRoot: root)
        XCTAssertFalse(unloaded.attachmentsEnabled, "Attaching stays hidden until the server publishes its options")
        XCTAssertNil(unloaded.addImage(photo))

        let disabled = await attachmentComposer(root: root, options: options(enabled: false))
        XCTAssertFalse(disabled.attachmentsEnabled)
        XCTAssertEqual(disabled.remainingAttachmentSlots, 0)
        XCTAssertNil(disabled.addImage(photo))
        disabled.offerCurrentScreen(photo)
        XCTAssertNil(disabled.currentScreenOffer)

        let imagesOnly = await attachmentComposer(root: root, options: options(videoAllowed: false))
        XCTAssertTrue(imagesOnly.attachmentsEnabled)
        XCTAssertFalse(imagesOnly.videoAllowed)
        XCTAssertNil(imagesOnly.addVideo(at: clip), "Videos are offered only when the server allows them")

        let capped = await attachmentComposer(root: root, options: options(maxCount: 2))
        await capped.addImage(photo)?.value
        capped.offerCurrentScreen(photo)
        XCTAssertNotNil(capped.currentScreenOffer)
        await capped.includeCurrentScreen()?.value
        XCTAssertEqual(capped.attachments.map(\.contentType), ["image/jpeg", "image/png"])
        XCTAssertEqual(capped.remainingAttachmentSlots, 0)
        XCTAssertNil(capped.addImage(photo), "maxCount bounds the attachments")
        capped.offerCurrentScreen(photo)
        XCTAssertNil(capped.currentScreenOffer, "A full report offers no screen capture")
    }

    func testCurrentScreenIsOnlyAnOfferUntilIncluded() async throws {
        let root = try stagingRoot()
        var requests: [FeedbackRequest] = []
        let model = await attachmentComposer(root: root, submit: { request in
            requests.append(request)
            return FeedbackResult(status: "sent", reportId: "synthetic-report")
        })
        model.offerCurrentScreen(try XCTUnwrap(TestImages.pngData(width: 30, height: 60)))
        XCTAssertNotNil(model.currentScreenOffer)
        XCTAssertTrue(model.attachments.isEmpty, "The screen capture is never attached by default")
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertNil(requests.first?.attachmentIds)
    }

    func testPhotosAreReencodedWithoutLocationAndCapped() async throws {
        let root = try stagingRoot()
        var uploads: [(data: Data, type: String)] = []
        let model = await attachmentComposer(root: root, upload: { data, type, _ in
            uploads.append((data, type))
            return .init(attachmentId: UUID(), contentType: type, bytes: data.count)
        })
        await model.addImage(try XCTUnwrap(TestImages.jpegDataWithLocation(width: 4_000, height: 3_000)))?.value
        model.offerCurrentScreen(try XCTUnwrap(TestImages.pngData(width: 3_000, height: 6_000)))
        await model.includeCurrentScreen()?.value
        XCTAssertEqual(uploads.map(\.type), ["image/jpeg", "image/png"])
        for upload in uploads {
            let source = try XCTUnwrap(CGImageSourceCreateWithData(upload.data as CFData, nil))
            let properties = try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
            XCTAssertNil(properties[kCGImagePropertyGPSDictionary], "GPS must never leave the phone")
            XCTAssertNil(properties[kCGImagePropertyExifDictionary], "EXIF must never leave the phone")
            let width = try XCTUnwrap(properties[kCGImagePropertyPixelWidth] as? Int)
            let height = try XCTUnwrap(properties[kCGImagePropertyPixelHeight] as? Int)
            XCTAssertEqual(max(width, height), 2_560)
        }
        XCTAssertEqual(CGImageSourceGetType(CGImageSourceCreateWithData(uploads[0].data as CFData, nil)!) as String?, "public.jpeg")
        XCTAssertEqual(CGImageSourceGetType(CGImageSourceCreateWithData(uploads[1].data as CFData, nil)!) as String?, "public.png")
        XCTAssertEqual(model.pendingAttachments.map(\.uploadPhase), [.ready, .ready])
        XCTAssertTrue(model.pendingAttachments.allSatisfy { $0.thumbnailData != nil })
    }

    func testRemovingAnAttachmentDeletesItsStagedFileAndKeepsItOutOfTheReport() async throws {
        let root = try stagingRoot()
        var requests: [FeedbackRequest] = []
        let model = await attachmentComposer(root: root, submit: { request in
            requests.append(request)
            return FeedbackResult(status: "sent", reportId: "synthetic-report")
        })
        let photo = try XCTUnwrap(TestImages.jpegData(width: 40, height: 30))
        await model.addImage(photo)?.value
        await model.addImage(photo)?.value
        let removed = try XCTUnwrap(model.attachments.first)
        let kept = try XCTUnwrap(model.attachments.last?.attachmentId)
        XCTAssertEqual(stagedFiles(in: root).count, 4, "Each attachment keeps its compressed file and thumbnail")
        model.removeAttachment(removed.id)
        XCTAssertEqual(model.attachments.count, 1)
        XCTAssertEqual(stagedFiles(in: root).filter { $0.contains(removed.id.uuidString) }, [])
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertEqual(requests.first?.attachmentIds, [kept])
    }

    func testFailedUploadBlocksSendUntilRetried() async throws {
        let root = try stagingRoot()
        var failing = true
        let model = await attachmentComposer(root: root, upload: { data, type, _ in
            if failing { throw APIError.network(underlying: URLError(.notConnectedToInternet)) }
            return .init(attachmentId: UUID(), contentType: type, bytes: data.count)
        })
        fill(model)
        await model.addImage(try XCTUnwrap(TestImages.jpegData(width: 40, height: 30)))?.value
        let id = try XCTUnwrap(model.attachments.first?.id)
        guard case .failed = model.pendingAttachments.first?.uploadPhase else { return XCTFail("The thumbnail shows its own failure") }
        XCTAssertFalse(model.canSend)
        failing = false
        await model.retryAttachment(id)?.value
        XCTAssertEqual(model.pendingAttachments.first?.uploadPhase, .ready)
        XCTAssertTrue(model.canSend)
    }

    func testRetryAfterRelaunchResendsTheSameAttachmentIDs() async throws {
        let root = try stagingRoot()
        let storage = defaults()
        var requests: [FeedbackRequest] = []
        let model = await attachmentComposer(storage: storage, root: root, submit: { request in
            requests.append(request)
            throw APIError.network(underlying: URLError(.timedOut))
        })
        await model.addImage(try XCTUnwrap(TestImages.jpegData(width: 40, height: 30)))?.value
        fill(model)
        let ids = model.attachments.compactMap(\.attachmentId)
        XCTAssertEqual(ids.count, 1)
        try await XCTUnwrap(model.send()).value
        XCTAssertTrue(model.hasUnknownOutcome)
        XCTAssertNil(model.addImage(try XCTUnwrap(TestImages.jpegData(width: 40, height: 30))), "An uncertain report cannot gain attachments")

        let relaunched = await attachmentComposer(storage: storage, root: root, submit: { request in
            requests.append(request)
            return FeedbackResult(status: "sent", reportId: "synthetic-report")
        })
        XCTAssertEqual(relaunched.attachments, model.attachments)
        XCTAssertNotNil(relaunched.pendingAttachments.first?.thumbnailData, "The thumbnail survives relaunch")
        try await XCTUnwrap(relaunched.send()).value
        XCTAssertEqual(requests.count, 3)
        XCTAssertTrue(requests.allSatisfy { $0 == requests[0] })
        XCTAssertEqual(requests.last?.attachmentIds, ids)
    }

    func testSettledReportClearsStagedFilesAndReportsRefusedAttachments() async throws {
        let root = try stagingRoot()
        let model = await attachmentComposer(root: root, submit: { request in
            let ids = try XCTUnwrap(request.attachmentIds)
            return FeedbackResult(status: "sent", reportId: "synthetic-report", attachments: [
                .init(attachmentId: ids[0], status: "sent"), .init(attachmentId: ids[1], status: "refused", reason: "quota")
            ])
        })
        let photo = try XCTUnwrap(TestImages.jpegData(width: 40, height: 30))
        await model.addImage(photo)?.value
        await model.addImage(photo)?.value
        XCTAssertFalse(stagedFiles(in: root).isEmpty)
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertTrue(model.attachments.isEmpty)
        XCTAssertEqual(stagedFiles(in: root), [], "Settling the report removes its staged files")
        XCTAssertEqual(model.confirmation.success?.title, "Sent without attachments")
    }

    func testFullySentAttachmentsKeepTheSentConfirmation() async throws {
        let model = await attachmentComposer(root: try stagingRoot(), submit: { request in
            FeedbackResult(status: "sent", reportId: "synthetic-report",
                           attachments: (request.attachmentIds ?? []).map { .init(attachmentId: $0, status: "sent") })
        })
        await model.addImage(try XCTUnwrap(TestImages.jpegData(width: 40, height: 30)))?.value
        fill(model)
        try await XCTUnwrap(model.send()).value
        XCTAssertEqual(model.confirmation.success?.title, "Feedback sent")
    }

    func testIdentityChangeClearsStagedFiles() async throws {
        let root = try stagingRoot()
        let storage = defaults()
        let model = await attachmentComposer(storage: storage, root: root)
        await model.addImage(try XCTUnwrap(TestImages.jpegData(width: 40, height: 30)))?.value
        model.offerCurrentScreen(try XCTUnwrap(TestImages.pngData(width: 30, height: 60)))
        XCTAssertFalse(stagedFiles(in: root).isEmpty)
        let cacheRoot = root.appendingPathComponent("cache")
        let container = try ModelContainer(for: CachedSession.self, CachedMessage.self,
            configurations: ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none))
        let reset = AuthManager.serverScopedStateReset(cacheContainer: container,
            draftStore: ChatDraftStore(persistence: ChatDraftFilePersistence(directoryURL: cacheRoot)),
            defaults: storage, responseCacheRoot: cacheRoot)
        try await reset(server)
        XCTAssertTrue(model.attachments.isEmpty)
        XCTAssertNil(model.currentScreenOffer)
        XCTAssertEqual(stagedFiles(in: root).filter { !$0.hasPrefix("cache") }, [], "The previous identity's files must be removed")
        let current = await attachmentComposer(storage: storage, root: root)
        XCTAssertTrue(current.attachments.isEmpty)
    }
}

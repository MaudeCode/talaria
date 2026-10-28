import XCTest
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
}

import Foundation
@testable import TalariaKit

actor BlockingChatDraftPersistence: ChatDraftPersisting {
    private let initialDrafts: [ChatDraftKey: ChatDraft]
    private var latest: [ChatDraftKey: ChatDraft]
    private var loadStarted = false
    private var loadStartContinuation: CheckedContinuation<Void, Never>?
    private var loadReleaseContinuation: CheckedContinuation<Void, Never>?

    init(initialDrafts: [ChatDraftKey: ChatDraft]) {
        self.initialDrafts = initialDrafts
        latest = initialDrafts
    }

    func load() async -> [ChatDraftKey: ChatDraft] {
        loadStarted = true
        loadStartContinuation?.resume()
        loadStartContinuation = nil
        await withCheckedContinuation { continuation in
            loadReleaseContinuation = continuation
        }
        return initialDrafts
    }

    func write(_ drafts: [ChatDraftKey: ChatDraft]) async throws {
        latest = drafts
    }

    func waitUntilLoadStarts() async {
        guard !loadStarted else { return }
        await withCheckedContinuation { continuation in
            loadStartContinuation = continuation
        }
    }

    func releaseLoad() {
        loadReleaseContinuation?.resume()
        loadReleaseContinuation = nil
    }

    func latestDrafts() -> [ChatDraftKey: ChatDraft] {
        latest
    }
}

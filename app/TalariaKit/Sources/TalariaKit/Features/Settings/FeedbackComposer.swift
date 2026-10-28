import Foundation
import Observation

/// Device-local feedback draft and optimistic presentation. The server owns diagnostics and delivery.
@MainActor
@Observable
public final class FeedbackComposer {
    private static let composers = NSHashTable<FeedbackComposer>(options: [.weakMemory, .objectPointerPersonality])
    public private(set) var draft: FeedbackRequest
    public var isPresented = false
    public private(set) var error: SettingsErrorText?
    public private(set) var diagnosticsText: String?
    public private(set) var diagnosticsError: SettingsErrorText?
    public private(set) var hasUnknownOutcome: Bool
    public private(set) var isSending = false
    public let confirmation = GitActionToastState()
    public let server: URL?

    private let defaults: UserDefaults
    private let storageKey: String
    private let cacheGeneration: Int
    private let clientMetadata: FeedbackClient
    private let submit: (FeedbackRequest) async throws -> FeedbackResult
    private let diagnostics: () async throws -> FeedbackDiagnostics

    private struct Stored: Codable {
        let draft: FeedbackRequest
        let hasUnknownOutcome: Bool
    }

    public init(server: URL?, defaults: UserDefaults = .standard, clientMetadata: FeedbackClient,
                submit: ((FeedbackRequest) async throws -> FeedbackResult)? = nil,
                diagnostics: (() async throws -> FeedbackDiagnostics)? = nil) {
        self.server = server
        self.defaults = defaults
        self.clientMetadata = clientMetadata
        storageKey = Self.storageKey(for: server)
        cacheGeneration = server.map { ServerCacheGeneration.current(for: $0) } ?? 0
        let stored = defaults.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        draft = stored?.draft ?? FeedbackRequest()
        hasUnknownOutcome = stored?.hasUnknownOutcome ?? false
        if stored?.hasUnknownOutcome == true {
            error = SettingsErrorText(String(localized: "The send could not be confirmed. Retry to check the same report."))
        }
        // Like the auth probe, keep credentials bound to the server that opened this composer.
        let headers = CustomHeaderStore.shared.snapshot()
        let client = server.map { APIClient(baseURL: $0, customHeaderProvider: { headers }) }
        self.submit = submit ?? { request in
            guard let client else { throw APIError.invalidServerURL }
            return try await client.submitFeedback(request)
        }
        self.diagnostics = diagnostics ?? {
            guard let client else { throw APIError.invalidServerURL }
            return try await client.feedbackDiagnostics()
        }
        Self.composers.add(self)
    }

    public var canSend: Bool {
        isCurrent && server != nil && !isSending
            && !draft.title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && validationError == nil
    }

    public var validationError: SettingsErrorText? {
        if draft.title.utf16.count > 120 {
            return SettingsErrorText(String(localized: "Title must be 120 characters or fewer."))
        }
        if draft.body.utf16.count > 8000 {
            return SettingsErrorText(String(localized: "Details must be 8000 characters or fewer."))
        }
        return nil
    }

    public func edit(_ change: (inout FeedbackRequest) -> Void) {
        guard isCurrent, !isSending, !hasUnknownOutcome else { return }
        var edited = draft
        change(&edited)
        guard edited != draft else { return }
        if draft.client != nil {
            edited.requestId = UUID()
            edited.client = nil
        }
        draft = edited
        persist()
    }

    public func loadDiagnostics() async {
        guard isCurrent else { return }
        diagnosticsError = nil
        do {
            let result = try await diagnostics()
            guard isCurrent else { return }
            diagnosticsText = result.text
        } catch {
            guard isCurrent else { return }
            diagnosticsError = SettingsErrorText(error)
        }
    }

    /// Presentation changes synchronously, before the task can reach the transport.
    @discardableResult
    public func send() -> Task<Void, Never>? {
        guard canSend else { return nil }
        if draft.client == nil { draft.client = clientMetadata }
        let request = draft
        let previouslyUnknown = hasUnknownOutcome
        hasUnknownOutcome = true
        persist()
        isSending = true
        error = nil
        isPresented = false
        confirmation.showSuccess(GitActionSuccess(title: String(localized: "Feedback sent")))
        return Task {
            guard isCurrent else { return }
            var unresolvedEarlierAttempt = previouslyUnknown
            do {
                let result: FeedbackResult
                do { result = try await submit(request) }
                catch {
                    guard isCurrent else { return }
                    guard Self.shouldRetry(error) else { throw error }
                    unresolvedEarlierAttempt = true
                    result = try await submit(request)
                }
                guard isCurrent else { return }
                guard result.status == "sent", !result.reportId.isEmpty else {
                    throw APIError.decoding(underlying: CocoaError(.coderReadCorrupt))
                }
                draft = FeedbackRequest()
                hasUnknownOutcome = false
                defaults.removeObject(forKey: storageKey)
            } catch {
                guard isCurrent else { return }
                hasUnknownOutcome = unresolvedEarlierAttempt || !Self.isRefusal(error)
                persist()
                if hasUnknownOutcome {
                    let guidance = String(localized: "The send could not be confirmed. Retry to check the same report.")
                    let serviceMessage = (error as? APIError)?.feedbackServiceMessage
                    self.error = SettingsErrorText(serviceMessage.map { "\($0)\n\(guidance)" } ?? guidance)
                } else {
                    self.error = SettingsErrorText(error)
                }
                confirmation.dismissSuccess()
                isPresented = true
            }
            isSending = false
        }
    }

    private func persist() {
        guard isCurrent else { return }
        if let data = try? JSONEncoder().encode(Stored(draft: draft, hasUnknownOutcome: hasUnknownOutcome)) {
            defaults.set(data, forKey: storageKey)
        }
    }

    /// Called after the shared server generation advances, for sign-out, removal, and identity changes.
    static func discardDraft(for server: URL, defaults: UserDefaults) {
        defaults.removeObject(forKey: storageKey(for: server))
        for composer in composers.allObjects where composer.server == server {
            composer.draft = FeedbackRequest()
            composer.diagnosticsText = nil
            composer.diagnosticsError = nil
            composer.error = nil
            composer.hasUnknownOutcome = false
            composer.isPresented = false
            composer.isSending = false
            composer.confirmation.dismissSuccess()
        }
    }

    private var isCurrent: Bool {
        server.map { ServerCacheGeneration.current(for: $0) == cacheGeneration } ?? true
    }

    private static func storageKey(for server: URL?) -> String {
        "feedback-draft.\(server?.absoluteString ?? "disconnected")"
    }

    private static func isRefusal(_ error: Error) -> Bool {
        if let api = error as? APIError,
           ["rate_limited", "feedback_unavailable", "invalid"].contains(api.serverMessage ?? "") { return true }
        return APIError.isDefinitiveWriteFailure(error)
    }

    private static func shouldRetry(_ error: Error) -> Bool {
        !APIError.isCancellation(error) && !isRefusal(error)
    }
}

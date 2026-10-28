import Foundation
import Observation

/// Device-local feedback draft and optimistic presentation. The server owns diagnostics and delivery.
@MainActor
@Observable
public final class FeedbackComposer {
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
        storageKey = "feedback-draft.\(server?.absoluteString ?? "disconnected")"
        let stored = defaults.data(forKey: storageKey).flatMap { try? JSONDecoder().decode(Stored.self, from: $0) }
        draft = stored?.draft ?? FeedbackRequest()
        hasUnknownOutcome = stored?.hasUnknownOutcome ?? false
        if stored?.hasUnknownOutcome == true {
            error = SettingsErrorText(String(localized: "The send could not be confirmed. Retry to check the same report."))
        }
        let client = server.map { APIClient(baseURL: $0) }
        self.submit = submit ?? { request in
            guard let client else { throw APIError.invalidServerURL }
            return try await client.submitFeedback(request)
        }
        self.diagnostics = diagnostics ?? {
            guard let client else { throw APIError.invalidServerURL }
            return try await client.feedbackDiagnostics()
        }
    }

    public var canSend: Bool {
        server != nil && !isSending
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
        guard !isSending, !hasUnknownOutcome else { return }
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
        diagnosticsError = nil
        do { diagnosticsText = try await diagnostics().text }
        catch { diagnosticsError = SettingsErrorText(error) }
    }

    /// Presentation changes synchronously, before the task can reach the transport.
    @discardableResult
    public func send() -> Task<Void, Never>? {
        guard canSend else { return nil }
        if draft.client == nil { draft.client = clientMetadata }
        let request = draft
        hasUnknownOutcome = true
        persist()
        isSending = true
        error = nil
        isPresented = false
        confirmation.showSuccess(GitActionSuccess(title: String(localized: "Feedback sent")))
        return Task {
            do {
                let result: FeedbackResult
                do { result = try await submit(request) }
                catch {
                    guard Self.shouldRetry(error) else { throw error }
                    result = try await submit(request)
                }
                guard result.status == "sent", !result.reportId.isEmpty else {
                    throw APIError.decoding(underlying: CocoaError(.coderReadCorrupt))
                }
                draft = FeedbackRequest()
                hasUnknownOutcome = false
                defaults.removeObject(forKey: storageKey)
            } catch {
                hasUnknownOutcome = !Self.isRefusal(error)
                persist()
                self.error = hasUnknownOutcome
                    ? SettingsErrorText(String(localized: "The send could not be confirmed. Retry to check the same report."))
                    : SettingsErrorText(error)
                confirmation.dismissSuccess()
                isPresented = true
            }
            isSending = false
        }
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(Stored(draft: draft, hasUnknownOutcome: hasUnknownOutcome)) {
            defaults.set(data, forKey: storageKey)
        }
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

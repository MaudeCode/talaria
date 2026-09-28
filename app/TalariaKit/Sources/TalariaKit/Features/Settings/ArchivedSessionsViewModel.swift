import Foundation
import Observation

@MainActor
@Observable
public final class ArchivedSessionsViewModel {
    public private(set) var sessions: [SessionSummary] = []
    public private(set) var isLoading = false
    private(set) var unarchivingSessionIDs: Set<String> = []
    public private(set) var errorMessage: String?
    public private(set) var actionErrorMessage: String?
    /// Last raw failure, exposed so the view can forward it to the shared
    /// API-error handler (401 → re-login), mirroring `SessionListViewModel`.
    public private(set) var lastError: Error?

    private let client: APIClient

    public var isUnarchiving: Bool {
        !unarchivingSessionIDs.isEmpty
    }

    public init(server: URL, client: APIClient? = nil) {
        self.client = client ?? APIClient(baseURL: server)
    }

    public func load() async {
        isLoading = true
        errorMessage = nil
        actionErrorMessage = nil
        lastError = nil

        do {
            // `include_archived=1` is required — the default response excludes
            // archived rows entirely, which made this view permanently empty
            // (issue #17). The merged response keeps the visible rows too; each
            // row carries an `archived` flag (verified against upstream routes.py
            // @312d3fab and the live server), so filter client-side.
            let response = try await client.sessions(includeArchived: true)
            sessions = (response.sessions ?? []).filter {
                Self.nonEmpty($0.sessionId) != nil && $0.archived == true
            }
        } catch {
            // A cancelled load (pull-to-refresh superseding `.task`, or the view
            // disappearing) is not a failure — don't flash an error state.
            if !APIError.isCancellation(error) {
                lastError = error
                errorMessage = error.localizedDescription
            }
        }

        isLoading = false
    }

    public func unarchive(_ session: SessionSummary) async -> Bool {
        guard let sessionId = Self.nonEmpty(session.sessionId) else {
            actionErrorMessage = String(localized: "The server did not provide a session ID.")
            return false
        }
        guard !unarchivingSessionIDs.contains(sessionId) else {
            return false
        }

        guard let removedSession = removeSession(withID: sessionId) else {
            return false
        }

        unarchivingSessionIDs.insert(sessionId)
        actionErrorMessage = nil
        lastError = nil
        defer {
            unarchivingSessionIDs.remove(sessionId)
        }

        do {
            let response = try await client.archiveSession(id: sessionId, archived: false)
            // Rejections (subagent / read-only CLI sessions) arrive as HTTP 400
            // and throw above; a 200 body with an `error` field is surfaced too
            // so the server's own message is always shown (issue #17). An
            // explicit `ok: false` without an `error` string is still a failure
            // (matching the `ok != false` guard used across the app) — only a
            // missing `ok` is treated as success, per tolerant decoding.
            if let error = Self.nonEmpty(response.error) {
                restore(removedSession)
                actionErrorMessage = error
                return false
            }
            if response.ok == false {
                restore(removedSession)
                actionErrorMessage = String(localized: "The server could not unarchive this session.")
                return false
            }
            return true
        } catch {
            restore(removedSession)
            if !APIError.isCancellation(error) {
                lastError = error
                actionErrorMessage = error.localizedDescription
            }
            return false
        }
    }

    public func isUnarchiving(_ session: SessionSummary) -> Bool {
        guard let sessionId = session.sessionId else { return false }
        return unarchivingSessionIDs.contains(sessionId)
    }

    public func clearActionError() {
        actionErrorMessage = nil
    }

    private func removeSession(withID sessionId: String) -> (index: Int, session: SessionSummary)? {
        guard let index = sessions.firstIndex(where: { $0.sessionId == sessionId }) else {
            return nil
        }

        let removed = sessions.remove(at: index)
        return (index, removed)
    }

    private func restore(_ removedSession: (index: Int, session: SessionSummary)) {
        guard removedSession.session.sessionId != nil,
              !sessions.contains(where: { $0.sessionId == removedSession.session.sessionId })
        else {
            return
        }

        sessions.insert(removedSession.session, at: min(removedSession.index, sessions.count))
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

}

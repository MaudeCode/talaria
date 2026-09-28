import Foundation

public struct SessionDuplicateResult {
    public let session: SessionSummary?
    public let errorMessage: String?
}

/// The server refuses `/api/session/move` with a 503 while the session is
/// streaming (it holds the per-session agent lock). Surface that as a specific,
/// actionable message instead of the generic "server unavailable" copy (issue #25).
struct SessionMoveWhileStreamingError: LocalizedError, Equatable {
    var errorDescription: String? {
        String(localized: "This session is still responding, so it can't be moved yet. Try again when it finishes.")
    }
}

public struct SessionMutator {
    let client: APIClient

    public init(client: APIClient) {
        self.client = client
    }

    public func setPinned(_ pinned: Bool, sessionID: String) async throws {
        _ = try await client.pinSession(id: sessionID, pinned: pinned)
    }

    public func archive(sessionID: String) async throws {
        _ = try await client.archiveSession(id: sessionID, archived: true)
    }

    public func delete(sessionID: String) async throws {
        _ = try await client.deleteSession(id: sessionID)
    }

    public func rename(sessionID: String, title: String) async throws -> SessionMutationResponse {
        try await client.renameSession(id: sessionID, title: title)
    }

    public func move(sessionID: String, to projectID: String?) async throws {
        do {
            _ = try await client.moveSession(id: sessionID, projectID: projectID)
        } catch let error as APIError {
            // Only a 503 carrying the server's JSON error payload is the documented
            // "session is busy (streaming)" refusal; a proxy/tunnel 503 has no JSON
            // body and keeps the generic connectivity message.
            guard case .http(let statusCode, _) = error,
                  statusCode == 503,
                  error.serverMessage != nil
            else { throw error }

            throw SessionMoveWhileStreamingError()
        }
    }

    /// Copies a session.
    ///
    /// Uses `/api/session/duplicate`, which deep-copies `messages` *and*
    /// `tool_calls`, carries the token and cost counters over, and leaves the
    /// copy a root session. This used to call `/api/session/branch`, whose
    /// meaning is "fork a child from here": that dropped the tool calls and the
    /// usage totals, and filed the result under the original in the lineage tree,
    /// three wrong outcomes for a menu item labelled Duplicate.
    ///
    /// The server names the copy itself (`title + " (copy)"`), so there is no
    /// title to pass, and it answers with the whole duplicated session, so
    /// there is no second fetch.
    public func duplicate(sessionID: String) async throws -> SessionDuplicateResult {
        let response = try await client.duplicateSession(id: sessionID)

        guard let duplicatedSessionDetail = response.session else {
            return SessionDuplicateResult(
                session: nil,
                errorMessage: String(localized: "The server did not return the duplicated session.")
            )
        }

        return SessionDuplicateResult(
            session: SessionSummary(from: duplicatedSessionDetail),
            errorMessage: nil
        )
    }
}

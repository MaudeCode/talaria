import Foundation

extension APIClient {
    /// Parameterless overload kept so `InsightsDataClient` (and any other
    /// protocol witness) still sees the exact `sessions()` signature — a method
    /// with defaulted parameters cannot satisfy that requirement.
    public func sessions() async throws -> SessionsResponse {
        try await sessions(includeArchived: false, archivedLimit: nil)
    }

    /// Fetches the session list. `includeArchived` opts in to archived rows
    /// (merged with the visible ones; each row carries an `archived` flag) and
    /// `archivedLimit` optionally caps how many archived rows the server appends
    /// (issue #17). Defaults keep today's request untouched.
    public func sessions(includeArchived: Bool = false, archivedLimit: Int? = nil) async throws -> SessionsResponse {
        try await send(
            endpoint: .sessions(includeArchived: includeArchived, archivedLimit: archivedLimit),
            method: "GET"
        )
    }

    /// Requests the session kinds selected in this client without changing the
    /// WebUI browser's saved visibility preferences.
    public func sessions(visibility: AutomatedSessionVisibility) async throws -> SessionsResponse {
        try await send(
            endpoint: .sessions(visibility: visibility),
            method: "GET"
        )
    }

    /// With `visibility`, the server searches the sidebar rows those toggles and
    /// `projectID` select (TAL-308); without it, every stored session.
    public func searchSessions(
        query: String,
        projectID: String? = nil,
        visibility: AutomatedSessionVisibility? = nil,
        content: Bool = true,
        depth: Int = 5
    ) async throws -> SessionSearchResponse {
        try await send(
            endpoint: .sessionsSearch(query: query, content: content, depth: depth, projectID: projectID, visibility: visibility),
            method: "GET"
        )
    }

    public func session(
        id: String,
        includeMessages: Bool = true,
        messageLimit: Int? = 50,
        messageBefore: Int? = nil,
        expandRenderable: Bool = false
    ) async throws -> SessionResponse {
        try await send(
            endpoint: .session(
                id: id,
                includeMessages: includeMessages,
                messageLimit: messageLimit,
                messageBefore: messageBefore,
                expandRenderable: expandRenderable
            ),
            method: "GET"
        )
    }

    func sessionStatus(id: String) async throws -> SessionStatusResponse {
        try await send(endpoint: .sessionStatus(id: id), method: "GET")
    }

    /// Earlier rows of a turn's scene, ending before row `before`.
    public func anchorSceneRows(sessionID: String, messageRef: String?, messageIndex: Int, before: Int, limit: Int = 200) async throws -> AnchorScenePageResponse {
        try await send(
            endpoint: .anchorScene(sessionID: sessionID, messageRef: messageRef, messageIndex: messageIndex, before: before, limit: limit),
            method: "GET"
        )
    }

    /// TAL-331: one tool call's whole, redacted result, for a scene row the server clipped (`result_truncated`).
    public func toolResult(sessionID: String, toolCallID: String) async throws -> ToolResultResponse {
        try await send(endpoint: .toolResult(sessionID: sessionID, toolCallID: toolCallID), method: "GET")
    }

    public func createSession(
        workspace: String?,
        model: String?,
        modelProvider: String?,
        profile: String?,
        projectID: String? = nil
    ) async throws -> SessionResponse {
        try await send(
            endpoint: .newSession,
            method: "POST",
            body: NewSessionRequest(
                workspace: workspace,
                model: model,
                modelProvider: modelProvider,
                profile: profile,
                projectId: projectID
            )
        )
    }

    public func renameSession(id: String, title: String) async throws -> SessionMutationResponse {
        try await send(
            endpoint: .renameSession,
            method: "POST",
            body: RenameSessionRequest(sessionId: id, title: title)
        )
    }

    func deleteSession(id: String) async throws -> SessionMutationResponse {
        try await send(
            endpoint: .deleteSession,
            method: "POST",
            body: SessionIDRequest(sessionId: id)
        )
    }

    func pinSession(id: String, pinned: Bool) async throws -> SessionMutationResponse {
        try await send(
            endpoint: .pinSession,
            method: "POST",
            body: PinSessionRequest(sessionId: id, pinned: pinned)
        )
    }

    public func archiveSession(id: String, archived: Bool) async throws -> SessionMutationResponse {
        try await send(
            endpoint: .archiveSession,
            method: "POST",
            body: ArchiveSessionRequest(sessionId: id, archived: archived)
        )
    }

    func bulkSessions(action: SessionBulkAction, ids: [String]) async throws -> SessionBulkResponse {
        try await send(
            endpoint: .bulkSessions,
            method: "POST",
            body: BulkSessionsRequest(action: action, sessionIds: ids)
        )
    }

    public func branchSession(id: String, keepCount: Int? = nil, title: String? = nil) async throws -> SessionBranchResponse {
        try await send(
            endpoint: .branchSession,
            method: "POST",
            body: BranchSessionRequest(sessionId: id, keepCount: keepCount, title: title)
        )
    }

    /// Copies a session. Answers with the whole duplicated session, so no
    /// follow-up fetch is needed. Rejects subagent sessions with a 400 — they
    /// are view-only upstream.
    func duplicateSession(id: String) async throws -> SessionResponse {
        try await send(
            endpoint: .duplicateSession,
            method: "POST",
            body: SessionIDRequest(sessionId: id)
        )
    }

    public func compressSession(id: String, focusTopic: String? = nil) async throws -> SessionCompressResponse {
        try await send(
            endpoint: .compressSession,
            method: "POST",
            body: CompressSessionRequest(sessionId: id, focusTopic: focusTopic)
        )
    }

    public func undoSession(id: String) async throws -> SessionUndoResponse {
        try await send(
            endpoint: .undoSession,
            method: "POST",
            body: SessionIDRequest(sessionId: id)
        )
    }

    public func retrySession(id: String) async throws -> SessionRetryResponse {
        try await send(
            endpoint: .retrySession,
            method: "POST",
            body: SessionIDRequest(sessionId: id)
        )
    }

    public func truncateSession(id: String, keepCount: Int) async throws -> SessionResponse {
        try await send(
            endpoint: .truncateSession,
            method: "POST",
            body: TruncateSessionRequest(sessionId: id, keepCount: keepCount)
        )
    }

    public func updateSession(
        id: String,
        workspace: String?,
        model: String?,
        modelProvider: String?
    ) async throws -> SessionResponse {
        try await send(
            endpoint: .updateSession,
            method: "POST",
            body: UpdateSessionRequest(
                sessionId: id,
                workspace: workspace,
                model: model,
                modelProvider: modelProvider
            )
        )
    }

    func moveSession(id: String, projectID: String?) async throws -> SessionMutationResponse {
        try await send(
            endpoint: .moveSession,
            method: "POST",
            body: MoveSessionRequest(sessionId: id, projectId: projectID)
        )
    }

    public func sessionYolo(sessionID: String) async throws -> SessionYoloResponse {
        try await send(endpoint: .sessionYolo(sessionID: sessionID), method: "GET")
    }

    public func setSessionYolo(sessionID: String, enabled: Bool) async throws -> SessionYoloResponse {
        try await send(
            endpoint: .sessionYolo(sessionID: nil),
            method: "POST",
            body: SessionYoloRequest(sessionId: sessionID, enabled: enabled)
        )
    }

    /// Sets the session's toolset override; nil restores the profile's defaults (TAL-631).
    public func setSessionToolsets(sessionID: String, toolsets: [String]?) async throws -> SessionToolsetsResponse {
        try await send(
            endpoint: .sessionToolsets,
            method: "POST",
            body: SessionToolsetsRequest(sessionId: sessionID, toolsets: toolsets)
        )
    }
}

public struct SessionToolsetsResponse: Decodable, Equatable {
    public let enabledToolsets: [String]?
}

private struct SessionToolsetsRequest: Encodable {
    let sessionId: String
    let toolsets: [String]?

    enum CodingKeys: String, CodingKey {
        case sessionId
        case toolsets
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sessionId, forKey: .sessionId)
        // An explicit null, not an absent key: null is the request for the profile's defaults.
        try container.encode(toolsets, forKey: .toolsets)
    }
}

private struct NewSessionRequest: Encodable {
    let workspace: String?
    let model: String?
    let modelProvider: String?
    let profile: String?
    let projectId: String?
}

private struct RenameSessionRequest: Encodable {
    let sessionId: String
    let title: String
}

private struct SessionIDRequest: Encodable {
    let sessionId: String
}

private struct PinSessionRequest: Encodable {
    let sessionId: String
    let pinned: Bool
}

private struct ArchiveSessionRequest: Encodable {
    let sessionId: String
    let archived: Bool
}

private struct BulkSessionsRequest: Encodable {
    let action: SessionBulkAction
    let sessionIds: [String]
}

private struct BranchSessionRequest: Encodable {
    let sessionId: String
    let keepCount: Int?
    let title: String?
}

private struct CompressSessionRequest: Encodable {
    let sessionId: String
    let focusTopic: String?
}

private struct TruncateSessionRequest: Encodable {
    let sessionId: String
    let keepCount: Int
}

private struct UpdateSessionRequest: Encodable {
    let sessionId: String
    let workspace: String?
    let model: String?
    let modelProvider: String?
}

private struct MoveSessionRequest: Encodable {
    let sessionId: String
    let projectId: String?
}

private struct SessionYoloRequest: Encodable {
    let sessionId: String
    let enabled: Bool
}

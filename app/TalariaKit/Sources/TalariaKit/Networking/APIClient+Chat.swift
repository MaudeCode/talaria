import Foundation

extension APIClient {
    public func startChat(
        sessionID: String,
        message: String,
        workspace: String?,
        model: String?,
        modelProvider: String? = nil,
        profile: String? = nil,
        explicitModelPick: Bool = false,
        attachments: [JSONValue]? = nil
    ) async throws -> ChatStartResponse {
        try await send(
            endpoint: .chatStart,
            method: "POST",
            body: ChatStartRequest(
                sessionId: sessionID,
                message: message,
                workspace: workspace,
                model: model,
                modelProvider: modelProvider,
                profile: profile,
                explicitModelPick: explicitModelPick ? true : nil,
                attachments: attachments
            )
        )
    }

    public nonisolated func chatStreamURL(streamID: String, replayAfterSeq: Int? = nil) -> URL {
        let url = Endpoint.chatStream(streamID: streamID).url(relativeTo: baseURL)
        guard let replayAfterSeq,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else {
            return url
        }

        // Percent-encoded items keep the endpoint's `%2B` escapes intact.
        var queryItems = components.percentEncodedQueryItems ?? []
        queryItems.append(URLQueryItem(name: "replay", value: "1"))
        queryItems.append(URLQueryItem(name: "after_seq", value: "\(max(0, replayAfterSeq))"))
        components.percentEncodedQueryItems = queryItems
        return components.url ?? url
    }

    func cancelChat(streamID: String) async throws -> ChatCancelResponse {
        try await send(endpoint: .chatCancel(streamID: streamID), method: "GET")
    }

    public func chatStreamStatus(streamID: String) async throws -> ChatStreamStatusResponse {
        try await send(endpoint: .chatStreamStatus(streamID: streamID), method: "GET")
    }

    public func approvalPending(sessionID: String) async throws -> ApprovalPendingResponse {
        try await send(endpoint: .approvalPending(sessionID: sessionID), method: "GET")
    }

    public nonisolated func approvalStreamURL(sessionID: String) -> URL {
        Endpoint.approvalStream(sessionID: sessionID).url(relativeTo: baseURL)
    }

    public func respondApproval(
        sessionID: String,
        choice: ApprovalChoice,
        approvalID: String?
    ) async throws -> ApprovalRespondResponse {
        try await send(
            endpoint: .approvalRespond,
            method: "POST",
            body: ApprovalRespondRequest(
                sessionId: sessionID,
                choice: choice,
                approvalId: approvalID
            )
        )
    }

    public func clarifyPending(sessionID: String) async throws -> ClarificationPendingResponse {
        try await send(endpoint: .clarifyPending(sessionID: sessionID), method: "GET")
    }

    public nonisolated func clarifyStreamURL(sessionID: String) -> URL {
        Endpoint.clarifyStream(sessionID: sessionID).url(relativeTo: baseURL)
    }

    public func respondClarification(
        sessionID: String,
        response: String? = nil,
        clarifyID: String?,
        answers: [String: JSONValue]? = nil
    ) async throws -> ClarificationRespondResponse {
        try await send(
            endpoint: .clarifyRespond,
            method: "POST",
            body: ClarificationRespondRequest(
                sessionId: sessionID,
                response: response,
                clarifyId: clarifyID,
                answers: answers
            )
        )
    }

    public func steerChat(sessionID: String, text: String, steerID: String) async throws -> ChatSteerResponse {
        try await send(
            endpoint: .chatSteer,
            method: "POST",
            body: ChatSteerRequest(sessionId: sessionID, text: text, steerId: steerID)
        )
    }

    /// TAL-426: take a pending steer back (`edit`, `cancel`); `withdrawn: false` when the Agent already took it.
    public func withdrawSteer(sessionID: String, steerID: String, reason: PendingSteerWithdrawReason) async throws -> SteerWithdrawResponse {
        try await send(endpoint: .chatSteerWithdraw, method: "POST", body: SteerWithdrawRequest(sessionId: sessionID, steerId: steerID, reason: reason))
    }

    /// TAL-426: deliver a pending steer now; `redirected: false` when nothing is running to take it.
    public func sendSteerNow(sessionID: String, steerID: String) async throws -> SteerSendNowResponse {
        try await send(endpoint: .chatSteerSendNow, method: "POST", body: SteerSendNowRequest(sessionId: sessionID, steerId: steerID))
    }

    public func submitGoal(
        sessionID: String,
        args: String,
        workspace: String?,
        model: String?,
        modelProvider: String?,
        profile: String?
    ) async throws -> GoalSubmissionResponse {
        try await send(
            endpoint: .submitGoal,
            method: "POST",
            body: GoalSubmissionRequest(
                sessionId: sessionID,
                args: args,
                workspace: workspace,
                model: model,
                modelProvider: modelProvider,
                profile: profile
            )
        )
    }

    public func startBtw(sessionID: String, question: String) async throws -> BtwStartResponse {
        try await send(
            endpoint: .btw,
            method: "POST",
            body: BtwRequest(sessionId: sessionID, question: question)
        )
    }

    public func startBackground(sessionID: String, prompt: String) async throws -> BackgroundStartResponse {
        try await send(
            endpoint: .background,
            method: "POST",
            body: BackgroundRequest(sessionId: sessionID, prompt: prompt)
        )
    }

    /// TAL-372: every piece of the session's background work; reading never consumes a result.
    public func backgroundTasks(sessionID: String) async throws -> BackgroundTasksResponse {
        try await send(endpoint: .backgroundTasks(sessionID: sessionID), method: "GET")
    }

    /// ponytail: old-server fallback (TAL-372): a Web without `/api/background/tasks` reports each finished task once here.
    public func backgroundStatus(sessionID: String) async throws -> BackgroundStatusResponse {
        try await send(endpoint: .backgroundStatus(sessionID: sessionID), method: "GET")
    }

    public func backgroundResult(sessionID: String, taskID: String) async throws -> BackgroundTaskResult {
        try await send(endpoint: .backgroundResult(sessionID: sessionID, taskID: taskID), method: "GET")
    }

    public func dismissBackgroundTask(sessionID: String, taskID: String) async throws -> BackgroundDismissResponse {
        try await send(endpoint: .backgroundDismiss, method: "POST", body: BackgroundDismissRequest(sessionId: sessionID, taskId: taskID))
    }
}

private struct BackgroundDismissRequest: Encodable {
    let sessionId: String
    let taskId: String
}

private struct ChatStartRequest: Encodable {
    let sessionId: String
    let message: String
    let workspace: String?
    let model: String?
    let modelProvider: String?
    let profile: String?
    let explicitModelPick: Bool?
    let attachments: [JSONValue]?
}

private struct SteerWithdrawRequest: Encodable {
    let sessionId: String
    let steerId: String
    let reason: PendingSteerWithdrawReason
}

private struct SteerSendNowRequest: Encodable {
    let sessionId: String
    let steerId: String
}

private struct ChatSteerRequest: Encodable {
    let sessionId: String
    let text: String
    let steerId: String
}

private struct GoalSubmissionRequest: Encodable {
    let sessionId: String
    let args: String
    let workspace: String?
    let model: String?
    let modelProvider: String?
    let profile: String?
}

private struct ApprovalRespondRequest: Encodable {
    let sessionId: String
    let choice: ApprovalChoice
    let approvalId: String?
}

private struct ClarificationRespondRequest: Encodable {
    let sessionId: String
    let response: String?
    let clarifyId: String?
    let answers: [String: JSONValue]?
}

private struct BtwRequest: Encodable {
    let sessionId: String
    let question: String
}

private struct BackgroundRequest: Encodable {
    let sessionId: String
    let prompt: String
}

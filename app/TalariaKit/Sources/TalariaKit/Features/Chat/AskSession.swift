import Foundation

/// TAL-1470: one question asked outside the chat screen (Siri, Shortcuts, the Action button). Starts a new chat with
/// the prompt, follows its stream to the turn's end, and returns what the server said. It never answers an approval
/// or a question for the user: those, a run past `timeout`, and a lost stream leave the chat running and hand back
/// its deep link.
@MainActor
public struct AskSession {
    public struct Result: Equatable, Sendable {
        public enum Status: Equatable, Sendable {
            /// `text` is the server's read-aloud script of the final answer.
            case replied
            /// `text` is the server's approval or clarification prompt.
            case needsInput
            /// The run outlived `timeout` or its stream; `text` is empty.
            case stillWorking
            /// `text` is the server's error message.
            case failed
        }

        public let status: Status
        public let text: String
        /// Opens the new chat.
        public let sessionURL: URL?
    }

    /// The server refused to start the chat; `message` is its reason.
    public struct Failure: LocalizedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }

        public init(message: String) { self.message = message }
    }

    let client: APIClient
    let timeout: Duration
    let makeStream: @MainActor () -> any SSEStreamingClient

    public init(
        client: APIClient,
        timeout: Duration = .seconds(60),
        makeStream: @escaping @MainActor () -> any SSEStreamingClient
    ) {
        self.client = client
        self.timeout = timeout
        self.makeStream = makeStream
    }

    /// `profile` nil asks in the server's active profile. Another profile is switched to first, as the app does: the
    /// server admits a chat and its stream only in the request's active profile, which the profile cookie carries.
    public func ask(_ prompt: String, profile: String?) async throws -> Result {
        if let profile, let error = try await client.switchProfile(name: profile).error {
            throw Failure(message: error)
        }
        let created = try await client.createSession(workspace: nil, model: nil, modelProvider: nil, profile: profile)
        guard let sessionID = created.session?.sessionId, !sessionID.isEmpty else {
            throw Failure(message: String(localized: "The server did not return the new session ID."))
        }
        let started = try await client.startChat(sessionID: sessionID, message: prompt, workspace: nil, model: nil, profile: profile)
        guard let streamID = started.streamId, !streamID.isEmpty else {
            throw Failure(message: started.error ?? String(localized: "The server did not return a stream ID."))
        }

        let sessionURL = TalariaDeepLink.sessionURL(sessionID: sessionID)
        func result(_ status: Result.Status, _ text: String = "") -> Result {
            Result(status: status, text: text, sessionURL: sessionURL)
        }

        let (events, continuation) = AsyncStream.makeStream(of: SSEEvent.self)
        let stream = makeStream()
        stream.start(url: client.chatStreamURL(streamID: streamID)) { continuation.yield($0) }
        let timer = Task { [timeout] in
            try? await Task.sleep(for: timeout)
            continuation.finish()
        }
        defer {
            timer.cancel()
            stream.stop()
        }

        var streamedText = ""
        for await event in events {
            switch event {
            case .token(let text):
                streamedText += text
            case .done(let done):
                let answer = done.session?.messages?.compactMap(\.activityScene).last?.finalAnswer ?? streamedText
                guard !answer.isEmpty else { return result(.failed, String(localized: "The agent did not reply.")) }
                let spoken = (try? await client.prepareSpeech(text: answer)) ?? answer
                return result(.replied, spoken)
            case .approvalPending(let approval):
                guard let pending = approval.pending else { continue }
                return result(.needsInput, pending.description ?? pending.command ?? "")
            case .clarificationPending(let clarification):
                guard let pending = clarification.pending, !pending.isEmpty else { continue }
                return result(.needsInput, pending.steps?.first?.question ?? "")
            case .error(let message, _):
                return result(.failed, message)
            case .cancelled:
                return result(.failed, String(localized: "The request was cancelled."))
            case .streamEnd, .transportError:
                return result(.stillWorking)
            default:
                continue
            }
        }
        return result(.stillWorking)
    }
}

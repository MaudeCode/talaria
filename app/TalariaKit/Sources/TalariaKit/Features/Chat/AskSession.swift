import Foundation

/// TAL-1470: one question asked outside the chat screen (Siri, Shortcuts, the Action button). Starts a new chat with
/// the prompt, or continues the chat a reply names (TAL-2231), follows its stream to the turn's end, and returns what
/// the server said. It never answers an approval or a question for the user: those, a run past `timeout`, a cancelled
/// task and a lost stream leave the chat running and hand back its deep link.
@MainActor
public struct AskSession {
    public struct Result: Equatable, Sendable {
        public enum Status: Equatable, Sendable {
            /// `text` is the server's read-aloud script of the final answer.
            case replied
            /// `text` is the server's approval or clarification prompt.
            case needsInput
            /// The run outlived `timeout`, its stream or the calling task; `text` is empty.
            case stillWorking
            /// `text` is the server's error message.
            case failed
        }

        public let status: Status
        public let text: String
        /// Opens the chat.
        public let sessionURL: URL?
    }

    /// The server refused to start the chat; `message` is its reason.
    public struct Failure: LocalizedError, Equatable {
        public let message: String
        public var errorDescription: String? { message }

        public init(message: String) { self.message = message }
    }

    /// TAL-2231: the chat the last Ask or Reply on this device used, so Reply continues it.
    public struct Last: Codable, Equatable, Sendable {
        public let sessionID: String
        /// Nil: the server's active profile.
        public let profile: String?
    }

    /// TAL-2231: device-local memory of the last chat and the server it is on, in the App Group defaults.
    public struct Memory {
        private struct Stored: Codable {
            let serverID: String
            let last: Last
        }

        let serverID: String
        let defaults: UserDefaults?
        private static let storageKey = "askSession.last.v1"

        public init(
            serverID: String,
            defaults: UserDefaults? = UserDefaults(suiteName: TalariaShareDraft.appGroupIdentifier)
        ) {
            self.serverID = serverID
            self.defaults = defaults
        }

        /// Another server's chat is never continued.
        var last: Last? {
            guard let data = defaults?.data(forKey: Self.storageKey),
                  let stored = try? JSONDecoder().decode(Stored.self, from: data),
                  stored.serverID == serverID
            else { return nil }
            return stored.last
        }

        func remember(_ last: Last) {
            guard let defaults, let data = try? JSONEncoder().encode(Stored(serverID: serverID, last: last)) else { return }
            defaults.set(data, forKey: Self.storageKey)
        }
    }

    let client: APIClient
    /// Nil follows the run until it ends or the calling task is cancelled.
    public var timeout: Duration?
    let memory: Memory?
    let clock: any Clock<Duration>
    /// How often a quiet stream re-reports the last activity, so the system never sees a stalled task.
    let heartbeat: Duration
    let makeStream: @MainActor () -> any SSEStreamingClient

    public init(
        client: APIClient,
        timeout: Duration? = .seconds(60),
        memory: Memory? = nil,
        clock: any Clock<Duration> = ContinuousClock(),
        heartbeat: Duration = .seconds(5),
        makeStream: @escaping @MainActor () -> any SSEStreamingClient
    ) {
        self.client = client
        self.timeout = timeout
        self.memory = memory
        self.clock = clock
        self.heartbeat = heartbeat
        self.makeStream = makeStream
    }

    /// The chat a reply continues; nil when this device has not asked on this server yet.
    public var last: Last? { memory?.last }

    /// `profile` nil asks in the server's active profile. Another profile is switched to first, as the app does: the
    /// server admits a chat and its stream only in the request's active profile, which the profile cookie carries.
    /// `sessionID` continues that chat and nil starts a new one; either way it becomes the chat a reply continues.
    /// `progress` gets the server's activity text verbatim as it streams, and a tick every `heartbeat`.
    public func ask(
        _ prompt: String,
        profile: String?,
        sessionID existingSessionID: String? = nil,
        progress: Progress? = nil
    ) async throws -> Result {
        if let profile, let error = try await client.switchProfile(name: profile).error {
            throw Failure(message: error)
        }
        let sessionID: String
        // A reply restores the chat's profile even after the app switched profiles; nil only when the server names none.
        var sessionProfile = profile
        if let existingSessionID {
            sessionID = existingSessionID
        } else {
            let created = try await client.createSession(workspace: nil, model: nil, modelProvider: nil, profile: profile)
            guard let newID = created.session?.sessionId, !newID.isEmpty else {
                throw Failure(message: String(localized: "The server did not return the new session ID."))
            }
            sessionID = newID
            sessionProfile = created.session?.profile ?? profile
        }
        let started = try await client.startChat(sessionID: sessionID, message: prompt, workspace: nil, model: nil, profile: profile)
        guard let streamID = started.streamId, !streamID.isEmpty else {
            throw Failure(message: started.error ?? String(localized: "The server did not return a stream ID."))
        }
        memory?.remember(Last(sessionID: sessionID, profile: sessionProfile))

        let sessionURL = TalariaDeepLink.sessionURL(sessionID: sessionID)
        func result(_ status: Result.Status, _ text: String = "") -> Result {
            Result(status: status, text: text, sessionURL: sessionURL)
        }

        progress?.totalUnitCount = -1
        func report(_ activity: String?) {
            guard let progress else { return }
            if let activity, !activity.isEmpty { progress.localizedDescription = activity }
            progress.completedUnitCount += 1
        }

        let (events, continuation) = AsyncStream.makeStream(of: SSEEvent.self)
        let stream = makeStream()
        stream.start(url: client.chatStreamURL(streamID: streamID)) { continuation.yield($0) }
        let timer = timeout.map { timeout in
            Task { [clock] in
                try? await clock.sleep(for: timeout)
                continuation.finish()
            }
        }
        let beat = progress.map { _ in
            Task { [clock, heartbeat] in
                while (try? await clock.sleep(for: heartbeat)) != nil { report(nil) }
            }
        }
        defer {
            timer?.cancel()
            beat?.cancel()
            stream.stop()
        }

        // Cancelling the calling task ends this loop; the run goes on on the server.
        var streamedText = ""
        for await event in events {
            switch event {
            case .reasoning(let reasoning):
                report(reasoning.titles.last)
            case .toolStarted(let tool), .toolProgress(let tool):
                report(tool.progress?.message ?? tool.preview)
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

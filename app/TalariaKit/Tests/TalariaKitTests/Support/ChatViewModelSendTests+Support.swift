// Shared by the package tests and the App-hosted TalariaTests, which compiles this file too (TAL-399).
import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UniformTypeIdentifiers
@testable import TalariaKit

@MainActor
extension ChatViewModelSendTests {
    static func toolHeavyRecentSessionJSON(offset: Int = 200, activeStreamID: String? = nil) throws -> String {
        var messages: [[String: Any]] = []
        for turn in 0..<25 {
            let scene: [String: Any] = ["version": "activity_scene_v1", "final_answer": "Recent answer \(turn)",
                "activity_rows": [["row_id": "prose-\(turn)", "order_index": 0, "role": "prose", "text": "Cached work \(turn)"]]]
            let rows: [[String: Any]] = [
                ["role": "user", "content": "Recent question \(turn)", "message_id": "question-\(turn)", "_ts": 2_000_000_000 + turn * 4, "_display": "row"],
                ["role": "tool", "content": "Tool result A", "message_id": "tool-a-\(turn)", "_display": "hidden"],
                ["role": "tool", "content": "Tool result B", "message_id": "tool-b-\(turn)", "_display": "hidden"],
                ["role": "assistant", "content": "Recent answer \(turn)", "message_id": "answer-\(turn)", "_ts": 2_000_000_003 + turn * 4, "_display": "row",
                 "_anchor_activity_scene": scene]
            ]
            messages.append(contentsOf: rows)
        }
        var session: [String: Any] = ["session_id": "session-abc", "title": "Recent tool-heavy chat", "messages": messages,
                                      "_messages_offset": offset, "_messages_truncated": true, "message_count": offset + messages.count]
        if let activeStreamID { session["active_stream_id"] = activeStreamID }
        return String(decoding: try JSONSerialization.data(withJSONObject: ["session": session]), as: UTF8.self)
    }

    /// A `503 {"error": ...}` for `/api/tts` — the canonical "server TTS refused,
    /// use the on-device fallback" stimulus for Listen tests (#15).
    static func ttsUnavailableResponse(for request: URLRequest) -> (HTTPURLResponse, Data) {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 503,
            httpVersion: nil,
            headerFields: ["Content-Type": "application/json"]
        )!
        return (response, Data(#"{"error": "TTS engine unavailable"}"#.utf8))
    }

    /// The test-owned clock for server rows that confirm a prompt sent during the test: a reload only accepts
    /// a server copy near the optimistic row's device timestamp, so a frozen epoch reads as an older turn.
    var serverNow: Int { Int(Date().timeIntervalSince1970) }

    func makeReloadedToolProgressModel(stream: SpySSEStreamingClient) throws -> ChatViewModel {
        try makeViewModel(streamClient: stream) { request in
            switch request.url?.path {
            case "/api/session":
                return apiTestJSONResponse(#"{"session":{"session_id":"session-abc","title":"Reloaded tool progress","model":"fixture-model","model_provider":"custom","active_stream_id":"run-tools","messages":[{"role":"user","content":"Index files","message_id":"prompt"},{"role":"assistant","content":"","message_id":"reply","_anchor_activity_scene":{"version":"activity_scene_v1","terminal_state":"running","activity_rows":[{"row_id":"row","role":"tool","tool":{"id":"call-index","name":"mcp__index","done":false,"progress":{"percent":42,"message":"indexing"}}}]}}]}}"#, for: request)
            case "/api/chat/stream/status": return apiTestJSONResponse(#"{"active":true}"#, for: request)
            case "/api/models": return apiTestJSONResponse(#"{"groups":[],"models":[{"id":"fixture-model","label":"Fixture Model"}],"default_model":"fixture-model","active_provider":"custom"}"#, for: request)
            case "/api/profiles": return apiTestJSONResponse(#"{"profiles":[],"single_profile_mode":true}"#, for: request)
            case "/api/workspaces": return apiTestJSONResponse(#"{"workspaces":[]}"#, for: request)
            case "/api/commands": return apiTestJSONResponse(#"{"commands":[]}"#, for: request)
            case "/api/session/yolo": return apiTestJSONResponse(#"{"ok":true,"yolo_enabled":false}"#, for: request)
            default: return apiTestJSONResponse("{}", for: request)
            }
        }
    }

    func makeEphemeralUserDefaults() throws -> UserDefaults {
        let suiteName = "TalariaTests.\(UUID().uuidString)"
        let userDefaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        userDefaults.removePersistentDomain(forName: suiteName)
        return userDefaults
    }

    @MainActor
    func makeViewModel(
        streamClient: SSEStreamingClient? = nil,
        approvalStreamClient: SSEStreamingClient? = nil,
        clarifyStreamClient: SSEStreamingClient? = nil,
        sessionSummary: SessionSummary? = nil,
        liveActivityManager: (any AgentLiveActivityManaging)? = nil,
        pollingIntervals: ChatPollingIntervals = .standard,
        streamingScrollCoalescingDelayNanoseconds: UInt64 = 16_000_000,
        speechSynthesizerFactory: @escaping () -> any ChatSpeechSynthesizing = { AVSpeechSynthesizer() },
        listenAudioSession: (any ListenAudioSessionControlling)? = nil,
        listenRemoteControlCenter: (any ListenRemoteControlControlling)? = nil,
        serverTTSAudioPlayerFactory: (@MainActor (Data) throws -> any ListenAudioPlaying)? = nil,
        draftAttachmentStore: any ChatDraftAttachmentStoring = RecordingSendDraftAttachmentStore(),
        userDefaults: UserDefaults? = nil,
        server: URL = URL(string: "https://example.test")!,
        protocolClasses: [AnyClass] = [MockURLProtocol.self],
        responseCache: ResponseCache? = nil,
        spokenText: ((String) -> String)? = { $0 },
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) throws -> ChatViewModel {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = protocolClasses
        // Listen asks the server for its read-aloud script first (TAL-906): `spokenText` answers it,
        // the message as written by default; nil hands that request to `handler` too.
        let routed: (URLRequest) throws -> (HTTPURLResponse, Data) = { request in
            guard let spokenText, request.url?.path == "/api/speech/prepare" else { return try handler(request) }
            let text = try apiTestJSONBody(from: request)["text"] as? String ?? ""
            let body = try JSONSerialization.data(withJSONObject: ["spoken_text": spokenText(text)])
            return apiTestJSONResponse(String(decoding: body, as: UTF8.self), for: request)
        }
        // Scope the handler to this view model's session: `MockURLProtocol.requestHandler`
        // is process-global, and a view model's untracked follow-up request (the
        // post-stream title refresh) would otherwise land on the next test's handler.
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(routed)]
        let urlSession = URLSession(configuration: configuration)
        let client = APIClient(baseURL: server, session: urlSession)
        let summary: SessionSummary
        if let sessionSummary {
            summary = sessionSummary
        } else {
            summary = try makeSession()
        }

        let resolvedStreamClient = streamClient ?? SpySSEStreamingClient()
        let viewModel = ChatViewModel(
            session: summary,
            server: server,
            client: client,
            streamClient: resolvedStreamClient,
            approvalStreamClient: approvalStreamClient ?? SpySSEStreamingClient(),
            clarifyStreamClient: clarifyStreamClient ?? SpySSEStreamingClient(),
            // Default to a spy so unit tests never leave real Live Activities on the simulator (TAL-375).
            liveActivityManager: liveActivityManager ?? SpyChatLiveActivityManager(),
            pollingIntervals: pollingIntervals,
            streamingScrollCoalescingDelayNanoseconds: streamingScrollCoalescingDelayNanoseconds,
            speechSynthesizerFactory: speechSynthesizerFactory,
            // Default to a spy so unit tests never drive the live shared AVAudioSession.
            listenAudioSession: listenAudioSession ?? SpyListenAudioSession(),
            listenRemoteControlCenter: listenRemoteControlCenter ?? SpyListenRemoteControlCenter(),
            serverTTSAudioPlayerFactory: serverTTSAudioPlayerFactory,
            draftAttachmentStore: draftAttachmentStore,
            // Test-owned state: a fresh suite unless the test passes its own.
            userDefaults: try userDefaults ?? makeEphemeralUserDefaults(),
            responseCache: responseCache
        )

        if let spyStreamClient = resolvedStreamClient as? SpySSEStreamingClient {
            spyStreamClient.flushPendingStreamingContent = { [weak viewModel] in
                viewModel?.flushPendingStreamingContent()
            }
        }

        return viewModel
    }

    /// Polls `condition` until it holds. The deadline is generous because a loaded CI runner can starve the
    /// main actor for seconds; a condition that already holds returns at once.
    @MainActor
    func waitUntil(
        timeout: Duration = .seconds(10),
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let deadline = ContinuousClock.now + timeout
        while !condition() {
            guard ContinuousClock.now < deadline else {
                return XCTFail("Condition was not met within \(timeout)", file: file, line: line)
            }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func runMainActorTest(
        timeout: TimeInterval = 5,
        _ body: @escaping @MainActor () async throws -> Void
    ) {
        let expectation = expectation(description: "MainActor async test")
        Task { @MainActor in
            defer { expectation.fulfill() }

            do {
                try await body()
            } catch {
                XCTFail("Unexpected error: \(error)")
            }
        }
        wait(for: [expectation], timeout: timeout)
    }

    func makeSession(
        title: String = "Planning",
        model: String? = "gpt-5.4",
        modelProvider: String? = nil,
        modelOptionID: String? = nil,
        profile: String? = nil,
        readOnly: Bool = false
    ) throws -> SessionSummary {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let modelJSON = model.map { ",\n              \"model\": \"\($0)\"" } ?? ""
        let modelProviderJSON = modelProvider.map { ",\n              \"model_provider\": \"\($0)\"" } ?? ""
        let optionJSON = modelOptionID.map { ",\n              \"model_option_id\": \"\($0)\"" } ?? ""
        let profileJSON = profile.map { ",\n              \"profile\": \"\($0)\"" } ?? ""
        let readOnlyJSON = readOnly ? ",\n              \"read_only\": true" : ""
        return try decoder.decode(
            SessionSummary.self,
            from: Data("""
            {
              "session_id": "session-abc",
              "title": "\(title)",
              "workspace": "/tmp/workspace"\(modelJSON)\(modelProviderJSON)\(optionJSON)\(profileJSON)\(readOnlyJSON),
              "can_branch": \(!readOnly)
            }
            """.utf8)
        )
    }

    func makeSessionDetail(_ json: String) throws -> SessionDetail {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionDetail.self, from: Data(json.utf8))
    }

    func makeContext() throws -> ModelContext {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true, cloudKitDatabase: .none)
        let container = try ModelContainer(
            for: CachedSession.self,
            CachedMessage.self,
            configurations: configuration
        )
        return ModelContext(container)
    }

    func makeJPEGData(size: CGSize) throws -> Data {
        try XCTUnwrap(TestImages.jpegData(width: Int(size.width), height: Int(size.height)))
    }

    func maxPixelDimension(in data: Data) throws -> Int {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        let properties = try XCTUnwrap(
            CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
        )
        let width = try XCTUnwrap(properties[kCGImagePropertyPixelWidth] as? NSNumber).intValue
        let height = try XCTUnwrap(properties[kCGImagePropertyPixelHeight] as? NSNumber).intValue
        return max(width, height)
    }

    @MainActor
    func waitForStreamingContent(
        _ viewModel: ChatViewModel,
        toSatisfy predicate: (String?) -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        try await waitUntil(file: file, line: line) { predicate(viewModel.messages.last?.content) }
    }
}

final class LockedCounter {
    private let lock = NSLock()
    private var value = 0

    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }

        value += 1
        return value
    }

    var count: Int {
        lock.lock()
        defer { lock.unlock() }

        return value
    }
}

@MainActor
final class SpyChatLiveActivityManager: AgentLiveActivityManaging {
    struct AggregateArm: Equatable {
        let sessionID: String
        let sessionTitle: String
        let publisherURL: URL
    }

    struct End: Equatable {
        let status: AgentRunActivityStatus
        let activity: String
        let errorSummary: String?
    }

    private(set) var aggregateArms: [AggregateArm] = []
    private(set) var ends: [End] = []

    func armAggregateForLocalWork(sessionID: String, sessionTitle: String, publisherURL: URL) {
        aggregateArms.append(AggregateArm(
            sessionID: sessionID,
            sessionTitle: sessionTitle,
            publisherURL: publisherURL
        ))
    }

    func start(sessionID: String, sessionTitle: String, streamID: String?, publisherURL: URL, startedAt: Date) {}

    private(set) var updates: [AgentLiveActivityEvent] = []
    func update(_ event: AgentLiveActivityEvent) { updates.append(event) }

    func markStale() {}

    func end(status: AgentRunActivityStatus, activity: String, errorSummary: String?) {
        ends.append(End(status: status, activity: activity, errorSummary: errorSummary))
    }
}

/// Shared, interleaved call log so tests can prove ordering ACROSS the audio-session
/// spy and the speech-synthesizer spy in one timeline — not two independent logs.
final class ListenCallRecorder {
    private(set) var events: [String] = []
    func record(_ event: String) { events.append(event) }
}

final class SpySpeechSynthesizer: ChatSpeechSynthesizing {
    var delegate: (any AVSpeechSynthesizerDelegate)?
    var isSpeaking = false
    var isPaused = false
    private(set) var spokenStrings: [String] = []
    private(set) var spokenUtterances: [AVSpeechUtterance] = []
    private(set) var stopBoundaries: [AVSpeechBoundary] = []
    private let recorder: ListenCallRecorder?

    init(recorder: ListenCallRecorder? = nil) {
        self.recorder = recorder
    }

    func speak(_ utterance: AVSpeechUtterance) {
        spokenStrings.append(utterance.speechString)
        spokenUtterances.append(utterance)
        isSpeaking = true
        recorder?.record("speak")
    }

    func stopSpeaking(at boundary: AVSpeechBoundary) -> Bool {
        stopBoundaries.append(boundary)
        isSpeaking = false
        isPaused = false
        return true
    }

    /// Drives the production delegate's `didCancel` exactly as `AVSpeechSynthesizer`
    /// would after `stopSpeaking(at:)` — late, via the delegate's `@MainActor` hop. The
    /// delegate ignores the synthesizer argument, so a throwaway instance is fine.
    func fireDidCancel(_ utterance: AVSpeechUtterance) {
        delegate?.speechSynthesizer?(AVSpeechSynthesizer(), didCancel: utterance)
    }
}

actor RecordingSendDraftAttachmentStore: ChatDraftAttachmentStoring {
    private var bytes: [String: Data] = [:]
    private var nextFileNumber = 1
    private var deletedFileNames: [String] = []

    func save(data: Data, suggestedFilename: String) async throws -> String {
        let fileName = "saved-\(nextFileNumber)-\(URL(fileURLWithPath: suggestedFilename).lastPathComponent)"
        nextFileNumber += 1
        bytes[fileName] = data
        return fileName
    }

    func data(named fileName: String) async throws -> Data {
        bytes[fileName] ?? Data()
    }

    func delete(named fileName: String) async {
        deletedFileNames.append(fileName)
    }

    func sweep(keepingReferenced fileNames: Set<String>, olderThan maxAge: TimeInterval) async {}

    func deletedNames() -> [String] {
        deletedFileNames
    }
}

@MainActor
final class SpyListenAudioPlayer: ListenAudioPlaying {
    var onFinish: (@MainActor () -> Void)?
    var playResult = true
    var currentTime: TimeInterval = 0
    var duration: TimeInterval = 75
    var rate: Float = 1
    private(set) var playCount = 0
    private(set) var pauseCount = 0
    private(set) var stopCount = 0
    private(set) var prepareToPlayCount = 0

    func prepareToPlay() {
        prepareToPlayCount += 1
    }

    func play() -> Bool {
        playCount += 1
        return playResult
    }

    func pause() {
        pauseCount += 1
    }

    func stop() {
        stopCount += 1
    }

    /// Simulates the wrapped `AVAudioPlayer` finishing naturally.
    func finishPlayback() {
        onFinish?()
    }
}

@MainActor
final class SpyListenAudioSession: ListenAudioSessionControlling {
    private(set) var activateCount = 0
    private(set) var deactivateCount = 0
    private let recorder: ListenCallRecorder?

    init(recorder: ListenCallRecorder? = nil) {
        self.recorder = recorder
    }

    func activate() {
        activateCount += 1
        recorder?.record("activate")
    }

    func deactivate() {
        deactivateCount += 1
        recorder?.record("deactivate")
    }
}

@MainActor
final class SpyListenRemoteControlCenter: ListenRemoteControlControlling {
    private(set) var configureCount = 0
    private(set) var clearCount = 0
    private(set) var snapshots: [ListenNowPlayingSnapshot] = []
    private var playHandler: (@MainActor () -> Void)?
    private var pauseHandler: (@MainActor () -> Void)?
    private var togglePlayPauseHandler: (@MainActor () -> Void)?
    private var changePlaybackPositionHandler: (@MainActor (TimeInterval) -> Void)?

    func configure(
        play: @escaping @MainActor () -> Void,
        pause: @escaping @MainActor () -> Void,
        togglePlayPause: @escaping @MainActor () -> Void,
        changePlaybackPosition: @escaping @MainActor (TimeInterval) -> Void
    ) {
        configureCount += 1
        playHandler = play
        pauseHandler = pause
        togglePlayPauseHandler = togglePlayPause
        changePlaybackPositionHandler = changePlaybackPosition
    }

    func update(_ snapshot: ListenNowPlayingSnapshot) {
        snapshots.append(snapshot)
    }

    func clear() {
        clearCount += 1
        snapshots.removeAll()
    }

    func firePlay() {
        playHandler?()
    }

    func firePause() {
        pauseHandler?()
    }

    func fireTogglePlayPause() {
        togglePlayPauseHandler?()
    }

    func fireChangePlaybackPosition(_ position: TimeInterval) {
        changePlaybackPositionHandler?(position)
    }
}

final class SpySSEStreamingClient: SSEStreamingClient {
    private(set) var startedURLs: [URL] = []
    private(set) var stopCount = 0
    private(set) var lastEventID: String?
    private var onEvent: (@MainActor (SSEEvent) -> Void)?
    var automaticallyFlushPendingStreamingContent = true
    var flushPendingStreamingContent: (() -> Void)?
    var eventsOnStart: [SSEEvent] = []

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        startedURLs.append(url)
        lastEventID = nil
        self.onEvent = onEvent
        if !eventsOnStart.isEmpty {
            MainActor.assumeIsolated {
                for event in eventsOnStart {
                    onEvent(event)
                    if automaticallyFlushPendingStreamingContent {
                        flushPendingStreamingContent?()
                    }
                }
            }
        }
    }

    func stop() {
        stopCount += 1
        onEvent = nil
    }

    @MainActor
    func emit(_ event: SSEEvent, lastEventID: String? = nil) {
        self.lastEventID = lastEventID
        onEvent?(event)
        if automaticallyFlushPendingStreamingContent {
            flushPendingStreamingContent?()
        }
    }
}

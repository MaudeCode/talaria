import Foundation
import LDSwiftEventSource

public enum SessionEventFrame: Equatable, Sendable {
    /// The stream connected. `/api/sessions/events` sends no opening frame, only keepalives.
    case opened
    case changed(SessionsChange)
    case ignored
}

enum SessionEventFrameDecoder {
    static func decode(eventType: String, data: String) -> SessionEventFrame {
        guard eventType == "sessions_changed",
              let payload = try? JSONDecoder().decode(Payload.self, from: Data(data.utf8)) else {
            return .ignored
        }
        return .changed(.changed(reason: payload.reason, sessionID: payload.session_id))
    }

    private struct Payload: Decodable {
        let reason: String?
        let session_id: String?
    }
}

@MainActor
public protocol SessionEventStreaming: AnyObject {
    func start(
        url: URL,
        onFrame: @escaping @MainActor (SessionEventFrame) -> Void,
        onFailure: @escaping @MainActor () -> Void
    )
    func stop()
}

/// The app's one `/api/sessions/events` subscription transport (TAL-434).
@MainActor
public final class SessionEventStreamClient: SessionEventStreaming {
    private let baseConfiguration: URLSessionConfiguration
    private let customHeaderProvider: @MainActor () -> [CustomHeader]
    private var eventSource: EventSource?
    private var redirectPolicyHeader: String?

    public init(
        urlSessionConfiguration: URLSessionConfiguration = .default,
        customHeaderProvider: @escaping @MainActor () -> [CustomHeader] = { CustomHeaderStore.shared.snapshot() }
    ) {
        baseConfiguration = urlSessionConfiguration
        self.customHeaderProvider = customHeaderProvider
    }

    public func start(
        url: URL,
        onFrame: @escaping @MainActor (SessionEventFrame) -> Void,
        onFailure: @escaping @MainActor () -> Void
    ) {
        stop()
        let made = ServerEventSource.make(
            url: url,
            handler: Handler(onFrame: onFrame, onFailure: onFailure),
            baseConfiguration: baseConfiguration,
            customHeaders: customHeaderProvider()
        )
        redirectPolicyHeader = made.redirectPolicyHeader
        eventSource = made.source
        made.source.start()
    }

    public func stop() {
        eventSource?.stop()
        eventSource = nil
        CrossOriginRedirectGuardURLProtocol.unregister(redirectPolicyHeader)
        redirectPolicyHeader = nil
    }

    deinit {
        eventSource?.stop()
        CrossOriginRedirectGuardURLProtocol.unregister(redirectPolicyHeader)
    }

    private final class Handler: EventHandler {
        private let onFrame: @MainActor (SessionEventFrame) -> Void
        private let onFailure: @MainActor () -> Void

        init(
            onFrame: @escaping @MainActor (SessionEventFrame) -> Void,
            onFailure: @escaping @MainActor () -> Void
        ) {
            self.onFrame = onFrame
            self.onFailure = onFailure
        }

        func onOpened() {
            Task { @MainActor in onFrame(.opened) }
        }

        // The server ends the response on purpose (e.g. a profile switch), so a close is a reconnect.
        func onClosed() {
            Task { @MainActor in onFailure() }
        }

        func onComment(comment: String) {}

        func onMessage(eventType: String, messageEvent: MessageEvent) {
            let frame = SessionEventFrameDecoder.decode(eventType: eventType, data: messageEvent.data)
            Task { @MainActor in onFrame(frame) }
        }

        func onError(error: Error) {
            // Never include the transport error or event payload in logs.
            Task { @MainActor in onFailure() }
        }
    }
}

/// Keeps the app's session-change subscription open while the scene is active (TAL-434): run it in
/// a `.task` keyed on scene activity, and cancelling the task closes the stream. A dropped stream
/// reconnects after 1, 2 and 4 s, then every 30 s, and each reconnect asks every screen to resync
/// because events may have been missed meanwhile.
public enum SessionEventsMonitor {
    static let retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4)]
    static let steadyRetryDelay = Duration.seconds(30)

    @MainActor
    public static func run(
        url: URL,
        client: SessionEventStreaming,
        onChange: @escaping @MainActor (SessionsChange) -> Void,
        sleep: @escaping (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) async {
        var failures = 0
        var hasConnected = false
        while !Task.isCancelled {
            // `nil` marks the connection's end; iteration also ends when the task is cancelled.
            let (frames, continuation) = AsyncStream<SessionEventFrame?>.makeStream()
            client.start(
                url: url,
                onFrame: { continuation.yield($0) },
                onFailure: { continuation.yield(nil) }
            )
            for await frame in frames {
                guard let frame else { break }
                switch frame {
                case .opened:
                    failures = 0
                    if hasConnected { onChange(.resync) }
                    hasConnected = true
                case .changed(let change):
                    onChange(change)
                case .ignored:
                    break
                }
            }
            continuation.finish()
            client.stop()
            guard !Task.isCancelled else { return }

            let delay = failures < retryDelays.count ? retryDelays[failures] : steadyRetryDelay
            failures += 1
            do {
                try await sleep(delay)
            } catch {
                return
            }
        }
    }
}

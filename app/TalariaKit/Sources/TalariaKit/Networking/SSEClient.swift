import Foundation
import LDSwiftEventSource
import OSLog

/// A conforming client must deliver events only for its current connection:
/// callbacks a superseded or stopped connection already queued are dropped.
/// `ChatStreamCoordinator` installs one bare `handle` closure per start and
/// relies on this instead of fencing per connection itself (TAL-115).
@MainActor
public protocol SSEStreamingClient: AnyObject {
    var lastEventID: String? { get }

    func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void)
    func stop()
}

@MainActor
public final class SSEClient: SSEStreamingClient {
    private let baseConfiguration: URLSessionConfiguration
    private var eventSource: EventSource?
    /// Handler behind the current `EventSource`; exposed so tests can replay a
    /// superseded connection's callbacks without a live server.
    private(set) var eventHandler: EventHandler?
    /// Bumped by every `stop()` (and therefore every `start()`). Callbacks a
    /// connection queued on the main actor before it was superseded compare
    /// their captured value against this and drop themselves.
    private var connectionGeneration = 0
    private var redirectPolicyHeader: String?
    public private(set) var lastEventID: String?
    /// Read at stream start so a new stream picks up the latest headers (#255).
    private let customHeaderProvider: @MainActor () -> [CustomHeader]

    public init(
        urlSessionConfiguration: URLSessionConfiguration = .default,
        customHeaderProvider: @escaping @MainActor () -> [CustomHeader] = { CustomHeaderStore.shared.snapshot() }
    ) {
        baseConfiguration = urlSessionConfiguration
        self.customHeaderProvider = customHeaderProvider
    }

    public func start(url: URL, onEvent: @escaping @MainActor (SSEEvent) -> Void) {
        stop()
        lastEventID = nil
        let generation = connectionGeneration
        let customHeaders = customHeaderProvider()

        let handler = SSEEventHandler(
            onEventID: { [weak self] eventID in
                guard let self, self.connectionGeneration == generation else { return }
                self.lastEventID = eventID
            },
            onEvent: { [weak self] event in
                guard let self, self.connectionGeneration == generation else { return }
                onEvent(event)
            }
        )
        var config = EventSource.Config(handler: handler, url: url)
        // `.shutdown` suppresses EventHandler.onError inside LDSwiftEventSource;
        // forward once so ChatStreamCoordinator can own status-based recovery.
        config.connectionErrorHandler = { error in
            handler.onError(error: error)
            return .shutdown
        }
        // Custom headers merged underneath the built-ins so the built-ins win on
        // collision, including immutable client identity.
        let cookieStorage = ServerCookieStore.shared.storage(for: url)
        var builtInHeaders = [
            AppConfig.clientIdentityHeaderName: AppConfig.clientIdentity,
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache, no-transform",
            "Accept-Encoding": "identity"
        ]
        if let cookie = HTTPCookie.requestHeaderFields(
            with: cookieStorage.cookies(for: url) ?? []
        )["Cookie"] {
            builtInHeaders["Cookie"] = cookie
        }
        config.headers = customHeaders.merged(under: builtInHeaders)

        let configuration = baseConfiguration.copy() as? URLSessionConfiguration ?? .default
        #if DEBUG
        UITestURLSessionHook.configure(configuration)
        #endif
        configuration.httpCookieStorage = cookieStorage
        configuration.httpCookieAcceptPolicy = .always
        configuration.httpShouldSetCookies = true
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let policyHeader = CrossOriginRedirectGuardURLProtocol.register(
            configuration: configuration,
            baseURL: url,
            customHeaders: customHeaders,
            builtInHeaders: builtInHeaders
        )
        redirectPolicyHeader = policyHeader
        configuration.protocolClasses = [CrossOriginRedirectGuardURLProtocol.self]
            + (configuration.protocolClasses ?? []).filter { $0 != CrossOriginRedirectGuardURLProtocol.self }
        config.headers[policyHeader] = "1"
        config.urlSessionConfiguration = configuration

        let source = EventSource(config: config)
        eventHandler = handler
        eventSource = source
        source.start()
    }

    public func stop() {
        connectionGeneration &+= 1
        eventSource?.stop()
        eventSource = nil
        eventHandler = nil
        CrossOriginRedirectGuardURLProtocol.unregister(redirectPolicyHeader)
        redirectPolicyHeader = nil
    }

    deinit {
        eventSource?.stop()
        CrossOriginRedirectGuardURLProtocol.unregister(redirectPolicyHeader)
    }
}

public enum SSEEvent: Equatable {
    case token(String)
    case interimAssistant(InterimAssistantStreamEvent)
    case reasoning(ReasoningStreamEvent)
    case toolStarted(ToolStreamEvent)
    case toolCompleted(ToolStreamEvent)
    case title(TitleStreamEvent)
    case metering(MeteringStreamEvent)
    case done(DoneStreamEvent)
    case approvalPending(ApprovalPendingResponse)
    case clarificationPending(ClarificationPendingResponse)
    case steerConsumed(SteeringStreamEvent)
    /// TAL-426: a pending steer the server added or changed, from any device.
    case steerPending(PendingSteer)
    /// TAL-426: a pending steer taken back (Edit, Cancel, Stop) or sent on as the server's follow-up turn.
    case steerWithdrawn(SteerWithdrawnEvent)
    case streamEnd
    /// The settled session an error or cancel frame carries, delivered just before that terminal event.
    case settledSession(SessionDetail)
    case cancelled
    /// A terminal error frame: its message and the server's turn outcome (`terminal_state`).
    case error(String, terminalState: String? = nil)
    case transportError(String)
    case heartbeat
    case ignored
}

extension SSEEvent {
    static func reasoning(_ text: String) -> SSEEvent {
        .reasoning(ReasoningStreamEvent(text: text))
    }
}

public struct ReasoningStreamEvent: Decodable, Equatable {
    public let text: String
    public let titles: [String]

    enum CodingKeys: String, CodingKey {
        case text
        case titles
    }

    init(text: String, titles: [String] = []) {
        self.text = text
        self.titles = ReasoningTitleMetadata.normalize(titles)
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = container.decodeLossyStringIfPresent(forKey: .text) ?? ""
        titles = ReasoningTitleMetadata.normalize(
            (try? container.decodeIfPresent([String].self, forKey: .titles)) ?? []
        )
    }
}

public struct SteeringStreamEvent: Decodable, Equatable {
    let sessionId: String?
    let streamId: String?
    public let steerId: String?
    public let text: String
    let createdAt: Double?
    let consumedAt: Double?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case streamId = "stream_id"
        case steerId = "steer_id"
        case text
        case createdAt = "created_at"
        case consumedAt = "consumed_at"
    }

    init(
        sessionId: String? = nil,
        streamId: String? = nil,
        steerId: String? = nil,
        text: String,
        createdAt: Double? = nil,
        consumedAt: Double? = nil
    ) {
        self.sessionId = sessionId
        self.streamId = streamId
        self.steerId = steerId
        self.text = text
        self.createdAt = createdAt
        self.consumedAt = consumedAt
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
        streamId = container.decodeLossyStringIfPresent(forKey: .streamId)
        steerId = container.decodeLossyStringIfPresent(forKey: .steerId)
        text = container.decodeLossyStringIfPresent(forKey: .text) ?? ""
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        consumedAt = container.decodeLossyDoubleIfPresent(forKey: .consumedAt)
    }
}

public struct TitleStreamEvent: Decodable, Equatable {
    public let sessionId: String?
    public let title: String?

    enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case title
    }
}

public struct ToolStreamEvent: Decodable, Equatable {
    let eventType: String?
    public let name: String?
    public let preview: String?
    public let args: [String: JSONValue]?
    public let duration: Double?
    public let isError: Bool?
    public let stableID: String?
    public let kind: ToolDisplayKind?
    public let target: String?

    enum CodingKeys: String, CodingKey {
        case eventType = "event_type"
        case name
        case preview
        case args
        case kind
        case target
        case duration
        case isError = "is_error"
        case stableID = "id"
    }

    init(
        eventType: String?,
        name: String?,
        preview: String?,
        args: [String: JSONValue]?,
        duration: Double?,
        isError: Bool?,
        stableID: String? = nil,
        kind: ToolDisplayKind? = nil,
        target: String? = nil
    ) {
        self.eventType = eventType
        self.name = name
        self.preview = preview
        self.args = args
        self.duration = duration
        self.isError = isError
        self.stableID = stableID?.nonEmptyToolStreamID
        self.kind = kind
        self.target = target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        eventType = container.decodeLossyStringIfPresent(forKey: .eventType)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        preview = container.decodeLossyStringIfPresent(forKey: .preview)
        args = try? container.decodeIfPresent([String: JSONValue].self, forKey: .args)
        duration = container.decodeLossyDoubleIfPresent(forKey: .duration)
        isError = container.decodeLossyBoolIfPresent(forKey: .isError)
        kind = ToolDisplayKind(serverValue: container.decodeLossyStringIfPresent(forKey: .kind))
        target = container.decodeLossyStringIfPresent(forKey: .target)
        stableID = container.decodeLossyStringIfPresent(forKey: .stableID)?.nonEmptyToolStreamID
    }
}

public struct InterimAssistantStreamEvent: Decodable, Equatable {
    public let text: String?
    public let alreadyStreamed: Bool?

    enum CodingKeys: String, CodingKey {
        case text
        case alreadyStreamed = "already_streamed"
    }

    init(text: String? = nil, alreadyStreamed: Bool? = nil) {
        self.text = text
        self.alreadyStreamed = alreadyStreamed
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = container.decodeLossyStringIfPresent(forKey: .text)
        alreadyStreamed = container.decodeLossyBoolIfPresent(forKey: .alreadyStreamed)
    }
}

public struct MeteringStreamEvent: Decodable, Equatable {
    let tokensPerSecond: Double?
    let isTokensPerSecondAvailable: Bool?
    let isEstimated: Bool?
    let sessionId: String?

    enum CodingKeys: String, CodingKey {
        case tokensPerSecond = "tps"
        case isTokensPerSecondAvailable = "tps_available"
        case isEstimated = "estimated"
        case sessionId = "session_id"
    }

    init(
        tokensPerSecond: Double? = nil,
        isTokensPerSecondAvailable: Bool? = nil,
        isEstimated: Bool? = nil,
        sessionId: String? = nil
    ) {
        self.tokensPerSecond = tokensPerSecond
        self.isTokensPerSecondAvailable = isTokensPerSecondAvailable
        self.isEstimated = isEstimated
        self.sessionId = sessionId
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tokensPerSecond = container.decodeLossyDoubleIfPresent(forKey: .tokensPerSecond)
        isTokensPerSecondAvailable = container.decodeLossyBoolIfPresent(forKey: .isTokensPerSecondAvailable)
        isEstimated = container.decodeLossyBoolIfPresent(forKey: .isEstimated)
        sessionId = container.decodeLossyStringIfPresent(forKey: .sessionId)
    }

    var displayableTokensPerSecond: Double? {
        guard isTokensPerSecondAvailable == true,
              isEstimated != true,
              let tokensPerSecond,
              tokensPerSecond.isFinite,
              tokensPerSecond > 0
        else {
            return nil
        }
        return tokensPerSecond
    }
}

struct SSEEventDecoder {
    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "Talaria",
        category: "SSEEventDecoder"
    )

    /// One frame's events: error and cancel frames carry the settled session, applied first as `done`'s is.
    static func decodeFrame(eventType: String, data: String) -> [SSEEvent] {
        let event = decode(eventType: eventType, data: data)
        guard ["cancel", "error", "apperror"].contains(eventType),
              let session = (try? JSONDecoder().decode(DonePayload.self, from: Data(data.utf8)))?.event.session
        else { return [event] }
        return [.settledSession(session), event]
    }

    static func decode(eventType: String, data: String) -> SSEEvent {
        let eventData = Data(data.utf8)
        let decoder = JSONDecoder()
        let snakeCaseDecoder = JSONDecoder()
        snakeCaseDecoder.keyDecodingStrategy = .convertFromSnakeCase

        switch eventType {
        case "token":
            let payload = decodePayload(TokenPayload.self, eventType: eventType, from: eventData, decoder: decoder)
            return .token(payload?.text ?? "")
        case "interim_assistant":
            let payload = decodePayload(
                InterimAssistantStreamEvent.self,
                eventType: eventType,
                from: eventData,
                decoder: decoder
            )
            return .interimAssistant(payload ?? InterimAssistantStreamEvent())
        case "reasoning":
            let payload = decodePayload(ReasoningPayload.self, eventType: eventType, from: eventData, decoder: decoder)
            return .reasoning(payload?.event ?? ReasoningStreamEvent(text: ""))
        case "tool":
            let payload = decodePayload(ToolStreamEvent.self, eventType: eventType, from: eventData, decoder: decoder)
            return .toolStarted(payload ?? ToolStreamEvent())
        case "tool_complete":
            let payload = decodePayload(ToolStreamEvent.self, eventType: eventType, from: eventData, decoder: decoder)
            return .toolCompleted(payload ?? ToolStreamEvent())
        case "title":
            let payload = decodePayload(TitleStreamEvent.self, eventType: eventType, from: eventData, decoder: decoder)
            return .title(payload ?? TitleStreamEvent())
        case "metering":
            let payload = decodePayload(
                MeteringStreamEvent.self,
                eventType: eventType,
                from: eventData,
                decoder: decoder
            )
            return .metering(payload ?? MeteringStreamEvent())
        case "done":
            guard let payload = decodePayload(DonePayload.self, eventType: eventType, from: eventData, decoder: decoder) else {
                return .transportError("The stream returned a malformed completion event.")
            }
            return .done(payload.event)
        case "initial":
            logInvalidJSONIfNeeded(eventType: eventType, payloadName: "pending stream payload", data: eventData)
            if ClarificationPendingResponse.containsClarificationMarkers(in: eventData) {
                return .clarificationPending(ClarificationPendingResponse.streamPayload(from: eventData, decoder: decoder))
            }
            return .approvalPending(ApprovalPendingResponse.streamPayload(from: eventData, decoder: decoder))
        case "approval":
            logInvalidJSONIfNeeded(eventType: eventType, payloadName: "approval stream payload", data: eventData)
            return .approvalPending(ApprovalPendingResponse.streamPayload(from: eventData, decoder: decoder))
        case "clarify":
            logInvalidJSONIfNeeded(eventType: eventType, payloadName: "clarification stream payload", data: eventData)
            return .clarificationPending(ClarificationPendingResponse.streamPayload(from: eventData, decoder: decoder))
        case "steer_consumed":
            let payload = decodePayload(
                SteeringStreamEvent.self,
                eventType: eventType,
                from: eventData,
                decoder: decoder
            )
            return .steerConsumed(payload ?? SteeringStreamEvent(text: ""))
        case "steer_pending":
            guard let payload = decodePayload(PendingSteer.self, eventType: eventType, from: eventData, decoder: snakeCaseDecoder) else { return .ignored }
            return .steerPending(payload)
        case "steer_withdrawn":
            guard let payload = decodePayload(SteerWithdrawnEvent.self, eventType: eventType, from: eventData, decoder: snakeCaseDecoder) else { return .ignored }
            return .steerWithdrawn(payload)
        // ponytail: old-server fallback; a Web older than TAL-424 sends no `steer_withdrawn`, so its leftover is a stopped
        // withdraw (this device's text returns to the composer). Delete once every supported Web ships `steer_withdrawn`.
        case "pending_steer_leftover":
            guard let payload = decodePayload(SteeringStreamEvent.self, eventType: eventType, from: eventData, decoder: decoder),
                  let steerID = payload.steerId
            else { return .ignored }
            return .steerWithdrawn(SteerWithdrawnEvent(steerId: steerID, reason: .stopped, text: payload.text))
        case "stream_end":
            return .streamEnd
        case "cancel":
            return .cancelled
        case "error", "apperror":
            // "apperror" is one of the four socket-closing frames (stream_end, cancel,
            // error, apperror). The docs describe its payload as {error, type, session,
            // terminal_state?} while the pinned upstream emits {message, type, hint,
            // details, …}; decoding both `error` and `message` covers either shape.
            // Mapping it onto `.error` reuses the existing terminal error path
            // (surface the message, finish the stream) unchanged.
            guard let payload = decodePayload(ErrorPayload.self, eventType: eventType, from: eventData, decoder: decoder) else {
                return .error(String(localized: "The stream returned a malformed error event."))
            }
            return .error(
                payload.error ?? payload.message ?? String(localized: "The stream returned an error."),
                terminalState: payload.terminalState
            )
        default:
            logger.debug("Ignoring unknown SSE event type '\(eventType, privacy: .public)'.")
            return .ignored
        }
    }

    private static func decodePayload<Payload: Decodable>(
        _ type: Payload.Type,
        eventType: String,
        from data: Data,
        decoder: JSONDecoder
    ) -> Payload? {
        do {
            return try decoder.decode(type, from: data)
        } catch {
            logDecodeFailure(eventType: eventType, payloadName: String(describing: type), error: error, data: data)
            return nil
        }
    }

    private static func logInvalidJSONIfNeeded(eventType: String, payloadName: String, data: Data) {
        do {
            _ = try JSONSerialization.jsonObject(with: data)
        } catch {
            logDecodeFailure(eventType: eventType, payloadName: payloadName, error: error, data: data)
        }
    }

    private static func logDecodeFailure(eventType: String, payloadName: String, error: Error, data: Data) {
        logger.debug(
            """
            Failed to decode SSE event '\(eventType, privacy: .public)' as \(payloadName, privacy: .public) \
            (\(data.count, privacy: .public) bytes): \(String(describing: error), privacy: .public)
            """
        )
    }
}

private extension TitleStreamEvent {
    init() {
        sessionId = nil
        title = nil
    }
}

private extension ToolStreamEvent {
    init() {
        eventType = nil
        name = nil
        preview = nil
        args = nil
        duration = nil
        isError = nil
        stableID = nil
        kind = nil
        target = nil
    }
}

private extension String {
    var nonEmptyToolStreamID: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

private final class SSEEventHandler: EventHandler {
    private let onEventID: @MainActor (String) -> Void
    private let onEvent: @MainActor (SSEEvent) -> Void

    init(
        onEventID: @escaping @MainActor (String) -> Void,
        onEvent: @escaping @MainActor (SSEEvent) -> Void
    ) {
        self.onEventID = onEventID
        self.onEvent = onEvent
    }

    func onOpened() {}

    func onClosed() {}

    func onMessage(eventType: String, messageEvent: MessageEvent) {
        let events = SSEEventDecoder.decodeFrame(eventType: eventType, data: messageEvent.data)

        Task { @MainActor in
            let eventID = messageEvent.lastEventId.trimmingCharacters(in: .whitespacesAndNewlines)
            if !eventID.isEmpty {
                onEventID(eventID)
            }
            events.forEach(onEvent)
        }
    }

    func onComment(comment _: String) {
        Task { @MainActor in
            onEvent(.heartbeat)
        }
    }

    func onError(error: Error) {
        Task { @MainActor in
            onEvent(.transportError(error.localizedDescription))
        }
    }
}

private struct TokenPayload: Decodable {
    let text: String?
}

private struct ReasoningPayload: Decodable {
    let event: ReasoningStreamEvent

    init(from decoder: Decoder) throws {
        event = try ReasoningStreamEvent(from: decoder)
    }
}

private struct ErrorPayload: Decodable {
    let error: String?
    let message: String?
    let terminalState: String?

    enum CodingKeys: String, CodingKey {
        case error
        case message
        case terminalState = "terminal_state"
    }
}

public struct DoneStreamEvent: Equatable {
    public let usage: ContextWindowSnapshot?
    public let session: SessionDetail?
    /// The server's turn outcome (`completed`, `no_response`, `tool_limit_reached`); nil from an older server.
    let terminalState: String?

    init(usage: ContextWindowSnapshot? = nil, session: SessionDetail? = nil, terminalState: String? = nil) {
        self.usage = usage
        self.session = session
        self.terminalState = terminalState
    }
}

private struct DonePayload: Decodable {
    let event: DoneStreamEvent

    enum CodingKeys: String, CodingKey {
        case usage
        case session
        case terminalState = "terminal_state"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        event = DoneStreamEvent(
            usage: try Self.decodeUsage(from: container),
            session: try Self.decodeSession(from: container),
            terminalState: try? container.decodeIfPresent(String.self, forKey: .terminalState)
        )
    }

    private static func decodeUsage(
        from container: KeyedDecodingContainer<CodingKeys>
    ) throws -> ContextWindowSnapshot? {
        guard container.contains(.usage) else {
            return nil
        }

        return try container.decodeIfPresent(ContextWindowSnapshot.self, forKey: .usage)
    }

    private static func decodeSession(from container: KeyedDecodingContainer<CodingKeys>) throws -> SessionDetail? {
        guard container.contains(.session),
              let value = try container.decodeIfPresent(JSONValue.self, forKey: .session)
        else {
            return nil
        }

        let data = try JSONEncoder().encode(value)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionDetail.self, from: data)
    }
}

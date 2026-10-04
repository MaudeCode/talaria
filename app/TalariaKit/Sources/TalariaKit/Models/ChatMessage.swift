import Foundation

public enum ReasoningTitleMetadata {
    public static func normalize(_ values: [String]) -> [String] {
        var result: [String] = []
        var seen = Set<String>()
        for value in values {
            let title = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty, seen.insert(title.lowercased()).inserted else { continue }
            result.append(title)
            if result.count == 8 { break }
        }
        return result
    }
}

public struct ChatMessage: Decodable, Equatable, Identifiable {
    public var id: String {
        messageId ?? "\(role ?? "unknown")-\(timestamp ?? 0)-\(content ?? "")"
    }

    public internal(set) var role: String?
    public internal(set) var content: String?
    public internal(set) var timestamp: Double?
    public internal(set) var messageId: String?
    public internal(set) var name: String?
    public internal(set) var toolCallId: String?
    public internal(set) var toolUseId: String?
    public internal(set) var toolCalls: [JSONValue]?
    public internal(set) var contentParts: [JSONValue]?
    public internal(set) var reasoning: String?
    public internal(set) var reasoningTitles: [String]?
    public internal(set) var activityScene: AssistantActivityScene?
    public internal(set) var attachments: [MessageAttachment]?
    public internal(set) var turnDuration: Double?
    public internal(set) var turnTps: Double?
    /// The server turn this row belongs to; turns are grouped by equality of this id.
    public internal(set) var turnId: String?
    /// A consumed steer the server persisted in its turn: shown inside the turn's scene, never as its own row.
    public internal(set) var steer: [String: JSONValue]?
    /// The server's collapsed excerpt of a body too long to lay out whole (TAL-456); `content` stays whole for actions.
    public internal(set) var displayExcerpt: String?
    /// The server's display text with media references rewritten, and their media (TAL-186); `content` stays for actions.
    public internal(set) var displayBody: TranscriptDisplayBody?
    /// The server marked this row an automatic background wakeup (TAL-371): render its completion lines, not the user's bubble.
    public internal(set) var backgroundUpdate: BackgroundUpdate?
    /// The server marked this row part of a background reply that is only a silence marker (TAL-460): it is not shown.
    public internal(set) var backgroundSilent: Bool
    /// The server marked this row a compaction marker (TAL-305): render its card, never a message bubble.
    public internal(set) var markerKind: ChatMarkerMessageKind?
    /// The server's card body for a marker whose text is not the body as written (a preserved task list).
    public internal(set) var markerBody: String?

    public init(
        role: String?,
        content: String?,
        timestamp: Double?,
        messageId: String?,
        name: String? = nil,
        toolCallId: String? = nil,
        toolUseId: String? = nil,
        toolCalls: [JSONValue]? = nil,
        contentParts: [JSONValue]? = nil,
        reasoning: String? = nil,
        reasoningTitles: [String]? = nil,
        activityScene: AssistantActivityScene? = nil,
        attachments: [MessageAttachment]? = nil,
        turnDuration: Double? = nil,
        turnTps: Double? = nil,
        turnId: String? = nil,
        steer: [String: JSONValue]? = nil,
        displayExcerpt: String? = nil,
        displayBody: TranscriptDisplayBody? = nil,
        backgroundUpdate: BackgroundUpdate? = nil,
        backgroundSilent: Bool = false,
        markerKind: ChatMarkerMessageKind? = nil,
        markerBody: String? = nil
    ) {
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.messageId = messageId
        self.name = name
        self.toolCallId = toolCallId
        self.toolUseId = toolUseId
        self.toolCalls = toolCalls
        self.contentParts = contentParts
        self.reasoning = reasoning
        self.reasoningTitles = reasoningTitles
        self.activityScene = activityScene
        self.attachments = attachments
        self.turnDuration = turnDuration
        self.turnTps = turnTps
        self.turnId = turnId
        self.steer = steer
        self.displayExcerpt = displayExcerpt
        self.displayBody = displayBody
        self.backgroundUpdate = backgroundUpdate
        self.backgroundSilent = backgroundSilent
        self.markerKind = markerKind
        self.markerBody = markerBody
    }

    enum CodingKeys: String, CodingKey {
        case role
        case content
        case timestamp
        case messageId
        case name
        case toolCallId
        case toolUseId
        case toolCalls
        case reasoning
        case reasoningTitles
        case activityScene = "_anchorActivityScene"
        case attachments
        case turnDuration = "_turnDuration"
        case turnTps = "_turnTps"
        case turnId = "_turnId"
        case steer = "_steer"
        case underscoredTimestamp = "_ts"
        case displayTruncated = "_displayTruncated"
        case displayExcerpt = "_displayExcerpt"
        case displayContent = "_displayContent"
        case media = "_media"
        case backgroundUpdate = "_backgroundUpdate"
        case backgroundSilent = "_backgroundSilent"
        case markerKind = "_markerKind"
        case markerBody = "_markerBody"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        role = container.decodeLossyStringIfPresent(forKey: .role)
        let decodedContent = Self.decodeContentTolerantly(from: container)
        content = decodedContent.text
        timestamp = container.decodeLossyDoubleIfPresent(forKey: .underscoredTimestamp)
            ?? container.decodeLossyDoubleIfPresent(forKey: .timestamp)
        messageId = container.decodeLossyStringIfPresent(forKey: .messageId)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        toolCallId = container.decodeLossyStringIfPresent(forKey: .toolCallId)
        toolUseId = container.decodeLossyStringIfPresent(forKey: .toolUseId)
        toolCalls = try? container.decodeIfPresent([JSONValue].self, forKey: .toolCalls)
        contentParts = decodedContent.parts
        reasoning = container.decodeLossyStringIfPresent(forKey: .reasoning)
        reasoningTitles = (try? container.decodeIfPresent([String].self, forKey: .reasoningTitles))
            .map(ReasoningTitleMetadata.normalize)
        activityScene = try? container.decodeIfPresent(AssistantActivityScene.self, forKey: .activityScene)
        let decodedAttachments = Self.decodeAttachmentsTolerantly(from: container)
        attachments = Self.attachments(decodedAttachments, enrichedByMarkerIn: content)
        turnDuration = container.decodeLossyDoubleIfPresent(forKey: .turnDuration)
            ?? activityScene?.turnDuration
        turnTps = container.decodeLossyDoubleIfPresent(forKey: .turnTps)
        turnId = container.decodeLossyStringIfPresent(forKey: .turnId)
        steer = try? container.decodeIfPresent([String: JSONValue].self, forKey: .steer)
        displayExcerpt = (try? container.decodeIfPresent(Bool.self, forKey: .displayTruncated)) == true
            ? container.decodeLossyStringIfPresent(forKey: .displayExcerpt)
            : nil
        displayBody = TranscriptDisplayBody.decoded(
            text: container.decodeLossyStringIfPresent(forKey: .displayContent),
            media: try? container.decodeIfPresent([JSONValue].self, forKey: .media)
        )
        backgroundUpdate = try? container.decodeIfPresent(BackgroundUpdate.self, forKey: .backgroundUpdate)
        backgroundSilent = (try? container.decodeIfPresent(Bool.self, forKey: .backgroundSilent)) == true
        markerKind = ChatMarkerMessageKind(wireValue: container.decodeLossyStringIfPresent(forKey: .markerKind))
        markerBody = markerKind == nil ? nil : container.decodeLossyStringIfPresent(forKey: .markerBody)
    }

    private static func attachments(
        _ decodedAttachments: [MessageAttachment]?,
        enrichedByMarkerIn content: String?
    ) -> [MessageAttachment]? {
        let inferredAttachments = MessageAttachment.inferredFromAttachedFilesMarker(in: content)

        guard let decodedAttachments, !decodedAttachments.isEmpty else {
            return inferredAttachments
        }

        guard let inferredAttachments, !inferredAttachments.isEmpty else {
            return decodedAttachments
        }

        var availableInferred = Array(inferredAttachments.enumerated())
        return decodedAttachments.enumerated().map { index, attachment in
            guard nonEmptyString(attachment.path) == nil,
                  let inferred = matchingInferredAttachment(
                    for: attachment,
                    at: index,
                    from: &availableInferred
                  )
            else {
                return attachment
            }

            return MessageAttachment(
                name: nonEmptyString(attachment.name) ?? inferred.name,
                path: nonEmptyString(inferred.path),
                mime: attachment.mime ?? inferred.mime,
                size: attachment.size ?? inferred.size,
                isImage: attachment.isImage ?? inferred.isImage
            )
        }
    }

    private static func matchingInferredAttachment(
        for attachment: MessageAttachment,
        at index: Int,
        from availableInferred: inout [(offset: Int, element: MessageAttachment)]
    ) -> MessageAttachment? {
        if let key = attachment.identityKey,
           let matchedIndex = availableInferred.firstIndex(where: { $0.element.identityKey == key }) {
            return availableInferred.remove(at: matchedIndex).element
        }

        guard let matchedIndex = availableInferred.firstIndex(where: { $0.offset == index }) else {
            return nil
        }

        return availableInferred.remove(at: matchedIndex).element
    }

    private static func nonEmptyString(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func decodeContentTolerantly(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> (text: String?, parts: [JSONValue]?) {
        if let content = container.decodeLossyStringIfPresent(forKey: .content) {
            return (content, nil)
        }

        guard let value = try? container.decodeIfPresent(JSONValue.self, forKey: .content) else {
            return (nil, nil)
        }

        if case .array(let parts) = value {
            return (textContent(from: parts), parts)
        }

        return (value.compactJSONString, nil)
    }

    private static func textContent(from parts: [JSONValue]) -> String? {
        let text = parts.compactMap { part -> String? in
            if case .string(let value) = part {
                return value
            }

            guard case .object(let object) = part,
                  let type = object["type"]?.stringValue,
                  ["text", "input_text", "output_text"].contains(type)
            else {
                return nil
            }

            return object["text"]?.stringValue
                ?? object["content"]?.stringValue
                ?? object["input_text"]?.stringValue
                ?? object["output_text"]?.stringValue
        }
        .joined()
        .trimmingCharacters(in: .whitespacesAndNewlines)

        return text.isEmpty ? nil : text
    }

    private static func decodeAttachmentsTolerantly(
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> [MessageAttachment]? {
        // Fast path: direct array decode when every attachment is well-shaped.
        if let direct = try? container.decodeIfPresent([MessageAttachment].self, forKey: .attachments) {
            return direct
        }

        // Fallback: decode as raw JSON values so one malformed attachment
        // does not throw away the entire message array.
        guard let jsonValues = try? container.decodeIfPresent([JSONValue].self, forKey: .attachments) else {
            return nil
        }

        let itemDecoder = JSONDecoder()
        itemDecoder.keyDecodingStrategy = .convertFromSnakeCase

        return jsonValues.compactMap { value in
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return try? itemDecoder.decode(MessageAttachment.self, from: data)
        }
    }
}

public enum SteeringHintState: String {
    case sending = "_talaria_steer_sending"
    case waiting = "_talaria_steer_waiting"
    case consumed = "_talaria_steer_consumed"
}

extension ChatMessage {
    public var steeringHintState: SteeringHintState? {
        name.flatMap(SteeringHintState.init(rawValue:))
    }

    /// A steer row the App draws itself (its `_talaria_steer_*` state never comes from the server), whatever the id.
    public var isLocalSteeringHint: Bool {
        steeringHintState != nil && messageId != nil
    }

    public func applyingTurnMetrics(duration: Double? = nil, tokensPerSecond: Double? = nil) -> ChatMessage {
        var message = self
        message.turnDuration = duration ?? turnDuration
        message.turnTps = tokensPerSecond ?? turnTps
        return message
    }
}

/// An automatic background wakeup the server classified (TAL-371), as one completion line per finished item (TAL-460).
public struct BackgroundUpdate: Codable, Equatable {
    public let lines: [BackgroundLine]

    public init(lines: [BackgroundLine]) {
        self.lines = lines
    }

    enum CodingKeys: String, CodingKey {
        case lines, attention, summary
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = (try? container.decodeIfPresent([BackgroundLine].self, forKey: .lines)) ?? []
        // Older servers (TAL-371) sent one summary instead of lines; it becomes the one line.
        let summary = container.decodeLossyStringIfPresent(forKey: .summary) ?? ""
        let attention = (try? container.decodeIfPresent(Bool.self, forKey: .attention)) == true
        lines = decoded.isEmpty
            ? [BackgroundLine(kind: .other, status: attention ? .failed : .completed, label: summary)]
            : decoded
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(lines, forKey: .lines)
    }
}

/// One finished background item: the client words it per `kind` and `status` around the server's `label`.
public struct BackgroundLine: Codable, Equatable {
    public enum Kind: String, Codable, Equatable {
        case agent, command, other
    }

    public enum Status: String, Codable, Equatable {
        case completed, failed, notice
    }

    public let kind: Kind
    public let status: Status
    /// An agent's goal, a command, or any other notice as written.
    public let label: String
    public let exitCode: Int?

    public init(kind: Kind, status: Status, label: String, exitCode: Int? = nil) {
        self.kind = kind
        self.status = status
        self.label = label
        self.exitCode = exitCode
    }

    enum CodingKeys: String, CodingKey {
        case kind, status, label, exitCode
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = container.decodeLossyStringIfPresent(forKey: .kind).flatMap(Kind.init(rawValue:)) ?? .other
        status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(Status.init(rawValue:)) ?? .notice
        label = container.decodeLossyStringIfPresent(forKey: .label) ?? ""
        exitCode = container.decodeLossyIntIfPresent(forKey: .exitCode)
    }
}

public struct AssistantActivityScene: Codable, Equatable {
    public let version: String?
    public let finalAnswer: String?
    /// The server's collapsed excerpt of a final answer too long to lay out whole (TAL-456).
    public let finalAnswerExcerpt: String?
    /// `finalAnswer` as the server rewrote it for display, and its media (TAL-186); see `finalAnswerDisplay`.
    let finalAnswerDisplayText: String?
    let finalAnswerMedia: [JSONValue]?
    public let activityRows: [AssistantActivitySceneRow]?
    let turnDuration: Double?
    /// Server-decided initial state of the turn's "Worked" disclosure.
    public let expandedByDefault: Bool
    /// Seconds from the turn's last consumed steer to its end (steered turns only).
    public let finalPhaseDuration: Double?
    /// Server-decided outcome of the turn (`completed`, `no_response`, `error`, `tool_limit_reached`, ...).
    public let terminalState: String?
    /// How many earlier rows the tail preview omits; page them from `/api/session/anchor-scene`.
    public let activityRowsOffset: Int
    public let activitySceneRef: String?
    /// Server-decided: whether the whole scene, including rows outside this preview, has a consumed steer.
    let serverHasConsumedSteering: Bool?
    /// Server-attributed files the whole turn changed, in first-touch order; `nil` from a Web
    /// that predates the field (TAL-355), which then shows no recap.
    public let fileChanges: [AssistantTurnFileChange]?

    enum CodingKeys: String, CodingKey {
        case version
        case finalAnswer
        case finalAnswerExcerpt
        case finalAnswerDisplayText = "finalAnswerDisplay"
        case finalAnswerMedia
        case activityRows
        case turnDuration
        case expandedByDefault
        case terminalState
        case activityRowsOffset
        case activitySceneRef
        case finalPhaseDuration
        case serverHasConsumedSteering = "hasConsumedSteering"
        case fileChanges
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        version = container.decodeLossyStringIfPresent(forKey: .version)
        finalAnswer = container.decodeLossyStringIfPresent(forKey: .finalAnswer)
        finalAnswerExcerpt = container.decodeLossyStringIfPresent(forKey: .finalAnswerExcerpt)
        finalAnswerDisplayText = container.decodeLossyStringIfPresent(forKey: .finalAnswerDisplayText)
        finalAnswerMedia = try? container.decodeIfPresent([JSONValue].self, forKey: .finalAnswerMedia)
        turnDuration = container.decodeLossyDoubleIfPresent(forKey: .turnDuration)
        expandedByDefault = (try? container.decodeIfPresent(Bool.self, forKey: .expandedByDefault)) ?? false
        terminalState = container.decodeLossyStringIfPresent(forKey: .terminalState)
        activityRowsOffset = max(0, container.decodeLossyIntIfPresent(forKey: .activityRowsOffset) ?? 0)
        activitySceneRef = container.decodeLossyStringIfPresent(forKey: .activitySceneRef)
        finalPhaseDuration = container.decodeLossyDoubleIfPresent(forKey: .finalPhaseDuration)
        serverHasConsumedSteering = try? container.decodeIfPresent(Bool.self, forKey: .serverHasConsumedSteering)
        fileChanges = (try? container.decodeIfPresent([JSONValue].self, forKey: .fileChanges))
            .map(AssistantTurnFileChange.decodeLossily)

        activityRows = (try? container.decodeIfPresent([JSONValue].self, forKey: .activityRows))
            .map(AssistantActivitySceneRow.decodeLossily)
    }
}

/// One page of a scene's earlier rows (`GET /api/session/anchor-scene`), in the same normalized row shape.
public struct AnchorScenePageResponse: Decodable, Equatable {
    public let rows: [AssistantActivitySceneRow]
    public let start: Int

    enum CodingKeys: String, CodingKey {
        case rows
        case start
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rows = AssistantActivitySceneRow.decodeLossily((try? container.decodeIfPresent([JSONValue].self, forKey: .rows)) ?? [])
        start = max(0, container.decodeLossyIntIfPresent(forKey: .start) ?? 0)
    }
}

/// `GET /api/session/tool-result`: one tool call's whole result and its uncapped sections.
public struct ToolResultResponse: Decodable, Equatable {
    public let result: String
    public let resultView: ToolResultView?

    enum CodingKeys: String, CodingKey {
        case result
        case resultView
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        result = container.decodeLossyStringIfPresent(forKey: .result) ?? ""
        // Through `JSONValue`, as scene rows read it: a keyed decode would miss `exit_code` under snake-case conversion.
        resultView = ToolResultView(try? container.decodeIfPresent(JSONValue.self, forKey: .resultView))
    }
}

extension AssistantActivityScene {
    /// `finalAnswer` as the server rewrote it for display, with its media (TAL-186).
    public var finalAnswerDisplay: TranscriptDisplayBody? {
        TranscriptDisplayBody.decoded(text: finalAnswerDisplayText, media: finalAnswerMedia)
    }

    public var hasConsumedSteering: Bool {
        // ponytail: preview scan is the pre-field server fallback; delete once those servers are unsupported.
        serverHasConsumedSteering ?? (activityRows?.contains(where: \.isConsumedSteering) == true)
    }
}

/// One server-normalized scene row. The server decides order, role, tool completion and error, and
/// steering consumption; the app reads those fields as sent.
public struct AssistantActivitySceneRow: Codable, Equatable {
    public let rowID: String?
    public let orderIndex: Int?
    public let role: String?
    public let text: String?
    public let titles: [String]?
    public let createdAt: Double?
    public let tool: [String: JSONValue]?
    public let steering: [String: JSONValue]?
    /// A prose row's text as the server rewrote it for display, and its media (TAL-186); see `display`.
    let displayText: String?
    let media: [JSONValue]?

    enum CodingKeys: String, CodingKey {
        case rowID = "rowId"
        case orderIndex
        case role
        case text
        case titles
        case createdAt
        case tool
        case steering
        case displayText
        case media
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rowID = container.decodeLossyStringIfPresent(forKey: .rowID)
        orderIndex = container.decodeLossyIntIfPresent(forKey: .orderIndex)
        role = container.decodeLossyStringIfPresent(forKey: .role)
        text = container.decodeLossyStringIfPresent(forKey: .text)
        titles = try? container.decodeIfPresent([String].self, forKey: .titles)
        createdAt = container.decodeLossyDoubleIfPresent(forKey: .createdAt)
        tool = try? container.decodeIfPresent([String: JSONValue].self, forKey: .tool)
        steering = try? container.decodeIfPresent([String: JSONValue].self, forKey: .steering)
        displayText = container.decodeLossyStringIfPresent(forKey: .displayText)
        media = try? container.decodeIfPresent([JSONValue].self, forKey: .media)
    }

    /// A prose row's text as the server rewrote it for display, with its media (TAL-186).
    public var display: TranscriptDisplayBody? {
        TranscriptDisplayBody.decoded(text: displayText, media: media)
    }

    /// Rows decode one by one, so a malformed row never drops its neighbours.
    static func decodeLossily(_ values: [JSONValue]) -> [AssistantActivitySceneRow] {
        let rowDecoder = JSONDecoder()
        rowDecoder.keyDecodingStrategy = .convertFromSnakeCase
        return values.compactMap { value in
            guard case .object = value,
                  let data = try? JSONEncoder().encode(value)
            else { return nil }
            return try? rowDecoder.decode(AssistantActivitySceneRow.self, from: data)
        }
    }

    var isConsumedSteering: Bool {
        guard role == "steering", case .bool(true)? = steering?["consumed"] else { return false }
        return true
    }

    public var steerID: String? {
        guard case .string(let steerID)? = steering?["steer_id"], !steerID.isEmpty else { return nil }
        return steerID
    }
}

public enum TranscriptTurnClassifier {
    public static func anchorID(for message: ChatMessage, at index: Int, messageOffset: Int? = nil) -> String {
        if let messageID = nonEmpty(message.messageId) {
            return messageID
        }

        return "raw:\(max(0, messageOffset ?? 0) + index)"
    }

    public static func isUserTurnBoundary(_ message: ChatMessage) -> Bool {
        // A persisted steer belongs inside its turn; it never opens one.
        guard message.role == "user", message.steer == nil else { return false }
        return hasVisibleUserContent(message)
    }

    public static func isToolResultOnlyMessage(_ message: ChatMessage) -> Bool {
        message.role == "user" && !hasVisibleUserContent(message)
    }

    /// Turn keys come from the server's `_turn_id` stamp; a row without one has no shared turn key.
    public static func assistantTurnKeysByAnchorID(_ messages: [ChatMessage], messageOffset: Int? = nil) -> [String: String] {
        var keysByMessageID: [String: String] = [:]
        for (messageIndex, message) in messages.enumerated() where message.role == "assistant" {
            guard let turnID = message.turnId else { continue }
            keysByMessageID[anchorID(for: message, at: messageIndex, messageOffset: messageOffset)] = "turn:\(turnID)"
        }
        return keysByMessageID
    }

    static func assistantTurnKeysByMessageID(_ messages: [ChatMessage]) -> [String: String] {
        assistantTurnKeysByAnchorID(messages)
    }

    static func assistantAnchorID(
        forRawIndex rawIndex: Int,
        in messages: [ChatMessage],
        messageOffset: Int? = nil
    ) -> String? {
        guard messages.indices.contains(rawIndex) else { return nil }

        if messages[rawIndex].role == "assistant" {
            return anchorID(for: messages[rawIndex], at: rawIndex, messageOffset: messageOffset)
        }

        let lowerBound = previousUserBoundaryIndex(before: rawIndex, in: messages).map { $0 + 1 } ?? messages.startIndex
        if rawIndex > lowerBound {
            for index in stride(from: rawIndex - 1, through: lowerBound, by: -1) where messages[index].role == "assistant" {
                return anchorID(for: messages[index], at: index, messageOffset: messageOffset)
            }
        }

        let upperBound = nextUserBoundaryIndex(after: rawIndex, in: messages) ?? messages.endIndex
        if messages.index(after: rawIndex) < upperBound {
            for index in messages.index(after: rawIndex)..<upperBound where messages[index].role == "assistant" {
                return anchorID(for: messages[index], at: index, messageOffset: messageOffset)
            }
        }

        return nil
    }

    public static func currentTurnAssistantAnchorIDs(in messages: [ChatMessage], messageOffset: Int? = nil) -> [String] {
        let latestUserIndex = messages.lastIndex { isUserTurnBoundary($0) }
        let startIndex = latestUserIndex.map { messages.index(after: $0) } ?? messages.startIndex
        guard startIndex < messages.endIndex else { return [] }

        return messages[startIndex...].enumerated().compactMap { offset, message in
            guard message.role == "assistant" else { return nil }
            return anchorID(for: message, at: startIndex + offset, messageOffset: messageOffset)
        }
    }

    static func currentTurnAssistantMessageIDs(in messages: [ChatMessage]) -> [String] {
        currentTurnAssistantAnchorIDs(in: messages)
    }

    private static func previousUserBoundaryIndex(before rawIndex: Int, in messages: [ChatMessage]) -> Int? {
        guard rawIndex > messages.startIndex else { return nil }

        for index in stride(from: rawIndex - 1, through: messages.startIndex, by: -1) where isUserTurnBoundary(messages[index]) {
            return index
        }

        return nil
    }

    private static func nextUserBoundaryIndex(after rawIndex: Int, in messages: [ChatMessage]) -> Int? {
        let nextIndex = messages.index(after: rawIndex)
        guard nextIndex < messages.endIndex else { return nil }

        return messages[nextIndex...].firstIndex { isUserTurnBoundary($0) }
    }

    private static func hasVisibleUserContent(_ message: ChatMessage) -> Bool {
        guard message.role == "user" else { return false }

        if message.content?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            return true
        }

        return message.attachments?.isEmpty == false
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

extension KeyedDecodingContainer {
    /// Skips elements that fail to decode instead of failing the whole array.
    func decodeLossyArrayIfPresent<Element: Decodable>(_ type: Element.Type, forKey key: Key) -> [Element]? {
        guard var rows = try? nestedUnkeyedContainer(forKey: key) else { return nil }
        var decoded: [Element] = []
        while !rows.isAtEnd {
            if let row = try? rows.decode(Element.self) {
                decoded.append(row)
            } else if (try? rows.decode(JSONValue.self)) == nil {
                break
            }
        }
        return decoded
    }

    func decodeLossyStringIfPresent(forKey key: Key) -> String? {
        if let value = try? decodeIfPresent(String.self, forKey: key) {
            return value
        }

        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            return "\(value)"
        }

        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return "\(value)"
        }

        if let value = try? decodeIfPresent(Bool.self, forKey: key) {
            return value ? "true" : "false"
        }

        return nil
    }

    func decodeLossyDoubleIfPresent(forKey key: Key) -> Double? {
        if let value = try? decodeIfPresent(Double.self, forKey: key) {
            return value
        }

        guard let stringValue = try? decodeIfPresent(String.self, forKey: key) else {
            return nil
        }

        return Double(stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    func decodeLossyIntIfPresent(forKey key: Key) -> Int? {
        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            return value
        }

        if let value = try? decodeIfPresent(Double.self, forKey: key),
           value.isFinite {
            // Int(exactly:) instead of Int(_:), which traps on doubles outside
            // Int range, so a huge server value decodes to nil instead of
            // crashing (#62). Truncation toward zero matches Int(_:) for
            // values that fit.
            return Int(exactly: value.rounded(.towardZero))
        }

        guard let stringValue = try? decodeIfPresent(String.self, forKey: key) else {
            return nil
        }

        let trimmed = stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if let value = Int(trimmed) {
            return value
        }

        guard let value = Double(trimmed),
              value.isFinite
        else {
            return nil
        }

        // Same out-of-range guard as the numeric branch above (#62).
        return Int(exactly: value.rounded(.towardZero))
    }

    func decodeLossyBoolIfPresent(forKey key: Key) -> Bool? {
        if let value = try? decodeIfPresent(Bool.self, forKey: key) {
            return value
        }

        if let value = try? decodeIfPresent(Int.self, forKey: key) {
            switch value {
            case 0:
                return false
            case 1:
                return true
            default:
                return nil
            }
        }

        guard let stringValue = try? decodeIfPresent(String.self, forKey: key) else {
            return nil
        }

        switch stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "true", "1", "yes":
            return true
        case "false", "0", "no":
            return false
        default:
            return nil
        }
    }
}

private extension JSONValue {
    var stringValue: String? {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value.formatted()
        case .bool(let value):
            return value ? "true" : "false"
        case .object, .array, .null:
            return nil
        }
    }

    var compactJSONString: String? {
        guard let data = try? JSONEncoder().encode(self) else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }
}

public import Foundation

public struct AssistantActivityRow: Identifiable, Equatable {
    public struct Reasoning: Equatable {
        public var text: String
        public var titles: [String]

        init(text: String, titles: [String] = []) {
            self.text = text
            self.titles = titles
        }
    }

    public struct Steering: Equatable {
        public let id: String
        public let text: String
        public let submittedAt: Double?
        let consumedAt: Double?
        /// Server-measured length of the work phase this steer ended.
        var phaseDuration: Double? = nil
    }

    public enum Content: Equatable {
        case prose(String)
        case reasoning(Reasoning)
        case tools([ToolCall])
        case steering(Steering)
    }

    public let id: String
    public var content: Content
    var createdAt: Double? = nil
    var isFinalAnswer = false
    /// A prose row's text as the server rewrote it for display, with its media (TAL-186).
    public var display: TranscriptDisplayBody? = nil

    var kind: String {
        switch content {
        case .prose: "prose"
        case .reasoning: "reasoning"
        case .tools: "tools"
        case .steering: "steering"
        }
    }

    var text: String? {
        switch content {
        case .prose(let text): text
        case .reasoning(let reasoning): reasoning.text
        case .tools: nil
        case .steering(let steering): steering.text
        }
    }

    public var toolCalls: [ToolCall] {
        guard case .tools(let toolCalls) = content else { return [] }
        return toolCalls
    }
}

/// Localized wording for the server's turn outcome; an ordinary completed turn shows none.
public enum AssistantTurnOutcome {
    public static func label(for terminalState: String?) -> String? {
        switch terminalState {
        case nil, "", "completed", "running": nil
        case "cancelled": String(localized: "Stopped")
        case "no_response": String(localized: "No answer produced.")
        case "interrupted", "connection_lost": String(localized: "Response interrupted")
        case "tool_limit_reached": String(localized: "Tool limit reached")
        case "compression_exhausted": String(localized: "Context limit reached")
        default: String(localized: "Response failed")
        }
    }
}

/// What one assistant turn's block lays out: its rows in order, whether the server's settled scene folds its work
/// under "Worked", and whether its last row is still being produced.
public struct AssistantTurnLayout: Equatable {
    public let rows: [AssistantActivityRow]
    public let foldsWork: Bool
    public let isLive: Bool

    public init(
        message: ChatMessage,
        liveRows: [AssistantActivityRow],
        archivedRows: [AssistantActivityRow],
        earlierSceneRows: [AssistantActivitySceneRow] = []
    ) {
        if !liveRows.isEmpty {
            // Live rows win while the turn streams.
            rows = liveRows
            foldsWork = false
            isLive = true
        } else if let scene = AssistantActivityTimeline.authoritativeScene(message: message, earlierRows: earlierSceneRows) {
            // A completed turn renders the server's scene.
            rows = scene.rows
            foldsWork = true
            isLive = false
        } else {
            // Before the scene arrives, the just-finished live rows hold its place. Without either (an older server),
            // the message renders as plain text.
            rows = archivedRows
            foldsWork = false
            isLive = false
        }
    }
}

public struct CompletedAssistantTurn: Equatable {
    public struct Phase: Identifiable, Equatable {
        public let id: String
        public let workRows: [AssistantActivityRow]
        public let steeringAfter: AssistantActivityRow.Steering?
    }

    public struct Segment: Identifiable, Equatable {
        public enum Content: Equatable {
            case activity([AssistantActivityRow])
            case prose(String)
            case steering(AssistantActivityRow.Steering)
        }

        public let id: String
        public let content: Content
        /// A prose segment's display text and media from the server (TAL-186).
        public var display: TranscriptDisplayBody? = nil
    }

    public let segments: [Segment]
    let workRows: [AssistantActivityRow]
    public let finalAnswer: String
    /// `finalAnswer` as the server rewrote it for display, with its media (TAL-186).
    public let finalAnswerDisplay: TranscriptDisplayBody?
    public let phases: [Phase]
    private let finalSegmentIndex: Int?

    public var hasSteering: Bool { phases.contains { $0.steeringAfter != nil } }

    public var workSegments: [Segment] {
        guard let finalSegmentIndex else { return segments }
        return segments.enumerated().compactMap { index, segment in
            index == finalSegmentIndex ? nil : segment
        }
    }

    public func phaseDurations(totalDuration: Double?, finalPhaseDuration: Double? = nil) -> [Double?] {
        guard !phases.isEmpty else { return [] }
        // Persisted steers carry server-measured phases; only local steers not yet persisted fall back to timestamps.
        if phases.dropLast().allSatisfy({ $0.steeringAfter?.phaseDuration != nil }) {
            return phases.dropLast().map { $0.steeringAfter?.phaseDuration } + [finalPhaseDuration ?? totalDuration]
        }
        var durations = Array<Double?>(repeating: nil, count: phases.count)
        var phaseStart = phases.first?.workRows.compactMap(\.createdAt).min()
            ?? phases.first?.steeringAfter?.submittedAt
        var measuredTotal = 0.0

        for index in phases.indices.dropLast() {
            guard let boundary = phases[index].steeringAfter?.consumedAt else { continue }
            if let phaseStart {
                let duration = max(0, boundary - phaseStart)
                durations[index] = duration
                measuredTotal += duration
            }
            phaseStart = boundary
        }

        if let totalDuration {
            durations[phases.index(before: phases.endIndex)] = max(0, totalDuration - measuredTotal)
        }
        return durations
    }

    public init?(rows: [AssistantActivityRow]) {
        var segments: [Segment] = []
        var pendingActivity: [AssistantActivityRow] = []
        var resolvedFinalSegmentIndex: Int?

        func appendActivity() {
            guard !pendingActivity.isEmpty else { return }
            segments.append(Segment(
                id: "activity:\(segments.count):\(pendingActivity.first?.id ?? "row")",
                content: .activity(pendingActivity)
            ))
            pendingActivity = []
        }

        // The final answer is the row the server marked; the app never infers it from row position.
        let finalIndex = rows.lastIndex(where: \.isFinalAnswer)

        for (rowIndex, row) in rows.enumerated() {
            switch row.content {
            case .prose(let text):
                appendActivity()
                guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
                segments.append(Segment(id: "prose:\(segments.count):\(row.id)", content: .prose(text), display: row.display))
                if rowIndex == finalIndex {
                    resolvedFinalSegmentIndex = segments.index(before: segments.endIndex)
                }
            case .reasoning, .tools:
                pendingActivity.append(row)
            case .steering(let steering):
                appendActivity()
                segments.append(Segment(
                    id: "steering:\(segments.count):\(steering.id)",
                    content: .steering(steering)
                ))
            }
        }
        appendActivity()

        // "Worked" exists whenever there is work besides the final answer, including earlier prose alone.
        let foldsEarlierProse = finalIndex != nil && rows.indices.contains { index in
            guard index != finalIndex, case .prose = rows[index].content else { return false }
            return true
        }
        guard foldsEarlierProse || segments.contains(where: {
            switch $0.content {
            case .activity, .steering: true
            case .prose: false
            }
        }) else { return nil }

        self.segments = segments
        finalSegmentIndex = resolvedFinalSegmentIndex
        if let finalIndex,
           case .prose(let finalAnswer) = rows[finalIndex].content {
            self.finalAnswer = finalAnswer
            finalAnswerDisplay = rows[finalIndex].display
            workRows = rows.enumerated().compactMap { $0.offset == finalIndex ? nil : $0.element }
        } else {
            finalAnswer = ""
            finalAnswerDisplay = nil
            workRows = rows
        }

        var phases: [Phase] = []
        var phaseRows: [AssistantActivityRow] = []
        for row in workRows {
            if case .steering(let steering) = row.content {
                phases.append(Phase(
                    id: "phase:\(phases.count):\(phaseRows.first?.id ?? steering.id)",
                    workRows: phaseRows,
                    steeringAfter: steering
                ))
                phaseRows = []
            } else {
                phaseRows.append(row)
            }
        }
        phases.append(Phase(
            id: "phase:\(phases.count):\(phaseRows.first?.id ?? "tail")",
            workRows: phaseRows,
            steeringAfter: nil
        ))
        self.phases = phases
    }
}

public struct AssistantActivityTimeline: Equatable {
    public private(set) var rows: [AssistantActivityRow] = []

    var persistedContentParts: [JSONValue] {
        rows.flatMap { row -> [JSONValue] in
            switch row.content {
            case .prose(let text):
                return [.object(["type": .string("text"), "text": .string(text)])]
            case .reasoning(let reasoning):
                var part: [String: JSONValue] = [
                    "type": .string("reasoning"),
                    "text": .string(reasoning.text)
                ]
                if !reasoning.titles.isEmpty {
                    part["titles"] = .array(reasoning.titles.map(JSONValue.string))
                }
                return [.object(part)]
            case .tools(let toolCalls):
                return toolCalls.map { toolCall in
                    var part: [String: JSONValue] = [
                        "type": .string("assistant_activity_tool"),
                        "id": .string(toolCall.id),
                        "name": .string(toolCall.name ?? "tool"),
                        "input": .object(toolCall.args ?? [:])
                    ]
                    if let preview = toolCall.preview { part["preview"] = .string(preview) }
                    if let duration = toolCall.duration { part["duration"] = .number(duration) }
                    if let isError = toolCall.isError { part["is_error"] = .bool(isError) }
                    part["done"] = .bool(toolCall.isCompleted)
                    return .object(part)
                }
            case .steering:
                return []
            }
        }
    }

    var reasoningText: String {
        rows.compactMap { row in
            guard case .reasoning(let reasoning) = row.content else { return nil }
            return reasoning.text
        }.joined()
    }

    var latestReasoningTitles: [String] {
        for row in rows.reversed() {
            guard case .reasoning(let reasoning) = row.content else { continue }
            if !reasoning.titles.isEmpty { return reasoning.titles }
        }
        return []
    }

    @discardableResult
    mutating func updateLatestReasoningTitles(_ titles: [String]) -> Bool {
        let normalizedTitles = ReasoningTitleMetadata.normalize(titles)
        guard !normalizedTitles.isEmpty else { return false }
        for index in rows.indices.reversed() {
            guard case .reasoning(var reasoning) = rows[index].content else { continue }
            guard reasoning.titles != normalizedTitles else { return false }
            reasoning.titles = normalizedTitles
            rows[index].content = .reasoning(reasoning)
            return true
        }
        return false
    }

    var toolCalls: [ToolCall] {
        rows.flatMap(\.toolCalls)
    }

    mutating func removeAll() {
        rows.removeAll(keepingCapacity: true)
    }

    mutating func appendProse(_ text: String, id: String? = nil) {
        appendText(text, kind: "prose", id: id) { .prose($0) }
    }

    mutating func appendReasoning(_ text: String, titles: [String] = [], id: String? = nil) {
        let normalizedTitles = ReasoningTitleMetadata.normalize(titles)
        if let lastIndex = rows.indices.last,
           case .reasoning(var reasoning) = rows[lastIndex].content {
            reasoning.text.append(contentsOf: text)
            if !normalizedTitles.isEmpty {
                reasoning.titles = normalizedTitles
            }
            rows[lastIndex].content = .reasoning(reasoning)
            return
        }
        guard !text.isEmpty else { return }
        rows.append(AssistantActivityRow(
            id: id ?? "reasoning:\(rows.count)",
            content: .reasoning(AssistantActivityRow.Reasoning(text: text, titles: normalizedTitles))
        ))
    }

    mutating func appendTool(_ toolCall: ToolCall, id: String? = nil) {
        if case .tools(var toolCalls)? = rows.last?.content {
            if let matchingIndex = toolCalls.lastIndex(where: { $0.id == toolCall.id }) {
                toolCalls[matchingIndex] = toolCall
            } else {
                toolCalls.append(toolCall)
            }
            rows[rows.index(before: rows.endIndex)].content = .tools(toolCalls)
            return
        }

        rows.append(AssistantActivityRow(
            id: id ?? "tools:\(rows.count)",
            content: .tools([toolCall])
        ))
    }

    func tool(at index: Int) -> ToolCall? {
        guard index >= 0 else { return nil }
        var currentIndex = 0
        for row in rows {
            guard case .tools(let toolCalls) = row.content else { continue }
            if index < currentIndex + toolCalls.count {
                return toolCalls[index - currentIndex]
            }
            currentIndex += toolCalls.count
        }
        return nil
    }

    mutating func updateTool(at index: Int, _ update: (ToolCall) -> ToolCall) -> Bool {
        guard index >= 0 else { return false }
        var currentIndex = 0
        for rowIndex in rows.indices {
            guard case .tools(var toolCalls) = rows[rowIndex].content else { continue }
            if index < currentIndex + toolCalls.count {
                let toolIndex = index - currentIndex
                toolCalls[toolIndex] = update(toolCalls[toolIndex])
                rows[rowIndex].content = .tools(toolCalls)
                return true
            }
            currentIndex += toolCalls.count
        }
        return false
    }

    static func persisted(
        message: ChatMessage,
        reasoningGroups: [ReasoningGroup],
        toolCallGroups: [ToolCallGroup]
    ) -> AssistantActivityTimeline {
        if let timeline = authoritativeScene(message: message) {
            return timeline
        }

        if let contentParts = message.contentParts, !contentParts.isEmpty {
            var timeline = AssistantActivityTimeline()
            for (index, part) in contentParts.enumerated() {
                timeline.appendContentPart(part, sourceIndex: index)
            }
            if !timeline.rows.isEmpty {
                timeline.enrichTools(from: toolCallGroups)
                return timeline
            }
        }

        var timeline = AssistantActivityTimeline()
        for (index, group) in reasoningGroups.enumerated() {
            let titles = !group.titles.isEmpty
                ? group.titles
                : (index == reasoningGroups.count - 1 ? message.reasoningTitles ?? [] : [])
            timeline.appendReasoning(group.text, titles: titles, id: group.id)
        }
        for group in toolCallGroups {
            for toolCall in group.toolCalls {
                timeline.appendTool(toolCall, id: group.id)
            }
        }
        timeline.appendFinalProseIfNeeded(message.content)
        return timeline
    }

    static func persisted(
        assistantSegments: [TranscriptAssistantSegment],
        reasoningGroups: [ReasoningGroup],
        toolCallGroups: [ToolCallGroup]
    ) -> AssistantActivityTimeline {
        guard let finalSegment = assistantSegments.last else { return AssistantActivityTimeline() }
        if let timeline = authoritativeScene(message: finalSegment.message) {
            return timeline
        }

        var timeline = AssistantActivityTimeline()

        for segment in assistantSegments {
            let segmentTimeline = persisted(
                message: segment.message,
                reasoningGroups: reasoningGroups.filter { $0.anchorMessageID == segment.anchorID },
                toolCallGroups: toolCallGroups.filter { $0.anchorMessageID == segment.anchorID }
            )
            timeline.rows.append(contentsOf: segmentTimeline.rows.map { row in
                AssistantActivityRow(
                    id: "\(segment.anchorID):\(row.id)",
                    content: row.content,
                    createdAt: row.createdAt,
                    isFinalAnswer: row.isFinalAnswer,
                    display: row.display
                )
            })
        }

        return timeline
    }

    public static func authoritativeScene(message: ChatMessage, earlierRows: [AssistantActivitySceneRow] = []) -> AssistantActivityTimeline? {
        guard let scene = message.activityScene,
              scene.version == "activity_scene_v1"
        else { return nil }

        var timeline = AssistantActivityTimeline()
        // Paged earlier rows come first, then the tail preview; both are already in server order.
        for (sourceIndex, row) in (earlierRows + (scene.activityRows ?? [])).enumerated().sorted(by: { lhs, rhs in
            (lhs.element.orderIndex ?? lhs.offset) < (rhs.element.orderIndex ?? rhs.offset)
        }) {
            timeline.appendSceneRow(row, sourceIndex: sourceIndex)
        }
        if let finalAnswer = scene.finalAnswer {
            // The server's rows exclude the answer, which it sends as `final_answer` (possibly empty).
            if let finalAnswer = Self.nonEmpty(finalAnswer) {
                timeline.rows.append(AssistantActivityRow(id: "scene:final", content: .prose(finalAnswer), isFinalAnswer: true, display: scene.finalAnswerDisplay))
            }
        } else {
            // Only a pre-TAL-328 server omits the field; its message text is the answer.
            // ponytail: old-server fallback; delete once those servers are unsupported.
            timeline.appendFinalProseIfNeeded(message.content)
        }
        guard !timeline.rows.isEmpty else { return nil }
        return timeline
    }

    private mutating func enrichTools(from toolCallGroups: [ToolCallGroup]) {
        let resolvedTools = toolCallGroups.flatMap(\.toolCalls)
        guard !resolvedTools.isEmpty else { return }

        for rowIndex in rows.indices {
            guard case .tools(var toolCalls) = rows[rowIndex].content else { continue }
            for toolIndex in toolCalls.indices {
                let toolCall = toolCalls[toolIndex]
                guard let resolved = resolvedTools.last(where: { $0.id == toolCall.id }) else { continue }
                toolCalls[toolIndex] = ToolCall(
                    id: toolCall.id,
                    name: toolCall.name ?? resolved.name,
                    preview: resolved.preview ?? toolCall.preview,
                    args: toolCall.args ?? resolved.args,
                    kind: toolCall.kind ?? resolved.kind,
                    target: toolCall.target ?? resolved.target,
                    resultView: resolved.resultView ?? toolCall.resultView,
                    duration: resolved.duration ?? toolCall.duration,
                    isError: resolved.isError ?? toolCall.isError,
                    isCompleted: toolCall.isCompleted || resolved.isCompleted,
                    startedAt: min(toolCall.startedAt, resolved.startedAt)
                )
            }
            rows[rowIndex].content = .tools(toolCalls)
        }
    }

    private mutating func appendText(
        _ text: String,
        kind: String,
        id: String?,
        content: (String) -> AssistantActivityRow.Content
    ) {
        guard !text.isEmpty else { return }
        if let lastIndex = rows.indices.last,
           rows[lastIndex].kind == kind,
           let existing = rows[lastIndex].text {
            rows[lastIndex].content = content(existing + text)
            return
        }
        rows.append(AssistantActivityRow(
            id: id ?? "\(kind):\(rows.count)",
            content: content(text)
        ))
    }

    private mutating func appendSceneRow(_ row: AssistantActivitySceneRow, sourceIndex: Int) {
        let rowID = row.rowID ?? "scene:\(sourceIndex)"
        switch row.role {
        case "prose":
            let previous = rows.last
            if appendProseIfPresent(row.text, id: rowID) {
                let index = rows.index(before: rows.endIndex)
                rows[index].createdAt = row.createdAt
                if rows[index].id == rowID {
                    rows[index].display = row.display
                } else if let previous, previous.display != nil || row.display != nil {
                    // Consecutive prose rows merge into one; their display text merges the same way.
                    rows[index].display = TranscriptDisplayBody(
                        text: (previous.display?.text ?? previous.text ?? "") + (row.display?.text ?? row.text ?? ""),
                        media: (previous.display?.media ?? []) + (row.display?.media ?? [])
                    )
                }
            }
        case "reasoning":
            if appendReasoningIfPresent(row.text, titles: row.titles ?? [], id: rowID) {
                rows[rows.index(before: rows.endIndex)].createdAt = row.createdAt
            }
        case "tool":
            if let toolCall = Self.sceneToolCall(row.tool, fallbackID: rowID) {
                appendTool(toolCall, id: rowID)
                if rows[rows.index(before: rows.endIndex)].createdAt == nil {
                    rows[rows.index(before: rows.endIndex)].createdAt = row.createdAt
                }
            }
        case "steering":
            guard let text = Self.nonEmpty(row.text) else { break }
            rows.append(AssistantActivityRow(
                id: rowID,
                content: .steering(.init(
                    id: row.steerID ?? rowID,
                    text: text,
                    submittedAt: Self.number(row.steering?["submitted_at"]),
                    consumedAt: Self.number(row.steering?["consumed_at"]),
                    phaseDuration: Self.number(row.steering?["phase_duration"])
                )),
                createdAt: row.createdAt
            ))
        default:
            break
        }
    }

    private mutating func appendContentPart(_ part: JSONValue, sourceIndex: Int) {
        if case .string(let text) = part {
            appendProseIfPresent(text, id: "content:\(sourceIndex)")
            return
        }
        guard case .object(let object) = part,
              let type = Self.string(object["type"])
        else { return }

        switch type {
        case "text", "input_text", "output_text":
            appendProseIfPresent(
                Self.string(object["text"])
                    ?? Self.string(object["content"])
                    ?? Self.string(object["input_text"])
                    ?? Self.string(object["output_text"]),
                id: "content:\(sourceIndex)"
            )
        case "thinking", "reasoning":
            appendReasoningIfPresent(
                Self.string(object["thinking"])
                    ?? Self.string(object["reasoning"])
                    ?? Self.string(object["text"])
                    ?? Self.string(object["content"]),
                titles: Self.strings(object["titles"]),
                id: "content:\(sourceIndex)"
            )
        case "tool_use", "assistant_activity_tool":
            if let toolCall = Self.toolCall(
                object: object,
                fallbackID: "content-tool:\(sourceIndex)",
                status: Self.string(object["status"])
            ) {
                appendTool(toolCall, id: "content:\(sourceIndex)")
            }
        default:
            break
        }
    }

    private mutating func appendFinalProseIfNeeded(_ text: String?) {
        guard let text = Self.nonEmpty(text) else { return }
        let normalizedText = Self.normalized(text)
        let alreadyPresentIndex = rows.lastIndex { row in
            guard case .prose(let prose) = row.content else { return false }
            return Self.normalized(prose) == normalizedText
        }
        if let alreadyPresentIndex {
            rows[alreadyPresentIndex].isFinalAnswer = true
        } else {
            rows.append(AssistantActivityRow(
                id: "scene:final",
                content: .prose(text),
                isFinalAnswer: true
            ))
        }
    }

    @discardableResult
    private mutating func appendProseIfPresent(_ text: String?, id: String) -> Bool {
        guard let text = Self.nonEmpty(text) else { return false }
        appendProse(text, id: id)
        return true
    }

    @discardableResult
    private mutating func appendReasoningIfPresent(
        _ text: String?,
        titles: [String] = [],
        id: String
    ) -> Bool {
        guard let text = Self.nonEmpty(text) else { return false }
        appendReasoning(text, titles: titles, id: id)
        return true
    }

    /// A server-normalized scene tool: every field is explicit, so nothing is inferred here.
    private static func sceneToolCall(_ object: [String: JSONValue]?, fallbackID: String) -> ToolCall? {
        guard let object else { return nil }
        var call = ToolCall(
            id: Self.nonEmpty(Self.string(object["id"])) ?? fallbackID,
            name: Self.nonEmpty(Self.string(object["name"])) ?? "tool",
            preview: Self.nonEmpty(Self.string(object["preview"])) ?? Self.nonEmpty(Self.string(object["result"])),
            args: Self.object(object["args"]),
            kind: ToolDisplayKind(serverValue: Self.string(object["kind"])),
            target: Self.string(object["target"]),
            resultView: ToolResultView(object["result_view"]),
            duration: Self.number(object["duration"]),
            isError: Self.bool(object["is_error"]),
            isCompleted: Self.bool(object["done"]) == true
        )
        call.background = Self.backgroundLink(object["background"])
        call.resultTruncated = Self.bool(object["result_truncated"]) == true
        return call
    }

    private static func backgroundLink(_ value: JSONValue?) -> BackgroundLink? {
        guard let value, case .object = value, let data = try? JSONEncoder().encode(value) else { return nil }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try? decoder.decode(BackgroundLink.self, from: data)
    }

    private static func toolCall(
        object: [String: JSONValue]?,
        fallbackID: String,
        status: String?
    ) -> ToolCall? {
        guard let object else { return nil }
        let function = Self.object(object["function"])
        let id = Self.nonEmpty(Self.string(object["id"]))
            ?? Self.nonEmpty(Self.string(object["tid"]))
            ?? Self.nonEmpty(Self.string(object["tool_call_id"]))
            ?? Self.nonEmpty(Self.string(object["tool_use_id"]))
            ?? fallbackID
        let name = Self.nonEmpty(Self.string(object["name"]))
            ?? Self.nonEmpty(Self.string(object["tool_name"]))
            ?? Self.nonEmpty(Self.string(function?["name"]))
            ?? "tool"
        let preview = Self.nonEmpty(Self.string(object["snippet"]))
            ?? Self.nonEmpty(Self.string(object["preview"]))
            ?? Self.nonEmpty(Self.string(object["result"]))
            ?? Self.nonEmpty(Self.string(object["output"]))
        let args = Self.object(object["args"])
            ?? Self.object(object["input"])
            ?? Self.arguments(Self.string(function?["arguments"]))
        let isError = Self.bool(object["is_error"]) ?? Self.bool(object["error"])
        return ToolCall(
            id: id,
            name: name,
            preview: preview,
            args: args,
            kind: ToolDisplayKind(serverValue: Self.string(object["kind"])),
            target: Self.string(object["target"]),
            resultView: ToolResultView(object["result_view"]),
            duration: Self.number(object["duration"]),
            isError: isError,
            isCompleted: status == "completed" || Self.bool(object["done"]) == true
        )
    }

    private static func string(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        switch value {
        case .string(let value): return value
        case .number(let value): return value.formatted()
        case .bool(let value): return value ? "true" : "false"
        case .object, .array:
            guard let data = try? JSONEncoder().encode(value) else { return nil }
            return String(data: data, encoding: .utf8)
        case .null: return nil
        }
    }

    private static func object(_ value: JSONValue?) -> [String: JSONValue]? {
        guard case .object(let object) = value else { return nil }
        return object
    }

    private static func strings(_ value: JSONValue?) -> [String] {
        guard case .array(let values) = value else { return [] }
        return ReasoningTitleMetadata.normalize(values.compactMap { value in
            guard case .string(let string) = value else { return nil }
            return string
        })
    }

    private static func bool(_ value: JSONValue?) -> Bool? {
        switch value {
        case .bool(let value): value
        case .number(let value): value != 0
        case .string(let value): ["true", "1", "yes"].contains(value.lowercased())
        default: nil
        }
    }

    private static func number(_ value: JSONValue?) -> Double? {
        switch value {
        case .number(let value): value
        case .string(let value): Double(value)
        default: nil
        }
    }

    private static func arguments(_ value: String?) -> [String: JSONValue]? {
        guard let value,
              let data = value.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let object) = decoded
        else { return nil }
        return object
    }

    private static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return text
    }

    private static func normalized(_ text: String) -> String {
        text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    }
}

public struct ReasoningGroup: Identifiable, Equatable {
    public let id: String
    public let anchorMessageID: String?
    public let text: String
    public let titles: [String]

    init(id: String = UUID().uuidString, anchorMessageID: String?, text: String, titles: [String] = []) {
        self.id = id
        self.anchorMessageID = anchorMessageID
        self.text = text
        self.titles = titles
    }
}

public struct TranscriptMessage: Identifiable, Equatable {
    public let loadedIndex: Int
    public let renderID: String
    public let anchorID: String
    public let message: ChatMessage
    public let assistantSegments: [TranscriptAssistantSegment]

    public var id: String { renderID }

    public func ownsActiveStream(
        hasLiveActivity: Bool,
        streamingAssistantMessageID: String?
    ) -> Bool {
        hasLiveActivity || assistantSegments.contains {
            $0.message.messageId == streamingAssistantMessageID
        }
    }
}

public struct TranscriptAssistantSegment: Equatable {
    public let anchorID: String
    let message: ChatMessage
}

/// Display model for the synthesized "Context compaction · Reference only" card.
public struct CompressionReferenceCard: Equatable {
    public let referenceText: String
    /// `renderID` of the transcript row the card renders directly after;
    /// nil places the card above the loaded transcript.
    public let afterRenderID: String?
}

public struct MessageActionContext: Equatable, Identifiable {
    public var id: String { messageID }

    public enum Role: Equatable {
        case user
        case assistant
    }

    public let role: Role
    let visibleIndex: Int
    let fullHistoryIndex: Int
    let keepCountThroughMessage: Int
    public let messageID: String
    public let copyText: String
    let listenText: String?

    public init?(message: ChatMessage, visibleIndex: Int, messagesOffset: Int?) {
        guard visibleIndex >= 0 else { return nil }

        switch message.role {
        case "user":
            role = .user
        case "assistant":
            role = .assistant
        default:
            return nil
        }

        let content = message.content ?? ""
        guard !content.isEmpty else { return nil }

        self.visibleIndex = visibleIndex
        fullHistoryIndex = max(0, messagesOffset ?? 0) + visibleIndex
        keepCountThroughMessage = fullHistoryIndex + 1
        messageID = message.id
        copyText = content
        listenText = role == .assistant ? SpeechTextNormalizer.normalizedAssistantText(content) : nil
    }
}

extension ChatViewModel {
    nonisolated static func reasoningDisplayGroups(
        messages: [ChatMessage],
        messageOffset: Int? = nil,
        archivedGroups: [ReasoningGroup]
    ) -> [ReasoningGroup] {
        let turnKeysByMessageID = TranscriptTurnClassifier.assistantTurnKeysByAnchorID(
            messages,
            messageOffset: messageOffset
        )
        let assistantMessagesByID = messages.enumerated().reduce(into: [String: ChatMessage]()) { result, entry in
            let message = entry.element
            guard message.role == "assistant" else { return }
            result[TranscriptTurnClassifier.anchorID(for: message, at: entry.offset, messageOffset: messageOffset)] = message
        }
        var candidates: [ReasoningDisplayCandidate] = []
        var order = 0

        for group in archivedGroups {
            let visibleText = group.anchorMessageID.flatMap { assistantMessagesByID[$0]?.content }
            appendReasoningCandidate(
                text: group.text,
                anchorMessageID: group.anchorMessageID,
                turnKey: group.anchorMessageID.flatMap { turnKeysByMessageID[$0] } ?? "archived:\(group.anchorMessageID ?? group.id)",
                visibleText: visibleText,
                order: &order,
                candidates: &candidates
            )
        }

        for (messageIndex, message) in messages.enumerated() where message.role == "assistant" {
            let anchorID = TranscriptTurnClassifier.anchorID(
                for: message,
                at: messageIndex,
                messageOffset: messageOffset
            )
            let turnKey = turnKeysByMessageID[anchorID] ?? "message:\(anchorID)"
            for text in reasoningTexts(from: message) {
                appendReasoningCandidate(
                    text: text,
                    anchorMessageID: anchorID,
                    turnKey: turnKey,
                    visibleText: message.content,
                    order: &order,
                    candidates: &candidates
                )
            }
        }

        var latestCandidateIndexByKey: [String: Int] = [:]
        for (index, candidate) in candidates.enumerated() {
            latestCandidateIndexByKey["\(candidate.turnKey)::\(normalizedReasoningKey(candidate.text))"] = index
        }

        return candidates.enumerated().compactMap { index, candidate in
            let key = "\(candidate.turnKey)::\(normalizedReasoningKey(candidate.text))"
            guard latestCandidateIndexByKey[key] == index else { return nil }

            return ReasoningGroup(
                id: "reasoning-\(candidate.anchorMessageID ?? "unanchored")-\(candidate.order)",
                anchorMessageID: candidate.anchorMessageID,
                text: candidate.text
            )
        }
    }

    nonisolated static func transcriptMessages(from messages: [ChatMessage], messageOffset: Int? = nil) -> [TranscriptMessage] {
        transcriptMessages(from: messages, messageOffset: messageOffset, hidingStreamingAssistantID: nil)
    }

    nonisolated static func transcriptMessages(
        from messages: [ChatMessage],
        messageOffset: Int? = nil,
        hidingStreamingAssistantID streamingAssistantID: String?
    ) -> [TranscriptMessage] {
        let offset = max(0, messageOffset ?? 0)
        var transcriptMessages: [TranscriptMessage] = []
        transcriptMessages.reserveCapacity(messages.count)
        var assistantSegments: [(loadedIndex: Int, segment: TranscriptAssistantSegment)] = []

        func appendAssistantTurn() {
            guard let first = assistantSegments.first,
                  let last = assistantSegments.last
            else { return }

            transcriptMessages.append(TranscriptMessage(
                loadedIndex: last.loadedIndex,
                renderID: "transcript:\(offset + first.loadedIndex)",
                anchorID: last.segment.anchorID,
                message: last.segment.message,
                assistantSegments: assistantSegments.map(\.segment)
            ))
            assistantSegments.removeAll(keepingCapacity: true)
        }

        for (loadedIndex, message) in messages.enumerated() {
            guard message.role != "tool" else { continue }
            guard !TranscriptTurnClassifier.isToolResultOnlyMessage(message) else { continue }
            // Persisted steers render inside their turn's scene, not as rows of their own.
            guard message.steer == nil else { continue }
            // A background reply that is only a silence marker shows nothing; its completion lines stay (TAL-460).
            guard !message.backgroundSilent else { continue }
            if let streamingAssistantID, message.messageId == streamingAssistantID {
                continue
            }

            let anchorID = TranscriptTurnClassifier.anchorID(
                for: message,
                at: loadedIndex,
                messageOffset: messageOffset
            )

            // A compaction marker is a card of its own, never part of an assistant turn (TAL-305).
            if message.role == "assistant", message.markerKind == nil {
                // The server stamps each row with its turn; a new turn id starts a new assistant turn.
                if let previous = assistantSegments.last, previous.segment.message.turnId != message.turnId {
                    appendAssistantTurn()
                }
                assistantSegments.append((
                    loadedIndex,
                    TranscriptAssistantSegment(anchorID: anchorID, message: message)
                ))
                continue
            }

            appendAssistantTurn()
            let absoluteIndex = offset + loadedIndex
            let renderID = "transcript:\(absoluteIndex)"

            transcriptMessages.append(TranscriptMessage(
                loadedIndex: loadedIndex,
                renderID: renderID,
                anchorID: anchorID,
                message: message,
                assistantSegments: []
            ))
        }

        appendAssistantTurn()

        return transcriptMessages
    }

    public nonisolated static func compressionReferenceCard(
        messages: [ChatMessage],
        messagesOffset: Int,
        transcriptMessages: [TranscriptMessage],
        metadata: CompressionAnchorMetadata?
    ) -> CompressionReferenceCard? {
        guard let resolution = CompressionAnchorResolver.resolve(
            messages: messages,
            messagesOffset: messagesOffset,
            metadata: metadata
        ) else {
            return nil
        }

        switch resolution.placement {
        case .top:
            return CompressionReferenceCard(referenceText: resolution.referenceText, afterRenderID: nil)
        case .afterLoadedMessageIndex(let loadedIndex):
            // The anchor message itself may be filtered out of the transcript
            // (e.g. tool-result-only); attach to the closest preceding row.
            let afterRenderID = transcriptMessages.last { $0.loadedIndex <= loadedIndex }?.renderID
            return CompressionReferenceCard(referenceText: resolution.referenceText, afterRenderID: afterRenderID)
        }
    }

    nonisolated private static func appendReasoningCandidate(
        text: String,
        anchorMessageID: String?,
        turnKey: String,
        visibleText: String?,
        order: inout Int,
        candidates: inout [ReasoningDisplayCandidate]
    ) {
        guard let text = strippedVisibleAssistantEcho(fromReasoning: text, visibleText: visibleText) else {
            return
        }

        candidates.append(
            ReasoningDisplayCandidate(
                order: order,
                anchorMessageID: anchorMessageID,
                turnKey: turnKey,
                text: text
            )
        )
        order += 1
    }

    /// The server ships one `reasoning` string per row (TAL-302); its content carries no thinking to extract.
    nonisolated private static func reasoningTexts(from message: ChatMessage) -> [String] {
        nonEmptyReasoningText(message.reasoning).map { [$0] } ?? []
    }

    nonisolated private static func strippedVisibleAssistantEcho(
        fromReasoning reasoning: String,
        visibleText: String?
    ) -> String? {
        var output = reasoning
        let visibleParagraphs = visibleText?
            .components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { $0.count >= 20 } ?? []

        for paragraph in visibleParagraphs {
            output = output.replacingOccurrences(of: paragraph, with: "")
        }

        return nonEmptyReasoningText(output)
    }

    nonisolated private static func normalizedReasoningKey(_ text: String) -> String {
        text
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    nonisolated private static func nonEmptyReasoningText(_ text: String?) -> String? {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

private struct ReasoningDisplayCandidate {
    let order: Int
    let anchorMessageID: String?
    let turnKey: String
    let text: String
}

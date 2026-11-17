import Foundation

public struct ToolCall: Identifiable, Equatable, Sendable {
    public let id: String
    public var name: String?
    public var preview: String?
    public var args: [String: JSONValue]?
    /// TAL-2318: the server's argument rows; nil from an older server, which formats `args` locally.
    public var argsFields: [ToolField]?
    /// Server-derived display fields; nil from an older server (shown as an unknown tool with no target).
    public var kind: ToolDisplayKind?
    /// TAL-2327: the verb a `kanban` call shows in place of its kind's own (server field).
    public var verb: ToolVerb?
    /// TAL-2330: an `mcp` or `connector` call's app, which names it and gives a connector its logo (server field).
    public var app: ToolApp?
    public var target: String?
    public var progress: ToolProgress?
    public var duration: Double?
    public var isError: Bool?
    public var isCompleted: Bool
    public let startedAt: Double
    /// TAL-372: the background work a delegation call started (server scene field); nil on any other call.
    public var background: BackgroundLink?
    /// TAL-315: the server's result sections; nil from an older server, which shows `preview` as sent.
    public var resultView: ToolResultView?
    /// TAL-448: a completed file edit's change (server field); nil on any other call, or from an older server.
    public var editDiff: ToolEditDiff?
    /// TAL-331: a limited response clipped this call's result (server scene field); `GET /api/session/tool-result` has it whole.
    public var resultTruncated = false
    /// TAL-2331: the transcript leaves this call out (server `hidden`): a tool lookup while Settings hides them.
    public var isHidden: Bool
    /// TAL-2332: on the first call of a server-merged run, how many calls the merged row stands for.
    public var mergedCount: Int?
    /// TAL-2332: the id of the call whose merged row this call folds into.
    public var mergedInto: String?

    public init(
        id: String = "live-tool-\(UUID().uuidString)",
        name: String?,
        preview: String?,
        args: [String: JSONValue]?,
        argsFields: [ToolField]? = nil,
        kind: ToolDisplayKind? = nil,
        verb: ToolVerb? = nil,
        app: ToolApp? = nil,
        target: String? = nil,
        progress: ToolProgress? = nil,
        resultView: ToolResultView? = nil,
        editDiff: ToolEditDiff? = nil,
        duration: Double? = nil,
        isError: Bool? = nil,
        isCompleted: Bool = false,
        startedAt: Double = Date().timeIntervalSince1970,
        isHidden: Bool = false
    ) {
        self.isHidden = isHidden
        self.verb = verb
        self.app = app
        self.id = id
        self.name = name
        self.preview = preview
        self.args = args
        self.argsFields = argsFields
        self.kind = kind
        self.target = target
        self.progress = progress
        self.resultView = resultView
        self.editDiff = editDiff
        self.duration = duration
        self.isError = isError
        self.isCompleted = isCompleted
        self.startedAt = startedAt
    }

    var displayName: String {
        let trimmedName = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmedName, !trimmedName.isEmpty else {
            return String(localized: "Tool")
        }
        return trimmedName
    }
}

/// TAL-2330: the app an `mcp` or `connector` call runs in: its title as the Agent names it and a connector's catalog logo.
public struct ToolApp: Decodable, Equatable, Sendable {
    public let name: String
    public let logoURL: URL?

    enum CodingKeys: String, CodingKey { case name, logoURL = "logo_url" }

    public init(name: String, logoURL: URL? = nil) {
        self.name = name
        self.logoURL = logoURL
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        logoURL = container.decodeLossyStringIfPresent(forKey: .logoURL).flatMap(URL.init(string:))
    }

    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let app = try? JSONDecoder().decode(Self.self, from: data)
        else { return nil }
        self = app
    }
}

/// TAL-2332: a run of reasoning and tool rows the server folds under one header: its calls by kind in the server's order,
/// its failed calls, and whether any still runs. The app words the header from these alone.
public struct AssistantActivityGroup: Codable, Equatable, Sendable {
    public struct Part: Codable, Equatable, Sendable {
        public let kind: ToolDisplayKind
        public let count: Int
        public let failed: Int

        enum CodingKeys: String, CodingKey { case kind, count, failed }

        public init(kind: ToolDisplayKind, count: Int, failed: Int = 0) {
            self.kind = kind
            self.count = count
            self.failed = failed
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = ToolDisplayKind(serverValue: container.decodeLossyStringIfPresent(forKey: .kind)) ?? .unknown
            count = max(0, container.decodeLossyIntIfPresent(forKey: .count) ?? 0)
            failed = max(0, container.decodeLossyIntIfPresent(forKey: .failed) ?? 0)
        }

        public func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(kind.rawValue, forKey: .kind)
            try container.encode(count, forKey: .count)
            try container.encode(failed, forKey: .failed)
        }
    }

    public let groupID: String
    public let parts: [Part]
    public let failed: Int
    public let running: Bool

    enum CodingKeys: String, CodingKey {
        case groupID = "group_id"
        case parts, failed, running
    }

    public init(groupID: String, parts: [Part], failed: Int = 0, running: Bool = false) {
        self.groupID = groupID
        self.parts = parts
        self.failed = failed
        self.running = running
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        groupID = try container.decode(String.self, forKey: .groupID)
        parts = (try? container.decodeIfPresent([Part].self, forKey: .parts)) ?? []
        failed = max(0, container.decodeLossyIntIfPresent(forKey: .failed) ?? 0)
        running = container.decodeLossyBoolIfPresent(forKey: .running) == true
    }

    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let group = try? JSONDecoder().decode(Self.self, from: data)
        else { return nil }
        self = group
    }

    /// The groups of a scene or page by id; a malformed record is left out.
    static func byID(_ values: [JSONValue]?) -> [String: AssistantActivityGroup] {
        Dictionary((values ?? []).compactMap(Self.init).map { ($0.groupID, $0) }, uniquingKeysWith: { $1 })
    }
}

/// Server-owned MCP progress. Unlike result sections, this value exists only while a tool runs.
public struct ToolProgress: Decodable, Equatable, Sendable {
    public let percent: Double?
    public let message: String?

    enum CodingKeys: String, CodingKey { case percent, message }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        percent = container.decodeLossyDoubleIfPresent(forKey: .percent)
        message = container.decodeLossyStringIfPresent(forKey: .message)
    }

    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let progress = try? JSONDecoder().decode(Self.self, from: data)
        else { return nil }
        self = progress
    }
}

/// TAL-2318: one top-level key of a call's arguments or JSON-object result, rendered on the server; `multiline` is whether
/// `value` holds a line break.
public struct ToolField: Decodable, Equatable, Sendable {
    public let key: String
    public let value: String
    public let multiline: Bool

    public init(key: String, value: String, multiline: Bool) {
        self.key = key
        self.value = value
        self.multiline = multiline
    }

    /// The rows a decoded JSON field holds; nil when the server sent none.
    static func rows(_ value: JSONValue?) -> [ToolField]? {
        guard case .array = value, let data = try? JSONEncoder().encode(value) else { return nil }
        return try? JSONDecoder().decode([ToolField].self, from: data)
    }
}

/// TAL-2323: one line a `read_file` result returned: its number in the file and its text.
public struct FileExcerptLine: Decodable, Equatable, Sendable {
    public let n: Int
    public let text: String
}

/// TAL-2323: a `read_file` result: the file the call named, the lines it returned with their real numbers, the file's
/// `totalLines`, and whether the read stopped early. `focusPath` locates the file inside the session workspace;
/// `language` is the highlight grammar the server named.
public struct FileExcerpt: Decodable, Equatable, Sendable {
    public let path: String
    public let focusPath: String?
    public let language: String?
    public let startLine: Int
    public let lines: [FileExcerptLine]
    public let totalLines: Int?
    public let truncated: Bool
    public let nextOffset: Int?
}

/// TAL-2323: one matching line of a `search_files` result.
public struct SearchMatch: Decodable, Equatable, Sendable {
    public let line: Int
    public let text: String
}

/// TAL-2323: one file of a `search_files` result: its matching lines, or its match `count` for a count search.
public struct SearchMatchFile: Decodable, Equatable, Sendable {
    public let path: String
    public let focusPath: String?
    public let count: Int?
    public let matches: [SearchMatch]
}

/// TAL-2323: a `search_files` result grouped by file, in the Agent's order.
public struct SearchMatches: Decodable, Equatable, Sendable {
    public let total: Int
    public let truncated: Bool
    public let files: [SearchMatchFile]
}

/// TAL-2324: one link a `web_search` result listed or an `x_search` answer cited: its title, the host it opens and the
/// search's one-line description.
public struct ResultLink: Decodable, Equatable, Sendable {
    public let title: String
    public let url: String
    public let domain: String
    public let snippet: String?
}

/// TAL-2324: a search's links in the Agent's order, under an `x_search` result's Markdown `answer`.
public struct ResultLinks: Decodable, Equatable, Sendable {
    public let answer: String?
    public let items: [ResultLink]
}

/// TAL-2324: one page a `web_extract` result read: its title, host and the start of its Markdown, or the error it failed with.
public struct ResultPage: Decodable, Equatable, Sendable {
    public let url: String
    public let domain: String
    public let title: String
    public let excerpt: String
    public let error: String?
}

/// TAL-2326: where a result row opens: a Talaria chat (`session`), the scheduled jobs page (`crons`), connected apps
/// (`connectors`), a skill or (TAL-2327) a Kanban task (`kanban_task`) on its board. An unknown kind opens nothing.
public struct ToolRowLink: Decodable, Equatable, Sendable {
    public let kind: String
    public let id: String?
    /// TAL-2327: a `kanban_task`'s board; nil for the current board.
    public let board: String?

    /// The app link the row opens: the chat, the Tasks page with the scheduled jobs, Settings › Tools (where connected
    /// apps live) or the Skills page; nil for a kind this app does not know or a chat with no id.
    public var destinationURL: URL? {
        switch kind {
        case "session": id.flatMap { TalariaDeepLink.sessionURL(sessionID: $0) }
        case "crons": TalariaDeepLink.sectionURL(.tasks)
        case "connectors": TalariaDeepLink.sectionURL(.tools)
        case "skill": TalariaDeepLink.sectionURL(.skills)
        case "kanban_task": id.flatMap { TalariaDeepLink.kanbanCardURL(cardID: $0, board: board) }
        default: nil
        }
    }
}

/// TAL-2326: one row of a result: its label, a muted detail line, a status dot and where it opens.
public struct ToolRow: Decodable, Equatable, Sendable {
    public let label: String
    public let detail: String?
    /// `ok`, `warn`, `error` or `pending` (waiting for approval); any other value draws no dot.
    public let status: String?
    public let link: ToolRowLink?
}

/// TAL-2326: a memory, skill, past-chat, scheduled job, connection or clarify result as titled rows, and a viewed skill's
/// Markdown under them.
public struct ToolRows: Decodable, Equatable, Sendable {
    public let title: String?
    public let rows: [ToolRow]
    public let markdown: String?
}

/// TAL-2335: what a finished call did, which its collapsed row shows after its label. The server decides the outcome, its
/// tone and its value (`ToolOutcomeSchema`); the App only words `key` with `count` or `value`.
public struct ToolOutcome: Decodable, Equatable, Sendable {
    public enum Key: String, Decodable, Sendable {
        case sent, approved, denied, created, paused, resumed, removed, blocked, completed, commented, connected, answered, skipped, exit, failed
        case goalSet = "goal_set", memoryAdded = "memory_added", memoryUpdated = "memory_updated", memoryRemoved = "memory_removed"
        case skillCreated = "skill_created", skillUpdated = "skill_updated", pendingApproval = "pending_approval", jobCreated = "job_created"
        case ranNow = "ran_now", movedTo = "moved_to", needsSignIn = "needs_sign_in", noMatches = "no_matches", noResults = "no_results"
    }

    /// `error` for a failure, `attention` while it waits on the user, else `neutral`.
    public enum Tone: String, Decodable, Sendable { case neutral, error, attention }

    public let key: Key
    public let tone: Tone
    public let count: Int?
    public let value: String?

    public init(key: Key, tone: Tone, count: Int? = nil, value: String? = nil) {
        self.key = key
        self.tone = tone
        self.count = count
        self.value = value
    }
}

extension ToolOutcome {
    /// TAL-2335: the outcome in the reader's words, as a collapsed row and a Live Activity (TAL-2336) show it.
    public var text: String {
        let count = self.count ?? 0
        let value = self.value ?? ""
        switch key {
        case .sent: return String(localized: "Sent")
        case .approved: return String(localized: "Approved")
        case .denied: return String(localized: "Denied")
        case .goalSet: return String(localized: "Goal set")
        case .created: return String(localized: "Created")
        case .memoryAdded: return String(localized: "Added \(count) memories")
        case .memoryUpdated: return String(localized: "Updated \(count) memories")
        case .memoryRemoved: return String(localized: "Removed \(count) memories")
        case .skillCreated: return String(localized: "Skill created")
        case .skillUpdated: return String(localized: "Skill updated")
        case .pendingApproval: return String(localized: "Waiting for approval")
        case .jobCreated:
            guard let next = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value) else { return String(localized: "Scheduled") }
            return String(localized: "Next run \(next.formatted(date: .abbreviated, time: .shortened))")
        case .paused: return String(localized: "Paused")
        case .resumed: return String(localized: "Resumed")
        case .removed: return String(localized: "Removed")
        case .ranNow: return String(localized: "Ran now")
        case .movedTo: return String(localized: "Moved to \(value)")
        case .blocked: return String(localized: "Blocked")
        case .completed: return String(localized: "Completed")
        case .commented: return String(localized: "Commented")
        case .connected: return String(localized: "Connected \(value)")
        case .needsSignIn: return String(localized: "Needs sign-in")
        case .answered: return String(localized: "Answered: \(value)")
        case .skipped: return String(localized: "Skipped")
        case .noMatches: return String(localized: "No matches")
        case .noResults: return String(localized: "No results")
        case .exit: return String(localized: "Exit \(count)")
        case .failed: return value.isEmpty ? String(localized: "Failed") : value
        }
    }
}

/// TAL-315: a tool result's display sections, decided on the server for every client. Shown in this order: `text`, or
/// `stdout`, `stderr`, a labelled `error` and a labelled `exitCode` (sent only when worth showing).
public struct ToolResultView: Decodable, Equatable, Sendable {
    public let text: String?
    public let stdout: String?
    public let stderr: String?
    public let error: String?
    public let exitCode: Int?
    /// TAL-1965: the review a `decision_review_put` made or revised, as it stood then.
    public let decisionReview: DecisionReviewRef?
    /// TAL-1967: the proposal a `propose` result made.
    public let proposal: ProposalRef?
    /// TAL-1968: the block a `show` result stored.
    public let block: ShowBlockRef?
    /// TAL-1997: the terminal a `terminal_open` result started.
    public let terminal: TerminalRef?
    /// TAL-2318: a JSON-object result's rows, shown in place of `text`.
    public let fields: [ToolField]?
    /// TAL-2323: a `read_file` result's lines, shown in place of `text`.
    public let fileExcerpt: FileExcerpt?
    /// TAL-2323: a `search_files` result's matches by file, shown in place of `text`.
    public let matches: SearchMatches?
    /// TAL-2324: a `web_search` or `x_search` result's links (and answer), shown in place of `text`.
    public let links: ResultLinks?
    /// TAL-2324: a `web_extract` result's pages, shown in place of `text`.
    public let pages: [ResultPage]?
    /// TAL-2325: the images, speech or video a media tool made, shown under its row without opening it.
    public let media: [TranscriptMediaReference]?
    /// TAL-2325: what an image or video analysis said, as Markdown, shown in place of `text`.
    public let analysis: String?
    /// TAL-2326: a memory, skill, past-chat, scheduled job, connection or clarify result's rows, shown in place of `text`.
    public let rows: ToolRows?
    /// TAL-2335: the outcome the collapsed row shows after its label; nil when it has none.
    public let outcome: ToolOutcome?

    public init(
        text: String? = nil, stdout: String? = nil, stderr: String? = nil, error: String? = nil, exitCode: Int? = nil,
        decisionReview: DecisionReviewRef? = nil, proposal: ProposalRef? = nil, block: ShowBlockRef? = nil,
        terminal: TerminalRef? = nil, fields: [ToolField]? = nil, fileExcerpt: FileExcerpt? = nil, matches: SearchMatches? = nil,
        links: ResultLinks? = nil, pages: [ResultPage]? = nil, media: [TranscriptMediaReference]? = nil, analysis: String? = nil,
        rows: ToolRows? = nil, outcome: ToolOutcome? = nil
    ) {
        self.outcome = outcome
        self.rows = rows
        self.media = media
        self.analysis = analysis
        self.links = links
        self.pages = pages
        self.fields = fields
        self.fileExcerpt = fileExcerpt
        self.matches = matches
        self.text = text
        self.stdout = stdout
        self.stderr = stderr
        self.error = error
        self.exitCode = exitCode
        self.decisionReview = decisionReview
        self.proposal = proposal
        self.block = block
        self.terminal = terminal
    }

    enum CodingKeys: String, CodingKey {
        case text, stdout, stderr, error
        case exitCode = "exit_code"
        case decisionReview = "decision_review"
        case proposal
        case block
        case terminal
        case fields
        case fileExcerpt = "file_excerpt"
        case matches
        case links
        case pages
        case media
        case analysis
        case rows
        case outcome
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        fields = try? container.decodeIfPresent([ToolField].self, forKey: .fields)
        text = container.decodeLossyStringIfPresent(forKey: .text)
        stdout = container.decodeLossyStringIfPresent(forKey: .stdout)
        stderr = container.decodeLossyStringIfPresent(forKey: .stderr)
        error = container.decodeLossyStringIfPresent(forKey: .error)
        exitCode = container.decodeLossyIntIfPresent(forKey: .exitCode)
        decisionReview = DecisionReview.decode(DecisionReviewRef.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .decisionReview))
        proposal = DecisionReview.decode(ProposalRef.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .proposal))
        block = DecisionReview.decode(ShowBlockRef.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .block))
        terminal = DecisionReview.decode(TerminalRef.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .terminal))
        fileExcerpt = DecisionReview.decode(FileExcerpt.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .fileExcerpt))
        matches = DecisionReview.decode(SearchMatches.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .matches))
        links = DecisionReview.decode(ResultLinks.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .links))
        pages = try? container.decodeIfPresent([ResultPage].self, forKey: .pages)
        // An item an App cannot read is dropped, never its neighbours.
        media = (try? container.decodeIfPresent([JSONValue].self, forKey: .media))?.map { TranscriptMediaReference.decodeLossily($0) }
        analysis = container.decodeLossyStringIfPresent(forKey: .analysis)
        rows = DecisionReview.decode(ToolRows.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .rows))
        // An outcome a newer server adds drops alone, never the sections around it.
        outcome = DecisionReview.decode(ToolOutcome.self, from: try? container.decodeIfPresent(JSONValue.self, forKey: .outcome))
    }

    /// The view a decoded JSON field holds; nil when the server sent none.
    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let view = try? JSONDecoder().decode(ToolResultView.self, from: data)
        else { return nil }
        self = view
    }
}

/// TAL-448: a file edit's change, decided on the server: `added` / `removed` count the whole diff, `diff` is the
/// redacted unified diff, cut to 400 lines when `truncated`, and `hunks` is that diff parsed (TAL-604).
public struct ToolEditDiff: Decodable, Equatable, Sendable {
    public let added: Int
    public let removed: Int
    public let diff: String
    public let truncated: Bool
    public let hunks: [DiffHunk]

    init(added: Int, removed: Int, diff: String, truncated: Bool, hunks: [DiffHunk] = []) {
        self.added = added
        self.removed = removed
        self.diff = diff
        self.truncated = truncated
        self.hunks = hunks
    }

    enum CodingKeys: String, CodingKey {
        case added, removed, diff, truncated, hunks
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let added = container.decodeLossyIntIfPresent(forKey: .added),
              let removed = container.decodeLossyIntIfPresent(forKey: .removed)
        else {
            throw DecodingError.dataCorruptedError(forKey: .added, in: container, debugDescription: "edit_diff without counts")
        }
        self.added = added
        self.removed = removed
        diff = container.decodeLossyStringIfPresent(forKey: .diff) ?? ""
        truncated = container.decodeLossyBoolIfPresent(forKey: .truncated) ?? false
        hunks = DiffHunk.resolved(try? container.decodeIfPresent(JSONValue.self, forKey: .hunks), diff: diff)
    }

    /// The change a decoded JSON field holds; nil when the server sent none.
    init?(_ value: JSONValue?) {
        guard case .object = value,
              let data = try? JSONEncoder().encode(value),
              let edit = try? JSONDecoder().decode(ToolEditDiff.self, from: data)
        else { return nil }
        self = edit
    }
}

public struct PersistedToolCall: Decodable, Equatable, Sendable {
    let name: String?
    let snippet: String?
    let tid: String?
    let assistantMsgIdx: Int?
    let args: [String: JSONValue]?
    let kind: ToolDisplayKind?
    let target: String?

    enum CodingKeys: String, CodingKey {
        case name
        case snippet
        case tid
        case assistantMsgIdx
        case assistantMsgIdxSnake = "assistant_msg_idx"
        case args
        case kind
        case target
    }

    init(
        name: String?,
        snippet: String?,
        tid: String?,
        assistantMsgIdx: Int?,
        args: [String: JSONValue]?,
        kind: ToolDisplayKind? = nil,
        target: String? = nil
    ) {
        self.name = name
        self.snippet = snippet
        self.tid = tid
        self.assistantMsgIdx = assistantMsgIdx
        self.args = args
        self.kind = kind
        self.target = target
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = container.decodeLossyStringIfPresent(forKey: .name)
        snippet = container.decodeLossyStringIfPresent(forKey: .snippet)
        tid = container.decodeLossyStringIfPresent(forKey: .tid)
        assistantMsgIdx = container.decodeLossyIntIfPresent(forKey: .assistantMsgIdx)
            ?? container.decodeLossyIntIfPresent(forKey: .assistantMsgIdxSnake)
        args = try? container.decodeIfPresent([String: JSONValue].self, forKey: .args)
        kind = ToolDisplayKind(serverValue: container.decodeLossyStringIfPresent(forKey: .kind))
        target = container.decodeLossyStringIfPresent(forKey: .target)
    }
}

public struct ToolCallGroup: Identifiable, Equatable, Sendable {
    public let id: String
    public let anchorMessageID: String?
    public let toolCalls: [ToolCall]

    public init(
        id: String = UUID().uuidString,
        anchorMessageID: String?,
        toolCalls: [ToolCall]
    ) {
        self.id = id
        self.anchorMessageID = anchorMessageID
        self.toolCalls = toolCalls
    }

    var activityTitle: String {
        String(localized: "Activity: \(toolCalls.count) tools")
    }

    var isComplete: Bool {
        toolCalls.allSatisfy(\.isCompleted)
    }

    var hasFailedTool: Bool {
        toolCalls.contains { $0.isError == true }
    }

    public static func live(anchorMessageID: String?, toolCalls: [ToolCall]) -> ToolCallGroup {
        ToolCallGroup(
            id: "live-tools-\(anchorMessageID ?? "unanchored")",
            anchorMessageID: anchorMessageID,
            toolCalls: toolCalls
        )
    }

    /// Each assistant message's `tool_calls` as the server resolved them (TAL-313): its done, error, duration and result
    /// fields decide the card. An older server sends none, so its calls show as completed without an error or result.
    public static func groups(messages: [ChatMessage], messageOffset: Int?) -> [ToolCallGroup] {
        messages.enumerated().compactMap { messageIndex, message in
            guard message.role == "assistant" else { return nil }
            let toolCalls = (message.toolCalls ?? []).enumerated().compactMap { toolIndex, value in
                toolCall(from: value, fallbackID: "message-tool-\(messageIndex)-\(toolIndex)")
            }
            guard !toolCalls.isEmpty else { return nil }
            let anchorMessageID = TranscriptTurnClassifier.anchorID(
                for: message,
                at: messageIndex,
                messageOffset: messageOffset
            )
            return ToolCallGroup(
                id: "persisted-tools-\(anchorMessageID)",
                anchorMessageID: anchorMessageID,
                toolCalls: toolCalls
            )
        }
    }

    static func toolCall(from value: JSONValue, fallbackID: String) -> ToolCall? {
        guard case .object(let object) = value else { return nil }

        let function = object["function"]?.objectValue
        return ToolCall(
            id: nonEmpty(object["id"]?.stringValue) ?? nonEmpty(object["call_id"]?.stringValue) ?? fallbackID,
            name: nonEmpty(function?["name"]?.stringValue) ?? nonEmpty(object["name"]?.stringValue) ?? "tool",
            preview: nonEmpty(object["result"]?.stringValue) ?? nonEmpty(object["preview"]?.stringValue),
            args: arguments(from: function?["arguments"] ?? object["args"]),
            argsFields: ToolField.rows(object["args_fields"]),
            kind: ToolDisplayKind(serverValue: object["kind"]?.stringValue),
            verb: ToolVerb(serverValue: object["verb"]?.stringValue),
            app: ToolApp(object["app"]),
            target: object["target"]?.stringValue,
            progress: ToolProgress(object["progress"]),
            resultView: ToolResultView(object["result_view"]),
            editDiff: ToolEditDiff(object["edit_diff"]),
            duration: object["duration"]?.numberValue,
            isError: object["is_error"]?.boolValue,
            isCompleted: object["done"]?.boolValue ?? true,
            isHidden: object["hidden"]?.boolValue == true
        )
    }

    private static func arguments(from value: JSONValue?) -> [String: JSONValue]? {
        guard let value else { return nil }

        if case .object(let object) = value {
            return object.isEmpty ? nil : object
        }

        guard case .string(let string) = value,
              let data = string.data(using: .utf8),
              let decoded = try? JSONDecoder().decode(JSONValue.self, from: data),
              case .object(let object) = decoded
        else {
            return nil
        }

        return object.isEmpty ? nil : object
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

public struct ToolCallGroupAnchorLookup: Equatable, Sendable {
    private let groupsByAnchor: [String?: [ToolCallGroup]]

    public init(groups: [ToolCallGroup] = []) {
        groupsByAnchor = Dictionary(grouping: groups) { group in
            group.anchorMessageID
        }
    }

    public func groups(anchorMessageID: String?) -> [ToolCallGroup] {
        groupsByAnchor[anchorMessageID] ?? []
    }
}

private extension JSONValue {
    var objectValue: [String: JSONValue]? {
        if case .object(let object) = self {
            return object
        }

        return nil
    }

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

    var numberValue: Double? {
        if case .number(let value) = self {
            return value
        }

        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self {
            return value
        }

        return nil
    }
}

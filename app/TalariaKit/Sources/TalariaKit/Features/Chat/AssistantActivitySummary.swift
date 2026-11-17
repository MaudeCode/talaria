import Foundation
import SwiftUI

public enum AssistantTurnSummary {
    public static func title(duration: Double?) -> String {
        guard let duration, duration.isFinite, duration >= 0 else {
            return String(localized: "Worked")
        }
        let total = Int(duration.rounded())
        if total < 60 { return String(localized: "Worked for \(total)s") }
        let hours = total / 3_600
        let minutes = (total % 3_600) / 60
        if hours > 0 { return String(localized: "Worked for \(hours)h \(minutes)m") }
        return String(localized: "Worked for \(minutes)m \(total % 60)s")
    }
}

public enum AssistantActivityHeaderSummary {
    public static func title(for rows: [AssistantActivityRow], isActive: Bool) -> String {
        let titles = titles(for: rows, isActive: isActive)
        if let title = titles.last { return title }
        if isActive, case .tools(let toolCalls)? = rows.last?.content,
           let current = toolCalls.last(where: { !$0.isCompleted && $0.isError != true }) ?? toolCalls.last {
            return AssistantActivitySummary.label(for: current)
        }
        let tools = rows.flatMap(\.toolCalls)
        return tools.isEmpty ? String(localized: "Thinking") : AssistantActivitySummary.title(for: tools)
    }

    public static func titles(for rows: [AssistantActivityRow], isActive: Bool) -> [String] {
        if isActive {
            guard case .reasoning(let reasoning)? = rows.last?.content else { return [] }
            return ReasoningTitleMetadata.normalize(reasoning.titles)
        }
        guard rows.flatMap(\.toolCalls).isEmpty else { return [] }
        for row in rows.reversed() {
            guard case .reasoning(let reasoning) = row.content else { continue }
            let titles = ReasoningTitleMetadata.normalize(reasoning.titles)
            if !titles.isEmpty { return titles }
        }
        return []
    }
}

public enum AssistantActivityGroupPolicy: Sendable {
    public static func requiresGroup(for rows: [AssistantActivityRow]) -> Bool {
        rows.reduce(into: 0) { count, row in
            switch row.content {
            case .reasoning:
                count += 1
            case .tools(let toolCalls):
                count += toolCalls.count
            case .prose, .steering:
                break
            }
        } > 1
    }
}

public enum AssistantActivitySummary: Sendable {
    enum Category: Hashable {
        case command
        case read
        case edit
        case search
        case web
        case load
        case talaria
        // TAL-2325: media a tool generates, and the analysis of an image or a video.
        case image
        case audio
        case video
        case imageAnalysis
        case videoAnalysis
        // TAL-2326: past chats searched, scheduled jobs, connected apps and questions asked.
        case session
        case schedule
        case connection
        case question
        // TAL-2327: Kanban tasks read or changed.
        case kanban
        // TAL-2328: the agent's browser and the desktop.
        case browser
        case computer
        case generic
    }

    /// TAL-2317: the Talaria mark (the shared `BrandAssets` sandal), the icon of Talaria's own tools; every other icon is an SF Symbol.
    public static let talariaMarkIcon = "Sandal"

    static func title(for toolCalls: [ToolCall]) -> String {
        guard !toolCalls.isEmpty else { return String(localized: "Thinking") }
        var order: [Category] = []
        var counts: [Category: Int] = [:]
        var failed = Set<Category>()
        var running = Set<Category>()
        for toolCall in toolCalls {
            let category = category(for: toolCall)
            if counts[category] == nil { order.append(category) }
            counts[category, default: 0] += 1
            if toolCall.isError == true { failed.insert(category) }
            if !toolCall.isCompleted && toolCall.isError != true { running.insert(category) }
        }
        return order.enumerated().map { index, category in
            let phrase = failed.contains(category)
                ? failedPhrase(for: category)
                : phrase(for: category, count: counts[category] ?? 1, completed: !running.contains(category))
            guard index > 0, let first = phrase.first else { return phrase }
            return first.lowercased() + phrase.dropFirst()
        }.joined(separator: ", ")
    }

    public static func label(for toolCall: ToolCall) -> String {
        if toolCall.kind == .kanban { return kanbanLabel(for: toolCall) }
        if toolCall.kind == .browser || toolCall.kind == .computer { return browserLabel(for: toolCall) }
        if let specificLabel = specificLabel(for: toolCall) {
            return specificLabel
        }
        if toolCall.isError == true {
            return failedPhrase(for: category(for: toolCall))
        }
        return phrase(for: category(for: toolCall), count: 1, completed: toolCall.isCompleted)
    }

    private static func specificLabel(for toolCall: ToolCall) -> String? {
        let kind = toolCall.kind ?? .unknown
        guard let target = collapsedTarget(for: toolCall, kind: kind) else {
            return nil
        }
        if toolCall.isError == true {
            switch kind {
            // An unknown tool with a target takes the generic run verb, as on Web.
            case .shell, .unknown: return String(localized: "Failed to run \(target)")
            case .read: return String(localized: "Failed to read \(target)")
            case .list: return String(localized: "Failed to list \(target)")
            case .search: return String(localized: "Failed to search for \(target)")
            case .web: return String(localized: "Failed to check \(target)")
            case .write: return String(localized: "Failed to edit \(target)")
            case .skill: return String(localized: "Failed to load \(target)")
            case .memory: return String(localized: "Failed to save \(target)")
            case .delegate: return String(localized: "Failed to delegate \(target)")
            case .talaria: return String(localized: "Failed to use \(target)")
            // A media tool reads as its kind's phrase; the server sends it no target.
            case .session: return String(localized: "Failed to search past chats for \(target)")
            case .image, .audio, .video, .imageAnalysis, .videoAnalysis, .schedule, .connection, .question: return failedPhrase(for: category(for: toolCall))
            case .kanban: return kanbanLabel(for: toolCall)
            case .browser, .computer: return browserLabel(for: toolCall)
            }
        }
        switch (kind, toolCall.isCompleted) {
        case (.shell, true), (.unknown, true): return String(localized: "Ran \(target)")
        case (.shell, false), (.unknown, false): return String(localized: "Running \(target)")
        case (.read, true): return String(localized: "Read \(target)")
        case (.read, false): return String(localized: "Reading \(target)")
        case (.list, true): return String(localized: "Listed \(target)")
        case (.list, false): return String(localized: "Listing \(target)")
        case (.search, true): return String(localized: "Searched for \(target)")
        case (.search, false): return String(localized: "Searching for \(target)")
        case (.web, true): return String(localized: "Checked \(target)")
        case (.web, false): return String(localized: "Checking \(target)")
        case (.write, true): return String(localized: "Edited \(target)")
        case (.write, false): return String(localized: "Editing \(target)")
        case (.skill, true): return String(localized: "Loaded \(target)")
        case (.skill, false): return String(localized: "Loading \(target)")
        case (.memory, true): return String(localized: "Saved \(target)")
        case (.memory, false): return String(localized: "Saving \(target)")
        case (.delegate, true): return String(localized: "Delegated \(target)")
        case (.delegate, false): return String(localized: "Delegating \(target)")
        case (.talaria, true): return String(localized: "Used \(target)")
        case (.talaria, false): return String(localized: "Using \(target)")
        case (.session, true): return String(localized: "Searched past chats for \(target)")
        case (.session, false): return String(localized: "Searching past chats for \(target)")
        // TAL-2326: a job, connection or question reads as its kind's phrase, as a media tool does.
        case (.image, _), (.audio, _), (.video, _), (.imageAnalysis, _), (.videoAnalysis, _), (.schedule, _), (.connection, _), (.question, _):
            return phrase(for: category(for: toolCall), count: 1, completed: toolCall.isCompleted)
        case (.kanban, _): return kanbanLabel(for: toolCall)
        case (.browser, _), (.computer, _): return browserLabel(for: toolCall)
        }
    }

    /// TAL-2327: a Kanban call's verb and the task it names, the server's `verb` picking the verb; a list reads as its
    /// tasks, and another call naming no task as the kind's phrase.
    private static func kanbanLabel(for toolCall: ToolCall) -> String {
        let failed = toolCall.isError == true
        let done = toolCall.isCompleted
        if toolCall.verb == .list {
            return failed ? String(localized: "Failed to list tasks") : done ? String(localized: "Listed tasks") : String(localized: "Listing tasks")
        }
        guard let target = collapsedTarget(for: toolCall, kind: .kanban) else {
            return failed ? failedPhrase(for: .kanban) : phrase(for: .kanban, count: 1, completed: done)
        }
        switch (toolCall.verb ?? .update, failed, done) {
        case (.create, true, _): return String(localized: "Failed to create \(target)")
        case (.create, false, true): return String(localized: "Created \(target)")
        case (.create, false, false): return String(localized: "Creating \(target)")
        case (.view, true, _): return String(localized: "Failed to view \(target)")
        case (.view, false, true): return String(localized: "Viewed \(target)")
        case (.view, false, false): return String(localized: "Viewing \(target)")
        case (.complete, true, _): return String(localized: "Failed to complete \(target)")
        case (.complete, false, true): return String(localized: "Completed \(target)")
        case (.complete, false, false): return String(localized: "Completing \(target)")
        case (.block, true, _): return String(localized: "Failed to block \(target)")
        case (.block, false, true): return String(localized: "Blocked \(target)")
        case (.block, false, false): return String(localized: "Blocking \(target)")
        case (.comment, true, _): return String(localized: "Failed to comment on \(target)")
        case (.comment, false, true): return String(localized: "Commented on \(target)")
        case (.comment, false, false): return String(localized: "Commenting on \(target)")
        case (_, true, _): return String(localized: "Failed to update \(target)")
        case (_, false, true): return String(localized: "Updated \(target)")
        case (_, false, false): return String(localized: "Updating \(target)")
        }
    }

    /// TAL-2328: a browser or computer call's phrase, the server's `verb` picking it: browser code names its session or
    /// comment line and a CDP command its method when the server sent one; any other call reads as its verb's phrase, and
    /// a call without a verb as its kind's.
    private static func browserLabel(for toolCall: ToolCall) -> String {
        let failed = toolCall.isError == true
        let done = toolCall.isCompleted
        let target = collapsedTarget(for: toolCall, kind: .browser)
        switch (toolCall.kind, toolCall.verb, target) {
        case (.browser, .run, let target?):
            return failed ? String(localized: "Failed to run \(target)") : done ? String(localized: "Ran \(target)") : String(localized: "Running \(target)")
        case (.browser, .run, nil):
            return failed ? String(localized: "Failed to run browser code") : done ? String(localized: "Ran browser code") : String(localized: "Running browser code")
        case (.browser, .send, let target?):
            return failed ? String(localized: "Failed to send \(target)") : done ? String(localized: "Sent \(target)") : String(localized: "Sending \(target)")
        case (.browser, .send, nil):
            return failed ? String(localized: "Failed to send a browser command") : done ? String(localized: "Sent a browser command") : String(localized: "Sending a browser command")
        case (.browser, .answer, _):
            return failed ? String(localized: "Failed to answer a dialog") : done ? String(localized: "Answered a dialog") : String(localized: "Answering a dialog")
        case (.browser, .fill, _):
            return failed ? String(localized: "Failed to fill a login") : done ? String(localized: "Filled a login") : String(localized: "Filling a login")
        case (.browser, .list, _):
            return failed ? String(localized: "Failed to list saved logins") : done ? String(localized: "Listed saved logins") : String(localized: "Listing saved logins")
        case (.computer, .capture, _):
            return failed ? String(localized: "Failed to capture the screen") : done ? String(localized: "Captured the screen") : String(localized: "Capturing the screen")
        case (.computer, .click, _):
            return failed ? String(localized: "Failed to click on the screen") : done ? String(localized: "Clicked on the screen") : String(localized: "Clicking on the screen")
        case (.computer, .type, _):
            return failed ? String(localized: "Failed to type text") : done ? String(localized: "Typed text") : String(localized: "Typing text")
        default:
            let category = category(for: toolCall)
            return failed ? failedPhrase(for: category) : phrase(for: category, count: 1, completed: done)
        }
    }

    /// The server's redacted target as sent; only the localized skill suffix and layout truncation are the app's.
    private static func collapsedTarget(for toolCall: ToolCall, kind: ToolDisplayKind) -> String? {
        guard var target = toolCall.target?.trimmingCharacters(in: .whitespacesAndNewlines), !target.isEmpty else {
            return nil
        }
        if kind == .skill, !target.lowercased().hasSuffix(" skill") {
            target += " " + String(localized: "skill")
        }
        return shortened(target, limit: 112)
    }

    private static func shortened(_ value: String, limit: Int) -> String {
        guard value.count > limit else { return value }
        let headCount = max(24, Int(Double(limit) * 0.68))
        let tailCount = max(12, limit - headCount - 3)
        return String(value.prefix(headCount)).trimmingCharacters(in: .whitespaces)
            + "..."
            + String(value.suffix(tailCount)).trimmingCharacters(in: .whitespaces)
    }

    public static func icon(for toolCalls: [ToolCall]) -> String {
        icon(for: toolCalls.first.map(category) ?? .generic)
    }

    public static func icon(for toolCall: ToolCall) -> String {
        icon(for: category(for: toolCall))
    }

    private static func category(for toolCall: ToolCall) -> Category {
        switch toolCall.kind ?? .unknown {
        case .shell: .command
        case .read, .list: .read
        case .write: .edit
        case .search: .search
        case .web: .web
        case .skill: .load
        case .talaria: .talaria
        case .image: .image
        case .audio: .audio
        case .video: .video
        case .imageAnalysis: .imageAnalysis
        case .videoAnalysis: .videoAnalysis
        case .session: .session
        case .schedule: .schedule
        case .connection: .connection
        case .question: .question
        case .kanban: .kanban
        case .browser: .browser
        case .computer: .computer
        case .memory, .delegate, .unknown: .generic
        }
    }

    private static func phrase(for category: Category, count: Int, completed: Bool) -> String {
        switch (category, count == 1, completed) {
        case (.command, true, true): String(localized: "Ran a command")
        case (.command, false, true): String(localized: "Ran commands")
        case (.command, true, false): String(localized: "Running a command")
        case (.command, false, false): String(localized: "Running commands")
        case (.read, true, true): String(localized: "Read a file")
        case (.read, false, true): String(localized: "Read files")
        case (.read, true, false): String(localized: "Reading a file")
        case (.read, false, false): String(localized: "Reading files")
        case (.edit, true, true): String(localized: "Edited a file")
        case (.edit, false, true): String(localized: "Edited files")
        case (.edit, true, false): String(localized: "Editing a file")
        case (.edit, false, false): String(localized: "Editing files")
        case (.search, _, true): String(localized: "Searched files")
        case (.search, _, false): String(localized: "Searching files")
        case (.web, _, true): String(localized: "Searched the web")
        case (.web, _, false): String(localized: "Searching the web")
        case (.load, true, true): String(localized: "Loaded a tool")
        case (.load, false, true): String(localized: "Loaded tools")
        case (.load, true, false): String(localized: "Loading a tool")
        case (.load, false, false): String(localized: "Loading tools")
        case (.talaria, true, true): String(localized: "Used a Talaria tool")
        case (.talaria, false, true): String(localized: "Used Talaria tools")
        case (.talaria, true, false): String(localized: "Using a Talaria tool")
        case (.talaria, false, false): String(localized: "Using Talaria tools")
        case (.image, true, true): String(localized: "Generated an image")
        case (.image, false, true): String(localized: "Generated images")
        case (.image, true, false): String(localized: "Generating an image")
        case (.image, false, false): String(localized: "Generating images")
        case (.audio, _, true): String(localized: "Spoke aloud")
        case (.audio, _, false): String(localized: "Speaking aloud")
        case (.video, true, true): String(localized: "Generated a video")
        case (.video, false, true): String(localized: "Generated videos")
        case (.video, true, false): String(localized: "Generating a video")
        case (.video, false, false): String(localized: "Generating videos")
        case (.imageAnalysis, true, true): String(localized: "Analyzed an image")
        case (.imageAnalysis, false, true): String(localized: "Analyzed images")
        case (.imageAnalysis, true, false): String(localized: "Analyzing an image")
        case (.imageAnalysis, false, false): String(localized: "Analyzing images")
        case (.videoAnalysis, true, true): String(localized: "Analyzed a video")
        case (.videoAnalysis, false, true): String(localized: "Analyzed videos")
        case (.videoAnalysis, true, false): String(localized: "Analyzing a video")
        case (.videoAnalysis, false, false): String(localized: "Analyzing videos")
        case (.session, _, true): String(localized: "Searched past chats")
        case (.session, _, false): String(localized: "Searching past chats")
        case (.schedule, true, true): String(localized: "Managed a scheduled job")
        case (.schedule, false, true): String(localized: "Managed scheduled jobs")
        case (.schedule, true, false): String(localized: "Managing a scheduled job")
        case (.schedule, false, false): String(localized: "Managing scheduled jobs")
        case (.connection, _, true): String(localized: "Managed connections")
        case (.connection, _, false): String(localized: "Managing connections")
        case (.question, true, true): String(localized: "Asked a question")
        case (.question, false, true): String(localized: "Asked questions")
        case (.question, true, false): String(localized: "Asking a question")
        case (.question, false, false): String(localized: "Asking questions")
        case (.kanban, true, true): String(localized: "Worked on a task")
        case (.kanban, false, true): String(localized: "Worked on tasks")
        case (.kanban, true, false): String(localized: "Working on a task")
        case (.kanban, false, false): String(localized: "Working on tasks")
        case (.browser, _, true): String(localized: "Used the browser")
        case (.browser, _, false): String(localized: "Using the browser")
        case (.computer, _, true): String(localized: "Used the computer")
        case (.computer, _, false): String(localized: "Using the computer")
        case (.generic, true, true): String(localized: "Called a tool")
        case (.generic, false, true): String(localized: "Called tools")
        case (.generic, true, false): String(localized: "Calling a tool")
        case (.generic, false, false): String(localized: "Calling tools")
        }
    }

    private static func failedPhrase(for category: Category) -> String {
        switch category {
        case .command: String(localized: "Failed to run a command")
        case .read: String(localized: "Failed to read a file")
        case .edit: String(localized: "Failed to edit a file")
        case .search: String(localized: "Failed to search files")
        case .web: String(localized: "Failed to search the web")
        case .load: String(localized: "Failed to load a tool")
        case .talaria: String(localized: "Failed to use a Talaria tool")
        case .image: String(localized: "Failed to generate an image")
        case .audio: String(localized: "Failed to speak aloud")
        case .video: String(localized: "Failed to generate a video")
        case .imageAnalysis: String(localized: "Failed to analyze an image")
        case .videoAnalysis: String(localized: "Failed to analyze a video")
        case .session: String(localized: "Failed to search past chats")
        case .schedule: String(localized: "Failed to manage a scheduled job")
        case .connection: String(localized: "Failed to manage connections")
        case .question: String(localized: "Failed to ask a question")
        case .kanban: String(localized: "Failed to update a task")
        case .browser: String(localized: "Failed to use the browser")
        case .computer: String(localized: "Failed to use the computer")
        case .generic: String(localized: "Tool failed")
        }
    }

    private static func icon(for category: Category) -> String {
        switch category {
        case .command: "terminal"
        case .read: "doc.text"
        case .edit: "doc.badge.ellipsis"
        case .search: "magnifyingglass"
        case .web: "globe"
        case .load: "puzzlepiece.extension"
        case .talaria: talariaMarkIcon
        case .image, .imageAnalysis: "photo"
        case .audio: "waveform"
        case .video, .videoAnalysis: "video"
        case .session: "bubble.left.and.bubble.right"
        case .schedule: "calendar.badge.clock"
        case .connection: "powerplug"
        case .question: "questionmark.bubble"
        case .kanban: "rectangle.split.3x1"
        case .browser: "macwindow"
        case .computer: "desktopcomputer"
        case .generic: "wrench"
        }
    }
}

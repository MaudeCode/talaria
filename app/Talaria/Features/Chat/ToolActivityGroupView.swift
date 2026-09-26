import SwiftUI

struct ToolActivityGroupView: View {
    let group: ToolCallGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(group.toolCalls) { toolCall in
                ToolCallCardView(toolCall: toolCall)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }
}

enum AssistantTurnSummary {
    static func title(duration: Double?) -> String {
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

enum AssistantActivityHeaderSummary {
    static func title(for rows: [AssistantActivityRow], isActive: Bool) -> String {
        let titles = titles(for: rows, isActive: isActive)
        if let title = titles.last { return title }
        if isActive, case .tools(let toolCalls)? = rows.last?.content,
           let current = toolCalls.last(where: { !$0.isCompleted && $0.isError != true }) ?? toolCalls.last {
            return AssistantActivitySummary.label(for: current)
        }
        let tools = rows.flatMap(\.toolCalls)
        return tools.isEmpty ? String(localized: "Thinking") : AssistantActivitySummary.title(for: tools)
    }

    static func titles(for rows: [AssistantActivityRow], isActive: Bool) -> [String] {
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

enum AssistantActivityGroupPolicy {
    static func requiresGroup(for rows: [AssistantActivityRow]) -> Bool {
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

enum AssistantActivitySummary {
    enum Category: Hashable {
        case command
        case read
        case edit
        case search
        case web
        case load
        case generic
    }

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

    static func label(for toolCall: ToolCall) -> String {
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
        guard kind != .unknown, let target = collapsedTarget(for: toolCall, kind: kind) else {
            return nil
        }
        if toolCall.isError == true {
            switch kind {
            case .shell: return String(localized: "Failed to run \(target)")
            case .read: return String(localized: "Failed to read \(target)")
            case .list: return String(localized: "Failed to list \(target)")
            case .search: return String(localized: "Failed to search for \(target)")
            case .web: return String(localized: "Failed to check \(target)")
            case .write: return String(localized: "Failed to edit \(target)")
            case .skill: return String(localized: "Failed to load \(target)")
            case .memory: return String(localized: "Failed to save \(target)")
            case .delegate: return String(localized: "Failed to delegate \(target)")
            case .unknown: return nil
            }
        }
        switch (kind, toolCall.isCompleted) {
        case (.shell, true): return String(localized: "Ran \(target)")
        case (.shell, false): return String(localized: "Running \(target)")
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
        case (.unknown, _): return nil
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

    static func icon(for toolCalls: [ToolCall]) -> String {
        icon(for: toolCalls.first.map(category) ?? .generic)
    }

    static func icon(for toolCall: ToolCall) -> String {
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
        case .generic: "wrench"
        }
    }
}

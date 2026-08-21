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

enum AssistantWorkSummary {
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
        if toolCall.isError == true {
            return failedPhrase(for: category(for: toolCall))
        }
        return phrase(for: category(for: toolCall), count: 1, completed: toolCall.isCompleted)
    }

    static func icon(for toolCalls: [ToolCall]) -> String {
        icon(for: toolCalls.first.map(category) ?? .generic)
    }

    static func icon(for toolCall: ToolCall) -> String {
        icon(for: category(for: toolCall))
    }

    private static func category(for toolCall: ToolCall) -> Category {
        let name = (toolCall.name ?? "").lowercased()
        if name.contains("web") || name.contains("browse") || name.contains("fetch") || name.contains("url") {
            return .web
        }
        if name.contains("write") || name.contains("edit") || name.contains("patch") || name.contains("replace") {
            return .edit
        }
        if name.contains("skill") || name.contains("load") {
            return .load
        }
        switch AgentRunActivitySanitizer.toolKind(name: toolCall.name) {
        case .command: return .command
        case .search: return .search
        case .files: return .read
        case .generic: return .generic
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

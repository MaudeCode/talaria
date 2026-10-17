import SwiftUI
import TalariaKit
import UIKit

/// A notice above the composer in the status chip's look: its level's icon, up to two lines, and a dismiss button.
/// The Agent's session notices and the chat's own short notices (TAL-1001) share it.
struct NoticeChip: View {
    let text: String
    let level: SessionNotice.Level
    let dismiss: () -> Void

    var body: some View {
        let style = Self.style(level)
        HStack(spacing: 8) {
            Image(systemName: style.symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(style.tint)
                .accessibilityHidden(true)
            Text(text)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityValue(style.name)
            Button(action: dismiss) {
                Image(systemName: "xmark")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(.rect)
            }
            .buttonStyle(.plain)
            .chatMinimumHitTarget(in: Circle())
            .accessibilityLabel(String(localized: "Dismiss notice"))
            .accessibilityValue(text)
        }
        .statusChipChrome()
        .accessibilityElement(children: .contain)
    }

    /// The level's icon, its tint, and the word VoiceOver reads for it.
    private static func style(_ level: SessionNotice.Level) -> (symbol: String, tint: Color, name: String) {
        switch level {
        case .error: ("xmark.octagon.fill", .red, String(localized: "Error"))
        case .warn: ("exclamationmark.triangle.fill", .orange, String(localized: "Warning"))
        case .info: ("info.circle.fill", .accentColor, String(localized: "Information"))
        case .success: ("checkmark.circle.fill", .green, String(localized: "Success"))
        }
    }
}

/// TAL-372: the session's background work the server pins (running work, and a finished `/background` result until
/// dismissed), opened from the composer's background tasks chip (TAL-1001): each task's status, the full result on
/// request, and Dismiss where the server offers it. The sheet closes once nothing is pinned.
struct BackgroundWorkSheet: View {
    let tasks: [BackgroundWorkTask]
    let loadResult: (String) async -> String?
    let dismiss: (String) async -> Void

    @Environment(\.dismiss) private var close

    var body: some View {
        NavigationStack {
            List(tasks) { task in
                row(task)
                    .swipeActions(edge: .trailing) {
                        if task.dismissible {
                            Button(role: .destructive) { Task { await dismiss(task.taskId) } } label: {
                                Label("Dismiss", systemImage: "xmark")
                            }
                        }
                    }
            }
            .navigationTitle(String(localized: "Background tasks"))
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: String.self) { taskID in
                BackgroundWorkResultView(
                    task: tasks.first { $0.taskId == taskID },
                    loadResult: { await loadResult(taskID) },
                    dismiss: { await dismiss(taskID) }
                )
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { close() }
                }
            }
        }
        // Initially too: the work can finish and be dismissed between the chip's tap and the sheet appearing.
        .onChange(of: tasks.isEmpty, initial: true) { _, isEmpty in
            if isEmpty { close() }
        }
    }

    @ViewBuilder
    private func row(_ task: BackgroundWorkTask) -> some View {
        let label = HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: Self.icon(task.status))
                .font(.footnote.weight(.semibold))
                .foregroundStyle(Self.tint(task.status))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.title)
                    .font(AppFont.body())
                    .lineLimit(2)
                Text(Self.kindLabel(task.kind) + " · " + Self.detail(task))
                    .font(AppFont.footnote())
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        if task.resultAvailable {
            NavigationLink(value: task.taskId) { label }
                .accessibilityHint(String(localized: "Show result"))
        } else {
            label
        }
    }

    private static func detail(_ task: BackgroundWorkTask) -> String {
        if let agents = task.agents, agents.total > 1 {
            return agentsSummary(agents)
        }
        return statusLabel(task.status)
    }

    /// "2 of 3 done · 1 failed": a delegation's subagents, in the sheet and in place on its row.
    static func agentsSummary(_ agents: BackgroundWorkTask.Agents) -> String {
        var parts = [String(localized: "\(agents.completed) of \(agents.total) done")]
        if agents.failed > 0 {
            parts.append(String(localized: "\(agents.failed) failed"))
        }
        return parts.joined(separator: " · ")
    }

    static func statusLabel(_ status: BackgroundWorkTask.Status) -> String {
        switch status {
        case .running: String(localized: "Running")
        case .attention: String(localized: "Needs attention")
        case .completed: String(localized: "Done")
        case .failed: String(localized: "Failed")
        case .cancelled: String(localized: "Stopped")
        case .unknown: String(localized: "Status unknown")
        }
    }

    private static func kindLabel(_ kind: BackgroundWorkTask.Kind) -> String {
        switch kind {
        case .delegation: String(localized: "Agent")
        case .process: String(localized: "Command")
        case .backgroundCommand: String(localized: "Background task")
        }
    }

    /// The transcript reuses the background-work icon mapping for shared outcomes.
    static func icon(_ review: BackgroundReviewState?) -> String {
        switch review {
        case .waiting: "clock"
        case .reviewing: "circle.dotted"
        case .reviewed: "checkmark"
        case .failed: icon(BackgroundWorkTask.Status.failed)
        case .unknown, nil: icon(BackgroundWorkTask.Status.unknown)
        }
    }

    static func icon(_ status: BackgroundWorkTask.Status) -> String {
        switch status {
        case .running: "circle.dotted"
        case .attention, .failed: "exclamationmark.triangle.fill"
        case .completed: "checkmark.circle.fill"
        case .cancelled: "xmark.circle"
        case .unknown: "questionmark.circle"
        }
    }

    private static func tint(_ status: BackgroundWorkTask.Status) -> Color {
        switch status {
        case .running: .accentColor
        case .attention, .failed: .orange
        case .completed: .green
        case .cancelled, .unknown: .secondary
        }
    }
}

/// A finished background task's full result, loaded on open, with Dismiss where the server offers it.
private struct BackgroundWorkResultView: View {
    let task: BackgroundWorkTask?
    let loadResult: () async -> String?
    let dismiss: () async -> Void

    @State private var text: String?
    @Environment(\.dismiss) private var back

    var body: some View {
        ScrollView {
            if let text {
                Text(text)
                    .font(AppFont.body())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            } else {
                ProgressView()
                    .padding()
            }
        }
        .navigationTitle(task?.title ?? "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if task?.dismissible == true {
                ToolbarItem(placement: .primaryAction) {
                    Button(String(localized: "Dismiss"), role: .destructive) {
                        Task {
                            await dismiss()
                            back()
                        }
                    }
                }
            }
        }
        .task {
            text = await loadResult() ?? String(localized: "The result is no longer available.")
        }
    }
}

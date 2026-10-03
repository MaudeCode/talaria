import SwiftUI
import TalariaKit
import UIKit

struct PinnedLocalNoticeStack: View {
    let notices: [String]

    var body: some View {
        VStack(spacing: 8) {
            ForEach(Array(notices.enumerated()), id: \.offset) { _, notice in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Color.green)

                    Text(notice)
                        .font(.footnote)
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(12)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .stroke(Color(.separator).opacity(0.45), lineWidth: 0.5)
                )
            }
        }
        .frame(maxWidth: .infinity)
        .shadow(color: Color.black.opacity(0.12), radius: 10, y: 4)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(notices.joined(separator: "\n"))
    }
}

/// TAL-372: the session's background work the server pins (running work, and a finished `/background` result until
/// dismissed), with each status, the full result on request, and Dismiss where the server offers it.
struct BackgroundWorkCard: View {
    let tasks: [BackgroundWorkTask]
    let loadResult: (String) async -> String?
    let dismiss: (String) async -> Void
    @State private var presentedResult: PresentedResult?

    private struct PresentedResult: Identifiable {
        let id: String
        let title: String
        var text: String?
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Background work")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(tasks) { task in
                row(task)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.ultraThinMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color(.separator).opacity(0.45), lineWidth: 0.5)
        )
        .shadow(color: Color.black.opacity(0.12), radius: 10, y: 4)
        .sheet(item: $presentedResult) { result in
            NavigationStack {
                ScrollView {
                    if let text = result.text {
                        Text(text)
                            .font(.body)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding()
                    } else {
                        ProgressView()
                            .padding()
                    }
                }
                .navigationTitle(result.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(String(localized: "Done")) { presentedResult = nil }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private func row(_ task: BackgroundWorkTask) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Image(systemName: Self.icon(task.status))
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Self.tint(task.status))
                    .accessibilityHidden(true)
                (Text(Self.kindLabel(task.kind)).foregroundStyle(.secondary) + Text(" ") + Text(task.title))
                    .font(.footnote)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                Text(Self.detail(task))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            if task.resultAvailable || task.dismissible {
                HStack(spacing: 16) {
                    if task.resultAvailable {
                        Button(String(localized: "Show result")) {
                            showResult(task)
                        }
                    }
                    if task.dismissible {
                        Button(String(localized: "Dismiss")) {
                            Task { await dismiss(task.taskId) }
                        }
                    }
                }
                .font(.caption.weight(.semibold))
                .buttonStyle(.borderless)
                .frame(minHeight: 44)
            }
        }
    }

    /// The full result opens in a sheet: it can be long, and the card stays one line per task.
    private func showResult(_ task: BackgroundWorkTask) {
        presentedResult = PresentedResult(id: task.taskId, title: task.title, text: nil)
        Task {
            let text = await loadResult(task.taskId) ?? String(localized: "The result is no longer available.")
            if presentedResult?.id == task.taskId { presentedResult?.text = text }
        }
    }

    private static func detail(_ task: BackgroundWorkTask) -> String {
        if let agents = task.agents, agents.total > 1 {
            return agentsSummary(agents)
        }
        return statusLabel(task.status)
    }

    /// "2 of 3 done · 1 failed": a delegation's subagents, in the card and in place on its row.
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

    private static func icon(_ status: BackgroundWorkTask.Status) -> String {
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

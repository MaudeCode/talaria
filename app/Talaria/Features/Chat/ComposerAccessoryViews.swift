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
/// request, and the actions the server offers on it. An owner chat's processes and subagents list here too, with Stop and
/// Steer only where their owner allows them (TAL-1337). Above the rows, the server's delegation summary says what still
/// runs and what awaits delivery (TAL-1580). The sheet closes once nothing is pinned and neither the owner nor the
/// summary has anything to say.
struct BackgroundWorkSheet: View {
    let tasks: [BackgroundWorkTask]
    var ownerWork: BackgroundTasksResponse.OwnerWork?
    var delegationSummary: DelegationStatus?
    let loadResult: (String) async -> String?
    let dismiss: (String) async -> Void
    var stop: (String) async -> BackgroundControlOutcome? = { _ in nil }
    var steer: (_ taskID: String, _ text: String) async -> BackgroundControlOutcome? = { _, _ in nil }

    @Environment(\.dismiss) private var close
    /// Rows whose Stop or Steer awaits its owner's answer: the owner produces the result, so only that row waits.
    @State private var controlling: Set<String> = []
    @State private var refusal: String?
    @State private var steering: BackgroundWorkTask?
    /// Each row's unsent steering message, kept when the owner does not take it.
    @State private var steerDrafts: [String: String] = [:]

    private enum RowAction: Hashable { case stop, steer, dismiss }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(tasks) { task in
                        let actions = controlling.contains(task.taskId) ? [] : Self.actions(task)
                        row(task)
                            // A full swipe never stops running work by accident.
                            .swipeActions(edge: .trailing, allowsFullSwipe: !task.canStop) {
                                ForEach(actions, id: \.self) { actionButton($0, task: task) }
                            }
                            .contextMenu {
                                ForEach(actions, id: \.self) { actionButton($0, task: task) }
                            }
                    }
                } header: {
                    VStack(alignment: .leading, spacing: 4) {
                        if let notice = Self.ownerNotice(ownerWork) {
                            Text(notice)
                                .accessibilityIdentifier("background-work-owner-notice")
                        }
                        if let delegationSummary {
                            let parts = Self.deliverySummary(delegationSummary)
                            Text(parts.joined(separator: " · "))
                                .accessibilityLabel(parts.joined(separator: ", "))
                                .accessibilityIdentifier("background-work-delivery-summary")
                        }
                    }
                    .font(AppFont.caption())
                    .textCase(nil)
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
            .alert(refusal ?? "", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) {
                Button("OK", role: .cancel) {}
            }
            .alert(String(localized: "Steer"), isPresented: Binding(get: { steering != nil }, set: { if !$0 { steering = nil } }), presenting: steering) { task in
                TextField(String(localized: "Message for this agent"), text: steerDraft(task.taskId))
                Button(String(localized: "Send")) { send(steerDrafts[task.taskId] ?? "", to: task) }
                Button("Cancel", role: .cancel) {}
            } message: { task in
                Text(task.title)
            }
        }
        // Initially too: the work can finish and be dismissed between the chip's tap and the sheet appearing. An owner
        // lost while its work is open keeps the sheet, which says why the rows went.
        .onChange(of: tasks.isEmpty && Self.ownerNotice(ownerWork) == nil && delegationSummary == nil, initial: true) { _, isEmpty in
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
            if controlling.contains(task.taskId) {
                Spacer(minLength: 0)
                ProgressView()
                    .controlSize(.small)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("background-task-row-\(task.taskId)")
        if task.resultAvailable {
            NavigationLink(value: task.taskId) { label }
                .accessibilityHint(String(localized: "Show result"))
        } else {
            label
        }
    }

    /// The row's actions, as the server offers them: Stop on work it may stop, else Dismiss on a finished result, and
    /// Steer on an owner subagent that takes a message now. A listed row without any is read-only.
    private static func actions(_ task: BackgroundWorkTask) -> [RowAction] {
        var actions: [RowAction] = []
        if task.canStop {
            actions.append(.stop)
        } else if task.dismissible {
            actions.append(.dismiss)
        }
        if task.canSteer {
            actions.append(.steer)
        }
        return actions
    }

    @ViewBuilder
    private func actionButton(_ action: RowAction, task: BackgroundWorkTask) -> some View {
        switch action {
        case .stop:
            Button(role: .destructive) {
                control(task) { await stop(task.taskId) }
            } label: {
                Label(String(localized: "Stop"), systemImage: "stop.circle")
            }
        case .steer:
            Button {
                steering = task
            } label: {
                Label(String(localized: "Steer"), systemImage: "arrow.turn.down.right")
            }
            .tint(.accentColor)
        case .dismiss:
            Button(role: .destructive) { Task { await dismiss(task.taskId) } } label: {
                Label("Dismiss", systemImage: "xmark")
            }
        }
    }

    private func steerDraft(_ taskID: String) -> Binding<String> {
        Binding(get: { steerDrafts[taskID] ?? "" }, set: { steerDrafts[taskID] = $0 })
    }

    private func send(_ text: String, to task: BackgroundWorkTask) {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        control(task) {
            let outcome = await steer(task.taskId, text)
            if outcome == .queued { steerDrafts[task.taskId] = nil }
            return outcome
        }
    }

    /// Runs one Stop or Steer. Its answer only explains itself when the owner did not do it; the rows show the
    /// owner's roster read after every answer. A nil answer belongs to another chat or profile.
    private func control(_ task: BackgroundWorkTask, _ run: @escaping () async -> BackgroundControlOutcome?) {
        controlling.insert(task.taskId)
        Task {
            let outcome = await run()
            controlling.remove(task.taskId)
            if let outcome { refusal = Self.refusalMessage(outcome) }
        }
    }

    static func refusalMessage(_ outcome: BackgroundControlOutcome) -> String? {
        switch outcome {
        case .stopped, .queued: nil
        case .notRunning: String(localized: "This work had already stopped.")
        case .notFound: String(localized: "This work is no longer running here.")
        case .rejected: String(localized: "The agent didn’t take the message.")
        case .unconfirmed: String(localized: "Couldn’t confirm what happened. The list shows the current state.")
        case let .failed(message): message
        }
    }

    /// An owner chat whose work the owner cannot show, or could not be read now.
    static func ownerNotice(_ ownerWork: BackgroundTasksResponse.OwnerWork?) -> String? {
        switch ownerWork {
        case .unsupported: String(localized: "This chat’s agents run in a worker Talaria can’t show")
        case .unavailable: String(localized: "The agent can’t report status right now.")
        case .available, nil: nil
        }
    }

    /// TAL-1580: the server's delegation summary in words, one part per count. Counts the server could not read are never
    /// shown as zero, and a completion awaiting delivery is neither a failure nor delivered.
    static func deliverySummary(_ status: DelegationStatus) -> [String] {
        switch status.availability {
        case .unsupported:
            return [String(localized: "This chat’s owner doesn’t report delivery status")]
        case .unknown, .unrecognized:
            return [String(localized: "Delivery status unavailable")]
        case .available:
            break
        }
        guard let running = status.runningCount, let awaiting = status.awaitingDeliveryCount else {
            return [String(localized: "Delivery status unavailable")]
        }
        var parts: [String] = []
        if running > 0 {
            parts.append(String(localized: "\(running) running"))
        } else if status.memoryLive == true {
            // A dispatch the Agent holds before its ledger row exists is running, though not counted yet.
            parts.append(statusLabel(.running))
        }
        if awaiting > 0 {
            parts.append(String(localized: "\(awaiting) awaiting delivery"))
        }
        return parts.isEmpty ? [String(localized: "Nothing running or awaiting delivery")] : parts
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

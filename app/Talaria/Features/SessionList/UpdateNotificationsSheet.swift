import Foundation
import Observation
import SwiftUI
import TalariaKit

extension View {
    /// Attach to the current modal host so an update can open over Settings without dismissing it.
    func updatingPresentation(
        _ updates: UpdateNotificationCenterViewModel, isEnabled: Bool = true, onAPIError: @escaping (Error) -> Void
    ) -> some View {
        modifier(UpdatingPresentation(updates: updates, isEnabled: isEnabled, onAPIError: onAPIError))
    }
}

private struct UpdatingPresentation: ViewModifier {
    let updates: UpdateNotificationCenterViewModel
    let isEnabled: Bool
    let onAPIError: (Error) -> Void

    func body(content: Content) -> some View {
        let showsUpdate = updates.updating != nil || updates.updateTimedOut
        return content.sheet(isPresented: Binding {
            isEnabled && showsUpdate
        } set: { presented in
            if !presented, isEnabled { updates.closeUpdating() }
        }) {
            UpdatingSheet(updates: updates, onAPIError: onAPIError)
        }
    }
}

struct UpdatingSheet: View {
    let updates: UpdateNotificationCenterViewModel
    let onAPIError: (Error) -> Void
    @State private var retainedContent: SheetContent?

    private enum SheetContent: Equatable {
        case record(UpdateNotificationRecord)
        case unverified
    }

    private var currentContent: SheetContent? {
        if let record = updates.updating { return .record(record) }
        return updates.updateTimedOut ? .unverified : nil
    }

    var body: some View {
        let content = currentContent ?? retainedContent
        let record: UpdateNotificationRecord? = if case let .record(value) = content { value } else { nil }
        NavigationStack {
            List {
                if let record {
                    ForEach(record.steps ?? []) { step in
                        let appearance = appearance(for: step.state)
                        VStack(alignment: .leading, spacing: 4) {
                            Label(step.label, systemImage: appearance.symbol)
                                .foregroundStyle(appearance.color)
                                .accessibilityValue(appearance.status)
                                .accessibilityIdentifier("updating-step-\(step.id)")
                            if step.state == "failed" {
                                Text(record.detail ?? record.message)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    if record.steps?.isEmpty != false { Text(record.detail ?? record.message) }
                    if let error = updates.updateActionError {
                        Label(error, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                    }
                    ForEach(record.actions) { action in
                        UpdateNotificationActionButton(action: action, isPerforming: updates.isPerforming(action, for: record), fillsRow: true) {
                            Task {
                                await updates.perform(action, for: record)
                                if let error = updates.lastError { onAPIError(error) }
                            }
                        }
                    }
                    if record.closeBehavior == .restartLater {
                        Button("Restart later") { updates.closeUpdating() }
                    }
                } else if content == .unverified {
                    Text("Couldn't verify that the update finished. Check the server and its update notifications.")
                }
            }
            .listStyle(.plain)
            .navigationTitle("Updating")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if record?.closeBehavior == .close || content == .unverified {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Close", systemImage: "xmark") { updates.closeUpdating() }
                            .labelStyle(.iconOnly)
                            .help("Close")
                    }
                }
            }
        }
        .presentationDetents([.large])
        .adaptiveFormPresentation()
        .interactiveDismissDisabled(record?.presentsDialog == true || (record != nil && record?.closeBehavior != .close))
        .onChange(of: currentContent, initial: true) { _, content in
            // SwiftUI draws the sheet while it dismisses, after the center has cleared the record.
            if let content { retainedContent = content }
        }
        .task(id: record?.closeBehavior == .auto ? record?.id : nil) {
            guard record?.closeBehavior == .auto else { return }
            do { try await Task.sleep(for: .milliseconds(2_500)) } catch { return }
            updates.closeUpdating()
        }
    }

    private func appearance(for state: String) -> (symbol: String, color: Color, status: LocalizedStringKey) {
        switch state {
        case "done": ("checkmark.circle.fill", .primary, "Complete")
        case "active": ("arrow.triangle.2.circlepath", .primary, "Running")
        case "failed": ("exclamationmark.circle.fill", .red, "Failed")
        case "pending": ("circle", .secondary, "Queued")
        default: ("circle", .secondary, "Unknown")
        }
    }
}

struct UpdateNotificationsSheet: View {
    @Bindable var viewModel: UpdateNotificationCenterViewModel
    let onAPIError: (Error) -> Void
    let openDestination: (UpdateNotificationDestination) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if viewModel.isLoading && viewModel.notifications.isEmpty {
                    ProgressView("Loading updates…")
                } else if let errorMessage = viewModel.errorMessage, viewModel.notifications.isEmpty {
                    ContentUnavailableView {
                        Label("Updates Unavailable", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(errorMessage)
                    } actions: {
                        Button("Try Again") { Task { await viewModel.load(); handleError() } }
                    }
                } else if viewModel.notifications.isEmpty {
                    ContentUnavailableView(
                        "No Notifications Yet",
                        systemImage: "bell",
                        description: Text("Recent activity and alerts from this server will appear here.")
                    )
                } else {
                    List {
                        if let errorMessage = viewModel.errorMessage {
                            HStack(alignment: .top, spacing: 10) {
                                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                                    .font(.footnote)
                                    .foregroundStyle(.red)
                                Spacer(minLength: 8)
                                Button("Try Again") {
                                    Task { await viewModel.refresh(); handleError() }
                                }
                                .font(.footnote.weight(.semibold))
                            }
                            .accessibilityElement(children: .contain)
                        }
                        ForEach(viewModel.notifications) { notification in
                            UpdateNotificationRow(
                                notification: notification,
                                isPerforming: { viewModel.isPerforming($0, for: notification) },
                                perform: { action in
                                    Task { await viewModel.perform(action, for: notification); handleError() }
                                },
                                openDestination: { destination in
                                    Task {
                                        await viewModel.markRead(notification)
                                        handleError()
                                        openDestination(destination)
                                    }
                                }
                            )
                                .swipeActions(edge: .trailing, allowsFullSwipe: notification.canDismiss) {
                                    if notification.canDismiss {
                                        Button(role: .destructive) {
                                            Task { await viewModel.dismiss(notification); handleError() }
                                        } label: {
                                            Label("Dismiss", systemImage: "trash")
                                        }
                                    }
                                }
                        }
                    }
                    .listStyle(.plain)
                    .refreshable { await viewModel.refresh(); handleError() }
                }
            }
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Clear All") {
                        Task { await viewModel.clearAll(); handleError() }
                    }
                    .disabled(!viewModel.canClear || viewModel.isClearing)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task {
            await viewModel.load()
            handleError()
            guard viewModel.supportsNotifications else { dismiss(); return }
            await viewModel.markAllRead()
            handleError()
        }
    }

    private func handleError() {
        if let error = viewModel.lastError { onAPIError(error) }
    }
}

private struct UpdateNotificationRow: View {
    let notification: UpdateNotificationRecord
    let isPerforming: (UpdateNotificationAction) -> Bool
    let perform: (UpdateNotificationAction) -> Void
    let openDestination: (UpdateNotificationDestination) -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(tint)
                .symbolEffect(.pulse, options: .repeating, isActive: isActive)
                .frame(width: 28, height: 28)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(notification.title)
                        .font(.subheadline.weight(.semibold))
                    if notification.unread {
                        Circle()
                            .fill(Color.accentColor)
                            .frame(width: 7, height: 7)
                            .accessibilityLabel("Unread")
                    }
                }
                Text(notification.message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = notification.detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                ForEach(notification.actions) { action in
                    UpdateNotificationActionButton(action: action, isPerforming: isPerforming(action)) { perform(action) }
                }
                if let destination = notification.destination, destination.key == "settings.system" {
                    Button(destination.label) { openDestination(destination) }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
                if let date = Self.timestamp(from: notification.updatedAt) {
                    Text(date, format: .dateTime.month(.abbreviated).day().hour().minute())
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(.vertical, 4)
        .listRowBackground(notification.requiresInteraction ? Color.red.opacity(0.08) : nil)
        .accessibilityElement(children: .contain)
    }

    private var isActive: Bool {
        notification.active
    }

    private var symbol: String {
        if notification.severity == "critical" { return "exclamationmark.triangle.fill" }
        return switch notification.phase {
        case "succeeded": "checkmark.circle.fill"
        case "blocked", "awaiting_confirmation": "clock.badge.exclamationmark"
        case "failed", "unknown": "exclamationmark.triangle.fill"
        default: "arrow.triangle.2.circlepath"
        }
    }

    private var tint: Color {
        if notification.severity == "critical" { return .red }
        return switch notification.phase {
        case "succeeded": .green
        case "blocked", "awaiting_confirmation": .orange
        case "failed", "unknown": .red
        default: .accentColor
        }
    }

    private static func timestamp(from value: String) -> Date? {
        UpdateNotificationTimestamp.date(from: value)
    }

}

private struct UpdateNotificationActionButton: View {
    let action: UpdateNotificationAction
    let isPerforming: Bool
    var fillsRow = false
    let perform: () -> Void

    var body: some View {
        Group {
            if fillsRow {
                Button(role: role, action: perform) {
                    Text(action.label)
                        .foregroundStyle(action.style == "destructive" ? .red : Color.accentColor)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            } else if action.style == "primary" {
                Button(action.label, action: perform)
                    .buttonStyle(.borderedProminent)
            } else {
                Button(action.label, role: role, action: perform)
                    .buttonStyle(.bordered)
            }
        }
        .controlSize(.small)
        .disabled(isPerforming)
    }

    private var role: ButtonRole? { action.style == "destructive" ? .destructive : nil }
}

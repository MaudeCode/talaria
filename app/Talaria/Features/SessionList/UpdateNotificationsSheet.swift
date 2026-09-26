import Foundation
import Observation
import SwiftUI

struct UpdateNotificationsPresentation: View {
    @Bindable var viewModel: UpdateNotificationCenterViewModel
    let onAPIError: (Error) -> Void
    let openDestination: (UpdateNotificationDestination) -> Void

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .bottom) {
                Color.black.opacity(0.22)
                    .ignoresSafeArea()

                UpdateNotificationsSheet(
                    viewModel: viewModel,
                    onAPIError: onAPIError,
                    openDestination: openDestination
                )
                .frame(height: proxy.size.height * 0.9)
                .background(Color(.systemBackground))
                .clipShape(
                    UnevenRoundedRectangle(
                        topLeadingRadius: 32,
                        bottomLeadingRadius: 0,
                        bottomTrailingRadius: 0,
                        topTrailingRadius: 32,
                        style: .continuous
                    )
                )
                .overlay(alignment: .top) {
                    Capsule()
                        .fill(.secondary.opacity(0.45))
                        .frame(width: 38, height: 5)
                        .padding(.top, 8)
                        .accessibilityHidden(true)
                }
                .ignoresSafeArea(edges: .bottom)
            }
        }
        .presentationBackground(.clear)
    }
}

@MainActor
@Observable
final class UpdateNotificationCenterViewModel {
    private(set) var notifications: [UpdateNotificationRecord] = []
    private(set) var unreadCount = 0
    private(set) var clearableCount = 0
    private(set) var canClear = false
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var lastError: Error?
    private(set) var performingActionIDs: Set<String> = []
    private(set) var isClearing = false

    private let client: APIClient

    init(server: URL, client: APIClient? = nil) {
        self.client = client ?? APIClient(baseURL: server)
    }

    func refresh() async {
        do {
            let response = try await client.updateNotifications()
            apply(response)
            errorMessage = nil
            lastError = nil
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    func load() async {
        isLoading = true
        await refresh()
        isLoading = false
    }

    func markAllRead() async {
        let unread = notifications.filter(\.unread)
        do {
            for notification in unread {
                _ = try await client.readUpdateNotification(id: notification.id)
            }
            if !unread.isEmpty { await refresh() }
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    func markRead(_ notification: UpdateNotificationRecord) async {
        guard notification.unread else { return }
        do {
            _ = try await client.readUpdateNotification(id: notification.id)
            await refresh()
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    func dismiss(_ notification: UpdateNotificationRecord) async {
        do {
            _ = try await client.dismissUpdateNotification(id: notification.id)
            await refresh()
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    func perform(_ action: UpdateNotificationAction, for notification: UpdateNotificationRecord) async {
        let actionKey = "\(notification.id):\(action.id)"
        guard !performingActionIDs.contains(actionKey) else { return }
        performingActionIDs.insert(actionKey)
        defer { performingActionIDs.remove(actionKey) }
        do {
            let updated = try await client.performUpdateNotificationAction(id: notification.id, actionID: action.id)
            if let index = notifications.firstIndex(where: { $0.id == updated.id }) {
                notifications[index] = updated
            }
            await refresh()
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    func isPerforming(_ action: UpdateNotificationAction, for notification: UpdateNotificationRecord) -> Bool {
        performingActionIDs.contains("\(notification.id):\(action.id)")
    }

    func clearAll() async {
        guard canClear, !isClearing else { return }
        isClearing = true
        defer { isClearing = false }
        do {
            apply(try await client.clearUpdateNotifications())
            errorMessage = nil
            lastError = nil
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    private func apply(_ response: UpdateNotificationsResponse) {
        notifications = response.notifications
        unreadCount = response.unreadCount
        clearableCount = response.clearableCount
        canClear = response.canClear
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
                ForEach(notification.actions) { action in
                    if action.style == "primary" {
                        Button { perform(action) } label: {
                            actionLabel(action)
                        }
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                            .disabled(isPerforming(action))
                    } else if action.style == "destructive" {
                        Button(role: .destructive) { perform(action) } label: {
                            actionLabel(action)
                        }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(isPerforming(action))
                    } else {
                        Button { perform(action) } label: {
                            actionLabel(action)
                        }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(isPerforming(action))
                    }
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

    @ViewBuilder
    private func actionLabel(_ action: UpdateNotificationAction) -> some View {
        Text(action.label)
    }
}

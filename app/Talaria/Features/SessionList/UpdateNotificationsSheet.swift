import Foundation
import Observation
import SwiftUI
import TalariaKit

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

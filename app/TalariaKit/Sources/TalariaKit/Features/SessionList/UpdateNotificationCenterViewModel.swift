import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
public final class UpdateNotificationCenterViewModel {
    public private(set) var notifications: [UpdateNotificationRecord] = []
    public private(set) var unreadCount = 0
    private(set) var clearableCount = 0
    public private(set) var canClear = false
    public private(set) var isLoading = false
    public private(set) var errorMessage: String?
    public private(set) var lastError: Error?
    private(set) var performingActionIDs: Set<String> = []
    public private(set) var isClearing = false
    public private(set) var supportsNotifications = true

    private let client: APIClient

    public init(server: URL, client: APIClient? = nil) {
        self.client = client ?? APIClient(baseURL: server)
    }

    @discardableResult
    public func refresh() async -> Bool {
        guard supportsNotifications else { return false }
        do {
            let response = try await client.updateNotifications()
            apply(response)
            errorMessage = nil
            lastError = nil
            return true
        } catch {
            if Self.isMissingCapability(error) {
                supportsNotifications = false
                notifications = []
                unreadCount = 0
                clearableCount = 0
                canClear = false
                errorMessage = nil
                lastError = nil
                return false
            }
            guard !APIError.isCancellation(error) else { return false }
            errorMessage = error.localizedDescription
            lastError = error
            return true
        }
    }

    public func load() async {
        isLoading = true
        await refresh()
        isLoading = false
    }

    public func markAllRead() async {
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

    public func markRead(_ notification: UpdateNotificationRecord) async {
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

    public func dismiss(_ notification: UpdateNotificationRecord) async {
        do {
            _ = try await client.dismissUpdateNotification(id: notification.id)
            await refresh()
        } catch {
            guard !APIError.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
            lastError = error
        }
    }

    public func perform(_ action: UpdateNotificationAction, for notification: UpdateNotificationRecord) async {
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

    public func isPerforming(_ action: UpdateNotificationAction, for notification: UpdateNotificationRecord) -> Bool {
        performingActionIDs.contains("\(notification.id):\(action.id)")
    }

    public func clearAll() async {
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

    private static func isMissingCapability(_ error: Error) -> Bool {
        guard case let APIError.http(statusCode, _) = error else { return false }
        return statusCode == 404 || statusCode == 405
    }
}

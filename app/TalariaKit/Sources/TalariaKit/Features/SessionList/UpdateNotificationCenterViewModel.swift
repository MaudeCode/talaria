import Foundation
import Observation
import SwiftUI

@MainActor
@Observable
public final class UpdateNotificationCenterViewModel {
    private static let updateTrackingTimeout: Duration = .seconds(600)
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
    public private(set) var updating: UpdateNotificationRecord?
    public private(set) var updateTimedOut = false
    public private(set) var completedUpdateID: String?
    public private(set) var updateActionError: String?

    private let client: APIClient
    private var trackedUpdate: TrackedUpdate?
    private var readGeneration = 0
    private var scopeID: String?
    private let now: () -> ContinuousClock.Instant

    private struct TrackedUpdate {
        let tabID = UUID().uuidString
        var deadline: ContinuousClock.Instant
        var notificationID: String?
        var requestSettled = false
    }

    public convenience init(server: URL, client: APIClient? = nil) {
        self.init(server: server, client: client, now: { .now })
    }

    init(server: URL, client: APIClient?, now: @escaping () -> ContinuousClock.Instant) {
        self.client = client ?? APIClient(baseURL: server)
        self.now = now
    }

    public var isFollowingUpdate: Bool {
        trackedUpdate != nil || updating?.presentsDialog == true
    }

    public var needsFastPolling: Bool {
        isFollowingUpdate || notifications.contains(where: \.active)
    }

    func beginUpdate() -> String {
        let update = TrackedUpdate(deadline: now().advanced(by: Self.updateTrackingTimeout))
        trackedUpdate = update
        updateTimedOut = false
        return update.tabID
    }

    func followUpdate(tabID: String, notificationID: String?) async {
        guard trackedUpdate?.tabID == tabID else { return }
        if let notificationID { trackedUpdate?.notificationID = notificationID }
        trackedUpdate?.requestSettled = true
        await refresh()
    }

    func stopTracking(tabID: String) {
        guard let trackedUpdate, trackedUpdate.tabID == tabID else { return }
        readGeneration += 1
        if updating?.id == trackedUpdate.notificationID { updating = nil }
        self.trackedUpdate = nil
    }

    public func closeUpdating() {
        guard let updating, updating.presentsDialog != true, updating.closeBehavior != .none else {
            if updating == nil { updateTimedOut = false }
            return
        }
        if updating.closeBehavior == .auto { completedUpdateID = updating.id }
        if trackedUpdate?.notificationID == updating.id { trackedUpdate = nil }
        self.updating = nil
        updateActionError = nil
    }

    public func resetProfile() {
        readGeneration += 1
        scopeID = nil
        notifications = []
        unreadCount = 0
        clearableCount = 0
        canClear = false
        trackedUpdate = nil
        updating = nil
        updateTimedOut = false
        updateActionError = nil
        completedUpdateID = nil
        errorMessage = nil
        lastError = nil
    }

    @discardableResult
    public func refresh() async -> Bool {
        guard supportsNotifications else { expireTracking(unsupported: true); return false }
        readGeneration += 1
        let generation = readGeneration
        let profile = ActiveServerProfile.switchCount(for: client.baseURL)
        let tabID = trackedUpdate?.tabID
        defer { if generation == readGeneration { expireTracking() } }
        do {
            let response = try await client.updateNotifications(tabID: tabID)
            guard generation == readGeneration, profile == ActiveServerProfile.switchCount(for: client.baseURL), !Task.isCancelled else { return true }
            apply(response)
            errorMessage = nil
            lastError = nil
            return true
        } catch {
            guard generation == readGeneration, profile == ActiveServerProfile.switchCount(for: client.baseURL) else { return true }
            if Self.isMissingCapability(error) {
                supportsNotifications = false
                notifications = []
                unreadCount = 0
                clearableCount = 0
                canClear = false
                errorMessage = nil
                lastError = nil
                expireTracking(unsupported: true)
                return false
            }
            guard !APIError.isCancellation(error) else { return false }
            errorMessage = error.localizedDescription
            lastError = error
            return true
        }
    }

    /// Refreshes once, then every `interval` until cancelled or the server lacks notifications. Foregrounding restarts
    /// this and `sessions_changed` refreshes too (TAL-1239), so the timer only covers a missed event.
    public func refreshWhileActive(
        interval: Duration = .seconds(60),
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        onRefresh: () -> Void
    ) async {
        while !Task.isCancelled {
            let continuePolling = await refresh()
            onRefresh()
            guard continuePolling else { return }
            do { try await sleep(needsFastPolling ? .seconds(2) : interval) } catch { return }
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
        let profile = ActiveServerProfile.switchCount(for: client.baseURL)
        let generation = readGeneration
        updateActionError = nil
        defer { performingActionIDs.remove(actionKey) }
        do {
            let updated = try await client.performUpdateNotificationAction(id: notification.id, actionID: action.id)
            guard profile == ActiveServerProfile.switchCount(for: client.baseURL) else { return }
            if generation == readGeneration {
                if let index = notifications.firstIndex(where: { $0.id == updated.id }) {
                    notifications[index] = updated
                }
                if updating?.id == updated.id { updating = updated }
            }
            await refresh()
        } catch {
            guard profile == ActiveServerProfile.switchCount(for: client.baseURL), !APIError.isCancellation(error) else { return }
            if !APIError.isDefinitiveWriteFailure(error) { await refresh() }
            guard profile == ActiveServerProfile.switchCount(for: client.baseURL) else { return }
            errorMessage = error.localizedDescription
            lastError = error
            if updating?.id == notification.id, updating?.actions.contains(where: { $0.id == action.id }) == true {
                updateActionError = error.localizedDescription
            }
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
        if let scopeID, scopeID != response.scopeId { resetProfile() }
        scopeID = response.scopeId
        notifications = response.notifications
        unreadCount = response.unreadCount
        clearableCount = response.clearableCount
        canClear = response.canClear

        let knownID = trackedUpdate?.notificationID
        let tracked = response.tabUpdate ?? notifications.first { $0.id == knownID }
        if let tracked, trackedUpdate != nil {
            trackedUpdate?.notificationID = tracked.id
        }
        if let tracked, trackedUpdate?.requestSettled == true {
            updating = tracked
            switch tracked.closeBehavior {
            case .auto, .close:
                trackedUpdate = nil
            case .none, .restartLater:
                // The server still knows where the update is. Only a loss of that evidence can time out.
                trackedUpdate?.deadline = now().advanced(by: Self.updateTrackingTimeout)
            }
        } else if let current = updating,
                  let fresh = notifications.first(where: { $0.id == current.id }) ?? (tracked?.id == current.id ? tracked : nil) {
            updating = fresh
        } else if let presenting = notifications.first(where: { $0.presentsDialog == true }) {
            updating = presenting
        }
        if updating != nil { updateTimedOut = false }
    }

    private func expireTracking(unsupported: Bool = false) {
        guard let trackedUpdate, trackedUpdate.requestSettled, unsupported || now() >= trackedUpdate.deadline else { return }
        self.trackedUpdate = nil
        updating = nil
        updateTimedOut = true
    }

    private static func isMissingCapability(_ error: Error) -> Bool {
        guard case let APIError.http(statusCode, _) = error else { return false }
        return statusCode == 404 || statusCode == 405
    }
}

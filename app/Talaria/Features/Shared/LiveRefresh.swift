import SwiftUI
import TalariaKit

extension View {
    /// Mirrors `isActive` into `isVisible` through `DelayedStatusVisibility`, so a loading indicator
    /// shows only after the work has run for 400 ms and then stays at least 400 ms (TAL-436).
    func delayedStatus(_ isActive: Bool, isVisible: Binding<Bool>) -> some View {
        modifier(DelayedStatusModifier(isActive: isActive, isVisible: isVisible))
    }

    /// Keeps a server-backed screen current while it is on screen (TAL-434, TAL-435). It runs
    /// `action` when the app returns from the background, when the server announces a change that
    /// matches `trigger`, and every `interval` while the app is active. Overlapping triggers queue
    /// one follow-up instead of piling up. With `showsStatus`, a refresh that outlasts 400 ms shows
    /// "Updating…" below the navigation bar; pass `false` while the screen has no content yet or
    /// already shows its own loading indicator.
    func refreshesLive(
        on trigger: SessionsChangeTrigger? = nil,
        every interval: Duration? = nil,
        showsStatus: Bool,
        action: @escaping @MainActor () async -> Void
    ) -> some View {
        modifier(LiveRefreshModifier(trigger: trigger, interval: interval, showsStatus: showsStatus, action: action))
    }
}

private struct DelayedStatusModifier: ViewModifier {
    let isActive: Bool
    @Binding var isVisible: Bool
    @State private var status = DelayedStatusVisibility()

    func body(content: Content) -> some View {
        content
            .task(id: isActive) {
                update()
                while let deadline = status.nextDeadline {
                    try? await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow)))
                    guard !Task.isCancelled else { return }
                    update()
                }
            }
    }

    private func update() {
        status.update(isActive: isActive, now: Date())
        if isVisible != status.isVisible {
            isVisible = status.isVisible
        }
    }
}

private struct LiveRefreshModifier: ViewModifier {
    let trigger: SessionsChangeTrigger?
    let interval: Duration?
    let showsStatus: Bool
    let action: @MainActor () async -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isRefreshing = false
    @State private var isRefreshQueued = false
    @State private var showsUpdating = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if showsUpdating {
                    StatusChip(
                        label: String(localized: "Updating…"),
                        accessibilityLabel: String(localized: "Updating content"),
                        icon: .activity
                    )
                    .padding(.top, 8)
                    .allowsHitTesting(false)
                    .transition(.opacity)
                }
            }
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: showsUpdating)
            .delayedStatus(isRefreshing && showsStatus, isVisible: $showsUpdating)
            .onReceive(NotificationCenter.default.publisher(for: .talariaReturnedToForeground)) { _ in
                refresh()
            }
            .onReceive(NotificationCenter.default.publisher(for: .talariaSessionsChanged)) { notification in
                guard let trigger,
                      let change = notification.userInfo?[SessionsChange.userInfoKey] as? SessionsChange,
                      trigger.matches(change) else { return }
                refresh()
            }
            .task(id: PollID(isActive: scenePhase == .active, interval: interval)) {
                guard let interval, scenePhase == .active else { return }
                while true {
                    try? await Task.sleep(for: interval)
                    guard !Task.isCancelled else { return }
                    refresh()
                }
            }
    }

    private func refresh() {
        guard !isRefreshing else {
            isRefreshQueued = true
            return
        }
        isRefreshing = true
        Task { @MainActor in
            repeat {
                isRefreshQueued = false
                await action()
            } while isRefreshQueued
            isRefreshing = false
        }
    }

    private struct PollID: Equatable {
        let isActive: Bool
        let interval: Duration?
    }
}

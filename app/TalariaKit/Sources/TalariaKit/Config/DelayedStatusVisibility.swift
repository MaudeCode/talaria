public import Foundation

/// Debounces a transient status so it never flickers (TAL-436): the status shows only once its
/// condition has held for `showDelay`, then stays for at least `minimumVisibleDuration`.
public struct DelayedStatusVisibility: Sendable {
    public static let showDelay: TimeInterval = 0.4
    public static let minimumVisibleDuration: TimeInterval = 0.4

    public private(set) var isVisible = false
    private var activeSince: Date?
    private var visibleSince: Date?

    public init() {}

    /// Feeds the condition's current value. Call again at `nextDeadline` while it is non-nil.
    public mutating func update(isActive: Bool, now: Date) {
        if !isActive {
            activeSince = nil
        } else if activeSince == nil {
            activeSince = now
        }

        // Compare against the same deadline `nextDeadline` reports, so a caller that
        // wakes exactly at it always flips the state.
        guard let deadline = nextDeadline, now >= deadline else { return }
        isVisible.toggle()
        visibleSince = isVisible ? now : nil
    }

    /// When visibility can next change without a new condition value.
    public var nextDeadline: Date? {
        if isVisible {
            guard activeSince == nil else { return nil }
            return visibleSince?.addingTimeInterval(Self.minimumVisibleDuration)
        }
        return activeSince?.addingTimeInterval(Self.showDelay)
    }
}

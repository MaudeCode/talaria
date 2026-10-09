/// The code-block Copy button's checkmark state.
public struct CodeBlockCopyConfirmation {
    public static let displayDuration: Duration = .seconds(2)

    /// When the latest copy's checkmark expires.
    public private(set) var expiresAt: ContinuousClock.Instant?

    public init() {}

    public var isShowing: Bool { expiresAt != nil }

    public mutating func copied(at now: ContinuousClock.Instant) {
        expiresAt = now + Self.displayDuration
    }

    /// Clears the checkmark only once the latest copy's interval has passed,
    /// so a reset scheduled by an earlier copy cannot clear newer feedback.
    public mutating func expire(at now: ContinuousClock.Instant) {
        if let expiresAt, now >= expiresAt {
            self.expiresAt = nil
        }
    }

    public mutating func reset() {
        expiresAt = nil
    }
}

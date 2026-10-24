import Foundation

/// Keeps intermediate fold measurements out of layout. Callers supply a monotonic clock.
public struct DivisionRegionSettlement<Value: Equatable> {
    public static var quietPeriod: TimeInterval { 0.12 }
    public private(set) var applied: Value?
    private var candidate: Value?
    private var changedAt: TimeInterval = 0

    public init() {}

    /// The first measurement mounts immediately; subsequent measurements must settle.
    public mutating func observe(_ value: Value, at now: TimeInterval) -> Value? {
        guard candidate != value else { return nil }
        candidate = value
        changedAt = now
        guard applied == nil else { return nil }
        applied = value
        return value
    }

    public mutating func settle(at now: TimeInterval, hingeIsSettled: Bool = false) -> Value? {
        guard let candidate, candidate != applied,
              hingeIsSettled || now - changedAt >= Self.quietPeriod else { return nil }
        applied = candidate
        return candidate
    }
}

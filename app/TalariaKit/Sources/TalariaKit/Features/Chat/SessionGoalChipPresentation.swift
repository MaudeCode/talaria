import Foundation

/// TAL-833: the standing `/goal` chip above the composer, worded from the server's session `goal`. The status word and
/// the turn count lead, so a narrow chip cuts the goal text rather than its state.
public struct SessionGoalChipPresentation: Equatable {
    public let label: String
    public let symbol: String

    /// Nil when no goal runs, which hides the chip.
    public init?(goal: SessionGoal?, now: Date = Date(), calendar: Calendar = .current) {
        guard let goal else { return nil }
        var parts: [String]
        switch goal.status {
        case .active:
            parts = [String(localized: "Goal")]
            symbol = "target"
        case .paused:
            parts = [String(localized: "Goal paused")]
            symbol = "pause.circle"
        case .parked:
            parts = [String(localized: "Goal parked")]
            symbol = "hourglass"
        }
        parts.append(String(localized: "\(goal.turnsUsed)/\(goal.maxTurns) turns"))
        if goal.status == .parked, let parkedUntil = goal.parkedUntil {
            let until = Date(timeIntervalSince1970: parkedUntil)
            let time = calendar.isDate(until, inSameDayAs: now)
                ? until.formatted(date: .omitted, time: .shortened)
                : until.formatted(date: .abbreviated, time: .shortened)
            parts.append(String(localized: "until \(time)"))
        }
        if let reason = goal.reason {
            parts.append(reason)
        }
        if !goal.text.isEmpty {
            parts.append(goal.text)
        }
        label = parts.joined(separator: " · ")
    }
}

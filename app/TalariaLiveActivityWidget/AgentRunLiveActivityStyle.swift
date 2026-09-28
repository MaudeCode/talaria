import SwiftUI
import TalariaKit

enum AgentRunLiveActivityTheme {
    static let background = Color(red: 0.025, green: 0.028, blue: 0.038)
    static let primaryText = Color.white
    static let secondaryText = Color.white.opacity(0.68)
    static let stroke = Color.white.opacity(0.13)
    static let pillBackground = Color.white.opacity(0.08)
    static let railBackground = Color.white.opacity(0.14)
    static let liveDot = Color(red: 0.35, green: 0.95, blue: 0.7)
}

enum AgentRunStatusStyle {
    static func color(for status: AgentRunActivityStatus, isStale: Bool) -> Color {
        if isStale {
            return Color.white.opacity(0.52)
        }

        switch status {
        case .starting, .thinking, .responding:
            return Color(red: 1.0, green: 0.82, blue: 0.18)
        case .usingTool:
            return Color(red: 0.50, green: 0.72, blue: 1.0)
        case .searchingFiles:
            return Color(red: 0.22, green: 0.92, blue: 0.95)
        case .readingFiles:
            return Color(red: 0.58, green: 0.78, blue: 1.0)
        case .runningCommand:
            return Color(red: 0.76, green: 0.55, blue: 1.0)
        case .waitingForApproval:
            return Color(red: 1.0, green: 0.58, blue: 0.24)
        case .waitingForClarification:
            return Color(red: 1.0, green: 0.65, blue: 0.30)
        case .complete:
            return Color(red: 0.35, green: 0.95, blue: 0.55)
        case .failed:
            return Color(red: 1.0, green: 0.32, blue: 0.32)
        case .cancelled:
            return Color.white.opacity(0.56)
        }
    }

    static func symbolName(for status: AgentRunActivityStatus) -> String {
        switch status {
        case .starting:
            "sparkle"
        case .thinking:
            "brain.head.profile"
        case .usingTool:
            "wrench.and.screwdriver"
        case .searchingFiles:
            "magnifyingglass"
        case .readingFiles:
            "doc.text"
        case .runningCommand:
            "terminal"
        case .responding:
            "text.bubble"
        case .waitingForApproval:
            "checkmark.shield"
        case .waitingForClarification:
            "questionmark.bubble"
        case .complete:
            "checkmark"
        case .failed:
            "exclamationmark"
        case .cancelled:
            "xmark"
        }
    }
}

/// Wall clock the running-timer labels read instead of ticking live. Only the
/// visual reference tests set it; a live activity leaves it nil so the system
/// keeps updating the timer without a widget refresh.
extension EnvironmentValues {
    @Entry var agentRunFrozenClock: Date?
}

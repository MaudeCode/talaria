import SwiftUI

public enum ReasoningTitleRotation {
    public static func shouldRotate(isActive: Bool, reduceMotion: Bool, titleCount: Int) -> Bool {
        isActive && !reduceMotion && titleCount > 1
    }

    public static func displayedTitle(titles: [String], index: Int, isActive: Bool) -> String? {
        guard !titles.isEmpty else { return nil }
        guard isActive else { return titles.last }
        return titles[min(max(0, index), titles.count - 1)]
    }

    /// The row's words when the server sent no title: a settled row has finished thinking (TAL-2026).
    public static func fallbackTitle(isActive: Bool) -> String {
        isActive ? String(localized: "Thinking") : String(localized: "Thought")
    }

    /// What VoiceOver reads for the row: its state, then the server's last title when there is one.
    public static func accessibilityLabel(titles: [String], isActive: Bool) -> String {
        guard let title = titles.last else { return fallbackTitle(isActive: isActive) }
        return isActive ? String(localized: "Thinking, \(title)") : String(localized: "Thought, \(title)")
    }
}

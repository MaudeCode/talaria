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
}

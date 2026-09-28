import SwiftUI

public enum SourceFileNavigation {
    /// The target line within the file, or nil when there is no target or file.
    public static func clampedTargetLine(_ targetLine: Int?, lineCount: Int) -> Int? {
        guard let targetLine, lineCount > 0 else { return nil }
        return min(max(targetLine, 1), lineCount)
    }
}

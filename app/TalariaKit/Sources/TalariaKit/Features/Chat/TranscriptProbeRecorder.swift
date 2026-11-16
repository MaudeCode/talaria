import Foundation
import os

#if DEBUG
/// Counts expensive transcript work by name for the performance budgets: decode probes on media the server could not
/// type (TAL-866) and the character arrays and code masks the math formatter builds (TAL-859).
/// `ChatBodyEvaluationRecorder` counts only main-thread render work, and this work also runs on detached tasks.
public enum TranscriptProbeRecorder {
    private static let state = OSAllocatedUnfairLock(initialState: [String: Int]())

    public static var counts: [String: Int] { state.withLock { $0 } }

    public static func reset() { state.withLock { $0.removeAll() } }

    public static func record(_ probe: String) { state.withLock { $0[probe, default: 0] += 1 } }
}
#endif

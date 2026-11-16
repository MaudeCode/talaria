import Foundation
import os

#if DEBUG
/// Counts the decode probes run on media the server could not type, for the unknown-media budget (TAL-866).
/// `ChatBodyEvaluationRecorder` counts only main-thread render work, and these probes also run on detached tasks.
public enum TranscriptMediaProbeRecorder {
    private static let state = OSAllocatedUnfairLock(initialState: [String: Int]())

    public static var counts: [String: Int] { state.withLock { $0 } }

    public static func reset() { state.withLock { $0.removeAll() } }

    public static func record(_ probe: String) { state.withLock { $0[probe, default: 0] += 1 } }
}
#endif

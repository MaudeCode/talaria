import CoreGraphics
import Foundation

#if DEBUG
/// Counts chat render work for hosted tests. A non-observable reference keeps measuring a body from invalidating that
/// body's environment. Like the message-menu registry, its identity survives environment updates.
@MainActor
public final class ChatBodyEvaluationRecorder {
    /// Receives work recorded where no view environment reaches: reasoning-card derivation, streaming Markdown splits,
    /// code highlighting and settled transcript rows (TAL-851).
    public static var installed: ChatBodyEvaluationRecorder?

    public private(set) var counts: [String: Int] = [:]
    public private(set) var transcriptFrame: CGRect = .null

    public init() {}

    public func recordTranscriptFrame(_ frame: CGRect) { transcriptFrame = frame }

    public func callAsFunction(_ body: String) {
        counts[body, default: 0] += 1
    }

    public func reset() {
        counts.removeAll(keepingCapacity: true)
    }

    /// Counts `work` in the installed recorder. Only main-thread work can stall a stream tick or a keystroke.
    public nonisolated static func record(_ work: String) {
        guard Thread.isMainThread else { return }
        MainActor.assumeIsolated { installed?(work) }
    }
}
#endif

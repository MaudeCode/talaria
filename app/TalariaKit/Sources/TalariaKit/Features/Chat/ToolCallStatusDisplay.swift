import Foundation
import SwiftUI

public struct ToolCallStatusDisplay: Equatable, Sendable {
    let collapsedText: String?
    public let detailText: String
    /// `detailText` with its duration in full words, for VoiceOver.
    public let accessibilityDetailText: String
    public let progressText: String?

    public init(toolCall: ToolCall) {
        let progress = toolCall.isCompleted ? nil : toolCall.progress
        let parts = [
            progress?.percent.map { ($0 / 100).formatted(.percent.precision(.fractionLength(0))) },
            progress?.message
        ].compactMap { $0 }
        progressText = parts.isEmpty ? nil : parts.joined(separator: " · ")
        if toolCall.isError == true {
            collapsedText = String(localized: "Failed")
            detailText = String(localized: "Failed")
            accessibilityDetailText = detailText
            return
        }

        if toolCall.isCompleted {
            collapsedText = nil
            if let duration = toolCall.duration {
                detailText = String(localized: "Completed in \(ChatActiveRunStatusPresentation.elapsedText(seconds: duration, showSeconds: true))")
                accessibilityDetailText = String(localized: "Completed in \(ChatActiveRunStatusPresentation.accessibilityElapsedText(seconds: duration))")
            } else {
                detailText = String(localized: "Completed")
                accessibilityDetailText = detailText
            }
            return
        }

        collapsedText = String(localized: "Running")
        detailText = String(localized: "Running")
        accessibilityDetailText = detailText
    }

    /// TAL-2340: how long a running call has gone on as of `now`, from the server's start; nil once it ends or without one.
    public static func runningElapsed(for toolCall: ToolCall, now: Date, locale: Locale = .autoupdatingCurrent) -> String? {
        guard !toolCall.isCompleted, toolCall.isError != true, let start = toolCall.timerStart else { return nil }
        return ChatActiveRunStatusPresentation.elapsedText(seconds: max(0, (now.timeIntervalSince1970 - start).rounded(.down)), locale: locale)
    }
}

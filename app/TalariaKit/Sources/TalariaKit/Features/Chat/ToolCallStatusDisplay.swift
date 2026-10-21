import Foundation
import SwiftUI

public struct ToolCallStatusDisplay: Equatable {
    let collapsedText: String?
    public let detailText: String
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
            return
        }

        if toolCall.isCompleted {
            collapsedText = nil
            if let duration = toolCall.duration {
                detailText = "Completed in \(duration.formatted(.number.precision(.fractionLength(1))))s"
            } else {
                detailText = String(localized: "Completed")
            }
            return
        }

        collapsedText = String(localized: "Running")
        detailText = String(localized: "Running")
    }
}

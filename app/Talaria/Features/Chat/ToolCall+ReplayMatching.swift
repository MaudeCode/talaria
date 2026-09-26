import Foundation

extension ToolCall {
    func matchesStableToolID(_ stableID: String) -> Bool {
        id.nonEmptyStableToolID == stableID
    }

    func applyingCompletionPayload(_ payload: ToolStreamEvent) -> ToolCall {
        ToolCall(
            id: id.nonEmptyStableToolID == nil ? payload.stableID ?? id : id,
            name: payload.name ?? name,
            preview: payload.preview ?? preview,
            args: payload.args ?? args,
            duration: payload.duration,
            isError: payload.isError,
            isCompleted: true,
            startedAt: startedAt
        )
    }
}

extension String {
    var nonEmptyReplayMatchText: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    var nonEmptyStableToolID: String? {
        guard let stableID = nonEmptyReplayMatchText,
              !stableID.hasPrefix("live-tool-"),
              !stableID.hasPrefix("message-tool-"),
              !stableID.hasPrefix("persisted-tool-")
        else {
            return nil
        }

        return stableID
    }
}

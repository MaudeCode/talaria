import Foundation

extension ToolCall {
    func matchesStableToolID(_ stableID: String) -> Bool {
        id.nonEmptyStableToolID == stableID
    }

    func matchesReplayToolStart(_ payload: ToolStreamEvent) -> Bool {
        matchesReplayToolIdentity(payload)
    }

    func matchesReplayToolCompletion(_ payload: ToolStreamEvent) -> Bool {
        matchesReplayToolIdentity(payload)
    }

    private func matchesReplayToolIdentity(_ payload: ToolStreamEvent) -> Bool {
        if let payloadStableID = payload.stableID?.nonEmptyReplayMatchText,
           let stableID = id.nonEmptyStableToolID {
            return stableID == payloadStableID
        }

        var didCompareStableField = false

        if let payloadName = payload.name?.nonEmptyReplayMatchText {
            didCompareStableField = true
            guard name?.nonEmptyReplayMatchText == payloadName else { return false }
        }

        if let payloadArgs = payload.args {
            didCompareStableField = true
            guard args == payloadArgs else { return false }
        }

        if didCompareStableField {
            return true
        }

        guard let payloadPreview = payload.preview?.nonEmptyReplayMatchText,
              let preview = preview?.nonEmptyReplayMatchText
        else {
            return false
        }

        return preview == payloadPreview
    }

    func applyingCompletionPayload(_ payload: ToolStreamEvent) -> ToolCall {
        ToolCall(
            id: id.nonEmptyStableToolID == nil ? payload.stableID ?? id : id,
            name: payload.name ?? name,
            preview: payload.preview ?? preview,
            args: payload.args ?? args,
            kind: payload.kind ?? kind,
            target: payload.target ?? target,
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

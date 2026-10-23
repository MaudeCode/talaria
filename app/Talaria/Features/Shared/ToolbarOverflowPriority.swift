import SwiftUI
import TalariaKit

extension ToolbarContent {
    /// One gate and mapping for all toolbar sites. Horizontal bars keep their original priorities.
    @MainActor
    @ToolbarContentBuilder
    func overflowPriority(_ action: ToolbarAction) -> some ToolbarContent {
        if #available(iOS 27.1, *) {
            PrioritizedToolbarContent(content: self, action: action)
        } else {
            self
        }
    }
}

@available(iOS 27.1, *)
private struct PrioritizedToolbarContent<Content: ToolbarContent>: ToolbarContent {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    let content: Content
    let action: ToolbarAction

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if verticalEdge != nil {
            switch action.priority {
            case .high: content.visibilityPriority(.high)
            case .low: content.visibilityPriority(.low)
            case .standard: content
            }
        } else {
            content
        }
    }
}

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

extension View {
    /// Reports whether this column's bar items sit in a vertical bar (iOS 27.1), as on the iPhone Duo in landscape.
    func onToolbarVerticalEdgeChange(_ action: @escaping (Bool) -> Void) -> some View {
        background {
            if #available(iOS 27.1, *) {
                ToolbarVerticalEdgeReader(action: action)
            }
        }
    }
}

@available(iOS 27.1, *)
private struct ToolbarVerticalEdgeReader: View {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    let action: (Bool) -> Void

    var body: some View {
        Color.clear.onChange(of: verticalEdge != nil, initial: true) { action($1) }
    }
}

extension EnvironmentValues {
    /// Whether the split view's detail column shows a sidebar list's bar actions, as it does beside the iPhone Duo's
    /// vertical bar, so the list leaves them out (TAL-1528).
    @Entry var detailHostsListActions = false
}

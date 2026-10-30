import SwiftUI
import TalariaKit

extension EnvironmentValues {
    /// The navigation container's admitted axis is available before a replacement chat's first layout.
    @Entry var navigationHasVerticalToolbar: Bool? = nil
}

extension ToolbarContent {
    /// One gate and mapping for all toolbar sites. The sidebar also opts in on horizontal bars.
    @MainActor
    @ToolbarContentBuilder
    func overflowPriority(_ action: ToolbarAction, includesHorizontal: Bool = false) -> some ToolbarContent {
        if #available(iOS 27.1, *) {
            PrioritizedToolbarContent(content: self, action: action, includesHorizontal: includesHorizontal)
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
    let includesHorizontal: Bool

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if verticalEdge != nil || includesHorizontal {
            switch action.priority {
            case .highest: content.visibilityPriority(.init(higherThan: .high))
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
    /// Reports whether this column's items are in the Duo's vertical toolbar.
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
        Color.clear
            .onChange(of: verticalEdge != nil, initial: true) { action($1) }
    }
}

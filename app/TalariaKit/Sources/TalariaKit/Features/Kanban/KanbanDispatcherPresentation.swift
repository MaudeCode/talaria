import SwiftUI

public enum KanbanDispatcherPresentation {
    static func hasResult(_ state: KanbanDispatchState?) -> Bool {
        guard let state, state.result != nil else { return false }
        switch state.phase {
        case .succeeded, .outcomeUncertain:
            return true
        case .submitting, .reconciling, .refused, .failed, .boardUnavailable:
            return false
        }
    }

    static func requiresAttention(_ state: KanbanDispatchState?) -> Bool {
        state?.phase == .outcomeUncertain && state?.result == nil
    }

    public static func toolbarSystemImage(for state: KanbanDispatchState?) -> String {
        if requiresAttention(state) {
            return "exclamationmark.circle.fill"
        }
        if hasResult(state) {
            return "bolt.horizontal.circle.fill"
        }
        return "bolt.horizontal.circle"
    }

    public static func toolbarAccessibilityLabel(for state: KanbanDispatchState?) -> String {
        if requiresAttention(state) {
            return String(localized: "Dispatcher, attention required")
        }
        if hasResult(state) {
            return String(localized: "Dispatcher, result available")
        }
        return String(localized: "Dispatcher")
    }
}

import SwiftUI

public enum KanbanBoardEditorMode: Identifiable, Sendable {
    case create
    case edit(KanbanBoard)

    public var id: String {
        switch self {
        case .create: "create"
        case let .edit(board): "edit-\(board.slug ?? "")"
        }
    }
}

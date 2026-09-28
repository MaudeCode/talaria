import SwiftUI
import UIKit
import TalariaKit

enum KanbanBoardEditorMode: Identifiable {
    case create
    case edit(KanbanBoard)

    var id: String {
        switch self {
        case .create: "create"
        case let .edit(board): "edit-\(board.slug ?? "")"
        }
    }
}

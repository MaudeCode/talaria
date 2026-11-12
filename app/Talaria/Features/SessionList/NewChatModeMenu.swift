import SwiftUI
import UIKit
import TalariaKit

/// The same checked choices serve New Chat's long press and the unsent composer's menu.
@MainActor
enum NewChatModeMenu {
    static func make(modes: [ExecutionModeOption], selected: ExecutionMode, onSelect: @escaping (ExecutionMode) -> Void) -> UIMenu {
        let actions = modes.map { option in
            UIAction(title: option.mode.title, subtitle: option.reasonTitle,
                     attributes: option.available ? [] : [.disabled],
                     state: selected == option.mode ? .on : .off) { _ in
                Task { @MainActor in onSelect(option.mode) }
            }
        }
        return UIMenu(children: [UIMenu(title: String(localized: "Agent Mode"), options: [.displayInline], children: actions)])
    }
}

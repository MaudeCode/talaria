import SwiftUI
import UIKit

struct KanbanStatusPresentation {
    let rawValue: String

    init(_ rawValue: String) { self.rawValue = rawValue }

    var title: String {
        switch rawValue {
        case "triage": String(localized: "Triage")
        case "todo": String(localized: "To Do")
        case "ready": String(localized: "Ready")
        case "running": String(localized: "Running")
        case "blocked": String(localized: "Blocked")
        case "done": String(localized: "Done")
        case "archived": String(localized: "Archived")
        case "": String(localized: "Unknown Status")
        default: String(localized: "Unsupported: \(rawValue)")
        }
    }

    var color: Color {
        switch rawValue {
        case "triage": .gray
        case "todo": .blue
        case "ready": .mint
        case "running": .orange
        case "blocked": .red
        case "done": .green
        case "archived": .secondary
        default: .purple
        }
    }
}

import SwiftUI
import UIKit
import TalariaKit

struct KanbanBoardStatusLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
            configuration.title
        }
        .accessibilityElement(children: .combine)
    }
}






enum KanbanCardAccessibility {
    static func summary(_ card: KanbanCard) -> String {
        var parts = [
            card.cardID ?? String(localized: "Unknown Card"),
            card.title ?? String(localized: "Untitled Card"),
            KanbanStatusPresentation(card.status?.rawValue ?? "").title,
            card.assignee ?? String(localized: "Unassigned")
        ]
        if let tenant = card.tenant { parts.append(tenant) }
        if let comments = card.commentCount { parts.append(KanbanCountFormatter.comments(comments)) }
        let prerequisites = card.linkCounts?.parents ?? 0
        let dependents = card.linkCounts?.children ?? 0
        if prerequisites > 0 { parts.append(KanbanCountFormatter.prerequisites(prerequisites)) }
        if dependents > 0 { parts.append(KanbanCountFormatter.dependents(dependents)) }
        if let age = card.ageSeconds { parts.append(String(localized: "Age \(KanbanAgeFormatter.full(age))")) }
        return parts.joined(separator: ", ")
    }
}

enum KanbanBoardAccessibility {
    static func browseLabel(_ board: KanbanBoard) -> String {
        let boardName = board.name ?? board.slug ?? String(localized: "Board")
        return String.localizedStringWithFormat(String(localized: "Browse Board: %@"), boardName)
    }

    static func actionsLabel(_ board: KanbanBoard) -> String {
        let boardName = board.name ?? board.slug ?? String(localized: "Board")
        return String.localizedStringWithFormat(String(localized: "Board actions for %@"), boardName)
    }

    static func browseSummary(_ board: KanbanBoard, isActive: Bool) -> String {
        var parts = [browseLabel(board)]
        if let description = board.description?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !description.isEmpty {
            parts.append(description)
        }
        parts.append(KanbanCountFormatter.cards(board.total ?? 0))
        let status = statusValue(isBrowsing: false, isActive: isActive)
        if !status.isEmpty { parts.append(status) }
        return parts.joined(separator: ", ")
    }

    static func statusValue(isBrowsing: Bool, isActive: Bool) -> String {
        var statuses: [String] = []
        if isBrowsing { statuses.append(String(localized: "Browsing")) }
        if isActive { statuses.append(String(localized: "Active")) }
        return statuses.joined(separator: ", ")
    }
}

enum KanbanBoardRowAction: Equatable {
    case edit
    case makeActive
    case archive

    var systemImage: String {
        switch self {
        case .edit: "pencil"
        case .makeActive: "checkmark.circle"
        case .archive: "archivebox"
        }
    }
}

struct KanbanBoardRowPresentation: Equatable {
    let browseSlug: String?
    let actions: [KanbanBoardRowAction]
    let mutationsAreEnabled: Bool
    let isBrowsing: Bool
    let isActive: Bool

    init(
        board: KanbanBoard,
        selectedBoardSlug: String?,
        sharedActiveBoardSlug: String?,
        canManageBoards: Bool
    ) {
        let trimmedSlug = board.slug?.trimmingCharacters(in: .whitespacesAndNewlines)
        let slug = trimmedSlug?.isEmpty == false ? trimmedSlug : nil
        isBrowsing = slug != nil && slug == selectedBoardSlug
        isActive = slug != nil && slug == sharedActiveBoardSlug
        browseSlug = isBrowsing ? nil : slug
        mutationsAreEnabled = canManageBoards && slug != nil

        guard let slug else {
            actions = []
            return
        }
        var applicableActions: [KanbanBoardRowAction] = [.edit]
        if slug != sharedActiveBoardSlug {
            applicableActions.append(.makeActive)
        }
        if slug != "default" {
            applicableActions.append(.archive)
        }
        actions = applicableActions
    }
}

enum KanbanBulkAccessibility {
    static func selectionLabel(_ card: KanbanCard, isSelected: Bool) -> String {
        var parts = [KanbanCardAccessibility.summary(card)]
        if isSelected { parts.append(String(localized: "Selected")) }
        return parts.joined(separator: ", ")
    }

    static func resultLabel(_ summary: KanbanBulkActionSummary) -> String {
        [
            "\(summary.succeededCount) \(String(localized: "Complete"))",
            "\(summary.failedCount) \(String(localized: "Failed"))",
            "\(summary.uncertainCount) \(String(localized: "Outcome Uncertain"))"
        ].joined(separator: ", ")
    }
}

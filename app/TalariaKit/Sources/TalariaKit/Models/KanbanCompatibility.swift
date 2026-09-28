import Foundation

public enum KanbanStaleness: Equatable, Sendable {
    case none
    case warning
    case critical
}

/// Retains an unknown server Status rather than turning it into a decoding
/// failure. Future mutation slices can use `isSupported` to keep it read-only.
public struct KanbanStatus: Equatable, Hashable, Sendable {
    public let rawValue: String

    init(rawValue: String) {
        self.rawValue = rawValue
    }

    public var isSupported: Bool {
        ["triage", "todo", "blocked", "ready", "running", "done", "archived"].contains(rawValue.lowercased())
    }
}

public struct KanbanCompatibilityReport: Equatable, Sendable {
    let board: KanbanBoard
    let warnings: [KanbanCompatibilityWarning]

    public var isPartial: Bool { !warnings.isEmpty }
}

enum KanbanCompatibilityWarning: Equatable, Sendable {
    case readOnly
    case writeCapabilityUnavailable
    case unsupportedStatus(String)
}

public enum KanbanContractViolation: Error, Equatable, LocalizedError, Sendable {
    case missingConfigurationColumns
    case missingCurrentBoard
    case missingBoardIdentity
    case missingBoardSnapshot
    case missingColumnStatus
    case missingCardIdentity
    case missingCardStatus

    public var errorDescription: String? {
        String(localized: "This server's Kanban response is incompatible with Talaria.")
    }
}

public enum KanbanResponseError: Error, Equatable, LocalizedError, Sendable {
    case nonJSONContentType

    public var errorDescription: String? {
        String(localized: "This server's Kanban response is incompatible with Talaria.")
    }
}

public enum KanbanCompatibilityValidator {
    public static func validate(
        configuration: KanbanConfiguration,
        boardsResponse: KanbanBoardsResponse,
        snapshot: KanbanBoardSnapshot
    ) throws -> KanbanCompatibilityReport {
        let currentBoardSlug = try nonEmpty(boardsResponse.current, missing: .missingCurrentBoard)
        return try validate(
            configuration: configuration,
            boardsResponse: boardsResponse,
            boardSlug: currentBoardSlug,
            snapshot: snapshot
        )
    }

    public static func validate(
        configuration: KanbanConfiguration,
        boardsResponse: KanbanBoardsResponse,
        boardSlug: String,
        snapshot: KanbanBoardSnapshot
    ) throws -> KanbanCompatibilityReport {
        let configuredStatuses = try nonEmptyValues(configuration.columns, missing: .missingConfigurationColumns)
        let selectedBoardSlug = try nonEmpty(boardSlug, missing: .missingBoardIdentity)
        let boards = boardsResponse.boards ?? []
        guard let board = boards.first(where: { normalized($0.slug) == selectedBoardSlug }) else {
            throw KanbanContractViolation.missingBoardIdentity
        }
        guard snapshot.changed == true, let columns = snapshot.columns, !columns.isEmpty else {
            throw KanbanContractViolation.missingBoardSnapshot
        }

        var warnings: [KanbanCompatibilityWarning] = []
        if configuration.readOnly == true || boardsResponse.readOnly == true || snapshot.readOnly == true {
            warnings.append(.readOnly)
        }
        if configuration.readOnly == nil || boardsResponse.readOnly == nil || snapshot.readOnly == nil {
            warnings.append(.writeCapabilityUnavailable)
        }

        for column in columns {
            let status = try nonEmpty(column.name, missing: .missingColumnStatus)
            for card in column.cards ?? [] {
                _ = try nonEmpty(card.cardID, missing: .missingCardIdentity)
                let cardStatus = try nonEmpty(card.status?.rawValue, missing: .missingCardStatus)
                if !configuredStatuses.contains(cardStatus), !warnings.contains(.unsupportedStatus(cardStatus)) {
                    warnings.append(.unsupportedStatus(cardStatus))
                }
            }
            if !configuredStatuses.contains(status), !warnings.contains(.unsupportedStatus(status)) {
                warnings.append(.unsupportedStatus(status))
            }
        }

        return KanbanCompatibilityReport(board: board, warnings: warnings)
    }

    private static func nonEmptyValues(
        _ values: [String]?,
        missing: KanbanContractViolation
    ) throws -> Set<String> {
        let normalizedValues = Set((values ?? []).compactMap(normalized))
        guard !normalizedValues.isEmpty else { throw missing }
        return normalizedValues
    }

    private static func nonEmpty(_ value: String?, missing: KanbanContractViolation) throws -> String {
        guard let normalized = normalized(value) else { throw missing }
        return normalized
    }

    private static func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

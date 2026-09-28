import Foundation
import TalariaKit

enum KanbanCompatibilityState: Equatable {
    case idle
    case checking
    case compatible
    case partial
    case authenticationRequired
    case networkUnavailable
    case serverUnavailable
    case incompatibleContract
}

enum KanbanReadCapabilityWarning: Hashable, Sendable {
    case statsUnavailable
    case profileHistoryUnavailable
}

enum KanbanWriteCapability: String, CaseIterable, Hashable, Sendable {
    case createCard
    case editCard
    case comments
    case cardWorkflow
    case bulkActions
    case boardManagement

    var title: String {
        switch self {
        case .createCard: String(localized: "New Card")
        case .editCard: String(localized: "Edit Card")
        case .comments: String(localized: "Comment")
        case .cardWorkflow: String(localized: "Card Actions")
        case .bulkActions: String(localized: "Bulk Actions")
        case .boardManagement: String(localized: "Board")
        }
    }
}

enum KanbanEndpointCompatibility {
    static func isMissingCapability(_ error: Error) -> Bool {
        guard let apiError = error as? APIError,
              case let .http(statusCode, _) = apiError else { return false }
        if statusCode == 405 { return true }
        guard statusCode == 404,
              let message = apiError.serverMessage?.lowercased() else { return false }
        return message.contains("unknown kanban endpoint")
            || message.contains("kanban endpoint not found")
            || message.contains("unsupported kanban endpoint")
    }
}

enum KanbanDispatchMode: Equatable, Sendable {
    case preview
    case run
}

enum KanbanDispatchPhase: Equatable, Sendable {
    case submitting
    case reconciling
    case succeeded
    case refused
    case failed
    case outcomeUncertain
    case boardUnavailable

    var isInFlight: Bool { self == .submitting || self == .reconciling }

    var statusTitle: String.LocalizationValue {
        switch self {
        case .submitting: "Running Dispatcher..."
        case .reconciling: "Checking Result"
        case .succeeded: "Done"
        case .refused, .failed: "Failed"
        case .outcomeUncertain: "Outcome Uncertain"
        case .boardUnavailable: "Unavailable"
        }
    }
}

struct KanbanDispatchState: Equatable, Sendable {
    let mode: KanbanDispatchMode
    let boardSlug: String
    let phase: KanbanDispatchPhase
    let result: KanbanDispatchResult?
    let completedAt: Date?
    let boardActivityGeneration: Int
    let canAcknowledgeUncertainOutcome: Bool

    init(
        mode: KanbanDispatchMode,
        boardSlug: String,
        phase: KanbanDispatchPhase,
        result: KanbanDispatchResult?,
        completedAt: Date?,
        boardActivityGeneration: Int,
        canAcknowledgeUncertainOutcome: Bool = false
    ) {
        self.mode = mode
        self.boardSlug = boardSlug
        self.phase = phase
        self.result = result
        self.completedAt = completedAt
        self.boardActivityGeneration = boardActivityGeneration
        self.canAcknowledgeUncertainOutcome = canAcknowledgeUncertainOutcome
    }
}

enum KanbanDispatchAccessibility {
    static func summary(_ state: KanbanDispatchState, isStale: Bool) -> String {
        var parts = [
            state.mode == .preview
                ? String(localized: "Preview Dispatch")
                : String(localized: "Run Dispatcher"),
            String(localized: state.phase.statusTitle)
        ]
        if isStale {
            parts.append(
                String(localized: "This Preview is stale. Run Preview Dispatch again before relying on it.")
            )
        }
        if let result = state.result {
            parts.append(contentsOf: [
                metric("Spawned", result.spawned),
                metric("Promoted", result.promoted),
                metric("Reclaimed", result.reclaimed),
                metric("Skipped—No Assignee", result.skippedUnassigned),
                metric("Skipped—Unknown Profile", result.skippedNonspawnable),
                metric("Auto-blocked", result.autoBlocked),
                metric("Timed Out", result.timedOut),
                metric("Crashed", result.crashed)
            ])
        }
        switch state.phase {
        case .refused:
            parts.append(
                String(localized: "The server refused this Dispatcher request. Talaria did not retry it.")
            )
        case .outcomeUncertain:
            parts.append(
                String(localized: "Talaria refreshed the Board, but cannot prove whether workers started. Review the current Board before running Dispatcher again.")
            )
        case .boardUnavailable:
            parts.append(String(localized: "This Board no longer exists. Choose another Board."))
        case .submitting, .reconciling, .succeeded, .failed:
            break
        }
        return parts.joined(separator: ", ")
    }

    private static func metric(_ label: String.LocalizationValue, _ count: Int?) -> String {
        "\(String(localized: label)): \(count.map(String.init) ?? String(localized: "Unknown"))"
    }
}

enum KanbanDispatchCopy {
    static var runConfirmation: String {
        String.localizedStringWithFormat(
            String(localized: "This may start up to %lld workers and consume API budget."),
            KanbanDispatchRequest.maximum
        )
    }
}

enum KanbanDispatcherAvailability: Equatable, Sendable {
    case available
    case busy
    case outcomeUncertain
    case offline
    case incompatible
    case readOnly
    case refreshing
    case refreshFailed
}

enum KanbanBoardCollectionExpectation {
    case boardMutation(generation: Int)
    case dispatch(generation: Int, board: String, mode: KanbanDispatchMode)
}

enum KanbanCardMutationPhase: Equatable, Sendable {
    case updating
    case checkingResult
    case succeeded
    case failed
    case outcomeUncertain

    var isInFlight: Bool { self == .updating || self == .checkingResult }
}

enum KanbanCardMutationKind: Equatable, Sendable {
    case status(String)
    case block(String?)
    case unblock
    case addPrerequisite(String)
    case removePrerequisite(String)
    case archive(previousStatus: String)
    case undoArchive(status: String)
}

struct KanbanCardMutationState: Equatable, Sendable {
    let kind: KanbanCardMutationKind
    let phase: KanbanCardMutationPhase
}

struct KanbanArchiveUndo: Equatable, Sendable {
    let cardID: String
    let cardTitle: String
    let previousStatus: String
    let expiresAt: Date
    let card: KanbanCard
}

enum KanbanBulkActionPhase: Equatable, Sendable {
    case submitting
    case reconciling
}

enum KanbanBoardMutationKind: Equatable, Sendable {
    case create(slug: String)
    case edit(slug: String)
    case archive(slug: String)
    case makeActive(slug: String)

    var slug: String {
        switch self {
        case let .create(slug), let .edit(slug), let .archive(slug), let .makeActive(slug):
            slug
        }
    }
}

struct KanbanBoardMutationState: Equatable, Sendable {
    let kind: KanbanBoardMutationKind
    let phase: KanbanCardMutationPhase
}

struct KanbanBoardSelectionNotice: Equatable, Sendable {
    let boardName: String
}

enum KanbanBulkMemberOutcome: Equatable, Sendable {
    case succeeded
    case failed
    case outcomeUncertain
}

struct KanbanBulkMemberResult: Equatable, Sendable, Identifiable {
    let cardID: String
    let cardTitle: String
    let outcome: KanbanBulkMemberOutcome

    var id: String { cardID }
}

struct KanbanBulkActionSummary: Equatable, Sendable {
    let action: KanbanBulkAction
    let members: [KanbanBulkMemberResult]

    var succeededCount: Int { members.count { $0.outcome == .succeeded } }
    var failedCount: Int { members.count { $0.outcome == .failed } }
    var uncertainCount: Int { members.count { $0.outcome == .outcomeUncertain } }
    var failedCardIDs: Set<String> {
        Set(members.lazy.filter { $0.outcome == .failed }.map(\.cardID))
    }
    var needsAttention: [KanbanBulkMemberResult] {
        members.filter { $0.outcome != .succeeded }
    }
}

enum KanbanBulkActionsAvailability: Equatable, Sendable {
    case available
    case noSelection
    case offline
    case incompatible
    case readOnly
    case refreshing
    case boardBusy
    case invalidSelection
    case unknownStatus
}

struct KanbanPendingDependencyChange {
    let prerequisiteID: String
    let isAdding: Bool
}

struct KanbanLiveUpdateTiming: Sendable {
    let coalescingDelay: Duration
    let reconnectDelays: [Duration]
    let pollingInterval: Duration
    let failuresBeforePolling: Int

    static let production = KanbanLiveUpdateTiming(
        coalescingDelay: .milliseconds(300),
        reconnectDelays: [.seconds(1), .seconds(2), .seconds(4)],
        pollingInterval: .seconds(30),
        failuresBeforePolling: 3
    )
}

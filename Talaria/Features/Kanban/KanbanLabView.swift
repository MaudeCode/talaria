import SwiftUI
import UIKit

enum KanbanCardAction: Equatable {
    case move(String)
    case block
    case unblock
    case complete
    case archive
}

enum KanbanCardRowPrimaryAction: Equatable {
    case openDetail(String)
    case toggleSelection(String)

    static func resolve(for card: KanbanCard, isSelecting: Bool) -> Self? {
        guard let cardID = card.cardID else { return nil }
        return isSelecting ? .toggleSelection(cardID) : .openDetail(cardID)
    }

    static func focusTarget(afterDismissing cardID: String, visibleCards: [KanbanCard]) -> String? {
        visibleCards.contains { $0.cardID == cardID } ? cardID : nil
    }
}

struct KanbanPendingCardAction: Identifiable, Equatable {
    let id = UUID()
    let card: KanbanCard
    let action: KanbanCardAction

    static func == (lhs: KanbanPendingCardAction, rhs: KanbanPendingCardAction) -> Bool {
        lhs.id == rhs.id
    }
}

enum KanbanDispatcherPresentation {
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

    static func toolbarSystemImage(for state: KanbanDispatchState?) -> String {
        if requiresAttention(state) {
            return "exclamationmark.circle.fill"
        }
        if hasResult(state) {
            return "bolt.horizontal.circle.fill"
        }
        return "bolt.horizontal.circle"
    }

    static func toolbarAccessibilityLabel(for state: KanbanDispatchState?) -> String {
        if requiresAttention(state) {
            return String(localized: "Dispatcher, attention required")
        }
        if hasResult(state) {
            return String(localized: "Dispatcher, result available")
        }
        return String(localized: "Dispatcher")
    }
}

@MainActor
struct KanbanFiltersDraft {
    var profile: String?
    var tenant: String?
    var includesArchived: Bool
    var onlyMine: Bool
    var groupsByProfile: Bool

    init(model: KanbanFeatureState) {
        profile = model.selectedProfile
        tenant = model.selectedTenant
        includesArchived = model.includeArchived
        onlyMine = model.onlyMine
        groupsByProfile = model.groupByProfile
    }

    func apply(to model: KanbanFeatureState) async {
        let serverFiltersChanged = profile != model.selectedProfile
            || tenant != model.selectedTenant
            || includesArchived != model.includeArchived
            || onlyMine != model.onlyMine
        model.groupByProfile = groupsByProfile
        guard serverFiltersChanged else { return }
        await model.applyFilters(
            profile: profile,
            tenant: tenant,
            includeArchived: includesArchived,
            onlyMine: onlyMine
        )
    }
}


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


enum KanbanAgeFormatter {
    static func abbreviated(_ seconds: Double) -> String { format(seconds, style: .abbreviated) }
    static func full(_ seconds: Double) -> String { format(seconds, style: .full) }

    private static func format(_ seconds: Double, style: DateComponentsFormatter.UnitsStyle) -> String {
        let formatter = switch (style, seconds) {
        case (.abbreviated, 86_400...): abbreviatedDays
        case (.abbreviated, 3_600...): abbreviatedHours
        case (.abbreviated, _): abbreviatedMinutes
        case (.full, 86_400...): fullDays
        case (.full, 3_600...): fullHours
        default: fullMinutes
        }
        return formatter.string(from: max(0, seconds)) ?? String(localized: "Just now")
    }

    private static let abbreviatedMinutes = makeFormatter(unit: .minute, style: .abbreviated)
    private static let abbreviatedHours = makeFormatter(unit: .hour, style: .abbreviated)
    private static let abbreviatedDays = makeFormatter(unit: .day, style: .abbreviated)
    private static let fullMinutes = makeFormatter(unit: .minute, style: .full)
    private static let fullHours = makeFormatter(unit: .hour, style: .full)
    private static let fullDays = makeFormatter(unit: .day, style: .full)

    private static func makeFormatter(
        unit: NSCalendar.Unit,
        style: DateComponentsFormatter.UnitsStyle
    ) -> DateComponentsFormatter {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = unit
        formatter.maximumUnitCount = 1
        formatter.unitsStyle = style
        return formatter
    }
}

enum KanbanCountFormatter {
    static func cards(_ count: Int) -> String { localized(count, key: "%lld Cards") }
    static func comments(_ count: Int) -> String { localized(count, key: "%lld comments") }
    static func prerequisites(_ count: Int) -> String { localized(count, key: "%lld Prerequisites") }
    static func dependents(_ count: Int) -> String { localized(count, key: "%lld Dependents") }

    private static func localized(_ count: Int, key: String.LocalizationValue) -> String {
        String.localizedStringWithFormat(String(localized: key), count)
    }
}

#if DEBUG
struct KanbanLabView: View {
    @State private var scenario = KanbanLabScenario.dense
    @State private var model = KanbanLabScenario.dense.makeModel()

    var body: some View {
        KanbanStatusFocusView(model: model)
            .toolbar {
                ToolbarItem(placement: .bottomBar) {
                    Menu {
                        Picker("Scenario", selection: $scenario) {
                            ForEach(KanbanLabScenario.allCases) { scenario in
                                Text(scenario.title).tag(scenario)
                            }
                        }
                    } label: {
                        Image(systemName: "testtube.2")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel(Text("Kanban Lab Scenario"))
                    .accessibilityHint(Text("Uses local fixtures and never contacts or changes a Kanban server."))
                }
            }
            .task(id: scenario) {
                model = scenario.makeModel()
                await model.load()
                if scenario == .filteredEmpty { model.searchText = "no matching fixture" }
            }
    }
}

enum KanbanLabScenario: String, CaseIterable, Identifiable {
    case firstLoad
    case dense
    case empty
    case filteredEmpty
    case partial
    case authentication
    case network
    case serverUnavailable
    case incompatible
    case liveDelayed
    case offline
    case detailEmpty
    case detailError
    case detailTruncated

    var id: String { rawValue }

    var title: String {
        switch self {
        case .firstLoad: "First load"
        case .dense: "Dense Board"
        case .empty: "Empty Board"
        case .filteredEmpty: "Filtered empty"
        case .partial: "Partial capability"
        case .authentication: "Authentication"
        case .network: "Network"
        case .serverUnavailable: "Server unavailable"
        case .incompatible: "Incompatible"
        case .liveDelayed: "Live updates delayed"
        case .offline: "Offline snapshot"
        case .detailEmpty: "Empty Card detail"
        case .detailError: "Card detail error"
        case .detailTruncated: "Truncated worker log"
        }
    }

    @MainActor
    func makeModel() -> KanbanFeatureState {
        KanbanFeatureState(
            server: URL(string: "https://kanban-lab.invalid")!,
            client: KanbanLabClient(scenario: self),
            streamClient: KanbanLabStreamClient(fails: self == .liveDelayed || self == .offline),
            timing: KanbanLiveUpdateTiming(
                coalescingDelay: .milliseconds(10),
                reconnectDelays: [.milliseconds(10), .milliseconds(10)],
                pollingInterval: self == .offline ? .milliseconds(10) : .seconds(30),
                failuresBeforePolling: 3
            )
        )
    }
}

actor KanbanLabClient: KanbanDataClient {
    let scenario: KanbanLabScenario
    private var submittedComments: [String: [String: [String]]] = [:]
    private var storedCards: [String: [String: StoredCard]] = [:]
    private var cardIDsByIntent: [String: String] = [:]
    private var nextCardSequence = 100
    private var activeBoardSlug = "default"
    private var storedBoards: [String: StoredBoard] = [
        "default": StoredBoard(
            slug: "default", name: "Default Board", description: "Primary fixture Board",
            icon: "📋", color: "#5B8DEF", total: 8
        ),
        "release": StoredBoard(
            slug: "release", name: "Release Board", description: "Shipping fixture",
            icon: "🚀", color: "#34C759", total: 2
        )
    ]

    init(scenario: KanbanLabScenario) { self.scenario = scenario }

    func kanbanConfiguration() async throws -> KanbanConfiguration {
        if scenario == .firstLoad { try await Task.sleep(for: .seconds(2)) }
        switch scenario {
        case .authentication: throw APIError.unauthorized
        case .network: throw APIError.network(underlying: URLError(.notConnectedToInternet))
        case .serverUnavailable: throw APIError.http(statusCode: 503, body: nil)
        default:
            return decode(#"{"columns":["triage","todo","ready","running","blocked","done"],"assignees":["builder","reviewer"],"read_only":false}"#)
        }
    }

    func kanbanBoards() throws -> KanbanBoardsResponse {
        decode([
            "boards": storedBoards.values.sorted { $0.slug < $1.slug }.map(\.object),
            "current": activeBoardSlug,
            "read_only": false
        ])
    }

    func createKanbanBoard(
        _ request: KanbanCreateBoardRequest
    ) throws -> KanbanBoardMutationEnvelope {
        let board = storedBoards[request.slug] ?? StoredBoard(
            slug: request.slug,
            name: request.name,
            description: request.description,
            icon: request.icon,
            color: request.color,
            total: 0
        )
        storedBoards[request.slug] = board
        return decode([
            "board": board.object,
            "current": activeBoardSlug,
            "read_only": false
        ])
    }

    func editKanbanBoard(
        _ request: KanbanEditBoardRequest
    ) throws -> KanbanBoardMutationEnvelope {
        guard var board = storedBoards[request.slug] else {
            throw APIError.http(statusCode: 404, body: nil)
        }
        board.name = request.name
        board.description = request.description
        board.icon = request.icon
        board.color = request.color
        storedBoards[request.slug] = board
        return decode(["board": board.object, "read_only": false])
    }

    func archiveKanbanBoard(
        _ request: KanbanBoardMutationRequest
    ) throws -> KanbanBoardMutationEnvelope {
        guard request.slug != "default", storedBoards.removeValue(forKey: request.slug) != nil else {
            throw APIError.http(statusCode: 400, body: nil)
        }
        if activeBoardSlug == request.slug {
            activeBoardSlug = storedBoards["default"] != nil ? "default" : storedBoards.keys.sorted().first ?? "default"
        }
        return decode(["current": activeBoardSlug, "read_only": false])
    }

    func makeKanbanBoardActive(
        _ request: KanbanBoardMutationRequest
    ) throws -> KanbanBoardMutationEnvelope {
        guard storedBoards[request.slug] != nil else {
            throw APIError.http(statusCode: 404, body: nil)
        }
        activeBoardSlug = request.slug
        return decode(["current": activeBoardSlug, "read_only": false])
    }

    func kanbanBoard(_ request: KanbanBoardRequest) throws -> KanbanBoardSnapshot {
        if scenario == .incompatible {
            return decode(#"{"changed":true,"read_only":false,"columns":[{"name":"ready","tasks":[{"title":"Missing identity","status":"ready"}]}]}"#)
        }
        if scenario == .empty {
            return decode(#"{"changed":true,"latest_event_id":1,"read_only":false,"columns":[{"name":"triage","tasks":[]},{"name":"todo","tasks":[]},{"name":"ready","tasks":[]},{"name":"running","tasks":[]},{"name":"blocked","tasks":[]},{"name":"done","tasks":[]}],"tenants":[],"assignees":[]}"#)
        }
        if request.since != nil {
            return decode(#"{"changed":false,"latest_event_id":9,"read_only":false}"#)
        }
        return decode(snapshotObject(for: request))
    }

    func kanbanStats(board: String) throws -> KanbanStats {
        if scenario == .partial { throw APIError.http(statusCode: 404, body: nil) }
        return decode(#"{"by_status":{"triage":1,"todo":1,"ready":2,"running":1,"blocked":1,"done":1},"by_assignee":{"builder":4,"reviewer":2,"unassigned":1}}"#)
    }

    func kanbanAssignees(board: String) throws -> KanbanAssigneeHistory {
        decode(#"{"assignees":["builder","reviewer","release"]}"#)
    }

    func kanbanEvents(_ request: KanbanEventsRequest) throws -> KanbanEventsEnvelope {
        if scenario == .offline {
            throw APIError.network(underlying: URLError(.notConnectedToInternet))
        }
        return decode(#"{"events":[],"cursor":9,"latest_event_id":9,"read_only":false}"#)
    }

    func dispatchKanban(_ request: KanbanDispatchRequest) async throws -> KanbanDispatchResult {
        try await Task.sleep(for: .milliseconds(650))
        if scenario == .partial {
            throw APIError.http(statusCode: 404, body: nil)
        }
        if scenario == .offline {
            throw APIError.network(underlying: URLError(.notConnectedToInternet))
        }

        if !request.dryRun, var spawnedCard = fixtureCard(cardID: "CARD-3") {
            spawnedCard.status = "running"
            storedCards[request.board, default: [:]][spawnedCard.cardID] = spawnedCard
        }

        return decode([
            "spawned": request.dryRun
                ? [["task_id": "CARD-3", "profile": "builder"]]
                : [["task_id": "CARD-3", "worker_pid": 42_424]],
            "promoted": [],
            "reclaimed": [],
            "skipped_unassigned": [["task_id": "CARD-1"]],
            "skipped_nonspawnable": [],
            "auto_blocked": [],
            "timed_out": [],
            "crashed": []
        ])
    }

    func kanbanCardDetail(_ request: KanbanCardDetailRequest) async throws -> KanbanCardDetailEnvelope {
        if scenario == .detailError { throw APIError.http(statusCode: 503, body: nil) }
        let stored = storedCards[request.board]?[request.cardID]
        let isFixture = fixtureCard(cardID: request.cardID) != nil
        let isEmpty = scenario == .detailEmpty
        var comments: [[String: Any]] = isEmpty || !isFixture ? [] : [
            ["id": 1, "task_id": request.cardID, "author": "reviewer", "body": "Looks good from the review side.", "created_at": 1_700_000_000]
        ]
        let cardComments = submittedComments[request.board]?[request.cardID] ?? []
        comments += cardComments.enumerated().map { offset, body in
            ["id": offset + 2, "task_id": request.cardID, "author": "webui", "body": body, "created_at": 1_700_000_100 + offset]
        }
        let task: [String: Any] = stored?.object ?? [
            "id": request.cardID,
            "title": isEmpty ? "Empty history fixture" : "Implement Status Focus",
            "body": isEmpty ? "" : "This **Markdown** description stays selectable.",
            "status": "ready",
            "assignee": "builder",
            "tenant": "app",
            "priority": 1,
            "created_at": 1_699_999_000,
            "updated_at": 1_700_000_000,
            "workspace_kind": "worktree",
            "workspace_path": "/private/fixture/explicit-history-only",
            "skills": ["swiftui-patterns"],
            "max_runtime_seconds": 3600,
            "current_run_id": "run-fixture",
            "claim_lock": "claim-fixture",
            "worker_pid": 4242
        ]
        let links: [String: [String]]
        if let stored {
            links = [
                "parents": stored.prerequisiteID.map { [$0] } ?? [],
                "children": []
            ]
        } else {
            links = isEmpty ? ["parents": [], "children": []] : [
                "parents": ["CARD-1"],
                "children": ["CARD-7"]
            ]
        }
        let hasFixtureHistory = !isEmpty && isFixture
        let payload: [String: Any] = [
            "task": task,
            "comments": comments,
            "events": hasFixtureHistory ? [[
                "id": 9, "task_id": request.cardID, "kind": "status",
                "payload": ["status": "ready", "secret": "discarded"], "created_at": 1_700_000_000
            ]] : [],
            "links": links,
            "runs": hasFixtureHistory ? [[
                "id": "run-fixture", "status": "finished", "outcome": "success",
                "summary": "Validated the focused suite.", "worker": "worker-fixture",
                "started_at": 1_699_999_500, "finished_at": 1_700_000_000
            ]] : [],
            "read_only": false
        ]
        return decode(payload)
    }

    func kanbanWorkerLog(_ request: KanbanWorkerLogRequest) async throws -> KanbanWorkerLog {
        if scenario == .detailError { throw APIError.http(statusCode: 503, body: nil) }
        if scenario == .detailEmpty {
            return decode(["task_id": request.cardID, "exists": false, "size_bytes": 0, "content": "", "truncated": false])
        }
        return decode([
            "task_id": request.cardID,
            "path": "/private/fixture/not-retained",
            "exists": true,
            "size_bytes": 131_072,
            "content": "Focused tests passed.\nFull suite queued.\n",
            "truncated": scenario == .detailTruncated
        ])
    }

    func addKanbanComment(_ request: KanbanAddCommentRequest) async throws -> KanbanAddCommentResponse {
        submittedComments[request.board, default: [:]][request.cardID, default: []].append(request.body)
        let count = submittedComments[request.board]?[request.cardID]?.count ?? 0
        return decode(["ok": true, "comment_id": count + 1, "read_only": false])
    }

    func createKanbanCard(_ request: KanbanCreateCardRequest) async throws -> KanbanCardMutationEnvelope {
        let intentKey = "\(request.board)\u{1F}\(request.idempotencyKey)"
        if let cardID = cardIDsByIntent[intentKey],
           let existing = storedCards[request.board]?[cardID] {
            return mutationEnvelope(for: existing)
        }

        let cardID = "CARD-LAB-\(nextCardSequence)"
        nextCardSequence += 1
        let card = StoredCard(cardID: cardID, request: request)
        storedCards[request.board, default: [:]][cardID] = card
        cardIDsByIntent[intentKey] = cardID
        return mutationEnvelope(for: card)
    }

    func editKanbanCard(_ request: KanbanEditCardRequest) async throws -> KanbanCardMutationEnvelope {
        let existing = storedCards[request.board]?[request.cardID]
            ?? fixtureCard(cardID: request.cardID)
        guard var card = existing else {
            throw APIError.http(statusCode: 404, body: nil)
        }
        card.apply(request)
        storedCards[request.board, default: [:]][request.cardID] = card
        return mutationEnvelope(for: card)
    }

    func performKanbanBulkAction(
        _ request: KanbanBulkActionRequest
    ) async throws -> KanbanBulkActionEnvelope {
        var results: [[String: Any]] = []
        for cardID in request.cardIDs {
            if scenario == .partial, cardID == "CARD-4" {
                results.append(["id": cardID, "ok": false, "error": "fixture refusal"])
                continue
            }
            guard var card = storedCards[request.board]?[cardID] ?? fixtureCard(cardID: cardID) else {
                results.append(["id": cardID, "ok": false, "error": "not found"])
                continue
            }
            switch request.action {
            case let .changeStatus(status):
                card.status = status
            case let .assignProfile(profile):
                card.assignee = profile
            case let .setPriority(priority):
                card.priority = priority
            case .archiveCards:
                card.status = "archived"
            }
            storedCards[request.board, default: [:]][cardID] = card
            results.append(["id": cardID, "ok": true])
        }
        return decode(["results": results, "read_only": false])
    }

    private func mutationEnvelope(for card: StoredCard) -> KanbanCardMutationEnvelope {
        decode(["task": card.object, "read_only": false])
    }

    private func snapshotObject(for request: KanbanBoardRequest) -> [String: Any] {
        let data = Data(snapshotJSON(for: request).utf8)
        var snapshot = try! JSONSerialization.jsonObject(with: data) as! [String: Any]
        var columns = snapshot["columns"] as! [[String: Any]]
        let cards = storedCards[request.board].map { Array($0.values) } ?? []
        let replacedIDs = Set(cards.map(\.cardID))

        for index in columns.indices {
            let existing = columns[index]["tasks"] as? [[String: Any]] ?? []
            columns[index]["tasks"] = existing.filter {
                guard let cardID = $0["id"] as? String else { return true }
                return !replacedIDs.contains(cardID)
            }
        }

        for card in cards where card.matches(request) {
            guard let index = columns.firstIndex(where: { $0["name"] as? String == card.status }) else {
                continue
            }
            var values = columns[index]["tasks"] as? [[String: Any]] ?? []
            values.append(card.object)
            columns[index]["tasks"] = values
        }
        snapshot["columns"] = columns
        return snapshot
    }

    private func fixtureCard(cardID: String) -> StoredCard? {
        guard (1...8).contains(Int(cardID.replacingOccurrences(of: "CARD-", with: "")) ?? -1) else {
            return nil
        }
        return StoredCard(
            cardID: cardID,
            title: "Implement Status Focus",
            body: "This **Markdown** description stays selectable.",
            status: "ready",
            priority: 1,
            assignee: "builder",
            tenant: "app",
            workspaceKind: "worktree",
            workspacePath: "/private/fixture/explicit-history-only",
            skills: ["swiftui-patterns"],
            maxRuntimeSeconds: 3_600,
            prerequisiteID: "CARD-1"
        )
    }

    private func snapshotJSON(for request: KanbanBoardRequest) -> String {
        let archived = request.includeArchived
            ? #",{"name":"archived","tasks":[{"id":"CARD-8","title":"Retired experiment","status":"archived","assignee":null,"priority":0,"age_seconds":172800}]}"#
            : ""
        let unknown = scenario == .partial
            ? #",{"name":"awaiting-review","tasks":[{"id":"CARD-9","title":"Future server Status remains visible","status":"awaiting-review","assignee":"reviewer","priority":1,"age_seconds":120}]}"#
            : ""
        let all = """
        {"changed":true,"latest_event_id":9,"read_only":false,"tenants":["app","ops"],"assignees":["builder","reviewer"],"columns":[
          {"name":"triage","tasks":[{"id":"CARD-1","title":"Shape the next slice","body":"Review **requirements** and capture decisions.","status":"triage","assignee":null,"tenant":"app","priority":2,"comment_count":2,"link_counts":{"parents":0,"children":1},"age_seconds":300}]},
          {"name":"todo","tasks":[{"id":"CARD-2","title":"Prepare fixtures","body":"- Dense Board\\n- Empty Board\\n- Error state","status":"todo","assignee":"builder","tenant":"app","priority":1,"comment_count":1,"link_counts":{"parents":1,"children":0},"age_seconds":1800}]},
          {"name":"ready","tasks":[{"id":"CARD-3","title":"Implement Status Focus","body":"Keep Card identity stable through refresh.","status":"ready","assignee":"builder","tenant":"app","priority":0,"comment_count":4,"link_counts":{"parents":0,"children":2},"age_seconds":7200},{"id":"CARD-4","title":"Audit localized copy","status":"ready","assignee":"reviewer","tenant":"app","priority":2,"comment_count":0,"link_counts":{"parents":0,"children":0},"age_seconds":600}]},
          {"name":"running","tasks":[{"id":"CARD-5","title":"Run the full XCTest suite","status":"running","assignee":"builder","tenant":"ops","priority":0,"comment_count":1,"link_counts":{"parents":0,"children":0},"age_seconds":4200}]},
          {"name":"blocked","tasks":[{"id":"CARD-6","title":"Await owner validation","body":"> Required before PR publication","status":"blocked","assignee":"reviewer","tenant":"ops","priority":1,"comment_count":3,"link_counts":{"parents":1,"children":0},"age_seconds":90000}]},
          {"name":"done","tasks":[{"id":"CARD-7","title":"Verify read contracts","status":"done","assignee":"builder","tenant":"ops","priority":0,"comment_count":0,"link_counts":{"parents":0,"children":1},"age_seconds":3600}]}
          \(archived)\(unknown)
        ]}
        """
        if request.onlyMine || request.assignee == "builder" {
            return all.replacingOccurrences(of: #",{"id":"CARD-4","title":"Audit localized copy","status":"ready","assignee":"reviewer","tenant":"app","priority":2,"comment_count":0,"link_counts":{"parents":0,"children":0},"age_seconds":600}"#, with: "")
        }
        return all
    }

    private func decode<T: Decodable>(_ json: String) -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(T.self, from: Data(json.utf8))
    }

    private func decode<T: Decodable>(_ object: Any) -> T {
        let data = try! JSONSerialization.data(withJSONObject: object)
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(T.self, from: data)
    }

    private struct StoredCard: Sendable {
        let cardID: String
        var title: String
        var body: String?
        var status: String
        var priority: Int
        var assignee: String?
        var tenant: String?
        let workspaceKind: String
        let workspacePath: String?
        let skills: [String]?
        let maxRuntimeSeconds: Int?
        let prerequisiteID: String?

        init(
            cardID: String,
            title: String,
            body: String?,
            status: String,
            priority: Int,
            assignee: String?,
            tenant: String?,
            workspaceKind: String,
            workspacePath: String?,
            skills: [String]?,
            maxRuntimeSeconds: Int?,
            prerequisiteID: String?
        ) {
            self.cardID = cardID
            self.title = title
            self.body = body
            self.status = status
            self.priority = priority
            self.assignee = assignee
            self.tenant = tenant
            self.workspaceKind = workspaceKind
            self.workspacePath = workspacePath
            self.skills = skills
            self.maxRuntimeSeconds = maxRuntimeSeconds
            self.prerequisiteID = prerequisiteID
        }

        init(cardID: String, request: KanbanCreateCardRequest) {
            self.init(
                cardID: cardID,
                title: request.title,
                body: request.body,
                status: request.status,
                priority: request.priority ?? 0,
                assignee: request.assignee,
                tenant: request.tenant,
                workspaceKind: request.workspaceKind,
                workspacePath: request.workspacePath,
                skills: request.skills,
                maxRuntimeSeconds: request.maxRuntimeSeconds,
                prerequisiteID: request.prerequisiteID
            )
        }

        mutating func apply(_ request: KanbanEditCardRequest) {
            title = request.title
            body = request.body
            tenant = request.tenant
            priority = request.priority
            assignee = request.assignee
            if let status = request.status { self.status = status }
        }

        func matches(_ request: KanbanBoardRequest) -> Bool {
            if status == "archived", !request.includeArchived { return false }
            if let tenant = request.tenant, self.tenant != tenant { return false }
            if let assignee = request.assignee, self.assignee != assignee { return false }
            if request.onlyMine, assignee != "builder" { return false }
            return true
        }

        var object: [String: Any] {
            var result: [String: Any] = [
                "id": cardID,
                "title": title,
                "status": status,
                "priority": priority,
                "workspace_kind": workspaceKind,
                "comment_count": 0,
                "age_seconds": 0
            ]
            if let body { result["body"] = body }
            if let assignee { result["assignee"] = assignee }
            if let tenant { result["tenant"] = tenant }
            if let workspacePath { result["workspace_path"] = workspacePath }
            if let skills { result["skills"] = skills }
            if let maxRuntimeSeconds { result["max_runtime_seconds"] = maxRuntimeSeconds }
            return result
        }
    }

    private struct StoredBoard: Sendable {
        let slug: String
        var name: String?
        var description: String?
        var icon: String?
        var color: String?
        let total: Int

        var object: [String: Any] {
            var result: [String: Any] = [
                "slug": slug,
                "total": total,
                "counts": total == 0 ? [:] : ["ready": total],
                "read_only": false
            ]
            result["name"] = name
            result["description"] = description
            result["icon"] = icon
            result["color"] = color
            return result
        }
    }
}

@MainActor
private final class KanbanLabStreamClient: KanbanEventStreamingClient {
    private let fails: Bool
    private var callbackTask: Task<Void, Never>?

    init(fails: Bool) { self.fails = fails }

    func start(
        url: URL,
        onFrame: @escaping @MainActor (KanbanStreamFrame) -> Void,
        onFailure: @escaping @MainActor () -> Void
    ) {
        stop()
        callbackTask = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled else { return }
            if fails {
                onFailure()
            } else {
                let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
                let board = components?.queryItems?.first(where: { $0.name == "board" })?.value ?? "main"
                let cursor = Int(components?.queryItems?.first(where: { $0.name == "since" })?.value ?? "0") ?? 0
                onFrame(.hello(cursor: cursor, board: board))
            }
        }
    }

    func stop() {
        callbackTask?.cancel()
        callbackTask = nil
    }
}
#endif

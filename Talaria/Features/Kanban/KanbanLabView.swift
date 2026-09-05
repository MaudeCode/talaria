import SwiftUI

#if DEBUG
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

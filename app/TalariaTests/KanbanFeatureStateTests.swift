import XCTest
@testable import Talaria
@testable import TalariaKit

/// Gives each test its own empty defaults suite so the persisted Board choice
/// never leaks between tests or runs.
class KanbanDefaultsTestCase: XCTestCase {
    private var suiteName: String!
    private(set) var defaults: UserDefaults!

    override func setUp() {
        super.setUp()
        suiteName = "\(type(of: self))-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }
}

@MainActor
final class KanbanFeatureStateTests: KanbanDefaultsTestCase {
}

func waitUntil(
    timeout: Duration = .seconds(1),
    condition: @escaping @Sendable () async -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
        if await condition() { return }
        await Task.yield()
    }
    XCTFail("Condition was not met before timeout")
}

private enum KanbanEventsNotStubbed: Error { case unexpectedCall }

extension KanbanDataClient {
    func kanbanEvents(_ request: KanbanEventsRequest) async throws -> KanbanEventsEnvelope {
        throw KanbanEventsNotStubbed.unexpectedCall
    }
}

actor KanbanClientStub: KanbanDataClient {
    enum Call: Equatable {
        case configuration
        case boards
        case board(KanbanBoardRequest)
        case stats(String)
        case assignees(String)
    }

    private let configurationResult: Result<KanbanConfiguration, Error>
    private let boardsResult: Result<KanbanBoardsResponse, Error>
    private let boardResult: Result<KanbanBoardSnapshot, Error>
    private var recordedCalls: [Call] = []

    init(
        configurationResult: Result<KanbanConfiguration, Error> = .success(KanbanFixtures.configuration),
        boardsResult: Result<KanbanBoardsResponse, Error> = .success(KanbanFixtures.boards),
        boardResult: Result<KanbanBoardSnapshot, Error> = .success(KanbanFixtures.snapshot)
    ) {
        self.configurationResult = configurationResult
        self.boardsResult = boardsResult
        self.boardResult = boardResult
    }

    func kanbanConfiguration() throws -> KanbanConfiguration {
        recordedCalls.append(.configuration)
        return try configurationResult.get()
    }

    func kanbanBoards() throws -> KanbanBoardsResponse {
        recordedCalls.append(.boards)
        return try boardsResult.get()
    }

    func kanbanBoard(_ request: KanbanBoardRequest) throws -> KanbanBoardSnapshot {
        recordedCalls.append(.board(request))
        return try boardResult.get()
    }

    func kanbanStats(board: String) -> KanbanStats {
        recordedCalls.append(.stats(board))
        return KanbanFixtures.stats
    }

    func kanbanAssignees(board: String) -> KanbanAssigneeHistory {
        recordedCalls.append(.assignees(board))
        return KanbanFixtures.history
    }

    func calls() -> [Call] { recordedCalls }
}

actor DeferredBoardCollectionClient: KanbanDataClient {
    private var collectionRequestCount = 0
    private var collectionContinuation: CheckedContinuation<KanbanBoardsResponse, Never>?
    private(set) var boardRequestCount = 0

    func kanbanConfiguration() -> KanbanConfiguration { KanbanFixtures.configuration }

    func kanbanBoards() async -> KanbanBoardsResponse {
        collectionRequestCount += 1
        if collectionRequestCount != 2 {
            return KanbanFixtures.boards
        }
        return await withCheckedContinuation { collectionContinuation = $0 }
    }

    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot {
        boardRequestCount += 1
        return KanbanFixtures.richSnapshot
    }

    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }

    func dispatchKanban(_ request: KanbanDispatchRequest) -> KanbanDispatchResult {
        mutationDecode(
            #"{"spawned":[],"promoted":0,"reclaimed":0,"skipped_unassigned":[],"skipped_nonspawnable":[],"auto_blocked":[],"timed_out":[],"crashed":[]}"#
        )
    }

    func waitForDeferredCollection() async {
        while collectionContinuation == nil { await Task.yield() }
    }

    func resumeDeferredCollection(
        _ response: KanbanBoardsResponse = KanbanFixtures.boards
    ) {
        collectionContinuation?.resume(returning: response)
        collectionContinuation = nil
    }
}

func mutationSnapshot(status: String = "todo") -> KanbanBoardSnapshot {
    return mutationDecode("""
    {
      "changed":true,
      "read_only":false,
      "columns":[
        {"name":"triage","tasks":[{"id":"CARD-2","title":"Second","status":"triage"}]},
        {"name":"\(status)","tasks":[{"id":"CARD-1","title":"First","status":"\(status)"}]},
        {"name":"ready","tasks":[]},
        {"name":"done","tasks":[]}
      ]
    }
    """)
}

func bulkSnapshot(firstStatus: String, secondStatus: String) -> KanbanBoardSnapshot {
    let cards = [
        ("CARD-1", "First", firstStatus),
        ("CARD-2", "Second", secondStatus)
    ]
    let todoCards = cards
        .filter { $0.2 == "todo" }
        .map { #"{"id":"\#($0.0)","title":"\#($0.1)","status":"todo"}"# }
        .joined(separator: ",")
    let doneCards = cards
        .filter { $0.2 == "done" }
        .map { #"{"id":"\#($0.0)","title":"\#($0.1)","status":"done"}"# }
        .joined(separator: ",")
    return mutationDecode("""
    {
      "changed": true,
      "read_only": false,
      "columns": [
        {"name":"triage","tasks":[]},
        {"name":"todo","tasks":[\(todoCards)]},
        {"name":"ready","tasks":[]},
        {"name":"running","tasks":[]},
        {"name":"blocked","tasks":[]},
        {"name":"done","tasks":[\(doneCards)]}
      ]
    }
    """)
}

func mutationDecode<T: Decodable>(_ json: String) -> T {
    let decoder = JSONDecoder()
    decoder.keyDecodingStrategy = .convertFromSnakeCase
    return try! decoder.decode(T.self, from: Data(json.utf8))
}

actor BrowsingClient: KanbanDataClient {
    private var requests: [KanbanBoardRequest] = []

    func kanbanConfiguration() -> KanbanConfiguration { KanbanFixtures.configuration }
    func kanbanBoards() -> KanbanBoardsResponse { KanbanFixtures.multiBoards }
    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot {
        requests.append(request)
        if request.since != nil { return KanbanFixtures.unchangedSnapshot }
        return KanbanFixtures.richSnapshot
    }
    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }
    func boardRequests() -> [KanbanBoardRequest] { requests }
}

enum KanbanFixtures {
    static let configuration = decode(KanbanConfiguration.self, #"{"columns":["triage","todo","ready","running","blocked","done"],"read_only":false}"#)
    static let boards = decode(KanbanBoardsResponse.self, #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#)
    static let readOnlyBoard = decode(KanbanBoardsResponse.self, #"{"boards":[{"slug":"main","name":"Main","read_only":true}],"current":"main","read_only":false}"#)
    static let multiBoards = decode(KanbanBoardsResponse.self, #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#)
    static let snapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"read_only":false,"columns":[{"name":"triage","tasks":[]}]}"#)
    static let supportedSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"read_only":false,"columns":[{"name":"triage","tasks":[{"id":"OLD","status":"triage"}]}]}"#)
    static let richSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"latest_event_id":11,"read_only":false,"tenants":["mobile"],"assignees":["builder"],"columns":[{"name":"triage","tasks":[]},{"name":"ready","tasks":[{"id":"CARD-1","title":"Status Focus","body":"markdown preview","status":"ready","assignee":"builder","tenant":"mobile"}]},{"name":"future","tasks":[{"id":"FUTURE-1","title":"Future","status":"future"}]}]}"#)
    static let futureSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"read_only":false,"columns":[{"name":"future","tasks":[{"id":"FUTURE-1","status":"future"}]}]}"#)
    static let unchangedSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":false,"latest_event_id":11,"read_only":false}"#)
    static let missingChangedSnapshot = decode(KanbanBoardSnapshot.self, #"{"latest_event_id":12,"read_only":false,"columns":[{"name":"triage","tasks":[]}]}"#)
    static let newSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"latest_event_id":13,"read_only":false,"columns":[{"name":"ready","tasks":[{"id":"NEW","title":"Newest filter","status":"ready"}]}]}"#)
    static let staleSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"latest_event_id":12,"read_only":false,"columns":[{"name":"ready","tasks":[{"id":"STALE","title":"Stale filter","status":"ready"}]}]}"#)
    static let stalenessSnapshot = decode(KanbanBoardSnapshot.self, #"{"changed":true,"columns":[{"name":"running","tasks":[{"id":"r1","status":"running","age_seconds":599},{"id":"r2","status":"running","age_seconds":600},{"id":"r3","status":"running","age_seconds":3600}]},{"name":"ready","tasks":[{"id":"q1","status":"ready","age_seconds":3599},{"id":"q2","status":"ready","age_seconds":3600}]},{"name":"blocked","tasks":[{"id":"b1","status":"blocked","age_seconds":3599},{"id":"b2","status":"blocked","age_seconds":3600},{"id":"b3","status":"blocked","age_seconds":86400}]}]}"#)
    static let stats = decode(KanbanStats.self, #"{"by_status":{"triage":0}}"#)
    static let history = decode(KanbanAssigneeHistory.self, #"{"assignees":["builder"]}"#)

    private static func decode<T: Decodable>(_ type: T.Type, _ json: String) -> T {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try! decoder.decode(T.self, from: Data(json.utf8))
    }
}

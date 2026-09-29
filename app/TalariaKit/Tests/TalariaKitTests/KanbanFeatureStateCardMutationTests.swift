import XCTest
@testable import TalariaKit

@MainActor
extension KanbanFeatureStateTests {
    func testCardMutationsAreOptimisticSerializedPerCardAndConcurrentAcrossCards() async throws {
        let client = DeferredMutationClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let firstCard = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        let secondCard = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-2" })

        let firstWrite = Task { await state.moveCard(firstCard, to: "ready") }
        try await waitUntil { await client.statusRequestCount == 1 }
        XCTAssertEqual(state.allCards.first { $0.cardID == "CARD-1" }?.status?.rawValue, "ready")
        XCTAssertEqual(state.mutationState(for: "CARD-1")?.phase, .updating)

        // A canonical refresh that still carries the old status must not erase
        // the pending optimistic status.
        await state.refresh()
        XCTAssertEqual(state.allCards.first { $0.cardID == "CARD-1" }?.status?.rawValue, "ready")

        let duplicateWrite = Task { await state.completeCard(firstCard) }
        let unrelatedWrite = Task { await state.moveCard(secondCard, to: "todo") }
        try await waitUntil { await client.statusRequestCount == 2 }
        let firstCardRequestCount = await client.requestCount(for: "CARD-1")
        let maximumConcurrentWrites = await client.maximumConcurrentWrites
        XCTAssertEqual(firstCardRequestCount, 1)
        XCTAssertEqual(maximumConcurrentWrites, 2)

        await client.finish(cardID: "CARD-1", status: "ready")
        await client.finish(cardID: "CARD-2", status: "todo")
        await firstWrite.value
        await duplicateWrite.value
        await unrelatedWrite.value

        XCTAssertEqual(state.mutationState(for: "CARD-1")?.phase, .succeeded)
        XCTAssertEqual(state.mutationState(for: "CARD-2")?.phase, .succeeded)
    }

    func testMissingWorkflowEndpointDisablesOnlyCardWorkflow() async throws {
        let client = ImmediateMutationClient(statusResults: [
            .failure(APIError.http(
                statusCode: 404,
                body: #"{"error":"Unknown Kanban endpoint; refresh the client"}"#
            ))
        ])
        let state = KanbanFeatureState(
            server: URL(string: "https://workflow-capability.example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.completeCard(card)

        XCTAssertEqual(state.state, .partial)
        XCTAssertEqual(state.unavailableWriteCapabilities, [.cardWorkflow])
        XCTAssertFalse(state.canUseCardWorkflow)
        XCTAssertTrue(state.canUseBulkActions)
        XCTAssertTrue(state.canCreateCards)
        XCTAssertTrue(state.canManageBoards)
    }

    func testAmbiguousMutationRequiresReconciliationBeforeTryAgain() async throws {
        let network = APIError.network(underlying: URLError(.networkConnectionLost))
        let client = ImmediateMutationClient(
            statusResults: [.failure(network)],
            detailResults: [
                .failure(network),
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.completeCard(card)

        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .outcomeUncertain)
        var statusRequestCount = await client.statusRequestCount
        XCTAssertEqual(statusRequestCount, 1)
        await state.refresh()
        XCTAssertEqual(
            state.allCards.first { $0.cardID == card.cardID }?.status?.rawValue,
            "todo",
            "An ordinary refresh must preserve the recoverable Card until uncertainty is explicitly checked."
        )
        await state.checkUncertainMutation(for: card)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .succeeded)
        statusRequestCount = await client.statusRequestCount
        XCTAssertEqual(statusRequestCount, 1, "A result check must never repeat the write.")
    }

    func testArchiveUndoUsesFreshAuthoritativeStateAndDependencyRefusalsPersist() async throws {
        let client = ImmediateMutationClient(
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"archived"}}"#)),
                .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"todo"}}"#))
            ],
            detailResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"archived"}}"#))
            ],
            dependencyResult: .failure(APIError.http(statusCode: 409, body: #"{"error":"cycle"}"#))
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.archiveCard(card)
        XCTAssertTrue(state.hasAvailableArchiveUndo)
        XCTAssertFalse(state.allCards.contains { $0.cardID == card.cardID })

        await state.undoArchive()
        XCTAssertEqual(state.allCards.first { $0.cardID == card.cardID }?.status?.rawValue, "todo")
        let detailRequestCount = await client.detailRequestCount
        XCTAssertEqual(detailRequestCount, 1, "Undo must read current authoritative state first.")

        let restored = try XCTUnwrap(state.allCards.first { $0.cardID == card.cardID })
        await state.addPrerequisite("CARD-2", to: restored)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .failed)
        let dependencyRequestCount = await client.dependencyRequestCount
        XCTAssertEqual(dependencyRequestCount, 1)
    }

    func testUnknownStatusAndRunningDestinationCannotConstructWrites() async throws {
        let client = ImmediateMutationClient(snapshot: mutationSnapshot(status: "future"))
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        XCTAssertFalse(state.canMutateCard(card))
        await state.moveCard(card, to: "running")
        let statusRequestCount = await client.statusRequestCount
        XCTAssertEqual(statusRequestCount, 0)
    }

    func testArchiveUndoExpiresWithoutIssuingAnotherWrite() async throws {
        let client = ImmediateMutationClient(statusResults: [
            .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#))
        ])
        // A test clock ends the undo window; a real 10 ms lifetime could lapse before the first check on a
        // slow runner.
        let clock = MutableClock(Date(timeIntervalSince1970: 1_770_000_000))
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client,
            archiveUndoLifetime: 8,
            now: { clock.now }
        )
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.archiveCard(card)
        XCTAssertTrue(state.hasAvailableArchiveUndo)
        clock.advance(by: 7.9)
        XCTAssertTrue(state.hasAvailableArchiveUndo)
        clock.advance(by: 0.1)

        XCTAssertFalse(state.hasAvailableArchiveUndo)
        let statusRequestCount = await client.statusRequestCount
        XCTAssertEqual(statusRequestCount, 1)
    }

    func testRunningExitRequiresExplicitConfirmationBeforeWriteConstruction() async throws {
        let client = ImmediateMutationClient(
            snapshot: mutationSnapshot(status: "running"),
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.completeCard(card)
        var requestCount = await client.statusRequestCount
        XCTAssertEqual(requestCount, 0)

        await state.completeCard(card, confirmingRunningExit: true)
        requestCount = await client.statusRequestCount
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .succeeded)
    }

    func testUncertainArchiveUndoStaysRecoverableAndChecksBeforeAnotherWrite() async throws {
        let network = APIError.network(underlying: URLError(.networkConnectionLost))
        let client = ImmediateMutationClient(
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#)),
                .failure(network)
            ],
            detailResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#)),
                .failure(network),
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"todo"}}"#))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.archiveCard(card)
        await state.undoArchive()
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .outcomeUncertain)
        XCTAssertTrue(state.hasAvailableArchiveUndo)
        var requestCount = await client.statusRequestCount
        XCTAssertEqual(requestCount, 2)

        let recoveryCard = try XCTUnwrap(state.archiveUndo?.card)
        await state.checkUncertainMutation(for: recoveryCard)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .succeeded)
        XCTAssertFalse(state.hasAvailableArchiveUndo)
        requestCount = await client.statusRequestCount
        XCTAssertEqual(requestCount, 2, "Checking an uncertain Undo must not repeat the write.")
    }

    func testSuccessfulStatusPresentationPersistsUntilFreshDetailLoads() async throws {
        let client = ImmediateMutationClient(
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#))
            ],
            detailResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let staleCard = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        let detailState = try XCTUnwrap(state.makeCardDetailState(cardID: "CARD-1"))

        await state.completeCard(staleCard)

        XCTAssertEqual(state.displayedCard(staleCard).status?.rawValue, "done")
        await state.refresh()
        XCTAssertEqual(
            state.allCards.first { $0.cardID == "CARD-1" }?.status?.rawValue,
            "todo",
            "A settled detail overlay must not mask a later authoritative Board refresh."
        )
        XCTAssertEqual(state.displayedCard(staleCard).status?.rawValue, "done")
        await detailState.load()
        let laterCanonical: KanbanCardDetailEnvelope = mutationDecode(
            #"{"task":{"id":"CARD-1","status":"ready"}}"#
        )
        XCTAssertEqual(
            state.displayedCard(try XCTUnwrap(laterCanonical.card)).status?.rawValue,
            "ready",
            "A successful detail load must retire the settled status overlay."
        )
    }

    func testSuccessfulDependencyPresentationPersistsUntilFreshDetailLoads() async throws {
        let confirmed: KanbanCardDetailEnvelope = mutationDecode(
            #"{"task":{"id":"CARD-1","status":"todo"},"links":{"parents":["CARD-2"]}}"#
        )
        let client = ImmediateMutationClient(detailResults: [.success(confirmed), .success(confirmed)])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        let detailState = try XCTUnwrap(state.makeCardDetailState(cardID: "CARD-1"))

        await state.addPrerequisite("CARD-2", to: card)

        XCTAssertEqual(state.displayedPrerequisites(for: "CARD-1", canonical: []), ["CARD-2"])
        await detailState.load()
        XCTAssertEqual(
            state.displayedPrerequisites(for: "CARD-1", canonical: []),
            [],
            "A successful detail load must retire the settled dependency overlay."
        )
    }

    func testUndoArchiveNotFoundDuringPrefetchClearsRecoveryOffer() async throws {
        let client = ImmediateMutationClient(
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#))
            ],
            detailResults: [.failure(APIError.http(statusCode: 404, body: nil))]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.archiveCard(card)
        await state.undoArchive()

        XCTAssertFalse(state.hasAvailableArchiveUndo)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .failed)
    }

    func testUndoArchiveNotFoundDuringUncertainCheckClearsRecoveryOffer() async throws {
        let network = APIError.network(underlying: URLError(.networkConnectionLost))
        let client = ImmediateMutationClient(
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#)),
                .failure(network)
            ],
            detailResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"archived"}}"#)),
                .failure(network),
                .failure(APIError.http(statusCode: 404, body: nil))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.archiveCard(card)
        await state.undoArchive()
        let recoveryCard = try XCTUnwrap(state.archiveUndo?.card)
        await state.checkUncertainMutation(for: recoveryCard)

        XCTAssertFalse(state.hasAvailableArchiveUndo)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .failed)
    }

    func testFullLoadAndBoardSwitchClearSettledMutationPresentation() async throws {
        let boards: KanbanBoardsResponse = mutationDecode(
            #"{"boards":[{"slug":"main"},{"slug":"release"}],"current":"main","read_only":false}"#
        )
        let client = ImmediateMutationClient(
            boards: boards,
            statusResults: [
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#)),
                .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"done"}}"#))
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        var card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        await state.completeCard(card)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .succeeded)
        await state.load()
        XCTAssertNil(state.mutationState(for: card.cardID))
        XCTAssertEqual(state.displayedCard(card).status?.rawValue, "todo")

        card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        await state.completeCard(card)
        XCTAssertEqual(state.mutationState(for: card.cardID)?.phase, .succeeded)
        await state.selectBoard("release")
        XCTAssertNil(state.mutationState(for: card.cardID))
        XCTAssertEqual(state.displayedCard(card).status?.rawValue, "todo")
    }

    func testCardSelectionSurvivesFiltersAndRefreshButNeverCrossesBoards() async throws {
        let client = BrowsingClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })

        state.beginSelectingCards()
        state.toggleCardSelection(card)
        await state.applyFilters(profile: "builder", tenant: "mobile", includeArchived: false, onlyMine: false)
        await state.refresh()

        XCTAssertTrue(state.isSelectingCards)
        XCTAssertEqual(state.selectedCardIDs, ["CARD-1"])
        XCTAssertEqual(state.selectedCardCount, 1)

        await state.selectBoard("release")
        XCTAssertFalse(state.isSelectingCards)
        XCTAssertTrue(state.selectedCardIDs.isEmpty)
        XCTAssertNil(state.bulkActionSummary)
    }

}

private actor DeferredMutationClient: KanbanDataClient {
    private var continuations: [String: CheckedContinuation<KanbanCardMutationEnvelope, Never>] = [:]
    private var requests: [KanbanCardStatusRequest] = []
    private var concurrentWrites = 0
    private(set) var maximumConcurrentWrites = 0

    var statusRequestCount: Int { requests.count }

    func requestCount(for cardID: String) -> Int {
        requests.count { $0.cardID == cardID }
    }

    func kanbanConfiguration() -> KanbanConfiguration {
        mutationDecode(#"{"columns":["triage","todo","ready","running","blocked","done"],"read_only":false}"#)
    }
    func kanbanBoards() -> KanbanBoardsResponse {
        mutationDecode(#"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#)
    }
    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot { mutationSnapshot() }
    func kanbanStats(board: String) -> KanbanStats { mutationDecode("{}") }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { mutationDecode("{}") }

    func setKanbanCardStatus(_ request: KanbanCardStatusRequest) async -> KanbanCardMutationEnvelope {
        requests.append(request)
        concurrentWrites += 1
        maximumConcurrentWrites = max(maximumConcurrentWrites, concurrentWrites)
        return await withCheckedContinuation { continuation in
            continuations[request.cardID] = continuation
        }
    }

    func finish(cardID: String, status: String) {
        concurrentWrites -= 1
        continuations.removeValue(forKey: cardID)?.resume(
            returning: mutationDecode(#"{"task":{"id":"\#(cardID)","status":"\#(status)"}}"#)
        )
    }
}

private actor ImmediateMutationClient: KanbanDataClient {
    private let snapshot: KanbanBoardSnapshot
    private let boards: KanbanBoardsResponse
    private var statusResults: [Result<KanbanCardMutationEnvelope, Error>]
    private var detailResults: [Result<KanbanCardDetailEnvelope, Error>]
    private let dependencyResult: Result<KanbanDependencyMutationEnvelope, Error>
    private(set) var statusRequestCount = 0
    private(set) var detailRequestCount = 0
    private(set) var dependencyRequestCount = 0

    init(
        snapshot: KanbanBoardSnapshot = mutationSnapshot(),
        boards: KanbanBoardsResponse = mutationDecode(
            #"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#
        ),
        statusResults: [Result<KanbanCardMutationEnvelope, Error>] = [],
        detailResults: [Result<KanbanCardDetailEnvelope, Error>] = [],
        dependencyResult: Result<KanbanDependencyMutationEnvelope, Error> = .success(
            mutationDecode(#"{"ok":true,"parent_id":"CARD-2","child_id":"CARD-1"}"#)
        )
    ) {
        self.snapshot = snapshot
        self.boards = boards
        self.statusResults = statusResults
        self.detailResults = detailResults
        self.dependencyResult = dependencyResult
    }

    func kanbanConfiguration() -> KanbanConfiguration {
        mutationDecode(#"{"columns":["triage","todo","ready","running","blocked","done"],"read_only":false}"#)
    }
    func kanbanBoards() -> KanbanBoardsResponse {
        boards
    }
    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot { snapshot }
    func kanbanStats(board: String) -> KanbanStats { mutationDecode("{}") }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { mutationDecode("{}") }

    func kanbanCardDetail(_ request: KanbanCardDetailRequest) throws -> KanbanCardDetailEnvelope {
        detailRequestCount += 1
        return try detailResults.removeFirst().get()
    }

    func setKanbanCardStatus(_ request: KanbanCardStatusRequest) throws -> KanbanCardMutationEnvelope {
        statusRequestCount += 1
        return try statusResults.removeFirst().get()
    }

    func addKanbanDependency(
        _ request: KanbanDependencyMutationRequest
    ) throws -> KanbanDependencyMutationEnvelope {
        dependencyRequestCount += 1
        return try dependencyResult.get()
    }
}

import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
extension KanbanFeatureStateTests {
    func testBulkAvailabilityExplainsUnknownStatusAndRejectsInvalidActions() async throws {
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(boardResult: .success(KanbanFixtures.richSnapshot))
        )
        await state.load()
        let unknown = try XCTUnwrap(state.allCards.first { $0.cardID == "FUTURE-1" })
        state.beginSelectingCards()
        state.toggleCardSelection(unknown)

        XCTAssertEqual(state.bulkActionsAvailability, .unknownStatus)
        XCTAssertFalse(state.canSubmitBulkAction(.changeStatus("running")))
        XCTAssertFalse(state.canSubmitBulkAction(.setPriority(101)))
        XCTAssertFalse(state.canSubmitBulkAction(.assignProfile("not-a-profile")))
    }

    func testBulkPartialResultRefetchesEveryCardAndRetryTargetsOnlyFailed() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "done")
            ],
            bulkResponses: [
                mutationDecode(
                    #"{"results":[{"id":"CARD-1","ok":true},{"id":"CARD-2","ok":false,"error":"refused"}],"read_only":false}"#
                ),
                mutationDecode(#"{"results":[{"id":"CARD-2","ok":true}],"read_only":false}"#)
            ],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"done"}}"#))
                ],
                "CARD-2": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-2","title":"Second","status":"todo"}}"#)),
                    .success(mutationDecode(#"{"task":{"id":"CARD-2","title":"Second","status":"done"}}"#))
                ]
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.beginSelectingCards()
        state.allCards.forEach(state.toggleCardSelection)

        await state.performBulkAction(.changeStatus("done"))

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 1)
        XCTAssertEqual(state.bulkActionSummary?.failedCount, 1)
        XCTAssertEqual(state.bulkActionSummary?.uncertainCount, 0)
        XCTAssertEqual(state.selectedCardIDs, ["CARD-2"])
        XCTAssertTrue(state.canRetryFailedBulkAction)
        let firstDetailRequests = await client.detailRequests()
        XCTAssertEqual(Set(firstDetailRequests), ["CARD-1", "CARD-2"])

        await state.retryFailedBulkAction()

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 1)
        XCTAssertEqual(state.bulkActionSummary?.failedCount, 0)
        XCTAssertTrue(state.selectedCardIDs.isEmpty)
        XCTAssertFalse(state.canRetryFailedBulkAction)
        let requests = await client.bulkRequests()
        XCTAssertEqual(requests.map(\.cardIDs), [["CARD-1", "CARD-2"], ["CARD-2"]])
    }

    func testBulkMalformedReconciliationRemainsSelectedButCannotBlindlyRetry() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "todo")
            ],
            bulkResponses: [
                mutationDecode(#"{"results":[{"id":"CARD-1","ok":true},42],"read_only":false}"#)
            ],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"done"}}"#))
                ],
                "CARD-2": [
                    .failure(KanbanResponseError.nonJSONContentType)
                ]
            ]
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.beginSelectingCards()
        state.allCards.forEach(state.toggleCardSelection)

        await state.performBulkAction(.changeStatus("done"))

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 1)
        XCTAssertEqual(state.bulkActionSummary?.uncertainCount, 1)
        XCTAssertEqual(state.selectedCardIDs, ["CARD-2"])
        XCTAssertFalse(state.canRetryFailedBulkAction)
        let detailRequests = await client.detailRequests()
        XCTAssertEqual(Set(detailRequests), ["CARD-1", "CARD-2"])
    }

    func testBulkSubmissionLocksOtherBoardWritesThroughReconciliation() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "todo")
            ],
            bulkResponses: [
                mutationDecode(#"{"results":[{"id":"CARD-1","ok":true}],"read_only":false}"#)
            ],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"done"}}"#))
                ]
            ],
            defersFirstBulkResponse: true
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let first = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        state.beginSelectingCards()
        state.toggleCardSelection(first)

        let submission = Task { await state.performBulkAction(.changeStatus("done")) }
        await client.waitForDeferredBulkResponse()

        XCTAssertEqual(state.bulkActionPhase, .submitting)
        XCTAssertEqual(state.bulkActionsAvailability, .boardBusy)
        XCTAssertFalse(state.canMutateCards)

        await client.resumeDeferredBulkResponse()
        await submission.value

        XCTAssertNil(state.bulkActionPhase)
        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 1)
    }

    func testBulkTransportFailureStillReconcilesEveryCard() async {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "done")
            ],
            bulkResponses: [],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"done"}}"#))
                ],
                "CARD-2": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-2","title":"Second","status":"done"}}"#))
                ]
            ],
            bulkError: KanbanResponseError.nonJSONContentType
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.beginSelectingCards()
        state.allCards.forEach(state.toggleCardSelection)

        await state.performBulkAction(.changeStatus("done"))

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 2)
        let detailRequests = await client.detailRequests()
        XCTAssertEqual(Set(detailRequests), ["CARD-1", "CARD-2"])
    }

    func testMissingBulkEndpointDisablesOnlyBulkActionsAfterReconciliation() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo")
            ],
            bulkResponses: [],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","status":"todo"}}"#))
                ]
            ],
            bulkError: APIError.http(
                statusCode: 404,
                body: #"{"error":"Unknown Kanban endpoint; refresh the client"}"#
            )
        )
        let state = KanbanFeatureState(
            server: URL(string: "https://bulk-capability.example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()
        let card = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        state.beginSelectingCards()
        state.toggleCardSelection(card)

        await state.performBulkAction(.changeStatus("done"))

        XCTAssertEqual(state.state, .partial)
        XCTAssertEqual(state.unavailableWriteCapabilities, [.bulkActions])
        XCTAssertFalse(state.canUseBulkActions)
        XCTAssertTrue(state.canUseCardWorkflow)
        XCTAssertTrue(state.canCreateCards)
    }

    func testBulkReconciliationFetchesCardDetailsConcurrently() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "done")
            ],
            bulkResponses: [
                mutationDecode(#"{"results":[{"id":"CARD-1","ok":true},{"id":"CARD-2","ok":true}]}"#)
            ],
            detailResults: [
                "CARD-1": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-1","title":"First","status":"done"}}"#))
                ],
                "CARD-2": [
                    .success(mutationDecode(#"{"task":{"id":"CARD-2","title":"Second","status":"done"}}"#))
                ]
            ],
            defersFirstDetailResponse: true
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.beginSelectingCards()
        state.allCards.forEach(state.toggleCardSelection)

        let submission = Task { await state.performBulkAction(.changeStatus("done")) }
        await client.waitForDeferredDetailResponse()
        try await waitUntil { await client.detailRequests().count == 2 }
        await client.resumeDeferredDetailResponse()
        await submission.value

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 2)
    }

    func testReloadAfterBrowsedBoardRemovalClearsSelectionDuringBulkSubmission() async throws {
        let client = BulkActionClient(
            boardSnapshots: [
                bulkSnapshot(firstStatus: "todo", secondStatus: "todo"),
                bulkSnapshot(firstStatus: "done", secondStatus: "done")
            ],
            boardsResponses: [
                mutationDecode(#"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#),
                mutationDecode(#"{"boards":[{"slug":"release"}],"current":"release","read_only":false}"#)
            ],
            bulkResponses: [
                mutationDecode(#"{"results":[{"id":"CARD-1","ok":true}]}"#)
            ],
            detailResults: [:],
            defersFirstBulkResponse: true
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let first = try XCTUnwrap(state.allCards.first { $0.cardID == "CARD-1" })
        state.beginSelectingCards()
        state.toggleCardSelection(first)

        let submission = Task { await state.performBulkAction(.changeStatus("done")) }
        await client.waitForDeferredBulkResponse()
        await state.load()

        XCTAssertNil(state.selectedBoardSlug)
        XCTAssertEqual(state.boardSelectionNotice?.boardName, "main")
        XCTAssertFalse(state.isSelectingCards)
        XCTAssertTrue(state.selectedCardIDs.isEmpty)

        await client.resumeDeferredBulkResponse()
        await submission.value
        XCTAssertNil(state.bulkActionPhase)
        XCTAssertNil(state.bulkActionSummary)
    }

    func testKanbanLabPartialScenarioProvidesSafePerCardFailureRecovery() async throws {
        let state = KanbanLabScenario.partial.makeModel()
        await state.load()
        state.beginSelectingCards()
        for card in state.allCards where ["CARD-3", "CARD-4"].contains(card.cardID ?? "") {
            state.toggleCardSelection(card)
        }

        await state.performBulkAction(.changeStatus("done"))

        XCTAssertEqual(state.bulkActionSummary?.succeededCount, 1)
        XCTAssertEqual(state.bulkActionSummary?.failedCount, 1)
        XCTAssertEqual(state.selectedCardIDs, ["CARD-4"])
        XCTAssertTrue(state.canRetryFailedBulkAction)
    }

}

private actor BulkActionClient: KanbanDataClient {
    private var boardSnapshots: [KanbanBoardSnapshot]
    private var boardsResponses: [KanbanBoardsResponse]
    private var bulkResponses: [KanbanBulkActionEnvelope]
    private var detailResults: [String: [Result<KanbanCardDetailEnvelope, Error>]]
    private var recordedBulkRequests: [KanbanBulkActionRequest] = []
    private var recordedDetailRequests: [String] = []
    private var shouldDeferBulkResponse: Bool
    private var bulkContinuation: CheckedContinuation<Void, Never>?
    private var shouldDeferDetailResponse: Bool
    private var detailContinuation: CheckedContinuation<Void, Never>?
    private var bulkError: Error?

    init(
        boardSnapshots: [KanbanBoardSnapshot],
        boardsResponses: [KanbanBoardsResponse] = [
            mutationDecode(#"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#)
        ],
        bulkResponses: [KanbanBulkActionEnvelope],
        detailResults: [String: [Result<KanbanCardDetailEnvelope, Error>]],
        defersFirstBulkResponse: Bool = false,
        defersFirstDetailResponse: Bool = false,
        bulkError: Error? = nil
    ) {
        self.boardSnapshots = boardSnapshots
        self.boardsResponses = boardsResponses
        self.bulkResponses = bulkResponses
        self.detailResults = detailResults
        shouldDeferBulkResponse = defersFirstBulkResponse
        shouldDeferDetailResponse = defersFirstDetailResponse
        self.bulkError = bulkError
    }

    func kanbanConfiguration() -> KanbanConfiguration {
        mutationDecode(
            #"{"columns":["triage","todo","ready","running","blocked","done"],"assignees":["builder","reviewer"],"read_only":false}"#
        )
    }

    func kanbanBoards() -> KanbanBoardsResponse {
        if boardsResponses.count > 1 { return boardsResponses.removeFirst() }
        return boardsResponses[0]
    }

    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot {
        if boardSnapshots.count > 1 { return boardSnapshots.removeFirst() }
        return boardSnapshots[0]
    }

    func kanbanStats(board: String) -> KanbanStats { mutationDecode("{}") }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { mutationDecode("{}") }

    func performKanbanBulkAction(
        _ request: KanbanBulkActionRequest
    ) async throws -> KanbanBulkActionEnvelope {
        recordedBulkRequests.append(request)
        if shouldDeferBulkResponse {
            shouldDeferBulkResponse = false
            await withCheckedContinuation { bulkContinuation = $0 }
        }
        if let error = bulkError {
            bulkError = nil
            throw error
        }
        return bulkResponses.removeFirst()
    }

    func kanbanCardDetail(_ request: KanbanCardDetailRequest) async throws -> KanbanCardDetailEnvelope {
        recordedDetailRequests.append(request.cardID)
        if shouldDeferDetailResponse {
            shouldDeferDetailResponse = false
            await withCheckedContinuation { detailContinuation = $0 }
        }
        guard var results = detailResults[request.cardID], !results.isEmpty else {
            throw KanbanResponseError.nonJSONContentType
        }
        let result = results.removeFirst()
        detailResults[request.cardID] = results
        return try result.get()
    }

    func bulkRequests() -> [KanbanBulkActionRequest] { recordedBulkRequests }
    func detailRequests() -> [String] { recordedDetailRequests }

    func waitForDeferredBulkResponse() async {
        while bulkContinuation == nil { await Task.yield() }
    }

    func resumeDeferredBulkResponse() {
        bulkContinuation?.resume()
        bulkContinuation = nil
    }

    func waitForDeferredDetailResponse() async {
        while detailContinuation == nil { await Task.yield() }
    }

    func resumeDeferredDetailResponse() {
        detailContinuation?.resume()
        detailContinuation = nil
    }
}

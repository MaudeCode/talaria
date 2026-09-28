import XCTest
@testable import TalariaKit

@MainActor
extension KanbanFeatureStateTests {
    func testBoardWritesSerializeAndCreationNeverChangesLocalOrSharedSelection() async throws {
        let client = BoardManagementClient(
            boardsResponses: [
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
                )),
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
                ))
            ],
            defersCreate: true
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        let creation = Task {
            await state.createBoard(KanbanCreateBoardRequest(
                slug: "release",
                name: "Release",
                description: "",
                icon: "",
                color: ""
            ))
        }
        await client.waitForDeferredCreate()
        XCTAssertEqual(state.boardMutationState?.phase, .updating)

        await state.makeBoardActive(slug: "main")
        let makeActiveRequestCount = await client.makeActiveRequestCount
        XCTAssertEqual(makeActiveRequestCount, 0)

        await client.resumeDeferredCreate()
        await creation.value

        let createRequestCount = await client.createRequestCount
        XCTAssertEqual(createRequestCount, 1)
        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)
        XCTAssertEqual(state.selectedBoardSlug, "main")
        XCTAssertEqual(state.sharedActiveBoardSlug, "main")
        XCTAssertTrue(state.boards.contains { $0.slug == "release" })
    }

    func testRemoteSharedActiveChangeNeverNavigatesLocallyBrowsedBoard() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main"},{"slug":"release"}],"current":"main","read_only":false}"#
            )),
            .success(mutationDecode(
                #"{"boards":[{"slug":"main"},{"slug":"release"}],"current":"release","read_only":false}"#
            ))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        await state.refresh()

        XCTAssertEqual(state.sharedActiveBoardSlug, "release")
        XCTAssertEqual(state.selectedBoardSlug, "main")
        let lastBoardRequest = await client.boardRequests().last
        XCTAssertEqual(lastBoardRequest?.board, "main")
    }

    func testRemoteArchiveReturnsToBoardSelectionAndTearsDownBoardState() async throws {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
            )),
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
            ))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        await state.selectBoard("release")
        state.beginSelectingCards()
        if let card = state.allCards.first { state.toggleCardSelection(card) }

        await state.refresh()

        XCTAssertNil(state.selectedBoardSlug)
        XCTAssertNil(state.snapshot)
        XCTAssertTrue(state.selectedCardIDs.isEmpty)
        XCTAssertEqual(state.boardSelectionNotice?.boardName, "Release")
        XCTAssertTrue(state.requiresBoardSelection)
    }

    func testRemovedBoardReloadPreservesPartialCompatibilityAndDisplayName() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
            )),
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
            ))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        await state.selectBoard("release")

        await state.load()

        XCTAssertEqual(state.state, .partial)
        XCTAssertEqual(state.report?.warnings, [.unsupportedStatus("future")])
        XCTAssertNil(state.selectedBoardSlug)
        XCTAssertEqual(state.boardSelectionNotice?.boardName, "Release")
    }

    func testPartialBoardContractDisablesBoardManagement() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main"}"#
            ))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        XCTAssertEqual(state.state, .partial)
        XCTAssertFalse(state.canManageBoards)
        await state.createBoard(KanbanCreateBoardRequest(
            slug: "release",
            name: "Release",
            description: "",
            icon: "",
            color: ""
        ))
        let createRequestCount = await client.createRequestCount
        XCTAssertEqual(createRequestCount, 0)
    }

    func testNetworkBoardCollectionFailureRefreshesSelectedBoardAndKeepsWritesDisabled() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
            )),
            .failure(APIError.network(underlying: URLError(.notConnectedToInternet)))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let loadedCards = state.allCards

        await state.refresh()

        XCTAssertFalse(state.isOffline)
        XCTAssertFalse(state.loadedDetailIsStale)
        XCTAssertEqual(state.allCards, loadedCards)
        XCTAssertFalse(state.canManageBoards)
        XCTAssertTrue(state.refreshFailed)
    }

    func testIncompleteBoardCollectionRefreshesSelectedBoardButKeepsWritesDisabled() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
            )),
            .success(mutationDecode(
                #"{"current":"main","read_only":false}"#
            ))
        ], refreshBoardSnapshot: mutationDecode(
            #"{"changed":true,"latest_event_id":12,"read_only":false,"columns":[{"name":"ready","tasks":[{"id":"REFRESHED","status":"ready"}]}]}"#
        ))
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        await state.refresh()

        XCTAssertFalse(state.isOffline)
        XCTAssertTrue(state.refreshFailed)
        XCTAssertEqual(state.allCards.map(\.cardID), ["REFRESHED"])
        XCTAssertFalse(state.canUseServerAuthoritativeActions)
        XCTAssertFalse(state.canManageBoards)
    }

    func testCancelledBoardCollectionRefreshDoesNotReportFailureOrBlockWrites() async {
        let client = DeferredBoardCollectionClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        let refresh = Task { await state.refresh() }
        await client.waitForDeferredCollection()
        refresh.cancel()
        await client.resumeDeferredCollection()
        await refresh.value

        XCTAssertFalse(state.refreshFailed)
        XCTAssertTrue(state.canUseServerAuthoritativeActions)
        let boardRequestCount = await client.boardRequestCount
        XCTAssertEqual(boardRequestCount, 1)
    }

    func testBoardManagementStateRemainsIsolatedPerServer() async {
        let firstClient = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
            )),
            .success(mutationDecode(
                #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
            ))
        ])
        let secondClient = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"personal","name":"Personal"}],"current":"personal","read_only":false}"#
            ))
        ])
        let first = KanbanFeatureState(
            server: URL(string: "https://first.example.test")!,
            defaults: defaults,
            client: firstClient
        )
        let second = KanbanFeatureState(
            server: URL(string: "https://second.example.test")!,
            defaults: defaults,
            client: secondClient
        )
        await first.load()
        await second.load()

        await first.createBoard(KanbanCreateBoardRequest(
            slug: "release",
            name: "Release",
            description: "",
            icon: "",
            color: ""
        ))

        XCTAssertTrue(first.boards.contains { $0.slug == "release" })
        XCTAssertEqual(second.boards.map(\.slug), ["personal"])
        XCTAssertEqual(second.selectedBoardSlug, "personal")
        let secondCreateRequestCount = await secondClient.createRequestCount
        XCTAssertEqual(secondCreateRequestCount, 0)
    }

    func testRebuiltStateForSameServerRestoresBrowsedBoardAndRefreshesAgainstIt() async {
        let boards = #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
        let server = URL(string: "https://example.test")!
        let first = KanbanFeatureState(
            server: server,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(boards))])
        )
        await first.load()
        await first.selectBoard("release")

        let client = BoardManagementClient(boardsResponses: [.success(mutationDecode(boards))])
        let rebuilt = KanbanFeatureState(server: server, defaults: defaults, client: client)
        await rebuilt.load()
        await rebuilt.refresh()

        XCTAssertEqual(rebuilt.selectedBoardSlug, "release")
        XCTAssertEqual(rebuilt.report?.board.slug, "release")
        XCTAssertEqual(rebuilt.sharedActiveBoardSlug, "main")
        let boardRequests = await client.boardRequests().map(\.board)
        XCTAssertEqual(boardRequests, ["release", "release"])
    }

    func testSecondServerDoesNotInheritBrowsedBoard() async {
        let boards = #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
        let first = KanbanFeatureState(
            server: URL(string: "https://first.example.test")!,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(boards))])
        )
        await first.load()
        await first.selectBoard("release")

        let second = KanbanFeatureState(
            server: URL(string: "https://second.example.test")!,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(boards))])
        )
        await second.load()

        XCTAssertEqual(second.selectedBoardSlug, "main")
    }

    func testStaleSavedBoardNeverReachesWireAndIsForgotten() async {
        let withRelease = #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
        let withoutRelease = #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
        let server = URL(string: "https://example.test")!
        let first = KanbanFeatureState(
            server: server,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(withRelease))])
        )
        await first.load()
        await first.selectBoard("release")

        let staleClient = BoardManagementClient(boardsResponses: [.success(mutationDecode(withoutRelease))])
        let stale = KanbanFeatureState(server: server, defaults: defaults, client: staleClient)
        await stale.load()

        XCTAssertEqual(stale.selectedBoardSlug, "main")
        XCTAssertNil(stale.boardSelectionNotice)
        let staleRequests = await staleClient.boardRequests().map(\.board)
        XCTAssertEqual(staleRequests, ["main"])

        // The stale slug was dropped: Release reappearing no longer restores it.
        let later = KanbanFeatureState(
            server: server,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(withRelease))])
        )
        await later.load()
        XCTAssertEqual(later.selectedBoardSlug, "main")
    }

    func testRemovingBrowsedBoardClearsSavedChoice() async {
        let withRelease = #"{"boards":[{"slug":"main","name":"Main"},{"slug":"release","name":"Release"}],"current":"main","read_only":false}"#
        let withoutRelease = #"{"boards":[{"slug":"main","name":"Main"}],"current":"main","read_only":false}"#
        let server = URL(string: "https://example.test")!
        let state = KanbanFeatureState(
            server: server,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [
                .success(mutationDecode(withRelease)),
                .success(mutationDecode(withoutRelease))
            ])
        )
        await state.load()
        await state.selectBoard("release")
        await state.refresh()
        XCTAssertNil(state.selectedBoardSlug)

        let rebuilt = KanbanFeatureState(
            server: server,
            defaults: defaults,
            client: BoardManagementClient(boardsResponses: [.success(mutationDecode(withRelease))])
        )
        await rebuilt.load()
        XCTAssertEqual(rebuilt.selectedBoardSlug, "main")
    }

    func testAmbiguousBoardWriteChecksAuthoritativeListAndDefaultArchiveIsBlocked() async {
        let client = BoardManagementClient(
            boardsResponses: [
                .success(mutationDecode(
                    #"{"boards":[{"slug":"default"}],"current":"default","read_only":false}"#
                )),
                .success(mutationDecode(
                    #"{"boards":[{"slug":"default"},{"slug":"release"}],"current":"default","read_only":false}"#
                ))
            ],
            createResult: .failure(APIError.network(underlying: URLError(.timedOut)))
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        await state.archiveBoard(slug: "default")
        let archiveRequestCount = await client.archiveRequestCount
        XCTAssertEqual(archiveRequestCount, 0)

        await state.createBoard(KanbanCreateBoardRequest(
            slug: "release",
            name: "Release",
            description: "",
            icon: "",
            color: ""
        ))

        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)
        XCTAssertEqual(state.selectedBoardSlug, "default")
    }

    func testUncertainBoardWriteBlocksRetryUntilAnotherAuthoritativeCheck() async {
        let client = BoardManagementClient(
            boardsResponses: [
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main"},{"slug":"release"}],"current":"main","read_only":false}"#
                )),
                .failure(APIError.network(underlying: URLError(.networkConnectionLost))),
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main"},{"slug":"release"},{"slug":"planned"}],"current":"main","read_only":false}"#
                ))
            ],
            createResult: .failure(APIError.network(underlying: URLError(.timedOut)))
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.beginSelectingCards()
        if let card = state.allCards.first { state.toggleCardSelection(card) }

        await state.createBoard(KanbanCreateBoardRequest(
            slug: "planned",
            name: "Planned",
            description: "",
            icon: "",
            color: ""
        ))

        XCTAssertEqual(state.boardMutationState?.phase, .outcomeUncertain)
        XCTAssertFalse(state.canManageBoards)
        XCTAssertFalse(state.canAddComments)
        XCTAssertFalse(state.canMutateCards)
        XCTAssertEqual(state.bulkActionsAvailability, .boardBusy)
        await state.selectBoard("release")
        XCTAssertEqual(state.selectedBoardSlug, "main")
        await state.checkBoardMutationResult()
        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)
        XCTAssertTrue(state.canManageBoards)
        XCTAssertTrue(state.canMutateCards)
    }

    func testReloadInvalidatesInFlightBoardMutationBeforeItCanApplyStaleState() async {
        let client = BoardManagementClient(
            boardsResponses: [
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main","name":"Original"}],"current":"main","read_only":false}"#
                )),
                .success(mutationDecode(
                    #"{"boards":[{"slug":"main","name":"Reloaded"}],"current":"main","read_only":false}"#
                ))
            ],
            defersCreate: true
        )
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        let creation = Task {
            await state.createBoard(KanbanCreateBoardRequest(
                slug: "release",
                name: "Release",
                description: "",
                icon: "",
                color: ""
            ))
        }
        await client.waitForDeferredCreate()
        XCTAssertEqual(state.boardMutationState?.phase, .updating)

        await state.load()
        XCTAssertEqual(state.boards.first?.name, "Reloaded")
        XCTAssertNil(state.boardMutationState)

        await client.resumeDeferredCreate()
        await creation.value

        XCTAssertEqual(state.boards.first?.name, "Reloaded")
        XCTAssertNil(state.boardMutationState)
        let boardsRequestCount = await client.boardsRequestCount
        XCTAssertEqual(boardsRequestCount, 2)
    }

    func testEditActivateAndArchiveReconcileTheBoardCollection() async {
        let client = BoardManagementClient(boardsResponses: [
            .success(mutationDecode(
                #"{"boards":[{"slug":"default","name":"Default"},{"slug":"release","name":"Old"}],"current":"default","read_only":false}"#
            )),
            .success(mutationDecode(
                ##"{"boards":[{"slug":"default","name":"Default"},{"slug":"release","name":"Release","description":"","icon":"🚀","color":"#00AAFF"}],"current":"default","read_only":false}"##
            )),
            .success(mutationDecode(
                ##"{"boards":[{"slug":"default","name":"Default"},{"slug":"release","name":"Release","description":"","icon":"🚀","color":"#00AAFF"}],"current":"release","read_only":false}"##
            )),
            .success(mutationDecode(
                #"{"boards":[{"slug":"default","name":"Default"}],"current":"default","read_only":false}"#
            ))
        ])
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        await state.editBoard(KanbanEditBoardRequest(
            slug: "release",
            name: "Release",
            description: "",
            icon: "🚀",
            color: "#00AAFF"
        ))
        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)

        await state.makeBoardActive(slug: "release")
        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)
        XCTAssertEqual(state.sharedActiveBoardSlug, "release")
        XCTAssertEqual(state.selectedBoardSlug, "default")

        await state.archiveBoard(slug: "release")
        XCTAssertEqual(state.boardMutationState?.phase, .succeeded)
        XCTAssertFalse(state.boards.contains { $0.slug == "release" })
        let editRequest = await client.editRequests().first
        let activeRequest = await client.activeRequests().first
        let archiveRequest = await client.archiveRequests().first
        XCTAssertEqual(editRequest?.slug, "release")
        XCTAssertEqual(activeRequest?.slug, "release")
        XCTAssertEqual(archiveRequest?.slug, "release")
    }

    func testMissingBoardManagementEndpointDisablesOnlyThatCapabilityUntilReload() async {
        let missingEndpoint = APIError.http(
            statusCode: 404,
            body: #"{"error":"Unknown Kanban endpoint; refresh the client"}"#
        )
        let client = BoardManagementClient(
            boardsResponses: [
                .success(KanbanFixtures.boards),
                .success(KanbanFixtures.boards)
            ],
            createResult: .failure(missingEndpoint),
            boardSnapshot: KanbanFixtures.snapshot
        )
        let state = KanbanFeatureState(
            server: URL(string: "https://capability.example.test")!,
            defaults: defaults,
            client: client
        )

        await state.load()
        await state.createBoard(KanbanCreateBoardRequest(
            slug: "release",
            name: "Release",
            description: "",
            icon: "",
            color: ""
        ))

        XCTAssertEqual(state.state, .partial)
        XCTAssertEqual(state.unavailableWriteCapabilities, [.boardManagement])
        XCTAssertFalse(state.canManageBoards)
        XCTAssertTrue(state.canCreateCards)
        XCTAssertTrue(state.canUseCardWorkflow)

        await state.load()

        XCTAssertEqual(state.state, .compatible)
        XCTAssertTrue(state.unavailableWriteCapabilities.isEmpty)
        XCTAssertTrue(state.canManageBoards)
    }

    func testCapabilityDetectionDoesNotConfuseMissingEntitiesWithMissingEndpoints() {
        XCTAssertTrue(KanbanEndpointCompatibility.isMissingCapability(
            APIError.http(statusCode: 405, body: nil)
        ))
        XCTAssertTrue(KanbanEndpointCompatibility.isMissingCapability(
            APIError.http(
                statusCode: 404,
                body: #"{"error":"Unknown Kanban endpoint; refresh the client"}"#
            )
        ))
        XCTAssertFalse(KanbanEndpointCompatibility.isMissingCapability(
            APIError.http(statusCode: 404, body: #"{"error":"task not found"}"#)
        ))
        XCTAssertFalse(KanbanEndpointCompatibility.isMissingCapability(
            APIError.http(statusCode: 404, body: nil)
        ))
    }

}

private actor BoardManagementClient: KanbanDataClient {
    private var boardsResponses: [Result<KanbanBoardsResponse, Error>]
    private let createResult: Result<KanbanBoardMutationEnvelope, Error>
    private let configuration: KanbanConfiguration
    private var boardSnapshots: [KanbanBoardSnapshot]
    private var createContinuation: CheckedContinuation<Void, Never>?
    private let defersCreate: Bool
    private var shouldDeferCreate: Bool
    private var recordedBoardRequests: [KanbanBoardRequest] = []
    private var recordedEditRequests: [KanbanEditBoardRequest] = []
    private var recordedArchiveRequests: [KanbanBoardMutationRequest] = []
    private var recordedActiveRequests: [KanbanBoardMutationRequest] = []
    private(set) var createRequestCount = 0
    private(set) var archiveRequestCount = 0
    private(set) var makeActiveRequestCount = 0
    private(set) var boardsRequestCount = 0

    init(
        boardsResponses: [Result<KanbanBoardsResponse, Error>],
        createResult: Result<KanbanBoardMutationEnvelope, Error> = .success(
            mutationDecode(#"{"board":{"slug":"release"},"current":"main","read_only":false}"#)
        ),
        configuration: KanbanConfiguration = KanbanFixtures.configuration,
        boardSnapshot: KanbanBoardSnapshot = KanbanFixtures.richSnapshot,
        refreshBoardSnapshot: KanbanBoardSnapshot? = nil,
        defersCreate: Bool = false
    ) {
        self.boardsResponses = boardsResponses
        self.createResult = createResult
        self.configuration = configuration
        boardSnapshots = [boardSnapshot]
        if let refreshBoardSnapshot {
            boardSnapshots.append(refreshBoardSnapshot)
        }
        self.defersCreate = defersCreate
        shouldDeferCreate = defersCreate
    }

    func kanbanConfiguration() -> KanbanConfiguration { configuration }

    func kanbanBoards() throws -> KanbanBoardsResponse {
        boardsRequestCount += 1
        if boardsResponses.count > 1 {
            return try boardsResponses.removeFirst().get()
        }
        return try boardsResponses[0].get()
    }

    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot {
        recordedBoardRequests.append(request)
        if boardSnapshots.count > 1 {
            return boardSnapshots.removeFirst()
        }
        return boardSnapshots[0]
    }

    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }

    func createKanbanBoard(_ request: KanbanCreateBoardRequest) async throws -> KanbanBoardMutationEnvelope {
        createRequestCount += 1
        if shouldDeferCreate {
            shouldDeferCreate = false
            await withCheckedContinuation { createContinuation = $0 }
        }
        return try createResult.get()
    }

    func archiveKanbanBoard(
        _ request: KanbanBoardMutationRequest
    ) -> KanbanBoardMutationEnvelope {
        archiveRequestCount += 1
        recordedArchiveRequests.append(request)
        return mutationDecode(#"{"current":"main","read_only":false}"#)
    }

    func editKanbanBoard(
        _ request: KanbanEditBoardRequest
    ) -> KanbanBoardMutationEnvelope {
        recordedEditRequests.append(request)
        return mutationDecode(#"{"board":{"slug":"\#(request.slug)"},"read_only":false}"#)
    }

    func makeKanbanBoardActive(
        _ request: KanbanBoardMutationRequest
    ) -> KanbanBoardMutationEnvelope {
        makeActiveRequestCount += 1
        recordedActiveRequests.append(request)
        return mutationDecode(#"{"current":"\#(request.slug)","read_only":false}"#)
    }

    func boardRequests() -> [KanbanBoardRequest] { recordedBoardRequests }
    func editRequests() -> [KanbanEditBoardRequest] { recordedEditRequests }
    func archiveRequests() -> [KanbanBoardMutationRequest] { recordedArchiveRequests }
    func activeRequests() -> [KanbanBoardMutationRequest] { recordedActiveRequests }

    func waitForDeferredCreate() async {
        guard defersCreate else { return }
        while createContinuation == nil { await Task.yield() }
    }

    func resumeDeferredCreate() {
        createContinuation?.resume()
        createContinuation = nil
    }
}

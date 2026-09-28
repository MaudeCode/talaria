import XCTest
@testable import TalariaKit

@MainActor
extension KanbanFeatureStateTests {
    func testCompatibleHandshakeIsOrderedAndBoundToItsServer() async {
        let client = KanbanClientStub()
        let firstServer = URL(string: "https://first.example.test")!
        let secondServer = URL(string: "https://second.example.test")!
        let first = KanbanFeatureState(server: firstServer, defaults: defaults, client: client)
        let second = KanbanFeatureState(server: secondServer, defaults: defaults, client: client)

        await first.load()

        XCTAssertEqual(first.state, .compatible)
        XCTAssertEqual(first.server, firstServer)
        XCTAssertEqual(second.state, .idle)
        XCTAssertEqual(second.server, secondServer)
        let calls = await client.calls()
        XCTAssertEqual(calls, [
            .configuration,
            .boards,
            .board(KanbanBoardRequest(board: "main")),
            .stats("main"),
            .assignees("main")
        ])
    }

    func testCommentCapabilityUsesEnvelopePermissionAndHonorsExplicitBoardReadOnly() async {
        let writable = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub()
        )
        await writable.load()

        // The verified Boards contract carries read_only on the envelope, not
        // each Board entry. A missing per-Board value must not override three
        // explicit writable envelope values.
        XCTAssertNil(writable.selectedBoard?.readOnly)
        XCTAssertTrue(writable.canAddComments)
        XCTAssertTrue(writable.canMutateCards)

        let explicitReadOnly = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(boardsResult: .success(KanbanFixtures.readOnlyBoard))
        )
        await explicitReadOnly.load()
        XCTAssertEqual(explicitReadOnly.selectedBoard?.readOnly, true)
        XCTAssertFalse(explicitReadOnly.canAddComments)
        XCTAssertFalse(explicitReadOnly.canMutateCards)
    }

    func testAuthenticationForwardsToExistingHandler() async {
        let client = KanbanClientStub(configurationResult: .failure(APIError.unauthorized))
        var forwardedErrors: [Error] = []
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client,
            onAPIError: { forwardedErrors.append($0) }
        )

        await state.load()

        XCTAssertEqual(state.state, .authenticationRequired)
        XCTAssertEqual(forwardedErrors.count, 1)
        XCTAssertTrue(forwardedErrors.first is APIError)
    }

    func testNetworkServerAndContractFailuresStayDistinct() async {
        let network = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(configurationResult: .failure(APIError.network(underlying: URLError(.notConnectedToInternet))))
        )
        await network.load()
        XCTAssertEqual(network.state, .networkUnavailable)

        let server = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(configurationResult: .failure(APIError.http(statusCode: 503, body: nil)))
        )
        await server.load()
        XCTAssertEqual(server.state, .serverUnavailable)

        let contract = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(configurationResult: .failure(KanbanResponseError.nonJSONContentType))
        )
        await contract.load()
        XCTAssertEqual(contract.state, .incompatibleContract)
    }

    func testCancelledHandshakeReturnsToIdle() async {
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(configurationResult: .failure(CancellationError()))
        )

        await state.load()

        XCTAssertEqual(state.state, .idle)
        XCTAssertFalse(state.isLoading)
        XCTAssertNil(state.report)
    }

    func testStaleHandshakeCompletionCannotReplaceNewerResult() async {
        let client = DeferredFirstConfigurationClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)

        let firstLoad = Task { await state.load() }
        await client.waitForFirstConfiguration()

        await state.load()
        XCTAssertEqual(state.state, .compatible)

        await client.resumeFirstConfiguration()
        await firstLoad.value

        XCTAssertEqual(state.state, .compatible)
        XCTAssertFalse(state.isLoading)
    }

    func testStatusSearchUnknownStatusAndClearFiltersUseLoadedBoardData() async {
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: KanbanClientStub(boardResult: .success(KanbanFixtures.richSnapshot))
        )
        await state.load()

        XCTAssertEqual(Array(state.availableStatuses.prefix(6)), KanbanFeatureState.liveStatuses)
        XCTAssertTrue(state.availableStatuses.contains("future"))
        state.selectedStatus = "ready"
        for query in ["CARD-1", "Status Focus", "markdown", "builder", "mobile"] {
            state.searchText = query
            XCTAssertEqual(state.visibleCards.map(\.cardID), ["CARD-1"], query)
        }

        state.searchText = "missing"
        XCTAssertTrue(state.visibleCards.isEmpty)
        await state.applyFilters(profile: "builder", tenant: "mobile", includeArchived: true, onlyMine: false)
        XCTAssertTrue(state.hasActiveFilters)
        await state.clearFilters()
        XCTAssertFalse(state.hasActiveFilters)
        XCTAssertEqual(state.selectedStatus, "ready")
    }

    func testFilterAndBoardTransitionsPreserveLocalPresentationState() async {
        let client = BrowsingClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        state.selectedStatus = "running"
        state.searchText = "worker"
        state.groupByProfile = true

        await state.applyFilters(profile: "review", tenant: "ops", includeArchived: true, onlyMine: true)
        XCTAssertNil(state.selectedProfile)
        XCTAssertEqual(state.selectedTenant, "ops")
        XCTAssertTrue(state.onlyMine)
        XCTAssertTrue(state.includeArchived)
        let lastFilterRequest = await client.boardRequests().last
        XCTAssertEqual(lastFilterRequest, KanbanBoardRequest(
            board: "main",
            tenant: "ops",
            includeArchived: true,
            onlyMine: true
        ))

        await state.selectBoard("release")
        XCTAssertEqual(state.selectedBoardSlug, "release")
        XCTAssertEqual(state.selectedStatus, "running")
        XCTAssertEqual(state.searchText, "worker")
        XCTAssertTrue(state.groupByProfile)
        XCTAssertEqual(state.selectedTenant, "ops")
        XCTAssertTrue(state.includeArchived)
        XCTAssertTrue(state.onlyMine)
    }

    func testGroupByProfileDraftCancelsOrAppliesLocallyWithoutRefetchingBoard() async {
        let client = BrowsingClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let requestsBeforeToggle = await client.boardRequests()
        var draft = KanbanFiltersDraft(model: state)

        draft.groupsByProfile = true

        XCTAssertFalse(state.groupByProfile, "A cancelled draft must not mutate presentation state.")
        var requestsAfterDraftChange = await client.boardRequests()
        XCTAssertEqual(requestsAfterDraftChange, requestsBeforeToggle)

        await draft.apply(to: state)

        XCTAssertTrue(state.groupByProfile)
        requestsAfterDraftChange = await client.boardRequests()
        XCTAssertEqual(requestsAfterDraftChange, requestsBeforeToggle)
    }

    func testBoardSwitchClearsBoardScopedDataAndRevalidatesCompatibility() async {
        let client = DeferredBoardSwitchClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        XCTAssertNotNil(state.snapshot)
        XCTAssertNotNil(state.stats)
        XCTAssertNotNil(state.assigneeHistory)

        let switchBoard = Task { await state.selectBoard("release") }
        await client.waitForReleaseRead()

        XCTAssertEqual(state.selectedBoardSlug, "release")
        XCTAssertNil(state.snapshot)
        XCTAssertNil(state.stats)
        XCTAssertNil(state.assigneeHistory)
        XCTAssertTrue(state.isRefreshing)

        await client.resumeReleaseRead()
        await switchBoard.value

        XCTAssertEqual(state.report?.board.slug, "release")
        XCTAssertEqual(state.report?.warnings, [.unsupportedStatus("future")])
        XCTAssertEqual(state.state, .partial)
        XCTAssertEqual(state.allCards.map(\.cardID), ["FUTURE-1"])
    }

    func testPullToRefreshPerformsFullReconciliation() async {
        let client = BrowsingClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let before = state.allCards

        await state.refresh()

        XCTAssertEqual(state.allCards, before)
        let lastRequest = await client.boardRequests().last
        XCTAssertNil(lastRequest?.since)
        XCTAssertFalse(state.refreshFailed)
    }

    func testRefreshRejectsMissingChangedAndPreservesStableCards() async {
        let client = MissingChangedRefreshClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()
        let before = state.allCards

        await state.refresh()

        XCTAssertEqual(state.allCards, before)
        XCTAssertTrue(state.refreshFailed)
    }

    func testStaleFilteredReadCannotReplaceNewerFilterResult() async {
        let client = DeferredBoardClient()
        let state = KanbanFeatureState(server: URL(string: "https://example.test")!, defaults: defaults, client: client)
        await state.load()

        let stale = Task { await state.setTenantFilter("ops") }
        await client.waitForDeferredRead()
        await state.setProfileFilter("review")
        XCTAssertEqual(state.allCards.first?.cardID, "NEW")

        await client.resumeDeferredRead()
        await stale.value
        XCTAssertEqual(state.allCards.first?.cardID, "NEW")
    }

    func testBoardRowPresentationSeparatesLocalBrowsingFromApplicableMenuActions() {
        let ordinary: KanbanBoard = mutationDecode(
            #"{"slug":"release","name":"Release"}"#
        )
        let ordinaryPresentation = KanbanBoardRowPresentation(
            board: ordinary,
            selectedBoardSlug: "main",
            sharedActiveBoardSlug: "main",
            canManageBoards: true
        )
        XCTAssertEqual(ordinaryPresentation.browseSlug, "release")
        XCTAssertEqual(ordinaryPresentation.actions, [.edit, .makeActive, .archive])
        XCTAssertTrue(ordinaryPresentation.mutationsAreEnabled)
        XCTAssertFalse(ordinaryPresentation.isBrowsing)
        XCTAssertFalse(ordinaryPresentation.isActive)

        let browsedPresentation = KanbanBoardRowPresentation(
            board: ordinary,
            selectedBoardSlug: "release",
            sharedActiveBoardSlug: "main",
            canManageBoards: true
        )
        XCTAssertNil(browsedPresentation.browseSlug)
        XCTAssertEqual(browsedPresentation.actions, [.edit, .makeActive, .archive])
        XCTAssertTrue(browsedPresentation.isBrowsing)

        let activePresentation = KanbanBoardRowPresentation(
            board: ordinary,
            selectedBoardSlug: "main",
            sharedActiveBoardSlug: "release",
            canManageBoards: true
        )
        XCTAssertEqual(activePresentation.browseSlug, "release")
        XCTAssertEqual(activePresentation.actions, [.edit, .archive])
        XCTAssertTrue(activePresentation.isActive)

        let defaultBoard: KanbanBoard = mutationDecode(
            #"{"slug":"default","name":"Default"}"#
        )
        let defaultPresentation = KanbanBoardRowPresentation(
            board: defaultBoard,
            selectedBoardSlug: "release",
            sharedActiveBoardSlug: "release",
            canManageBoards: true
        )
        XCTAssertEqual(defaultPresentation.browseSlug, "default")
        XCTAssertEqual(defaultPresentation.actions, [.edit, .makeActive])
        XCTAssertFalse(defaultPresentation.actions.contains(.archive))
    }

    func testBoardRowPresentationDisablesAllMutationsWhenManagementIsUnavailable() {
        let board: KanbanBoard = mutationDecode(
            #"{"slug":"release","name":"Release"}"#
        )
        let presentation = KanbanBoardRowPresentation(
            board: board,
            selectedBoardSlug: "main",
            sharedActiveBoardSlug: "main",
            canManageBoards: false
        )

        XCTAssertEqual(presentation.browseSlug, "release")
        XCTAssertEqual(presentation.actions, [.edit, .makeActive, .archive])
        XCTAssertFalse(presentation.mutationsAreEnabled)
        XCTAssertEqual(KanbanBoardRowAction.edit.systemImage, "pencil")
        XCTAssertEqual(KanbanBoardRowAction.makeActive.systemImage, "checkmark.circle")
        XCTAssertEqual(KanbanBoardRowAction.archive.systemImage, "archivebox")

        let invalidBoard: KanbanBoard = mutationDecode(
            #"{"name":"Missing slug"}"#
        )
        let invalidPresentation = KanbanBoardRowPresentation(
            board: invalidBoard,
            selectedBoardSlug: "main",
            sharedActiveBoardSlug: "main",
            canManageBoards: true
        )
        XCTAssertNil(invalidPresentation.browseSlug)
        XCTAssertFalse(invalidPresentation.isBrowsing)
        XCTAssertFalse(invalidPresentation.mutationsAreEnabled)
        XCTAssertTrue(invalidPresentation.actions.isEmpty)
    }

    func testCardRowPrimaryActionKeepsNavigationAndSelectionDistinct() throws {
        let card = try XCTUnwrap(KanbanFixtures.richSnapshot.columns?[1].cards?.first)
        let cardID = try XCTUnwrap(card.cardID)

        XCTAssertEqual(
            KanbanCardRowPrimaryAction.resolve(for: card, isSelecting: false),
            .openDetail(cardID)
        )
        XCTAssertEqual(
            KanbanCardRowPrimaryAction.resolve(for: card, isSelecting: true),
            .toggleSelection(cardID)
        )
        XCTAssertEqual(
            KanbanCardRowPrimaryAction.focusTarget(
                afterDismissing: cardID,
                visibleCards: [card]
            ),
            cardID
        )
        XCTAssertNil(
            KanbanCardRowPrimaryAction.focusTarget(
                afterDismissing: cardID,
                visibleCards: []
            )
        )

        let missingIdentity: KanbanCard = mutationDecode(#"{"title":"Missing identity"}"#)
        XCTAssertNil(
            KanbanCardRowPrimaryAction.resolve(for: missingIdentity, isSelecting: false)
        )
        XCTAssertNil(
            KanbanCardRowPrimaryAction.resolve(for: missingIdentity, isSelecting: true)
        )
    }

    func testStatusSpecificStalenessThresholds() {
        let cards = KanbanFixtures.stalenessSnapshot.columns?.flatMap { $0.cards ?? [] } ?? []
        XCTAssertEqual(cards.map(\.staleness), [
            .none, .warning, .critical,
            .none, .warning,
            .none, .warning, .critical
        ])
    }

}

private actor DeferredFirstConfigurationClient: KanbanDataClient {
    private var configurationCalls = 0
    private var continuation: CheckedContinuation<KanbanConfiguration, Error>?

    func kanbanConfiguration() async throws -> KanbanConfiguration {
        configurationCalls += 1
        if configurationCalls == 1 {
            return try await withCheckedThrowingContinuation { continuation = $0 }
        }
        return KanbanFixtures.configuration
    }

    func kanbanBoards() -> KanbanBoardsResponse { KanbanFixtures.boards }
    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot { KanbanFixtures.snapshot }
    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }

    func waitForFirstConfiguration() async {
        while continuation == nil { await Task.yield() }
    }

    func resumeFirstConfiguration() {
        continuation?.resume(returning: KanbanFixtures.configuration)
        continuation = nil
    }
}

private actor DeferredBoardClient: KanbanDataClient {
    private var boardCallCount = 0
    private var continuation: CheckedContinuation<KanbanBoardSnapshot, Never>?

    func kanbanConfiguration() -> KanbanConfiguration { KanbanFixtures.configuration }
    func kanbanBoards() -> KanbanBoardsResponse { KanbanFixtures.boards }
    func kanbanBoard(_ request: KanbanBoardRequest) async -> KanbanBoardSnapshot {
        boardCallCount += 1
        if boardCallCount == 1 { return KanbanFixtures.richSnapshot }
        if boardCallCount == 2 {
            return await withCheckedContinuation { continuation = $0 }
        }
        return KanbanFixtures.newSnapshot
    }
    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }

    func waitForDeferredRead() async {
        while continuation == nil { await Task.yield() }
    }

    func resumeDeferredRead() {
        continuation?.resume(returning: KanbanFixtures.staleSnapshot)
        continuation = nil
    }
}

private actor DeferredBoardSwitchClient: KanbanDataClient {
    private var boardCallCount = 0
    private var releaseContinuation: CheckedContinuation<KanbanBoardSnapshot, Never>?

    func kanbanConfiguration() -> KanbanConfiguration { KanbanFixtures.configuration }
    func kanbanBoards() -> KanbanBoardsResponse { KanbanFixtures.multiBoards }
    func kanbanBoard(_ request: KanbanBoardRequest) async -> KanbanBoardSnapshot {
        boardCallCount += 1
        if boardCallCount == 1 { return KanbanFixtures.supportedSnapshot }
        return await withCheckedContinuation { releaseContinuation = $0 }
    }
    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }

    func waitForReleaseRead() async {
        while releaseContinuation == nil { await Task.yield() }
    }

    func resumeReleaseRead() {
        releaseContinuation?.resume(returning: KanbanFixtures.futureSnapshot)
        releaseContinuation = nil
    }
}

private actor MissingChangedRefreshClient: KanbanDataClient {
    private var boardCallCount = 0

    func kanbanConfiguration() -> KanbanConfiguration { KanbanFixtures.configuration }
    func kanbanBoards() -> KanbanBoardsResponse { KanbanFixtures.boards }
    func kanbanBoard(_ request: KanbanBoardRequest) -> KanbanBoardSnapshot {
        boardCallCount += 1
        return boardCallCount == 1 ? KanbanFixtures.richSnapshot : KanbanFixtures.missingChangedSnapshot
    }
    func kanbanStats(board: String) -> KanbanStats { KanbanFixtures.stats }
    func kanbanAssignees(board: String) -> KanbanAssigneeHistory { KanbanFixtures.history }
}

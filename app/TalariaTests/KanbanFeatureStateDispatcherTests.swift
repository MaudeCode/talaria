import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
extension KanbanFeatureStateTests {
    func testPreviewDispatchIsOptionalSingleFlightTimestampedAndBecomesStaleAfterRefresh() async {
        let completedAt = Date(timeIntervalSince1970: 1_750_000_000)
        let client = DispatcherClient(defersFirstDispatch: true)
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client,
            now: { completedAt }
        )
        await state.load()

        let preview = Task { await state.previewDispatch() }
        await client.waitForDeferredDispatch()
        await state.previewDispatch()

        let inFlightRequestCount = await client.dispatchRequestCount
        XCTAssertEqual(inFlightRequestCount, 1)
        XCTAssertEqual(state.dispatcherAvailability, .busy)
        await client.resumeDeferredDispatch()
        await preview.value

        XCTAssertEqual(state.dispatchState?.mode, .preview)
        XCTAssertEqual(state.dispatchState?.phase, .succeeded)
        XCTAssertEqual(state.dispatchState?.completedAt, completedAt)
        let previewRequest = await client.dispatchRequests.first
        XCTAssertEqual(previewRequest?.dryRun, true)
        XCTAssertFalse(state.isPreviewStale)

        await state.refresh()

        XCTAssertTrue(state.isPreviewStale)
        let finalRequestCount = await client.dispatchRequestCount
        XCTAssertEqual(finalRequestCount, 1)
    }

    func testDispatcherToolbarResultPersistsUntilExplicitDismissal() async {
        let client = DispatcherClient()
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()

        XCTAssertFalse(KanbanDispatcherPresentation.hasResult(state.dispatchState))
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarAccessibilityLabel(for: state.dispatchState),
            String(localized: "Dispatcher")
        )

        await state.previewDispatch()

        XCTAssertTrue(KanbanDispatcherPresentation.hasResult(state.dispatchState))
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarAccessibilityLabel(for: state.dispatchState),
            String(localized: "Dispatcher, result available")
        )

        let failed = KanbanDispatchState(
            mode: .preview,
            boardSlug: "main",
            phase: .failed,
            result: nil,
            completedAt: nil,
            boardActivityGeneration: 0
        )
        let refused = KanbanDispatchState(
            mode: .run,
            boardSlug: "main",
            phase: .refused,
            result: nil,
            completedAt: nil,
            boardActivityGeneration: 0
        )
        let uncertain = KanbanDispatchState(
            mode: .run,
            boardSlug: "main",
            phase: .outcomeUncertain,
            result: nil,
            completedAt: nil,
            boardActivityGeneration: 0
        )
        let uncertainWithResult = KanbanDispatchState(
            mode: .run,
            boardSlug: "main",
            phase: .outcomeUncertain,
            result: state.dispatchState?.result,
            completedAt: nil,
            boardActivityGeneration: 0
        )
        XCTAssertFalse(KanbanDispatcherPresentation.hasResult(failed))
        XCTAssertFalse(KanbanDispatcherPresentation.hasResult(refused))
        XCTAssertFalse(KanbanDispatcherPresentation.hasResult(uncertain))
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarSystemImage(for: failed),
            "bolt.horizontal.circle"
        )
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarSystemImage(for: refused),
            "bolt.horizontal.circle"
        )
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarSystemImage(for: uncertain),
            "exclamationmark.circle.fill",
            "Ambiguous-outcome recovery must use a distinct, visibly reopenable indicator."
        )
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarAccessibilityLabel(for: uncertain),
            String(localized: "Dispatcher, attention required")
        )
        XCTAssertTrue(KanbanDispatcherPresentation.hasResult(uncertainWithResult))
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarSystemImage(for: state.dispatchState),
            "bolt.horizontal.circle.fill"
        )
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarSystemImage(for: uncertainWithResult),
            "bolt.horizontal.circle.fill"
        )
        XCTAssertEqual(
            KanbanDispatcherPresentation.toolbarAccessibilityLabel(for: uncertainWithResult),
            String(localized: "Dispatcher, result available")
        )

        state.dismissDispatchResult()

        XCTAssertNil(state.dispatchState)
        XCTAssertFalse(KanbanDispatcherPresentation.hasResult(state.dispatchState))
    }

    func testRunDispatcherJoinsBoardWideLockAndAlwaysReconcilesWithoutRequiringPreview() async {
        let multipleBoards: KanbanBoardsResponse = mutationDecode(
            #"{"boards":[{"slug":"main"},{"slug":"release"}],"current":"main","read_only":false}"#
        )
        let client = DispatcherClient(
            boardsResponses: [multipleBoards],
            defersFirstDispatch: true
        )
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()

        let run = Task { await state.runDispatcher() }
        await client.waitForDeferredDispatch()

        XCTAssertFalse(state.canMutateCards)
        XCTAssertFalse(state.canManageBoards)
        XCTAssertEqual(state.dispatcherAvailability, .busy)
        await state.previewDispatch()
        await state.selectBoard("release")
        let lockedRequestCount = await client.dispatchRequestCount
        XCTAssertEqual(lockedRequestCount, 1)
        XCTAssertEqual(state.selectedBoardSlug, "main")

        await client.resumeDeferredDispatch()
        await run.value

        XCTAssertEqual(state.dispatchState?.mode, .run)
        XCTAssertEqual(state.dispatchState?.phase, .succeeded)
        XCTAssertEqual(state.dispatchState?.result?.spawned, 1)
        let runRequest = await client.dispatchRequests.first
        let reconciledBoardRequestCount = await client.boardRequestCount
        XCTAssertEqual(runRequest?.dryRun, false)
        XCTAssertEqual(reconciledBoardRequestCount, 2, "Run must refetch the canonical Board.")
        XCTAssertTrue(state.canMutateCards)
    }

    func testAmbiguousRunRequiresSuccessfulRefreshAndAcknowledgementBeforeManualRetry() async {
        let client = DispatcherClient(
            dispatchResults: [
                .failure(APIError.network(underlying: URLError(.timedOut))),
                .failure(APIError.network(underlying: URLError(.timedOut)))
            ]
        )
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()

        await state.runDispatcher()

        XCTAssertEqual(state.dispatchState?.phase, .outcomeUncertain)
        XCTAssertFalse(state.dispatchState?.canAcknowledgeUncertainOutcome == true)
        XCTAssertEqual(state.dispatcherAvailability, .outcomeUncertain)
        XCTAssertNil(state.dispatchState?.result)
        let initialDispatchRequestCount = await client.dispatchRequestCount
        let initialBoardRequestCount = await client.boardRequestCount
        XCTAssertEqual(initialDispatchRequestCount, 1)
        XCTAssertEqual(initialBoardRequestCount, 2)

        state.dismissDispatchResult()
        XCTAssertEqual(state.dispatchState?.phase, .outcomeUncertain)
        await state.runDispatcher()
        let requestCountAfterBlockedRetry = await client.dispatchRequestCount
        XCTAssertEqual(requestCountAfterBlockedRetry, 1)

        await state.refreshUncertainDispatchOutcome()

        XCTAssertEqual(state.dispatchState?.phase, .outcomeUncertain)
        XCTAssertTrue(state.dispatchState?.canAcknowledgeUncertainOutcome == true)
        var dispatchRequestCount = await client.dispatchRequestCount
        var boardRequestCount = await client.boardRequestCount
        XCTAssertEqual(dispatchRequestCount, 1, "A refresh must never retry Run Dispatcher.")
        XCTAssertEqual(boardRequestCount, 3)

        state.dismissDispatchResult()
        XCTAssertNil(state.dispatchState)

        await state.runDispatcher()

        dispatchRequestCount = await client.dispatchRequestCount
        boardRequestCount = await client.boardRequestCount
        XCTAssertEqual(dispatchRequestCount, 2, "Only an acknowledged manual retry may submit again.")
        XCTAssertEqual(boardRequestCount, 4)
    }

    func testKnownDispatchResultResolvesAfterFailedReconciliationThenSuccessfulRefresh() async {
        let client = DispatcherClient(boardResults: [
            .success(mutationSnapshot()),
            .failure(APIError.http(statusCode: 503, body: nil)),
            .success(mutationSnapshot(status: "running"))
        ])
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()

        await state.runDispatcher()

        XCTAssertEqual(state.dispatchState?.phase, .outcomeUncertain)
        XCTAssertNotNil(state.dispatchState?.result)
        XCTAssertTrue(state.refreshFailed)
        XCTAssertEqual(state.dispatcherAvailability, .refreshFailed)

        await state.refreshUncertainDispatchOutcome()

        XCTAssertEqual(state.dispatchState?.phase, .succeeded)
        XCTAssertFalse(state.refreshFailed)
        let dispatchRequestCount = await client.dispatchRequestCount
        let boardRequestCount = await client.boardRequestCount
        XCTAssertEqual(dispatchRequestCount, 1)
        XCTAssertEqual(boardRequestCount, 3)
    }

    func testMalformedRunResultIsUncertainWhilePreviewFailureIsSafeAndRetryable() async {
        let malformed = KanbanDispatchResponseError.missingResultCategories
        let runClient = DispatcherClient(dispatchResults: [.failure(malformed)])
        let runState = KanbanFeatureState(
            server: URL(string: "https://run.example.test")!,
            defaults: defaults,
            client: runClient
        )
        await runState.load()
        await runState.runDispatcher()
        XCTAssertEqual(runState.dispatchState?.phase, .outcomeUncertain)
        let malformedRunRequestCount = await runClient.dispatchRequestCount
        XCTAssertEqual(malformedRunRequestCount, 1)

        let previewClient = DispatcherClient(dispatchResults: [.failure(malformed)])
        let previewState = KanbanFeatureState(
            server: URL(string: "https://preview.example.test")!,
            defaults: defaults,
            client: previewClient
        )
        await previewState.load()
        await previewState.previewDispatch()
        XCTAssertEqual(previewState.dispatchState?.phase, .failed)
        XCTAssertEqual(previewState.dispatcherAvailability, .available)
    }

    func testDispatcherRefusalIncompatibilityPartialCapabilityAndOfflineStayDistinct() async {
        let refusalClient = DispatcherClient(
            dispatchResults: [.failure(APIError.http(statusCode: 409, body: nil))]
        )
        let refusal = KanbanFeatureState(
            server: URL(string: "https://refusal.example.test")!,
            defaults: defaults,
            client: refusalClient
        )
        await refusal.load()
        await refusal.runDispatcher()
        XCTAssertEqual(refusal.dispatchState?.phase, .refused)
        XCTAssertFalse(refusal.dispatcherCapabilityIsIncompatible)

        let incompatibleClient = DispatcherClient(
            dispatchResults: [.failure(APIError.http(statusCode: 404, body: nil))]
        )
        let incompatible = KanbanFeatureState(
            server: URL(string: "https://old.example.test")!,
            defaults: defaults,
            client: incompatibleClient
        )
        await incompatible.load()
        await incompatible.previewDispatch()
        XCTAssertEqual(incompatible.dispatchState?.phase, .refused)
        XCTAssertEqual(incompatible.dispatcherAvailability, .incompatible)

        let partialClient = DispatcherClient(statsError: KanbanResponseError.nonJSONContentType)
        let partial = KanbanFeatureState(
            server: URL(string: "https://partial.example.test")!,
            defaults: defaults,
            client: partialClient
        )
        await partial.load()
        XCTAssertEqual(partial.state, .partial)
        XCTAssertEqual(partial.dispatcherAvailability, .available)

        let missingWriteCapability = DispatcherClient(
            configuration: mutationDecode(
                #"{"columns":["triage","todo","ready","running","blocked","done"]}"#
            )
        )
        let unavailable = KanbanFeatureState(
            server: URL(string: "https://unknown.example.test")!,
            defaults: defaults,
            client: missingWriteCapability
        )
        await unavailable.load()
        XCTAssertEqual(unavailable.state, .partial)
        XCTAssertEqual(unavailable.dispatcherAvailability, .incompatible)

        let offlineClient = DispatcherClient(
            dispatchResults: [
                .failure(APIError.network(underlying: URLError(.notConnectedToInternet)))
            ]
        )
        let offline = KanbanFeatureState(
            server: URL(string: "https://offline.example.test")!,
            defaults: defaults,
            client: offlineClient
        )
        await offline.load()
        await offline.previewDispatch()
        XCTAssertEqual(offline.dispatcherAvailability, .offline)
    }

    func testRunReportsRemovedBoardAndDispatcherStateNeverCrossesServers() async {
        let removedBoards: KanbanBoardsResponse = mutationDecode(
            #"{"boards":[{"slug":"release"}],"current":"release","read_only":false}"#
        )
        let firstClient = DispatcherClient(boardsResponses: [
            mutationDecode(#"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#),
            removedBoards
        ])
        let secondClient = DispatcherClient()
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

        await first.runDispatcher()

        XCTAssertEqual(first.dispatchState?.phase, .boardUnavailable)
        XCTAssertNil(first.selectedBoardSlug)
        XCTAssertNotNil(first.boardSelectionNotice)
        XCTAssertNil(second.dispatchState)
        let secondDispatchRequestCount = await secondClient.dispatchRequestCount
        XCTAssertEqual(secondDispatchRequestCount, 0)
    }

    func testObsoleteDispatchCollectionCannotOverwriteReloadedState() async {
        let client = DeferredBoardCollectionClient()
        let state = KanbanFeatureState(
            server: URL(string: "https://example.test")!,
            defaults: defaults,
            client: client
        )
        await state.load()

        let run = Task { await state.runDispatcher() }
        await client.waitForDeferredCollection()

        await state.load()
        await client.resumeDeferredCollection(
            mutationDecode(
                #"{"boards":[{"slug":"release"}],"current":"release","read_only":false}"#
            )
        )
        await run.value

        XCTAssertEqual(state.selectedBoardSlug, "main")
        XCTAssertEqual(state.boards.compactMap(\.slug), ["main"])
        XCTAssertNil(state.boardSelectionNotice)
        XCTAssertNil(state.dispatchState)
    }

}

private actor DispatcherClient: KanbanDataClient {
    private let configuration: KanbanConfiguration
    private var boardsResponses: [KanbanBoardsResponse]
    private var boardResults: [Result<KanbanBoardSnapshot, Error>]
    private var dispatchResults: [Result<KanbanDispatchResult, Error>]
    private let statsError: Error?
    private var shouldDeferDispatch: Bool
    private var dispatchContinuation: CheckedContinuation<Void, Never>?
    private(set) var dispatchRequests: [KanbanDispatchRequest] = []
    private(set) var boardRequestCount = 0

    var dispatchRequestCount: Int { dispatchRequests.count }

    init(
        configuration: KanbanConfiguration = mutationDecode(
            #"{"columns":["triage","todo","ready","running","blocked","done"],"read_only":false}"#
        ),
        boardsResponses: [KanbanBoardsResponse] = [
            mutationDecode(#"{"boards":[{"slug":"main"}],"current":"main","read_only":false}"#)
        ],
        boardSnapshots: [KanbanBoardSnapshot] = [mutationSnapshot()],
        boardResults: [Result<KanbanBoardSnapshot, Error>]? = nil,
        dispatchResults: [Result<KanbanDispatchResult, Error>] = [
            .success(mutationDecode(
                #"{"spawned":[{"future":"shape"}],"promoted":0,"reclaimed":0,"skipped_unassigned":[],"skipped_nonspawnable":[],"auto_blocked":[],"timed_out":[],"crashed":[]}"#
            ))
        ],
        statsError: Error? = nil,
        defersFirstDispatch: Bool = false
    ) {
        self.configuration = configuration
        self.boardsResponses = boardsResponses
        self.boardResults = boardResults ?? boardSnapshots.map(Result.success)
        self.dispatchResults = dispatchResults
        self.statsError = statsError
        shouldDeferDispatch = defersFirstDispatch
    }

    func kanbanConfiguration() -> KanbanConfiguration {
        configuration
    }

    func kanbanBoards() -> KanbanBoardsResponse {
        if boardsResponses.count > 1 { return boardsResponses.removeFirst() }
        return boardsResponses[0]
    }

    func kanbanBoard(_ request: KanbanBoardRequest) throws -> KanbanBoardSnapshot {
        boardRequestCount += 1
        if boardResults.count > 1 { return try boardResults.removeFirst().get() }
        return try boardResults[0].get()
    }

    func kanbanStats(board: String) throws -> KanbanStats {
        if let statsError { throw statsError }
        return mutationDecode("{}")
    }

    func kanbanAssignees(board: String) -> KanbanAssigneeHistory {
        mutationDecode("{}")
    }

    func dispatchKanban(_ request: KanbanDispatchRequest) async throws -> KanbanDispatchResult {
        dispatchRequests.append(request)
        if shouldDeferDispatch {
            shouldDeferDispatch = false
            await withCheckedContinuation { dispatchContinuation = $0 }
        }
        return try dispatchResults.removeFirst().get()
    }

    func waitForDeferredDispatch() async {
        while dispatchContinuation == nil { await Task.yield() }
    }

    func resumeDeferredDispatch() {
        dispatchContinuation?.resume()
        dispatchContinuation = nil
    }
}

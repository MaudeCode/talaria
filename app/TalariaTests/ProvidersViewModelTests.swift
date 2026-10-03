import XCTest
@testable import Talaria
@testable import TalariaKit

final class ProvidersViewModelTests: APIClientTestCase {
    private static let serverURL = URL(string: "https://example.test")!

    /// Routes only this test's requests to `handler`, so a refresh loop request
    /// cancelled at the end of one test cannot reach the next test's handler.
    private func makeScopedClient(
        handler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)
    ) -> APIClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        configuration.httpAdditionalHeaders = [MockURLProtocol.scopeHeader: MockURLProtocol.register(handler)]
        return APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
    }

    @MainActor
    func testLoadQuotasKeepsDuplicateProviderAccountsDistinct() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_widget",
              "profile_id": "default",
              "sources": [
                {
                  "source_id": "qsrc_work",
                  "provider_id": "openai-codex",
                  "provider_label": "Codex",
                  "account_label": "Work",
                  "status": "available",
                  "supported": true,
                  "windows": [{ "label": "Session", "used_percent": 25, "remaining_percent": 75 }]
                },
                {
                  "source_id": "qsrc_personal",
                  "provider_id": "openai-codex",
                  "provider_label": "Codex",
                  "account_label": "Personal",
                  "status": "available",
                  "supported": true,
                  "windows": [{ "label": "Weekly", "used_percent": 40, "remaining_percent": 60 }]
                },
                {
                  "source_id": "qsrc_openrouter",
                  "provider_id": "openrouter",
                  "provider_label": "OpenRouter",
                  "account_label": "OpenRouter",
                  "status": "available",
                  "supported": true,
                  "windows": []
                }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_work", "qsrc_personal", "qsrc_openrouter"])
        XCTAssertEqual(model.quotaSources.map(\.accountLabel), ["Work", "Personal", "OpenRouter"])
        XCTAssertTrue(model.hasStableQuotaSources)
        XCTAssertNil(model.quotaErrorMessage)
    }

    @MainActor
    func testQuotaReloadTracksRenameReorderingAndRemovalByStableIdentity() async throws {
        var load = 0
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            load += 1
            if load == 1 {
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "scope_id": "qscope_default",
                  "profile_id": "default",
                  "sources": [
                    { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [] },
                    { "source_id": "qsrc_b", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "B", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_default",
              "profile_id": "default",
              "sources": [
                { "source_id": "qsrc_b", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "B renamed", "status": "available", "supported": true, "windows": [] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_b"])
        XCTAssertEqual(model.quotaSources[0].accountLabel, "B renamed")
    }

    /// TAL-272: a same-scope reload whose provider now carries a new source id used to
    /// keep the old id as a `removed` row, so Insights showed the provider twice.
    @MainActor
    func testSameScopeReloadRendersOnlyServerSourcesWithoutDuplicateProviderCards() async throws {
        var load = 0
        let client = makeClient { request in
            load += 1
            let codexID = load == 1 ? "qsrc_codex_old" : "qsrc_codex_new"
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_default",
              "profile_id": "default",
              "sources": [
                { "source_id": "\(codexID)", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Codex", "status": "available", "supported": true, "windows": [] },
                { "source_id": "qsrc_openrouter", "provider_id": "openrouter", "provider_label": "OpenRouter", "account_label": "OpenRouter", "status": "available", "supported": true, "windows": [] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_codex_new", "qsrc_openrouter"])
        XCTAssertEqual(model.quotaSources.map(\.providerID), ["openai-codex", "openrouter"])
    }

    @MainActor
    func testSnapshotRestoreDropsRemovedRowsFromOlderBuilds() throws {
        let suite = "ProvidersViewModelSnapshotRestore.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let row = { (id: String, status: String) in
            ProviderQuotaWidgetSource(
                sourceID: id,
                scopeLabel: "Server · default",
                providerID: "openai-codex",
                providerLabel: "Codex",
                accountLabel: "Codex",
                isActiveProvider: false,
                status: status,
                plan: nil,
                windows: [],
                retryAfter: nil,
                fetchedAt: nil
            )
        }
        XCTAssertTrue(store.save(
            scopeID: "qscope_default",
            sources: [row("qsrc_codex_new", "available"), row("qsrc_codex_old", "removed")]
        ))

        let model = ProvidersViewModel(
            server: Self.serverURL,
            client: makeClient { request in apiTestJSONResponse("{}", for: request) },
            quotaSnapshotStore: store,
            reloadQuotaWidgets: {}
        )

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_codex_new"])
    }

    @MainActor
    func testTargetedRefreshOfMissingSourceDropsItsRowAndNeverAppendsUnknownRows() async throws {
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            let source = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first { $0.name == "source" }?.value
            switch source {
            case nil:
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "scope_id": "qscope_default",
                  "profile_id": "default",
                  "sources": [
                    { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [] },
                    { "source_id": "qsrc_b", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "B", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            case "qsrc_a":
                return apiTestJSONResponse("""
                { "version": 1, "scope_id": "qscope_default", "profile_id": "default", "requested_source_id": "qsrc_a", "missing_source": true, "sources": [] }
                """, for: request)
            default:
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "scope_id": "qscope_default",
                  "profile_id": "default",
                  "requested_source_id": "qsrc_c",
                  "sources": [
                    { "source_id": "qsrc_c", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "C", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            }
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.refreshQuota(sourceID: "qsrc_a")
        await model.refreshQuota(sourceID: "qsrc_c")

        XCTAssertEqual(requestCount, 3)
        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_b"])
    }

    @MainActor
    func testQuotaReloadDiscardsRemovedSourcesWhenScopeChanges() async throws {
        let suite = "ProvidersViewModelScopeChange.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        var load = 0
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            load += 1
            if load == 1 {
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "scope_id": "qscope_old",
                  "profile_id": "default",
                  "sources": [
                    { "source_id": "qsrc_old", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Codex", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_new",
              "profile_id": "default",
              "sources": [
                { "source_id": "qsrc_new", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Codex", "status": "available", "supported": true, "windows": [] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(
            server: Self.serverURL,
            client: client,
            quotaSnapshotStore: store,
            reloadQuotaWidgets: {}
        )

        await model.loadQuotas()
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_new"])
        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_new"])
        XCTAssertEqual(store.load()?.sources.map(\.scopeID), ["qscope_new"])
    }

    @MainActor
    func testQuotaReloadDiscardsUnscopedSourcesWhenScopeBecomesKnown() async throws {
        var load = 0
        let client = makeClient { request in
            load += 1
            if load == 1 {
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "profile_id": "default",
                  "sources": [
                    { "source_id": "qsrc_old", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Old", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_new",
              "profile_id": "default",
              "sources": [
                { "source_id": "qsrc_new", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "New", "status": "available", "supported": true, "windows": [] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_new"])
        XCTAssertEqual(model.quotaScopeID, "qscope_new")
    }

    @MainActor
    func testQuotaReloadDiscardsScopedSourcesWhenScopeBecomesMissing() async throws {
        var load = 0
        let client = makeClient { request in
            load += 1
            if load == 1 {
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "scope_id": "qscope_old",
                  "profile_id": "default",
                  "sources": [
                    { "source_id": "qsrc_old", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Old", "status": "available", "supported": true, "windows": [] }
                  ]
                }
                """, for: request)
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "profile_id": "default",
              "sources": [
                { "source_id": "qsrc_new", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "New", "status": "available", "supported": true, "windows": [] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources.map(\.id), ["qsrc_new"])
        XCTAssertNil(model.quotaScopeID)
    }

    @MainActor
    func testMissingMultiSourceEndpointIsAnError() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            return (
                HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!,
                Data()
            )
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas(refresh: true)

        XCTAssertTrue(model.quotaSources.isEmpty)
        XCTAssertFalse(model.hasStableQuotaSources)
        XCTAssertNotNil(model.quotaErrorMessage)
    }

    @MainActor
    func testTargetedQuotaRefreshUpdatesOnlySelectedSource() async throws {
        var requestCount = 0
        let client = makeClient { request in
            requestCount += 1
            if requestCount == 1 {
                return apiTestJSONResponse("""
                {
                  "version": 1,
                  "sources": [
                    { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 10 }] },
                    { "source_id": "qsrc_b", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "B", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 20 }] }
                  ]
                }
                """, for: request)
            }
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            })
            XCTAssertEqual(query["source"], "qsrc_b")
            XCTAssertEqual(query["refresh"], "1")
            return apiTestJSONResponse("""
            {
              "version": 1,
              "requested_source_id": "qsrc_b",
              "sources": [
                { "source_id": "qsrc_b", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "B", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 30 }] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()
        await model.refreshQuota(sourceID: "qsrc_b")

        XCTAssertEqual(model.quotaSources[0].windows.first?.usedPercent, 10)
        XCTAssertEqual(model.quotaSources[1].windows.first?.usedPercent, 30)
    }

    @MainActor
    func testTargetedQuotaRefreshCannotOverwriteNewerFullLoad() async throws {
        let initialRequestArrived = expectation(description: "initial quota request arrived")
        let targetedRequestArrived = expectation(description: "targeted quota request arrived")
        let reloadRequestArrived = expectation(description: "quota reload request arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pendingRequest in
            switch requests.append(pendingRequest) {
            case 1: initialRequestArrived.fulfill()
            case 2: targetedRequestArrived.fulfill()
            case 3: reloadRequestArrived.fulfill()
            default: XCTFail("unexpected extra quota request")
            }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        let initialLoad = Task { await model.loadQuotas() }
        await fulfillment(of: [initialRequestArrived], timeout: 5)
        requests.request(at: 0).complete(withJSON: """
        {
          "version": 1,
          "profile_id": "default",
          "sources": [
            { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 20 }] }
          ]
        }
        """)
        await initialLoad.value

        let staleRefresh = Task { await model.refreshQuota(sourceID: "qsrc_a") }
        await fulfillment(of: [targetedRequestArrived], timeout: 5)

        let freshLoad = Task { await model.loadQuotas(refresh: true) }
        await fulfillment(of: [reloadRequestArrived], timeout: 5)
        requests.request(at: 2).complete(withJSON: """
        {
          "version": 1,
          "profile_id": "work",
          "sources": [
            { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Work", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 70 }] }
          ]
        }
        """)
        await freshLoad.value

        requests.request(at: 1).complete(withJSON: """
        {
          "version": 1,
          "profile_id": "default",
          "requested_source_id": "qsrc_a",
          "sources": [
            { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": 99 }] }
          ]
        }
        """)
        await staleRefresh.value

        XCTAssertEqual(model.quotaProfileID, "work")
        XCTAssertEqual(model.quotaSources.first?.accountLabel, "Work")
        XCTAssertEqual(model.quotaSources.first?.windows.first?.usedPercent, 70)
        XCTAssertNil(model.quotaErrorMessage)
    }

    @MainActor
    func testQuotaFormattingUsesReturnedPercentWithoutInventingZero() {
        let used = ProviderQuotaWindow(label: "Session", usedPercent: 25)
        let remaining = ProviderQuotaWindow(label: "Weekly", remainingPercent: 60)
        let missing = ProviderQuotaWindow(label: "Monthly")

        XCTAssertEqual(ProvidersViewModel.quotaUsedPercent(used), 25)
        XCTAssertEqual(ProvidersViewModel.quotaUsedPercent(remaining), 40)
        XCTAssertNil(ProvidersViewModel.quotaUsedPercent(missing))
        XCTAssertEqual(
            ProvidersViewModel.quotaPercentText(used, locale: Locale(identifier: "en_US")),
            "25% used"
        )
    }

    @MainActor
    func testStableQuotaLoadPersistsSanitizedWidgetSnapshotAndReloadsTimeline() async throws {
        let suite = "ProvidersViewModelWidgetSnapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        var reloadCount = 0
        let client = makeClient { request in
            apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_widget",
              "profile_id": "default",
              "sources": [{
                "source_id": "qsrc_widget",
                "provider_id": "openai-codex",
                "provider_label": "Codex",
                "account_label": "Widget account",
                "status": "available",
                "supported": true,
                "windows": [{ "label": "Session", "used_percent": 25 }]
              }]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(
            server: Self.serverURL,
            client: client,
            quotaSnapshotStore: store,
            reloadQuotaWidgets: { reloadCount += 1 }
        )

        await model.loadQuotas()

        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_widget"])
        XCTAssertEqual(reloadCount, 1)
    }

    @MainActor
    func testCancelledQuotaLoadCannotRestoreClearedWidgetSnapshot() async throws {
        let requestArrived = expectation(description: "quota request arrived")
        let requests = DeferredRequests()
        DeferredMockURLProtocol.onRequest = { request in
            _ = requests.append(request)
            requestArrived.fulfill()
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let suite = "ProvidersViewModelCancelledWidgetSnapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
        let model = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store)

        let staleLoad = Task { await model.loadQuotas() }
        await fulfillment(of: [requestArrived], timeout: 5)
        model.cancelLoads()
        requests.request(at: 0).complete(withJSON: """
        {
          "version": 1,
          "scope_id": "qscope_old",
          "profile_id": "old",
          "sources": [
            { "source_id": "qsrc_old", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "Old", "status": "available", "supported": true, "windows": [] }
          ]
        }
        """)
        await staleLoad.value

        XCTAssertNil(store.load())
        XCTAssertTrue(model.quotaSources.isEmpty)
        XCTAssertFalse(model.isQuotaLoading)
    }

    @MainActor
    func testPeriodicQuotaRefreshForcesServerRefreshWhileVisible() async {
        let refreshed = expectation(description: "periodic quota refresh")
        var requestCount = 0
        let client = makeScopedClient { request in
            requestCount += 1
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            XCTAssertTrue(components?.queryItems?.contains(URLQueryItem(name: "refresh", value: "1")) == true)
            if requestCount == 1 {
                refreshed.fulfill()
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_widget",
              "profile_id": "default",
              "sources": []
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        let refreshTask = Task {
            await model.refreshQuotasPeriodically(every: .milliseconds(10))
        }
        await fulfillment(of: [refreshed], timeout: 2)
        refreshTask.cancel()
        await refreshTask.value

        XCTAssertFalse(model.isQuotaLoading)
    }

    @MainActor
    func testQuotaRefreshLoopReconcilesLoadedButStaleSourcesImmediately() async throws {
        let suite = "ProvidersViewModelStaleQuota.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        var requestedRefreshes: [Bool] = []
        let client = makeScopedClient { request in
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            let forced = components?.queryItems?.contains(URLQueryItem(name: "refresh", value: "1")) == true
            requestedRefreshes.append(forced)
            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_widget",
              "profile_id": "default",
              "sources": [
                { "source_id": "qsrc_a", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "A", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": \(forced ? 80 : 20) }] }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store)
        await model.loadQuotas()
        XCTAssertEqual(model.quotaSources.first?.windows.first?.usedPercent, 20)

        // Insights and the session list both join the shared schedule; with a long
        // interval, only the entry reconcile can produce a request.
        let insightsLoop = Task { await model.refreshQuotasPeriodically(every: .seconds(60)) }
        let sessionListLoop = Task { await model.refreshQuotasPeriodically(every: .seconds(60)) }
        try await Task.sleep(for: .milliseconds(500))
        insightsLoop.cancel()
        sessionListLoop.cancel()
        await insightsLoop.value
        await sessionListLoop.value

        XCTAssertEqual(requestedRefreshes, [false, true])
        XCTAssertEqual(model.quotaSources.first?.windows.first?.usedPercent, 80)
        XCTAssertEqual(store.load()?.sources.first?.windows.first?.usedPercent, 80)
        XCTAssertFalse(model.isQuotaLoading)
    }

    @MainActor
    func testQuotaRefreshLoopSkipsEntryRefreshWhenRecentlyForced() async throws {
        var requestCount = 0
        let client = makeScopedClient { request in
            requestCount += 1
            return apiTestJSONResponse("""
            { "version": 1, "scope_id": "qscope_widget", "profile_id": "default", "sources": [] }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)
        await model.loadQuotas(refresh: true)

        let loop = Task { await model.refreshQuotasPeriodically(every: .seconds(60)) }
        try await Task.sleep(for: .milliseconds(300))
        loop.cancel()
        await loop.value

        XCTAssertEqual(requestCount, 1)
    }

    @MainActor
    func testOlderFullQuotaLoadCannotOverwriteNewerTargetedRefresh() async throws {
        let requestsArrived = (1...5).map { expectation(description: "quota request \($0) arrived") }
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pendingRequest in
            let count = requests.append(pendingRequest)
            guard count <= requestsArrived.count else {
                XCTFail("unexpected extra quota request")
                return
            }
            requestsArrived[count - 1].fulfill()
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        func response(_ sourceIDs: [String], usedPercent: Int, requestedSourceID: String? = nil) -> String {
            let sources = sourceIDs.map {
                """
                { "source_id": "\($0)", "provider_id": "openai-codex", "provider_label": "Codex", "account_label": "\($0)", "status": "available", "supported": true, "windows": [{ "label": "Session", "used_percent": \(usedPercent) }] }
                """
            }
            return """
            {
              "version": 1,
              "scope_id": "qscope_widget",
              "profile_id": "default",
              \(requestedSourceID.map { "\"requested_source_id\": \"\($0)\"," } ?? "")
              "sources": [\(sources.joined(separator: ","))]
            }
            """
        }

        let initialLoad = Task { await model.loadQuotas() }
        await fulfillment(of: [requestsArrived[0]], timeout: 5)
        requests.request(at: 0).complete(withJSON: response(["qsrc_a", "qsrc_b", "qsrc_c"], usedPercent: 10))
        await initialLoad.value

        let periodicLoad = Task { await model.loadQuotas(refresh: true) }
        await fulfillment(of: [requestsArrived[1]], timeout: 5)
        let targetedA = Task { await model.refreshQuota(sourceID: "qsrc_a") }
        await fulfillment(of: [requestsArrived[2]], timeout: 5)
        requests.request(at: 2).complete(withJSON: response(["qsrc_a"], usedPercent: 90, requestedSourceID: "qsrc_a"))
        await targetedA.value
        let targetedB = Task { await model.refreshQuota(sourceID: "qsrc_b") }
        await fulfillment(of: [requestsArrived[3]], timeout: 5)
        requests.request(at: 3).complete(withJSON: response(["qsrc_b"], usedPercent: 90, requestedSourceID: "qsrc_b"))
        await targetedB.value
        // The older full response still lists qsrc_a and omits qsrc_b.
        requests.request(at: 1).complete(withJSON: response(["qsrc_a", "qsrc_c"], usedPercent: 30))
        await periodicLoad.value

        func source(_ id: String) -> ProviderQuotaSource? { model.quotaSources.first(where: { $0.id == id }) }
        XCTAssertEqual(source("qsrc_a")?.windows.first?.usedPercent, 90)
        XCTAssertEqual(source("qsrc_b")?.windows.first?.usedPercent, 90)
        XCTAssertEqual(source("qsrc_b")?.status, "available")
        XCTAssertEqual(source("qsrc_c")?.windows.first?.usedPercent, 30)

        // A later full load supersedes the targeted rows again.
        let laterLoad = Task { await model.loadQuotas(refresh: true) }
        await fulfillment(of: [requestsArrived[4]], timeout: 5)
        requests.request(at: 4).complete(withJSON: response(["qsrc_a", "qsrc_c"], usedPercent: 40))
        await laterLoad.value

        XCTAssertEqual(source("qsrc_a")?.windows.first?.usedPercent, 40)
        XCTAssertNil(source("qsrc_b"))
    }

    @MainActor
    func testLoadPopulatesProvidersPreservingServerOrder() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/providers")
            return apiTestJSONResponse("""
            {
              "active_provider": "openai-codex",
              "providers": [
                { "id": "openai-codex", "display_name": "OpenAI Codex", "has_key": true },
                { "id": "anthropic", "display_name": "Anthropic", "has_key": false },
                { "id": "custom:glmcode", "display_name": "glmcode", "has_key": true }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.load()

        XCTAssertNil(model.errorMessage)
        XCTAssertFalse(model.isLoading)
        XCTAssertEqual(model.providers.map(\.id), ["openai-codex", "anthropic", "custom:glmcode"])
        XCTAssertEqual(model.activeProviderID, "openai-codex")
        XCTAssertTrue(model.isActive(model.providers[0]))
        XCTAssertFalse(model.isActive(model.providers[1]))
    }

    @MainActor
    func testLoadFailureSetsErrorMessageAndKeepsEmptyList() async {
        let client = makeClient { request in
            (HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!, Data())
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.load()

        XCTAssertNotNil(model.errorMessage)
        XCTAssertTrue(model.providers.isEmpty)
        XCTAssertFalse(model.isLoading)
    }

    /// A failed pull-to-refresh must keep the cached providers *and* surface the
    /// error — the view shows a refresh-failure banner above the stale rows.
    @MainActor
    func testRefreshFailureKeepsCachedProvidersAndSetsErrorMessage() async {
        let client = makeClient { request in
            apiTestJSONResponse("""
            {
              "active_provider": "anthropic",
              "providers": [
                { "id": "anthropic", "display_name": "Anthropic", "has_key": true }
              ]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.load()
        XCTAssertEqual(model.providers.map(\.id), ["anthropic"])
        XCTAssertNil(model.errorMessage)

        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(
                url: request.url!,
                statusCode: 500,
                httpVersion: nil,
                headerFields: nil
            )!, Data())
        }

        await model.load()

        XCTAssertEqual(model.providers.map(\.id), ["anthropic"], "cached providers must survive a failed refresh")
        XCTAssertNotNil(model.errorMessage, "the failed refresh must be surfaced")
        XCTAssertFalse(model.isLoading)
    }

    /// `load()` has three overlapping entry points (`.task`, `.refreshable`,
    /// "Try Again"). When two loads race and their responses land out of order,
    /// the older response must be discarded: it may not overwrite newer provider
    /// data or the newer load's state (#42 Codex review).
    @MainActor
    func testStaleOverlappingLoadDoesNotOverwriteNewerResponse() async throws {
        let firstRequestArrived = expectation(description: "stale request arrived")
        let secondRequestArrived = expectation(description: "fresh request arrived")
        let requests = DeferredRequests()

        DeferredMockURLProtocol.onRequest = { pendingRequest in
            switch requests.append(pendingRequest) {
            case 1: firstRequestArrived.fulfill()
            case 2: secondRequestArrived.fulfill()
            default: XCTFail("unexpected extra providers request")
            }
        }
        defer { DeferredMockURLProtocol.onRequest = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        let staleLoad = Task { await model.load() }
        await fulfillment(of: [firstRequestArrived], timeout: 5)

        // A newer load starts while the first request is still in flight …
        let freshLoad = Task { await model.load() }
        await fulfillment(of: [secondRequestArrived], timeout: 5)

        // … and its response lands first.
        requests.request(at: 1).complete(withJSON: """
        { "active_provider": "fresh", "providers": [ { "id": "fresh" } ] }
        """)
        await freshLoad.value
        XCTAssertEqual(model.providers.map(\.id), ["fresh"])
        XCTAssertFalse(model.isLoading)

        // The stale response lands afterwards — it must be discarded.
        requests.request(at: 0).complete(withJSON: """
        { "active_provider": "stale", "providers": [ { "id": "stale" } ] }
        """)
        await staleLoad.value

        XCTAssertEqual(model.providers.map(\.id), ["fresh"], "a stale response must not overwrite newer data")
        XCTAssertEqual(model.activeProviderID, "fresh")
        XCTAssertFalse(model.isLoading)
        XCTAssertNil(model.errorMessage)
    }

    @MainActor
    func testActiveProviderMatchingIsTrimmedAndCaseInsensitive() {
        XCTAssertEqual(ProvidersViewModel.normalizedProviderID("  OpenAI-Codex \n"), "openai-codex")
        XCTAssertNil(ProvidersViewModel.normalizedProviderID("   "))
        XCTAssertNil(ProvidersViewModel.normalizedProviderID(nil))
    }

    @MainActor
    func testDisplayNameFallsBackFromDisplayNameToIDToPlaceholder() {
        XCTAssertEqual(
            ProvidersViewModel.displayName(for: ProviderSummary(id: "openai", displayName: "OpenAI")),
            "OpenAI"
        )
        XCTAssertEqual(
            ProvidersViewModel.displayName(for: ProviderSummary(id: "openai", displayName: "  ")),
            "openai"
        )
        XCTAssertEqual(
            ProvidersViewModel.displayName(for: ProviderSummary(id: nil)),
            String(localized: "Unknown provider")
        )
    }

    @MainActor
    func testKeySourceBadgeCollapsesUpstreamVocabulary() {
        func badge(_ keySource: String?, hasKey: Bool? = true) -> String? {
            ProvidersViewModel.keySourceBadge(
                for: ProviderSummary(id: "p", hasKey: hasKey, keySource: keySource)
            )
        }

        XCTAssertEqual(badge("env_file"), "env")
        XCTAssertEqual(badge("env_var"), "env")
        XCTAssertEqual(badge("env"), "env")
        XCTAssertEqual(badge("oauth"), "OAuth")
        XCTAssertEqual(badge("token"), "OAuth")
        XCTAssertEqual(badge("config_yaml"), "config")
        XCTAssertEqual(badge("config"), "config")
        XCTAssertEqual(badge(" OAuth "), "OAuth")

        // Unknown future sources pass through instead of being hidden.
        XCTAssertEqual(badge("keychain"), "keychain")

        // No badge without a key, or when the source is missing/none.
        XCTAssertNil(badge("none"))
        XCTAssertNil(badge(nil))
        XCTAssertNil(badge("oauth", hasKey: false))
        XCTAssertNil(badge("oauth", hasKey: nil))
    }

    @MainActor
    func testAuthErrorTextTrimsAndDropsEmptyValues() {
        XCTAssertEqual(
            ProvidersViewModel.authErrorText(
                for: ProviderSummary(id: "p", authError: "  token expired \n")
            ),
            "token expired"
        )
        XCTAssertNil(ProvidersViewModel.authErrorText(for: ProviderSummary(id: "p", authError: "   ")))
        XCTAssertNil(ProvidersViewModel.authErrorText(for: ProviderSummary(id: "p", authError: nil)))
    }

    @MainActor
    func testExpansionKeyPrefersStableProviderIDWithIndexFallback() {
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: " openai "), at: 3), "openai")
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: "   "), at: 3), "#3")
        XCTAssertEqual(ProvidersView.expansionKey(for: ProviderSummary(id: nil), at: 0), "#0")
    }

    @MainActor
    func testModelCountPrefersModelsTotalWhenListIsTrimmed() {
        let trimmed = ProviderSummary(
            id: "nous",
            models: [ProviderModel(id: "a"), ProviderModel(id: "b")],
            modelsTotal: 396
        )
        XCTAssertEqual(ProvidersViewModel.modelCount(for: trimmed), 396)
        let info = ProvidersViewModel.truncatedModelInfo(for: trimmed)
        XCTAssertEqual(info?.shown, 2)
        XCTAssertEqual(info?.total, 396)

        let complete = ProviderSummary(
            id: "openai",
            models: [ProviderModel(id: "a"), ProviderModel(id: "b")],
            modelsTotal: 2
        )
        XCTAssertEqual(ProvidersViewModel.modelCount(for: complete), 2)
        XCTAssertNil(ProvidersViewModel.truncatedModelInfo(for: complete))

        // No visible models -> no truncation footer even if a total is reported.
        let hidden = ProviderSummary(id: "p", models: [], modelsTotal: 4)
        XCTAssertNil(ProvidersViewModel.truncatedModelInfo(for: hidden))

        let bare = ProviderSummary(id: "p")
        XCTAssertEqual(ProvidersViewModel.modelCount(for: bare), 0)
        XCTAssertNil(ProvidersViewModel.truncatedModelInfo(for: bare))
    }

    /// ProvidersView: an error and no providers -> "Could not load providers" with Try Again; a
    /// retry that succeeds replaces it (formerly `ReadFailureUITests`, TAL-402).
    @MainActor
    func testFailedProviderLoadShowsTheFailureThenRetryLoadsProviders() async {
        var fails = true
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/providers")
            if fails {
                let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
                return (response, Data(#"{"error":"Fixture read failure"}"#.utf8))
            }
            return apiTestJSONResponse(#"{"providers":[{"id":"fixture-provider","name":"Fixture Provider"}]}"#, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.load()
        XCTAssertFalse(model.isLoading)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertTrue(model.providers.isEmpty)

        fails = false
        await model.load()
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.providers.map(\.id), ["fixture-provider"])
    }

    /// InsightsView: loaded quotas with no sources and no error -> "No quota sources reported by
    /// this server." (formerly `AgentPanelEmptyStateUITests`, TAL-402).
    @MainActor
    func testNoQuotaSourcesShowTheEmptyState() async {
        let client = makeClient { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            return apiTestJSONResponse("""
            {"version":1,"scope_id":"ui-fixture-scope","profile_id":"ui-fixture-profile",\
            "active_provider":"fixture-provider","sources":[]}
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client)

        await model.loadQuotas()

        XCTAssertFalse(model.isQuotaLoading)
        XCTAssertNil(model.quotaErrorMessage)
        XCTAssertTrue(model.quotaSources.isEmpty)
    }
}

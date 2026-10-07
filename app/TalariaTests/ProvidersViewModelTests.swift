import UserNotifications
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
        XCTAssertTrue(model.hasServerQuotaSources)
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
    func testFailedQuotaRefreshKeepsCachedServerPaceAndAFreshModelSeedsIt() async throws {
        let suite = "ProvidersViewModelPaceCache.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        var serverUp = true
        let client = makeScopedClient { request in
            guard serverUp else {
                return (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, Data())
            }
            return apiTestJSONResponse("""
            {
              "version": 1,
              "computed_at": "2026-09-28T08:00:00Z",
              "scope_id": "qscope_pace",
              "profile_id": "default",
              "sources": [{
                "source_id": "qsrc_pace",
                "provider_id": "anthropic",
                "provider_label": "Claude",
                "account_label": "Claude",
                "status": "available",
                "supported": true,
                "pace_window_index": 0,
                "session_window_index": null,
                "weekly_window_index": 0,
                "windows": [{
                  "label": "Weekly", "used_percent": 32, "remaining_percent": 68, "reset_at": "2026-10-03T08:00:00Z",
                  "window_seconds": 604800, "detail": null,
                  "pace": { "expected_remaining_percent": 71.4, "pace_delta_percent": -3.4, "burn_rate": 1.12, "minutes_to_reset": 7200,
                            "projected_minutes_to_empty": 6120, "elapsed_minutes": 2880, "valid_until": "2026-10-03T08:00:00Z" },
                  "forecast": { "outcome": "warning", "budget_unit": "day", "budget_percent": 13.6, "depletion_margin_minutes": -1080 }
                }]
              }]
            }
            """, for: request)
        }
        let model = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store, reloadQuotaWidgets: {})

        await model.loadQuotas()
        let loaded = try XCTUnwrap(model.quotaSources.first)
        XCTAssertEqual(loaded.windows.first?.pace?.burnRate, 1.12)
        let saved = try XCTUnwrap(store.load())

        serverUp = false
        await model.loadQuotas(refresh: true)

        XCTAssertEqual(model.quotaSources, [loaded], "a failed refresh keeps the cached server pace")
        XCTAssertEqual(store.load(), saved, "a failed refresh never rewrites the snapshot")

        let relaunched = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store, reloadQuotaWidgets: {})
        let seeded = try XCTUnwrap(relaunched.quotaSources.first)
        XCTAssertTrue(relaunched.hasStableQuotaSources)
        XCTAssertFalse(relaunched.hasServerQuotaSources, "a cached snapshot is not a server list")
        XCTAssertEqual(seeded.windows, loaded.windows)
        XCTAssertEqual(seeded.paceWindowIndex, 0)
        XCTAssertEqual(seeded.computedAt, "2026-09-28T08:00:00Z")
    }

    @MainActor
    func testQuotaAlertsEvaluateOnlyFreshServerSourcesAndTheCacheKeepsServerUrgency() async throws {
        let suite = "ProvidersViewModelAlerts.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        var serverUp = true
        let client = makeScopedClient { request in
            guard serverUp else {
                return (HTTPURLResponse(url: request.url!, statusCode: 503, httpVersion: nil, headerFields: nil)!, Data())
            }
            let window = #"{ "label": "Weekly", "used_percent": 80, "urgency": { "remaining": "warning", "pace": "critical" } }"#
            let source = { (id: String) in
                #"{ "source_id": "\#(id)", "provider_id": "anthropic", "provider_label": "Claude", "account_label": "\#(id)", "status": "available", "supported": true, "urgency": { "remaining": "warning", "pace": "critical" }, "windows": [\#(window)] }"#
            }
            let ids = request.url?.query?.contains("source=qsrc_b") == true ? ["qsrc_b"] : ["qsrc_a", "qsrc_b"]
            return apiTestJSONResponse(#"{ "version": 1, "scope_id": "qscope_alerts", "profile_id": "default", "sources": [\#(ids.map(source).joined(separator: ","))] }"#, for: request)
        }
        var evaluations: [(ids: [String], fresh: Set<String>?)] = []
        let evaluate: ([ProviderQuotaWidgetSource], Set<String>?) -> Void = { evaluations.append(($0.map(\.sourceID), $1)) }
        let model = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store, reloadQuotaWidgets: {}, evaluateQuotaAlerts: evaluate)

        await model.loadQuotas()
        XCTAssertEqual(evaluations.count, 1)
        XCTAssertNil(evaluations.last?.fresh, "a full response evaluates every source")
        await model.refreshQuota(sourceID: "qsrc_b")
        XCTAssertEqual(evaluations.last?.fresh, ["qsrc_b"], "a targeted refresh evaluates only the refreshed source")

        // The snapshot keeps the server urgency for widgets and an offline relaunch, which never evaluates alerts.
        let cached = try XCTUnwrap(store.load()?.sources.first)
        XCTAssertEqual(cached.urgency, ProviderQuotaUrgencyLevels(remaining: .warning, pace: .critical))
        XCTAssertEqual(cached.windows.first?.urgency, ProviderQuotaUrgencyLevels(remaining: .warning, pace: .critical))
        serverUp = false
        let relaunched = ProvidersViewModel(server: Self.serverURL, client: client, quotaSnapshotStore: store, reloadQuotaWidgets: {}, evaluateQuotaAlerts: evaluate)
        XCTAssertEqual(relaunched.quotaSources.first?.urgency, cached.urgency)
        await relaunched.loadQuotas(refresh: true)
        XCTAssertEqual(evaluations.count, 2, "neither the cache nor a failed refresh evaluates alerts")
    }

    func testQuotaAlertsFireOnEnteringWarningOrCriticalAndOnEscalation() {
        func run(
            _ urgency: ProviderQuotaUrgency,
            after previous: [String: String],
            preferences: ProviderQuotaAlertService.Preferences = .init()
        ) -> (ProviderQuotaAlertService.Level?, [String: String]) {
            let result = ProviderQuotaAlertService.transitions([("qsrc", urgency)], previous: previous, preferences: preferences)
            return (result.alerts["qsrc"], result.states)
        }
        XCTAssertEqual(run(.warning, after: [:]).0, .warning)
        XCTAssertNil(run(.warning, after: ["qsrc": "warning"]).0)
        XCTAssertEqual(run(.critical, after: ["qsrc": "warning"]).0, .critical)
        XCTAssertNil(run(.critical, after: ["qsrc": "critical"]).0)
        XCTAssertEqual(run(.critical, after: [:]).0, .critical)
        let recovered = run(.healthy, after: ["qsrc": "critical"])
        XCTAssertNil(recovered.0)
        XCTAssertEqual(recovered.1, [:], "recovering re-arms the alert")
        XCTAssertNil(run(.stale, after: [:]).0)
        XCTAssertNil(run(.unavailable, after: [:]).0)

        let criticalOnly = ProviderQuotaAlertService.Preferences(warning: false, critical: true)
        let silentWarning = run(.warning, after: [:], preferences: criticalOnly)
        XCTAssertNil(silentWarning.0, "a disabled warning level stays silent")
        XCTAssertEqual(silentWarning.1, ["qsrc": "warning"], "a silent warning still records the level")
        XCTAssertEqual(run(.critical, after: silentWarning.1, preferences: criticalOnly).0, .critical, "escalation still alerts")

        let warningOnly = ProviderQuotaAlertService.Preferences(warning: true, critical: false)
        XCTAssertEqual(run(.warning, after: [:], preferences: warningOnly).0, .warning)
        let silentCritical = run(.critical, after: ["qsrc": "warning"], preferences: warningOnly)
        XCTAssertNil(silentCritical.0, "a disabled critical level stays silent")
        XCTAssertNil(run(.warning, after: silentCritical.1, preferences: warningOnly).0, "falling back to warning does not re-alert")
    }

    func testQuotaAlertPreferencesReadEachLevelIndependently() throws {
        let suite = "ProviderQuotaAlertPreferences.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertEqual(
            ProviderQuotaAlertService.Preferences.stored(defaults: defaults),
            .init(warning: true, critical: true, criticalTimeSensitive: false),
            "both levels default on and Time Sensitive defaults off"
        )

        defaults.set(false, forKey: ProviderQuotaAlertSettings.warningEnabledKey)
        defaults.set(true, forKey: ProviderQuotaAlertSettings.criticalTimeSensitiveKey)
        let criticalOnly = ProviderQuotaAlertService.Preferences.stored(defaults: defaults)
        XCTAssertFalse(criticalOnly.allows(.warning))
        XCTAssertTrue(criticalOnly.allows(.critical))
        XCTAssertTrue(criticalOnly.criticalTimeSensitive)

        defaults.set(true, forKey: ProviderQuotaAlertSettings.warningEnabledKey)
        defaults.set(false, forKey: ProviderQuotaAlertSettings.criticalEnabledKey)
        let warningOnly = ProviderQuotaAlertService.Preferences.stored(defaults: defaults)
        XCTAssertTrue(warningOnly.allows(.warning))
        XCTAssertFalse(warningOnly.allows(.critical))
        XCTAssertFalse(warningOnly.criticalTimeSensitive, "Time Sensitive is unavailable without critical alerts")
    }

    func testOnlyTimeSensitiveCriticalQuotaAlertsUseTheTimeSensitiveLevel() {
        func request(_ level: ProviderQuotaAlertService.Level, timeSensitive: Bool) -> UNNotificationRequest {
            ProviderQuotaAlertService.request(
                level,
                sourceID: "qsrc_a",
                name: "Claude",
                remaining: 12.5,
                preferences: .init(criticalTimeSensitive: timeSensitive)
            )
        }
        XCTAssertEqual(request(.critical, timeSensitive: true).content.interruptionLevel, .timeSensitive)
        XCTAssertEqual(request(.critical, timeSensitive: false).content.interruptionLevel, .active)
        XCTAssertEqual(request(.warning, timeSensitive: true).content.interruptionLevel, .active)

        let critical = request(.critical, timeSensitive: true)
        XCTAssertEqual(critical.identifier, "provider-quota-qsrc_a-critical")
        XCTAssertEqual(critical.content.categoryIdentifier, ProviderQuotaAlertSettings.categoryIdentifier)
        XCTAssertEqual(critical.content.userInfo as? [String: String], ["quota_source_id": "qsrc_a"])
        XCTAssertEqual(critical.content.title, "Claude quota critical")
    }

    func testOnlyQuotaAlertsStayInNotificationCenterWhileForegrounded() {
        let quota = ProviderQuotaAlertService.request(.warning, sourceID: "qsrc_a", name: "Claude", remaining: nil, preferences: .init())
        XCTAssertEqual(TalariaAppDelegate.foregroundPresentation(for: quota.content), [.banner, .sound, .list])

        let session = UNMutableNotificationContent()
        session.userInfo = [SessionNotificationRefresh.sessionIDKey: "session-1"]
        XCTAssertEqual(TalariaAppDelegate.foregroundPresentation(for: session), [.banner, .sound])
        XCTAssertEqual(TalariaAppDelegate.foregroundPresentation(for: UNMutableNotificationContent()), [.banner, .sound])
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

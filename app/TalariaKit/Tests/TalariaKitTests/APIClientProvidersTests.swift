import XCTest
@testable import TalariaKit

/// Decoding contract for `GET /api/providers` (#26). The primary fixture mirrors
/// the live server shape captured 2026-07-02 plus upstream
/// `api/providers.py::get_providers()` @ `312d3fab`, including a
/// `custom_providers`-derived entry that omits most fields.
final class APIClientProvidersTests: APIClientTestCase {
    func testUnknownQuotaMembershipRetainsOnlyTheMatchingSourceGeneration() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let initial = try decoder.decode(ProviderQuotasResponse.self, from: Data(#"{"scope_id":"qscope_test","profile_id":"default","availability":{"status":"available","authoritative":true,"generation":"generation-one"},"sources":[{"source_id":"qsrc_test","status":"available","is_stale":false,"windows":[{"label":"5h","remaining_percent":75}]}]}"#.utf8))
        let unavailable = try decoder.decode(ProviderQuotasResponse.self, from: Data(#"{"scope_id":"qscope_test","profile_id":"default","availability":{"status":"unavailable","authoritative":false,"generation":"generation-one","unavailable_reason":"Agent recovery is incomplete."},"sources":[]}"#.utf8))
        let retained = unavailable.retainingUnconfirmedSources(initial.sources, scopeID: initial.scopeID, generation: initial.availability?.generation)
        XCTAssertEqual(retained.map(\.id), ["qsrc_test"])
        XCTAssertEqual(retained.first?.status, "unavailable")
        XCTAssertEqual(retained.first?.windows.first?.remainingPercent, 75)
        XCTAssertEqual(retained.first?.urgency?.remaining, .unavailable)
        XCTAssertEqual(retained.first?.isStale, false)
        // A read that keeps last-confirmed data marks each retained source stale, as the server marks its own copies.
        let stale = try decoder.decode(ProviderQuotasResponse.self, from: Data(#"{"scope_id":"qscope_test","availability":{"status":"stale","authoritative":false,"generation":"generation-one"},"sources":[]}"#.utf8))
        XCTAssertEqual(stale.retainingUnconfirmedSources(initial.sources, scopeID: initial.scopeID, generation: "generation-one").first?.isStale, true)
        XCTAssertTrue(unavailable.retainingUnconfirmedSources(initial.sources, scopeID: "another-server-profile", generation: "generation-one").isEmpty)
        XCTAssertTrue(unavailable.retainingUnconfirmedSources(initial.sources, scopeID: initial.scopeID, generation: "replacement-credential").isEmpty)
        XCTAssertTrue(unavailable.retainingUnconfirmedSources([], scopeID: initial.scopeID, generation: initial.availability?.generation).isEmpty)
        let empty = try decoder.decode(ProviderQuotasResponse.self, from: Data(#"{"scope_id":"qscope_test","availability":{"authoritative":true,"status":"available","generation":"generation-one"},"sources":[]}"#.utf8))
        XCTAssertTrue(empty.retainingUnconfirmedSources(initial.sources, scopeID: initial.scopeID, generation: "generation-one").isEmpty)
    }

    func testProviderQuotasRequestTargetsOneStableSourceAndDecodesWidgetReadyShape() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            let query = Dictionary(uniqueKeysWithValues: (components?.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            })
            XCTAssertEqual(query["source"], "qsrc_personal")
            XCTAssertEqual(query["refresh"], "1")

            return apiTestJSONResponse("""
            {
              "version": 1,
              "scope_id": "qscope_work",
              "profile_id": "work",
              "active_provider": "openai-codex",
              "requested_source_id": "qsrc_personal",
              "missing_source": false,
              "sources": [{
                "source_id": "qsrc_personal",
                "provider_id": "openai-codex",
                "provider_label": "Codex",
                "account_label": "Personal",
                "is_active_provider": true,
                "supported": true,
                "status": "available",
                "plan": "Pro",
                "windows": [
                  {
                    "label": "Session",
                    "window_seconds": 18000,
                    "used_percent": 25,
                    "remaining_percent": 75,
                    "reset_at": "2030-03-17T17:30:00Z",
                    "detail": null
                  },
                  {
                    "label": "Weekly",
                    "window_seconds": 604800,
                    "used_percent": 40.5,
                    "remaining_percent": 59.5,
                    "reset_at": "2030-03-24T12:30:00Z"
                  }
                ],
                "quota": null,
                "details": ["Fresh"],
                "unavailable_reason": null,
                "retry_after": null,
                "fetched_at": "2030-03-17T12:30:00Z",
                "message": "Codex account limits loaded."
              }]
            }
            """, for: request)
        }

        let response = try await client.providerQuotas(sourceID: "qsrc_personal", refresh: true)

        XCTAssertEqual(response.version, 1)
        XCTAssertEqual(response.scopeID, "qscope_work")
        XCTAssertEqual(response.profileID, "work")
        XCTAssertEqual(response.requestedSourceID, "qsrc_personal")
        XCTAssertEqual(response.missingSource, false)
        let source = try XCTUnwrap(response.sources.first)
        XCTAssertEqual(source.id, "qsrc_personal")
        XCTAssertEqual(source.providerID, "openai-codex")
        XCTAssertEqual(source.accountLabel, "Personal")
        XCTAssertTrue(source.isActiveProvider)
        XCTAssertEqual(source.plan, "Pro")
        XCTAssertEqual(source.windows.map(\.label), ["Session", "Weekly"])
        XCTAssertEqual(source.windows.map(\.windowSeconds), [18_000, 604_800])
        XCTAssertEqual(source.windows[0].usedPercent, 25)
        XCTAssertEqual(source.windows[1].remainingPercent, 59.5)
        XCTAssertEqual(source.fetchedAt, "2030-03-17T12:30:00Z")
    }

    func testProviderQuotaModelsRoundTripAsSanitizedWidgetSnapshots() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ProviderQuotasResponse.self, from: Data("""
        {
          "version": 1,
          "profile_id": "work",
          "server_url": "https://hostile.example.test",
          "access_token": "root-secret",
          "api_key": "root-api-secret",
          "apiKey": "root-camel-api-secret",
          "sources": [{
            "source_id": "qsrc_safe",
            "provider_id": "openai-codex",
            "provider_label": "Codex",
            "account_label": "Work",
            "status": "available",
            "supported": true,
            "server_url": "https://source-hostile.example.test",
            "access_token": "source-secret",
            "api_key": "source-api-secret",
            "apiKey": "source-camel-api-secret",
            "windows": [{ "label": "Session", "used_percent": 20 }]
          }]
        }
        """.utf8))

        let encoded = try JSONEncoder().encode(response)
        let snapshot = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(
            Set(snapshot.keys),
            ["version", "profileId", "missingSource", "sources"]
        )
        let sources = try XCTUnwrap(snapshot["sources"] as? [[String: Any]])
        let source = try XCTUnwrap(sources.first)
        XCTAssertEqual(
            Set(source.keys),
            [
                "sourceId", "providerId", "providerLabel", "accountLabel",
                "isActiveProvider", "supported", "status", "windows", "details",
            ]
        )
        let windows = try XCTUnwrap(source["windows"] as? [[String: Any]])
        XCTAssertEqual(Set(try XCTUnwrap(windows.first).keys), ["label", "usedPercent"])

        let roundTrip = try JSONDecoder().decode(ProviderQuotasResponse.self, from: encoded)

        XCTAssertEqual(roundTrip, response)
    }

    func testSharedProviderQuotaFixtureDecodesServerPaceForecastAndWindowIndexes() throws {
        let response = try decodedQuotaFixture()
        let source = try XCTUnwrap(response.sources.first)

        XCTAssertEqual(response.computedAt, "2026-09-28T08:00:00Z")
        XCTAssertEqual(source.computedAt, "2026-09-28T08:00:00Z")
        XCTAssertEqual(source.paceWindowIndex, 1)
        XCTAssertEqual(source.sessionWindowIndex, 0)
        XCTAssertEqual(source.weeklyWindowIndex, 1)
        XCTAssertEqual(source.windows.map(\.label), ["Session", "Weekly", "Monthly"])
        XCTAssertEqual(source.windows.map(\.windowSeconds), [18_000, 604_800, nil])
        let weekly = source.windows[1]
        XCTAssertNotNil(ProviderQuotaDateParser.date(from: weekly.resetAt))
        XCTAssertEqual(weekly.pace, ProviderQuotaWindowPace(
            expectedRemainingPercent: 71.4,
            paceDeltaPercent: -3.4,
            burnRate: 1.12,
            minutesToReset: 7200,
            projectedMinutesToEmpty: 6120,
            elapsedMinutes: 2880,
            validUntil: "2026-10-03T08:00:00Z",
            status: "over"
        ))
        XCTAssertEqual(weekly.forecast, ProviderQuotaWindowForecast(
            outcome: .warning,
            budgetUnit: .day,
            budgetPercent: 13.6,
            depletionMarginMinutes: -1080
        ))
        XCTAssertNil(source.windows[2].pace)
        XCTAssertNil(source.windows[2].forecast)
        // TAL-411: the server's classification at default thresholds, per window and for the source.
        XCTAssertEqual(source.windows.map(\.projectionEligible), [false, true, false])
        XCTAssertEqual(weekly.urgency, ProviderQuotaUrgencyLevels(remaining: .healthy, pace: .warning))
        XCTAssertEqual(source.urgency, ProviderQuotaUrgencyLevels(remaining: .healthy, pace: .warning))
    }

    func testWidgetSnapshotPersistsServerPaceAndStillLoadsALegacyV1Snapshot() throws {
        let suite = "ProviderQuotaPaceSnapshot.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)

        let response = try decodedQuotaFixture()
        let sources = try response.sources.map {
            ProviderQuotaWidgetSource($0, scopeID: try XCTUnwrap(response.scopeID), scopeLabel: "Home · default")
        }
        XCTAssertTrue(store.save(scopeID: try XCTUnwrap(response.scopeID), sources: sources))
        let loaded = try XCTUnwrap(store.load()?.sources.first)
        XCTAssertEqual(loaded, sources.first)
        XCTAssertEqual(loaded.computedAt, "2026-09-28T08:00:00Z")
        XCTAssertEqual(loaded.paceWindowIndex, 1)
        XCTAssertEqual(loaded.windows[1].forecast?.outcome, .warning)
        XCTAssertEqual(loaded.urgency, ProviderQuotaUrgencyLevels(remaining: .healthy, pace: .warning))
        XCTAssertEqual(loaded.windows[1].urgency?.pace, .warning)
        XCTAssertEqual(loaded.windows[1].projectionEligible, true)
        XCTAssertEqual(loaded.isStale, false)
        XCTAssertEqual(loaded.staleSince, "2026-09-28T08:14:30Z")
        XCTAssertEqual(loaded.windows.map(\.paceNeedsRefresh), [false, false, false])

        // Written by a build before the server shipped pace: no pace, forecast, indexes, or computedAt.
        defaults.set(Data("""
        {
          "updatedAt": 0,
          "sources": [{
            "sourceID": "qsrc_legacy",
            "scopeID": "qscope_legacy",
            "scopeLabel": "Home · default",
            "cachedAt": 0,
            "providerID": "anthropic",
            "providerLabel": "Anthropic",
            "accountLabel": "Anthropic",
            "isActiveProvider": true,
            "status": "available",
            "plan": "Max",
            "windows": [{ "label": "Weekly", "usedPercent": 30, "remainingPercent": 70, "resetAt": "2026-10-03T08:00:00Z" }],
            "fetchedAt": "2026-09-28T07:59:30Z"
          }]
        }
        """.utf8), forKey: ProviderQuotaWidgetSnapshotStore.storageKey)
        let legacy = try XCTUnwrap(store.load()?.sources.first)
        XCTAssertEqual(legacy.sourceID, "qsrc_legacy")
        XCTAssertEqual(legacy.windows.first?.usedPercent, 30)
        XCTAssertNil(legacy.windows.first?.pace)
        XCTAssertNil(legacy.paceWindowIndex)
        XCTAssertNil(legacy.computedAt)
        XCTAssertNil(legacy.urgency)
        XCTAssertNil(legacy.windows.first?.urgency)
        XCTAssertNil(legacy.staleSince)
        XCTAssertNil(legacy.windows.first?.paceNeedsRefresh)
    }

    private func decodedQuotaFixture() throws -> ProviderQuotasResponse {
        // app/TalariaKit/Tests/TalariaKitTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(
            ProviderQuotasResponse.self,
            from: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/provider-quotas.json"))
        )
    }

    func testProvidersRequestDecodesLiveShape() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertEqual(request.url?.path, "/api/providers")

            return apiTestJSONResponse("""
            {
              "active_provider": "openai-codex",
              "providers": [
                {
                  "id": "openai-codex",
                  "display_name": "OpenAI Codex",
                  "has_key": true,
                  "configurable": false,
                  "is_self_hosted": false,
                  "base_url": null,
                  "is_plugin_provider": false,
                  "is_oauth": true,
                  "key_source": "oauth",
                  "key_source_kind": "oauth",
                  "is_active": true,
                  "auth_error": null,
                  "models": [
                    { "id": "gpt-5.5", "label": "GPT 5.5" },
                    { "id": "gpt-5.5-codex", "label": "GPT 5.5 Codex" }
                  ],
                  "models_total": 5
                },
                {
                  "id": "anthropic",
                  "display_name": "Anthropic",
                  "has_key": false,
                  "configurable": true,
                  "is_self_hosted": false,
                  "base_url": null,
                  "is_plugin_provider": false,
                  "is_oauth": true,
                  "key_source": "oauth",
                  "key_source_kind": null,
                  "is_active": false,
                  "auth_error": "OAuth token expired — run hermes auth login anthropic",
                  "models": [],
                  "models_total": 0
                },
                {
                  "id": "custom:glmcode",
                  "display_name": "glmcode",
                  "has_key": true,
                  "configurable": false,
                  "is_custom": true,
                  "key_source": "config_yaml",
                  "models": [ "glm-4.7" ],
                  "models_total": 1
                }
              ]
            }
            """, for: request)
        }

        let response = try await client.providers()

        XCTAssertEqual(response.activeProvider, "openai-codex")
        let providers = try XCTUnwrap(response.providers)
        XCTAssertEqual(providers.count, 3)

        let codex = providers[0]
        XCTAssertEqual(codex.id, "openai-codex")
        XCTAssertEqual(codex.displayName, "OpenAI Codex")
        XCTAssertEqual(codex.hasKey, true)
        XCTAssertEqual(codex.configurable, false)
        XCTAssertEqual(codex.isSelfHosted, false)
        XCTAssertNil(codex.baseUrl)
        XCTAssertEqual(codex.isPluginProvider, false)
        XCTAssertEqual(codex.isOauth, true)
        XCTAssertEqual(codex.keySource, "oauth")
        XCTAssertEqual(codex.keySourceKind, "oauth")
        XCTAssertEqual(codex.isActive, true)
        XCTAssertNil(codex.authError)
        XCTAssertEqual(codex.models?.count, 2)
        XCTAssertEqual(codex.models?.first?.id, "gpt-5.5")
        XCTAssertEqual(codex.models?.first?.label, "GPT 5.5")
        XCTAssertEqual(codex.modelsTotal, 5)

        let anthropic = providers[1]
        XCTAssertEqual(anthropic.hasKey, false)
        XCTAssertNil(anthropic.keySourceKind)
        XCTAssertEqual(anthropic.isActive, false)
        XCTAssertEqual(anthropic.authError, "OAuth token expired — run hermes auth login anthropic")
        XCTAssertEqual(anthropic.models, [])

        // Custom-provider entries omit is_oauth / auth_error / is_self_hosted /
        // base_url / is_plugin_provider, and may carry bare-string model IDs.
        let custom = providers[2]
        XCTAssertEqual(custom.id, "custom:glmcode")
        XCTAssertEqual(custom.isCustom, true)
        XCTAssertNil(custom.isOauth)
        XCTAssertNil(custom.authError)
        XCTAssertEqual(custom.keySource, "config_yaml")
        XCTAssertNil(custom.keySourceKind, "a pre-TAL-603 server omits the kind")
        XCTAssertNil(custom.isActive)
        XCTAssertEqual(custom.models?.first?.id, "glm-4.7")
        XCTAssertEqual(custom.models?.first?.label, "glm-4.7")
    }

    func testProvidersDecodingToleratesAbsentAndUnknownFields() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let empty = try decoder.decode(ProvidersResponse.self, from: Data("{}".utf8))
        XCTAssertNil(empty.providers)
        XCTAssertNil(empty.activeProvider)

        let sparse = try decoder.decode(ProvidersResponse.self, from: Data("""
        {
          "active_provider": null,
          "providers": [
            {},
            {
              "id": "mystery",
              "key_source": "keychain",
              "future_field": { "nested": true },
              "models": [ { "id": "m-1" }, "m-2" ],
              "models_total": "7"
            }
          ]
        }
        """.utf8))

        XCTAssertNil(sparse.activeProvider)
        let providers = try XCTUnwrap(sparse.providers)
        XCTAssertEqual(providers.count, 2)
        XCTAssertNil(providers[0].id)
        XCTAssertNil(providers[0].hasKey)
        XCTAssertNil(providers[0].models)

        let mystery = providers[1]
        XCTAssertEqual(mystery.id, "mystery")
        XCTAssertEqual(mystery.keySource, "keychain")
        XCTAssertEqual(mystery.models?.count, 2)
        XCTAssertEqual(mystery.models?[0].id, "m-1")
        XCTAssertNil(mystery.models?[0].label)
        XCTAssertEqual(mystery.models?[1].id, "m-2")
        XCTAssertEqual(mystery.models?[1].label, "m-2")
        XCTAssertEqual(mystery.modelsTotal, 7)
    }

    func testProvidersDecodingSurvivesUnexpectedProvidersShape() throws {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase

        let response = try decoder.decode(ProvidersResponse.self, from: Data("""
        { "providers": "unexpected", "active_provider": 7 }
        """.utf8))

        XCTAssertNil(response.providers)
        XCTAssertEqual(response.activeProvider, "7")
    }
}

/// Provider quota widget models: the snapshot store, settings, deep link, dates and widget refresh (TAL-45).
extension APIClientProvidersTests {
    func testSnapshotRoundTripContainsOnlySanitizedDisplayFields() throws {
        let source = makeQuotaWidgetSource(id: "qsrc_work", account: "Work")
        let snapshot = ProviderQuotaWidgetSnapshot(updatedAt: Date(timeIntervalSince1970: 100), sources: [source])

        let data = try JSONEncoder().encode(snapshot)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let sources = try XCTUnwrap(json["sources"] as? [[String: Any]])

        XCTAssertEqual(Set(json.keys), ["updatedAt", "sources"])
        XCTAssertEqual(
            Set(try XCTUnwrap(sources.first).keys),
            ["sourceID", "scopeID", "scopeLabel", "cachedAt", "providerID", "providerLabel", "accountLabel", "isActiveProvider", "status", "plan", "windows", "fetchedAt"]
        )
        XCTAssertEqual(try JSONDecoder().decode(ProviderQuotaWidgetSnapshot.self, from: data), snapshot)
        let encoded = String(decoding: data, as: UTF8.self)
        XCTAssertFalse(encoded.contains("https://"))
        XCTAssertFalse(encoded.contains("serverURL"))
        XCTAssertFalse(encoded.contains("apiKey"))
        XCTAssertFalse(encoded.contains("accessToken"))
    }

    /// TAL-272: older servers could return one source id twice; a snapshot cached from
    /// that response must load with one row per id so every by-id lookup stays valid.
    func testStoreLoadsOneRowPerSourceIDFromADuplicatedSnapshot() throws {
        let suite = "ProviderQuotaWidgetDuplicates.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let first = makeQuotaWidgetSource(id: "qsrc_custom", account: "My LLM")
        let repeated = makeQuotaWidgetSource(id: "qsrc_custom", account: "my-llm")
        let other = makeQuotaWidgetSource(id: "qsrc_work", account: "Work")

        XCTAssertTrue(store.save(scopeID: "qscope_default", sources: [first, repeated, other]))

        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_custom", "qsrc_work"])
        XCTAssertEqual(store.load()?.sources.first?.accountLabel, "My LLM")
        XCTAssertTrue(store.save(scopeID: "qscope_default", sources: [other], updatedSourceIDs: ["qsrc_work"]))
        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_work"])
    }

    func testStoreKeepsOnlyTheActiveServerProfileScope() throws {
        let suite = "ProviderQuotaWidgetScopes.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let first = makeQuotaWidgetSource(id: "qsrc_a", account: "A", scopeID: "qscope_a")
        let second = makeQuotaWidgetSource(id: "qsrc_b", account: "B", scopeID: "qscope_b")

        XCTAssertTrue(store.save(scopeID: "qscope_a", sources: [first]))
        XCTAssertTrue(store.save(scopeID: "qscope_b", sources: [second]))

        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_b"])
    }

    func testTargetedSavePreservesUnchangedSourceFreshness() throws {
        let suite = "ProviderQuotaWidgetFreshness.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let oldDate = Date(timeIntervalSince1970: 100)
        let newDate = Date(timeIntervalSince1970: 200)
        let oldA = makeQuotaWidgetSource(id: "a", account: "A", cachedAt: oldDate)
        let oldB = makeQuotaWidgetSource(id: "b", account: "B", cachedAt: oldDate)
        let newA = makeQuotaWidgetSource(id: "a", account: "A", cachedAt: newDate)
        let newB = makeQuotaWidgetSource(id: "b", account: "B", cachedAt: newDate)

        XCTAssertTrue(store.save(scopeID: "qscope_default", sources: [oldA, oldB]))
        XCTAssertTrue(
            store.save(
                scopeID: "qscope_default",
                sources: [newA, newB],
                updatedSourceIDs: ["b"]
            )
        )

        XCTAssertEqual(store.load()?.sources.map(\.cachedAt), [oldDate, newDate])
    }

    func testQuotaOnlySourcePreservesSanitizedCreditValues() throws {
        let source = ProviderQuotaWidgetSource(
            sourceID: "qsrc_openrouter",
            providerLabel: "OpenRouter",
            accountLabel: "Credits",
            isActiveProvider: false,
            status: "available",
            plan: nil,
            windows: [],
            quota: ProviderQuotaAmount(limitRemaining: 12.5, usage: 7.5, limit: 20),
            retryAfter: nil,
            fetchedAt: nil
        )

        let data = try JSONEncoder().encode(source)
        let decoded = try JSONDecoder().decode(ProviderQuotaWidgetSource.self, from: data)

        XCTAssertEqual(decoded.quota?.limitRemaining, 12.5)
        XCTAssertEqual(decoded.quota?.usage, 7.5)
        XCTAssertEqual(decoded.quota?.limit, 20)
    }

    func testSidebarQuotaSelectionDefaultsEmptyAndKeepsAtMostTwoUniqueSources() {
        XCTAssertEqual(ProviderQuotaSidebarSettings.sourceIDs(first: "", second: "  "), [])
        XCTAssertEqual(
            ProviderQuotaSidebarSettings.sourceIDs(first: " qsrc_work ", second: "qsrc_personal"),
            ["qsrc_work", "qsrc_personal"]
        )
        XCTAssertEqual(
            ProviderQuotaSidebarSettings.sourceIDs(first: "qsrc_work", second: "qsrc_work"),
            ["qsrc_work"]
        )
    }

    func testSidebarQuotaPruneKeepsOnlyVisiblePinsInFirstSlot() {
        let prune = { (first: String, second: String, visible: Set<String>) -> [String] in
            let kept = ProviderQuotaSidebarSettings.pruned(first: first, second: second, keeping: visible)
            return [kept.first, kept.second]
        }
        XCTAssertEqual(prune("qsrc_a", "qsrc_b", ["qsrc_a", "qsrc_b"]), ["qsrc_a", "qsrc_b"])
        XCTAssertEqual(prune("qsrc_stale", "qsrc_b", ["qsrc_b"]), ["qsrc_b", ""])
        XCTAssertEqual(prune("qsrc_hidden", "qsrc_stale", ["qsrc_c"]), ["", ""])
        XCTAssertEqual(prune(" qsrc_a ", "qsrc_a", ["qsrc_a"]), ["qsrc_a", ""])
    }

    func testQuotaRefreshIntervalDefaultsToFiveMinutesAndRejectsUnknownValues() {
        XCTAssertEqual(ProviderQuotaRefreshInterval.defaultValue, .fiveMinutes)
        XCTAssertEqual(ProviderQuotaRefreshInterval.defaultValue.rawValue, 300)
        XCTAssertEqual(ProviderQuotaRefreshInterval.storedValue(900), .fifteenMinutes)
        XCTAssertEqual(ProviderQuotaRefreshInterval.storedValue(123), .fiveMinutes)
    }

    func testHiddenProviderSettingsNormalizePersistAndRestoreProviders() {
        var data = Data()

        data = ProviderQuotaVisibilitySettings.data(
            bySetting: " OpenAI-Codex ",
            hidden: true,
            in: data
        )
        data = ProviderQuotaVisibilitySettings.data(
            bySetting: "GEMINI",
            hidden: true,
            in: data
        )

        XCTAssertEqual(
            ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: data),
            ["openai-codex", "gemini"]
        )

        data = ProviderQuotaVisibilitySettings.data(
            bySetting: "openai-codex",
            hidden: false,
            in: data
        )
        XCTAssertEqual(ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: data), ["gemini"])
    }

    func testProviderAliasesRenameAndRestoreProviderNames() {
        var data = Data()
        data = ProviderQuotaDisplaySettings.data(
            byRenaming: "openai-codex",
            to: "Work Codex",
            in: data
        )

        XCTAssertEqual(
            ProviderQuotaDisplaySettings.displayName(
                providerID: "openai-codex",
                fallback: "OpenAI Codex",
                aliasesData: data
            ),
            "Work Codex"
        )

        data = ProviderQuotaDisplaySettings.data(
            byRenaming: "openai-codex",
            to: "",
            in: data
        )
        XCTAssertEqual(
            ProviderQuotaDisplaySettings.displayName(
                providerID: "openai-codex",
                fallback: "OpenAI Codex",
                aliasesData: data
            ),
            "OpenAI Codex"
        )
    }

    func testSnapshotStalenessUsesSavedTime() {
        let snapshot = ProviderQuotaWidgetSnapshot(updatedAt: Date(timeIntervalSince1970: 100), sources: [])

        XCTAssertFalse(snapshot.isStale(at: Date(timeIntervalSince1970: 999), maximumAge: 900))
        XCTAssertTrue(snapshot.isStale(at: Date(timeIntervalSince1970: 1_001), maximumAge: 900))
    }

    func testQuotaSourceDeepLinkRoundTripsOpaqueIdentity() throws {
        let url = try XCTUnwrap(TalariaDeepLink.quotaSourceURL(sourceID: "qsrc_work"))

        XCTAssertEqual(url.host, TalariaDeepLink.quotaSourceHost)
        XCTAssertEqual(TalariaDeepLink.quotaSourceID(from: url), "qsrc_work")
        XCTAssertNil(TalariaDeepLink.quotaSourceURL(sourceID: "  "))

        let refreshURL = try XCTUnwrap(TalariaDeepLink.quotaSourceURL(sourceID: "qsrc_work", refresh: true))
        XCTAssertTrue(TalariaDeepLink.requestsQuotaRefresh(refreshURL))
        XCTAssertEqual(TalariaDeepLink.quotaSourceID(from: refreshURL), "qsrc_work")
        XCTAssertTrue(
            TalariaDeepLink.isProviderQuotaWidgetSettingsURL(
                try XCTUnwrap(TalariaDeepLink.providerQuotaWidgetSettingsURL)
            )
        )
    }

    func testQuotaDatesDecodeWithAndWithoutFractionalSeconds() {
        XCTAssertNotNil(ProviderQuotaDateParser.date(from: "2030-03-17T12:30:00Z"))
        XCTAssertNotNil(ProviderQuotaDateParser.date(from: "2030-03-17T12:30:00.123456Z"))
    }

    func testStoredCookieApplicabilityEnforcesExpiryOriginPathAndSecureScheme() throws {
        let now = Date()
        let cookie = ProviderQuotaWidgetRefreshCookie(
            try XCTUnwrap(
                HTTPCookie(properties: [
                    .name: "session",
                    .value: "value",
                    .domain: ".example.test",
                    .path: "/api/provider",
                    .secure: "TRUE",
                    .expires: now.addingTimeInterval(60),
                ])
            )
        )

        XCTAssertTrue(cookie.applies(to: URL(string: "https://example.test/api/provider/quotas")!, at: now))
        XCTAssertTrue(cookie.applies(to: URL(string: "https://sub.example.test/api/provider/quotas")!, at: now))
        XCTAssertFalse(cookie.applies(to: URL(string: "http://example.test/api/provider/quotas")!, at: now))
        XCTAssertFalse(cookie.applies(to: URL(string: "https://other.test/api/provider/quotas")!, at: now))
        XCTAssertFalse(cookie.applies(to: URL(string: "https://example.test/api/providers")!, at: now))
        XCTAssertFalse(
            cookie.applies(
                to: URL(string: "https://example.test/api/provider/quotas")!,
                at: now.addingTimeInterval(120)
            )
        )

        let injected = ProviderQuotaWidgetRefreshCookie(
            name: "session",
            value: "value; injected=true",
            domain: "example.test",
            path: "/",
            isSecure: false,
            expiresDate: nil
        )
        XCTAssertFalse(
            injected.applies(to: URL(string: "https://example.test/api/provider/quotas")!, at: now)
        )
    }

    func testWidgetRefreshUsesHeadersLiveCookiesSnakeCaseAndPersistsResponseCookies() async throws {
        let suite = "ProviderQuotaRefresh.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let snapshotStore = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let now = Date()
        let credentials = makeQuotaRefreshCredentials(now: now)
        XCTAssertEqual(credentials.cookies.map(\.name), ["live", "expired"])
        XCTAssertGreaterThan(try XCTUnwrap(credentials.cookies[0].expiresDate), now)
        XCTAssertLessThan(try XCTUnwrap(credentials.cookies[1].expiresDate), now)
        var savedCredentials: ProviderQuotaWidgetRefreshCredentials?
        var reloadCount = 0
        let performRequest: (URLRequest) async throws -> (Data, URLResponse) = { request in
            XCTAssertEqual(request.url?.path, "/api/provider/quotas")
            XCTAssertEqual(
                URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?
                    .queryItems?.first(where: { $0.name == "refresh" })?.value,
                "1"
            )
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Test"), "widget")
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Talaria-Client"), AppConfig.clientIdentity)
            let cookie = request.value(forHTTPHeaderField: "Cookie") ?? ""
            XCTAssertTrue(
                cookie.contains("live=value"),
                "Expected live cookie in request headers: \(request.allHTTPHeaderFields ?? [:])"
            )
            XCTAssertFalse(cookie.contains("expired=value"))
            let response = try XCTUnwrap(
                HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Set-Cookie": "rotated=fresh; Path=/; Secure"]
                )
            )
            return (Data(Self.quotaResponseJSON.utf8), response)
        }

        let refreshed = await ProviderQuotaWidgetRefreshClient.refresh(
            credentials: credentials,
            snapshotStore: snapshotStore,
            now: now,
            saveCredentials: {
                savedCredentials = $0
                return true
            },
            reloadTimelines: { reloadCount += 1 },
            performRequest: performRequest
        )

        XCTAssertTrue(refreshed)
        XCTAssertEqual(snapshotStore.load()?.sources.map(\.sourceID), ["qsrc_work"])
        XCTAssertEqual(snapshotStore.load()?.sources.first?.scopeID, "qscope_work")
        XCTAssertEqual(savedCredentials?.cookies.first(where: { $0.name == "rotated" })?.value, "fresh")
        XCTAssertEqual(reloadCount, 1)
    }

    func testWidgetRedirectDelegateAllowsOnlySameOrigin() throws {
        let baseURL = try XCTUnwrap(URL(string: "https://example.test"))
        let delegate = ProviderQuotaWidgetRedirectDelegate(baseURL: baseURL)
        let task = URLSession.shared.dataTask(with: baseURL)
        let response = try XCTUnwrap(
            HTTPURLResponse(url: baseURL, statusCode: 302, httpVersion: nil, headerFields: nil)
        )

        var sameOrigin: URLRequest?
        delegate.urlSession(
            .shared,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://example.test/next")!),
            completionHandler: { sameOrigin = $0 }
        )
        XCTAssertEqual(sameOrigin?.url?.absoluteString, "https://example.test/next")

        var crossOrigin: URLRequest?
        delegate.urlSession(
            .shared,
            task: task,
            willPerformHTTPRedirection: response,
            newRequest: URLRequest(url: URL(string: "https://other.test/next")!),
            completionHandler: { crossOrigin = $0 }
        )
        XCTAssertNil(crossOrigin)
    }

    private static let quotaResponseJSON = """
    {
      "version": 1,
      "scope_id": "qscope_work",
      "profile_id": "work",
      "sources": [{
        "source_id": "qsrc_work",
        "provider_id": "openai-codex",
        "provider_label": "Codex",
        "account_label": "Work",
        "is_active_provider": true,
        "supported": true,
        "status": "available",
        "plan": "Pro",
        "windows": [{
          "label": "Weekly",
          "window_seconds": 604800,
          "used_percent": 25,
          "remaining_percent": 75,
          "reset_at": "2030-03-24T12:30:00Z"
        }],
        "details": [],
        "fetched_at": "2030-03-17T12:30:00Z"
      }]
    }
    """
}

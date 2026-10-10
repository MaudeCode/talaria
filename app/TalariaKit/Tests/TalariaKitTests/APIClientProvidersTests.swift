import XCTest
@testable import TalariaKit

/// Decoding contract for `GET /api/providers` (#26). The primary fixture mirrors
/// the live server shape captured 2026-07-02 plus upstream
/// `api/providers.py::get_providers()` @ `312d3fab`, including a
/// `custom_providers`-derived entry that omits most fields.
final class APIClientProvidersTests: APIClientTestCase {
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

import XCTest
import Security
@testable import Talaria
@testable import TalariaKit

final class ProviderQuotaWidgetTests: XCTestCase {
    func testSnapshotRoundTripContainsOnlySanitizedDisplayFields() throws {
        let source = makeSource(id: "qsrc_work", account: "Work")
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

    func testStorePreservesLastGoodSnapshotUntilAnotherSuccessIsSaved() throws {
        let suite = "ProviderQuotaWidgetTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let source = makeSource(id: "qsrc_work", account: "Work")

        XCTAssertTrue(store.save(scopeID: "qscope_default", sources: [source], at: Date(timeIntervalSince1970: 100)))
        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_work"])

        XCTAssertEqual(store.load()?.sources.map(\.sourceID), ["qsrc_work"])
    }

    /// TAL-272: older servers could return one source id twice; a snapshot cached from
    /// that response must load with one row per id so every by-id lookup stays valid.
    func testStoreLoadsOneRowPerSourceIDFromADuplicatedSnapshot() throws {
        let suite = "ProviderQuotaWidgetDuplicates.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = ProviderQuotaWidgetSnapshotStore(defaults: defaults)
        let first = makeSource(id: "qsrc_custom", account: "My LLM")
        let repeated = makeSource(id: "qsrc_custom", account: "my-llm")
        let other = makeSource(id: "qsrc_work", account: "Work")

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
        let first = makeSource(id: "qsrc_a", account: "A", scopeID: "qscope_a")
        let second = makeSource(id: "qsrc_b", account: "B", scopeID: "qscope_b")

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
        let oldA = makeSource(id: "a", account: "A", cachedAt: oldDate)
        let oldB = makeSource(id: "b", account: "B", cachedAt: oldDate)
        let newA = makeSource(id: "a", account: "A", cachedAt: newDate)
        let newB = makeSource(id: "b", account: "B", cachedAt: newDate)

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

    func testExplicitSlotCapacityUsesOneTwoAndFourWithoutAutoFill() {
        let slots = ["one", nil, "three", "four"]

        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 1), ["one"])
        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 2), ["one"])
        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 4), ["one", "three", "four"])
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

    func testQuotaRefreshIntervalDefaultsToFiveMinutesAndRejectsUnknownValues() {
        XCTAssertEqual(ProviderQuotaRefreshInterval.defaultValue, .fiveMinutes)
        XCTAssertEqual(ProviderQuotaRefreshInterval.defaultValue.rawValue, 300)
        XCTAssertEqual(ProviderQuotaRefreshInterval.storedValue(900), .fifteenMinutes)
        XCTAssertEqual(ProviderQuotaRefreshInterval.storedValue(123), .fiveMinutes)
    }

    func testWidgetAppearanceDefaultsStayMinimal() {
        XCTAssertEqual(ProviderQuotaWidgetArcColor.defaultValue, .automatic)
        XCTAssertEqual(ProviderQuotaWidgetArcWeight.defaultValue, .regular)
        XCTAssertEqual(ProviderQuotaWidgetColorBasis.defaultValue, .pace)
        XCTAssertEqual(ProviderQuotaWidgetStatusText.defaultValue, .percentage)
        XCTAssertEqual(ProviderQuotaWidgetResetDisplay.defaultValue, .compact)
        XCTAssertEqual(ProviderQuotaWidgetBackground.defaultValue, .system)
        XCTAssertEqual(ProviderQuotaWidgetTapAction.defaultValue, .insights)
        XCTAssertTrue(ProviderQuotaWidgetAppearanceSettings.defaultShowsProviderIcon)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultProviderIconStyle, .color)
        XCTAssertTrue(ProviderQuotaWidgetAppearanceSettings.defaultShowsPaceMarker)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultTrackOpacityPercent, 18)
    }

    func testLockScreenWidgetKindsAndSettingsRemainIndependentFromProfiles() {
        XCTAssertNotEqual(
            ProviderQuotaWidgetSnapshotStore.widgetKind,
            ProviderQuotaWidgetSnapshotStore.paceWidgetKind
        )
        XCTAssertTrue(ProviderQuotaLockScreenSettings.defaultShowsProviderIcon)
        XCTAssertTrue(ProviderQuotaLockScreenSettings.defaultShowsReset)
        XCTAssertTrue(ProviderQuotaLockScreenSettings.defaultShowsWindow)
        XCTAssertEqual(ProviderQuotaLockScreenPaceDetail.defaultValue, .burnAndForecast)
        XCTAssertNil(
            ProviderQuotaWidgetProfileStore.defaultValues[
                ProviderQuotaLockScreenSettings.paceDetailKey
            ]
        )
    }

    func testLockScreenSettingsPersistInAppGroupCompatibleDefaults() throws {
        let suite = "ProviderQuotaLockScreenSettings.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        defaults.set(false, forKey: ProviderQuotaLockScreenSettings.showsProviderIconKey)
        defaults.set(false, forKey: ProviderQuotaLockScreenSettings.showsResetKey)
        defaults.set(false, forKey: ProviderQuotaLockScreenSettings.showsWindowKey)
        defaults.set(
            ProviderQuotaLockScreenPaceDetail.forecast.rawValue,
            forKey: ProviderQuotaLockScreenSettings.paceDetailKey
        )

        XCTAssertFalse(defaults.bool(forKey: ProviderQuotaLockScreenSettings.showsProviderIconKey))
        XCTAssertFalse(defaults.bool(forKey: ProviderQuotaLockScreenSettings.showsResetKey))
        XCTAssertFalse(defaults.bool(forKey: ProviderQuotaLockScreenSettings.showsWindowKey))
        XCTAssertEqual(
            defaults.string(forKey: ProviderQuotaLockScreenSettings.paceDetailKey),
            ProviderQuotaLockScreenPaceDetail.forecast.rawValue
        )
    }

    func testSharedSlotGeometryKeepsSingleAndDualPrimaryGaugeBoundsIdentical() {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 140)
        let singleWithForecast = ProviderQuotaWidgetSlotGeometry.frames(
            count: 2,
            in: bounds,
            spacing: 12
        )
        let dualProvider = ProviderQuotaWidgetSlotGeometry.frames(
            count: 2,
            in: bounds,
            spacing: 12
        )

        XCTAssertEqual(singleWithForecast[0], dualProvider[0])
        XCTAssertEqual(singleWithForecast[0], CGRect(x: 0, y: 0, width: 144, height: 140))

        let fourProvider = ProviderQuotaWidgetSlotGeometry.frames(
            count: 4,
            in: CGRect(x: 0, y: 0, width: 300, height: 300),
            spacing: 12
        )
        XCTAssertEqual(fourProvider.count, 4)
        XCTAssertEqual(fourProvider[3], CGRect(x: 156, y: 156, width: 144, height: 144))

        let expanded = ProviderQuotaWidgetPrimaryDetailGeometry.frames(
            in: CGRect(x: 0, y: 0, width: 300, height: 300),
            spacing: 20
        )
        XCTAssertEqual(expanded[0], CGRect(x: 0, y: 0, width: 300, height: 168))
        XCTAssertEqual(expanded[1], CGRect(x: 0, y: 188, width: 300, height: 112))
    }

    func testThreePeriodPresentationOrdersCompleteDurationsAndPreservesIncompleteOrder() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let settings = ProviderQuotaEvaluationSettings(
            percentageMode: .used,
            colorBasis: .overall,
            windowSelection: .automatic
        )
        func source(_ windows: [ProviderQuotaWindow]) -> ProviderQuotaWidgetSource {
            ProviderQuotaWidgetSource(
                sourceID: "qsrc_periods",
                scopeID: "qscope_default",
                scopeLabel: "Test server · default",
                cachedAt: now,
                providerID: "opencode-go",
                providerLabel: "OpenCode Go",
                accountLabel: "OpenCode Go",
                isActiveProvider: true,
                status: "available",
                plan: "Go",
                windows: windows,
                retryAfter: nil,
                fetchedAt: nil
            )
        }

        let complete = ProviderQuotaPresentation.periods(
            for: source([
                ProviderQuotaWindow(label: "Monthly", windowSeconds: 2_592_000, usedPercent: 30),
                ProviderQuotaWindow(label: "Weekly", windowSeconds: 604_800, usedPercent: 20),
                ProviderQuotaWindow(label: "Session", windowSeconds: 18_000, usedPercent: 10),
            ]),
            settings: settings,
            at: now
        )
        XCTAssertEqual(complete.map(\.shortLabel), ["5h", "Week", "Month"])
        XCTAssertEqual(complete.map(\.state.percent), [10, 20, 30])

        let incomplete = ProviderQuotaPresentation.periods(
            for: source([
                ProviderQuotaWindow(label: "Monthly", usedPercent: 30),
                ProviderQuotaWindow(label: "Session", windowSeconds: 18_000, usedPercent: 10),
                ProviderQuotaWindow(label: "Weekly", windowSeconds: 604_800, usedPercent: 20),
            ]),
            settings: settings,
            at: now
        )
        XCTAssertEqual(incomplete.map(\.shortLabel), ["Month", "5h", "Week"])
    }

    func testForecastSummarySharesBurnBudgetAndDepletionFormatting() {
        let settings = ProviderQuotaEvaluationSettings(
            percentageMode: .used,
            colorBasis: .pace,
            windowSelection: .automatic
        )
        let pace = ProviderQuotaWindowPace(
            expectedRemainingPercent: 50,
            paceDeltaPercent: -3.8,
            burnRate: 1.18,
            minutesToReset: 3 * 24 * 60,
            projectedMinutesToEmpty: 1.5 * 24 * 60,
            elapsedMinutes: 4 * 24 * 60
        )
        let state = ProviderQuotaPresentationState(
            window: ProviderQuotaWindow(label: "Weekly", usedPercent: 25, remainingPercent: 75),
            percent: 25,
            remainingPercent: 75,
            resetAt: Date(timeIntervalSince1970: 1_900_000_000),
            referenceDate: Date(timeIntervalSince1970: 1_899_740_800),
            freshnessDate: Date(timeIntervalSince1970: 1_899_999_900),
            isStale: false,
            pace: pace,
            urgency: .warning,
            settings: settings,
            forecast: ProviderQuotaWindowForecast(
                outcome: .warning,
                budgetUnit: .day,
                budgetPercent: 25,
                depletionMarginMinutes: -1.5 * 24 * 60
            )
        )

        let forecast = ProviderQuotaForecastSummary(state: state)

        XCTAssertEqual(forecast.burnRateLabel, "1.18×")
        XCTAssertEqual(forecast.budgetTitle, "Budget / day")
        XCTAssertEqual(forecast.budgetLabel, "25%")
        XCTAssertEqual(forecast.forecastLabel, "Empty 1d 12h early")
        XCTAssertEqual(forecast.systemImage, "exclamationmark.triangle")
        XCTAssertEqual(forecast.outcome, .warning)

        let unavailable = ProviderQuotaForecastSummary(
            state: ProviderQuotaPresentationState(
                window: nil,
                percent: nil,
                remainingPercent: nil,
                resetAt: nil,
                referenceDate: state.referenceDate,
                freshnessDate: state.freshnessDate,
                isStale: false,
                pace: nil,
                urgency: .unavailable,
                settings: settings
            )
        )
        XCTAssertEqual(unavailable.forecastLabel, "Forecast unavailable")
        XCTAssertEqual(unavailable.outcome, .unavailable)

        var lasting = state
        lasting.forecast = ProviderQuotaWindowForecast(outcome: .safe, budgetUnit: .hour, budgetPercent: 12.5, depletionMarginMinutes: 90)
        XCTAssertEqual(ProviderQuotaForecastSummary(state: lasting).budgetTitle, "Budget / hr")
        XCTAssertEqual(ProviderQuotaForecastSummary(state: lasting).budgetLabel, "12.5%")
        XCTAssertEqual(ProviderQuotaForecastSummary(state: lasting).forecastLabel, "Lasts through reset")
        lasting.forecast = ProviderQuotaWindowForecast(outcome: .safe, budgetUnit: .hour)
        XCTAssertEqual(ProviderQuotaForecastSummary(state: lasting).forecastLabel, "No depletion projected")
    }

    func testServerPaceRendersUntilValidUntilThenNeedsRefresh() {
        let computedAt = Date(timeIntervalSince1970: 1_900_000_000)
        let reset = computedAt.addingTimeInterval(4 * 60 * 60)
        let resetText = ISO8601DateFormatter().string(from: reset)
        let settings = ProviderQuotaEvaluationSettings(
            percentageMode: .used,
            colorBasis: .pace,
            windowSelection: .automatic
        )
        let window = ProviderQuotaWindow(
            label: "Session",
            windowSeconds: 18_000,
            usedPercent: 10,
            remainingPercent: 90,
            resetAt: resetText,
            pace: ProviderQuotaWindowPace(
                expectedRemainingPercent: 80,
                paceDeltaPercent: 10,
                burnRate: 0.5,
                minutesToReset: 240,
                projectedMinutesToEmpty: 540,
                elapsedMinutes: 60,
                validUntil: resetText,
                status: "under"
            ),
            forecast: ProviderQuotaWindowForecast(outcome: .safe, budgetUnit: .hour, budgetPercent: 22.5, depletionMarginMinutes: 300)
        )
        let source = ProviderQuotaWidgetSource(
            sourceID: "qsrc_pace",
            cachedAt: computedAt,
            providerLabel: "Claude",
            accountLabel: "Claude",
            isActiveProvider: true,
            status: "available",
            plan: nil,
            windows: [window],
            retryAfter: nil,
            fetchedAt: ISO8601DateFormatter().string(from: computedAt),
            paceWindowIndex: 0,
            sessionWindowIndex: 0,
            computedAt: ISO8601DateFormatter().string(from: computedAt)
        )

        // An hour later the cached server values render unchanged, marked stale and "as of" their computation.
        let cached = ProviderQuotaPresentation.state(for: source, settings: settings, at: computedAt.addingTimeInterval(60 * 60))
        XCTAssertEqual(cached.pace, window.pace)
        XCTAssertEqual(cached.forecast, window.forecast)
        XCTAssertEqual(cached.computedAt, computedAt)
        XCTAssertEqual(cached.resetAt, reset)
        XCTAssertTrue(cached.isStale)
        XCTAssertFalse(cached.paceNeedsRefresh)
        XCTAssertEqual(cached.paceLabel, "10% under pace")
        XCTAssertEqual(ProviderQuotaForecastSummary(state: cached).burnRateLabel, "0.50×")
        XCTAssertEqual(ProviderQuotaForecastSummary(state: cached).forecastLabel, "Lasts through reset")

        // Past the window's reset the cached pace describes the previous window.
        let expired = ProviderQuotaPresentation.state(for: source, settings: settings, at: reset.addingTimeInterval(1))
        XCTAssertNil(expired.pace)
        XCTAssertNil(expired.forecast)
        XCTAssertNil(expired.paceLabel)
        XCTAssertTrue(expired.paceNeedsRefresh)
        XCTAssertEqual(expired.percent, 10)
        XCTAssertEqual(ProviderQuotaForecastSummary(state: expired).forecastLabel, "Refresh needed")
        XCTAssertEqual(ProviderQuotaForecastSummary(state: expired).outcome, .unavailable)

        // An old server sends no pace: unavailable, never refresh-needed, and no client math.
        let legacy = ProviderQuotaWidgetSource(
            sourceID: "qsrc_legacy",
            cachedAt: computedAt,
            providerLabel: "Claude",
            accountLabel: "Claude",
            isActiveProvider: true,
            status: "available",
            plan: nil,
            windows: [ProviderQuotaWindow(label: "Session", usedPercent: 10, resetAt: resetText)],
            retryAfter: nil,
            fetchedAt: nil
        )
        let legacyState = ProviderQuotaPresentation.state(for: legacy, settings: settings, at: computedAt)
        XCTAssertNil(legacyState.pace)
        XCTAssertFalse(legacyState.paceNeedsRefresh)
        XCTAssertEqual(legacyState.percent, 10)
        XCTAssertEqual(ProviderQuotaForecastSummary(state: legacyState).forecastLabel, "Forecast unavailable")
    }

    func testWidgetProfilesCaptureProviderIconVisibilityAndStyle() throws {
        let suite = "ProviderQuotaWidgetProfiles.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(false, forKey: ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey)
        defaults.set(
            ProviderIconStyle.silhouette.rawValue,
            forKey: ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey
        )

        let profile = try XCTUnwrap(
            ProviderQuotaWidgetProfileStore.saveCurrent(name: "No icon", defaults: defaults)
        )

        XCTAssertEqual(
            profile.values[ProviderQuotaWidgetAppearanceSettings.showsProviderIconKey],
            "0"
        )
        XCTAssertEqual(
            profile.values[ProviderQuotaWidgetAppearanceSettings.providerIconStyleKey],
            ProviderIconStyle.silhouette.rawValue
        )
    }

    func testPresentationRendersServerUrgencyAndAnOldServerStaysNeutral() throws {
        let suite = "ProviderQuotaServerUrgency.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        func source(urgency: String) throws -> ProviderQuotaWidgetSource {
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            // 90% used, far over pace: the App's former local math says critical on both bases.
            let response = try decoder.decode(ProviderQuotasResponse.self, from: Data("""
            {
              "version": 1, "scope_id": "qscope_test", "profile_id": "default",
              "sources": [{
                "source_id": "qsrc_server", "provider_id": "anthropic", "provider_label": "Claude", "account_label": "Claude",
                "status": "available", "supported": true, "pace_window_index": 0, \(urgency)
                "windows": [{
                  "label": "Weekly", "used_percent": 90, "remaining_percent": 10, "window_seconds": 604800, \(urgency)
                  "pace": { "expected_remaining_percent": 71.4, "pace_delta_percent": -61.4, "burn_rate": 3.15, "minutes_to_reset": 7200,
                            "projected_minutes_to_empty": 320, "elapsed_minutes": 2880, "valid_until": "2999-01-01T00:00:00Z" }
                }]
              }]
            }
            """.utf8))
            return ProviderQuotaWidgetSource(try XCTUnwrap(response.sources.first), scopeID: "qscope_test", scopeLabel: "Test · default")
        }
        func urgency(_ source: ProviderQuotaWidgetSource, basis: ProviderQuotaWidgetColorBasis) -> ProviderQuotaUrgency {
            defaults.set(basis.rawValue, forKey: ProviderQuotaWidgetColorBasis.storageKey)
            return ProviderQuotaPresentation.state(
                for: source,
                settings: ProviderQuotaEvaluationSettings.stored(defaults: defaults),
                at: Date()
            ).urgency
        }

        // The server classified this window at its own thresholds; the App renders that, per colour basis.
        let classified = try source(urgency: #""urgency": { "remaining": "warning", "pace": "healthy" },"#)
        XCTAssertEqual(urgency(classified, basis: .overall), .warning)
        XCTAssertEqual(urgency(classified, basis: .pace), .healthy)

        // A server without `urgency` gets neutral colouring and no client fallback math.
        let legacy = try source(urgency: "")
        XCTAssertEqual(urgency(legacy, basis: .overall), .healthy)
        XCTAssertEqual(urgency(legacy, basis: .pace), .healthy)
    }

    func testDisplayWindowUsesTheWindowsTheServerSelects() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let resetInFiveDays = ISO8601DateFormatter().string(from: now.addingTimeInterval(5 * 24 * 60 * 60))

        func weekly(used: Double, delta: Double, burn: Double, projected: Double) -> ProviderQuotaWindow {
            ProviderQuotaWindow(
                label: "Weekly",
                windowSeconds: 604_800,
                usedPercent: used,
                remainingPercent: 100 - used,
                resetAt: resetInFiveDays,
                pace: ProviderQuotaWindowPace(
                    expectedRemainingPercent: 71.4,
                    paceDeltaPercent: delta,
                    burnRate: burn,
                    minutesToReset: 7200,
                    projectedMinutesToEmpty: projected,
                    elapsedMinutes: 2880,
                    validUntil: resetInFiveDays
                )
            )
        }
        func source(paceIndex: Int?, sessionIndex: Int?, weeklyIndex: Int?) -> ProviderQuotaWidgetSource {
            ProviderQuotaWidgetSource(
                sourceID: "qsrc_select",
                providerLabel: "Claude",
                accountLabel: "Claude",
                isActiveProvider: true,
                status: "available",
                plan: nil,
                windows: [
                    ProviderQuotaWindow(label: "Session", usedPercent: 10),
                    weekly(used: 30, delta: -1.4, burn: 1.05, projected: 6720),
                ],
                retryAfter: nil,
                fetchedAt: nil,
                paceWindowIndex: paceIndex,
                sessionWindowIndex: sessionIndex,
                weeklyWindowIndex: weeklyIndex
            )
        }
        let selected = source(paceIndex: 1, sessionIndex: 0, weeklyIndex: 1)
        XCTAssertEqual(ProviderQuotaDisplayWindow.window(for: selected, basis: .pace)?.label, "Weekly")
        XCTAssertEqual(ProviderQuotaDisplayWindow.window(for: selected, basis: .overall)?.label, "Session")
        XCTAssertEqual(
            ProviderQuotaDisplayWindow.window(for: selected, basis: .overall, selection: .weekly)?.label,
            "Weekly"
        )
        XCTAssertEqual(
            ProviderQuotaDisplayWindow.window(for: selected, basis: .pace, selection: .session)?.label,
            "Session"
        )
        // An old server names no windows: the first window shows and no label is matched.
        let legacy = source(paceIndex: nil, sessionIndex: nil, weeklyIndex: nil)
        XCTAssertEqual(ProviderQuotaDisplayWindow.window(for: legacy, basis: .pace)?.label, "Session")
        XCTAssertNil(ProviderQuotaDisplayWindow.window(for: legacy, basis: .pace, selection: .weekly))
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

    func testWidgetEntityQueryEnumeratesSavedProviderAccounts() async throws {
        let store = ProviderQuotaWidgetSnapshotStore()
        defer { store.clear() }
        XCTAssertTrue(
            store.save(
                scopeID: "qscope_default",
                sources: [
                    makeSource(id: "qsrc_work", account: "Work"),
                    makeSource(id: "qsrc_personal", account: "Personal"),
                ]
            )
        )

        let entities = try await ProviderQuotaSourceEntityQuery().allEntities()

        XCTAssertEqual(
            entities.map(\.id),
            [ProviderQuotaSourceEntity.noneID, "qsrc_work", "qsrc_personal"]
        )
        XCTAssertEqual(entities.map(\.name), ["None", "Codex", "Codex"])
        let primaryEntities = try await ProviderQuotaPrimarySourceEntityQuery().allEntities()
        XCTAssertEqual(
            primaryEntities.map(\.id),
            ["qsrc_work", "qsrc_personal"]
        )
        let secondaryDefault = await ProviderQuotaSourceEntityQuery().defaultResult()
        XCTAssertEqual(
            secondaryDefault?.id,
            ProviderQuotaSourceEntity.noneID
        )
    }

    func testWidgetSecondaryNoneSelectionDoesNotProduceASourceID() {
        let configuration = ProviderQuotaWidgetConfigurationIntent()
        configuration.source1 = ProviderQuotaSourceEntity(
            id: "qsrc_work",
            name: "Codex",
            scopeLabel: "Test server"
        )
        configuration.source2 = ProviderQuotaSourceEntity.none

        XCTAssertEqual(configuration.sourceIDs[0], "qsrc_work")
        XCTAssertNil(configuration.sourceIDs[1])
    }

    func testSameProviderAccountsRemainDistinctAcrossReorderAndRename() {
        let selected = ["qsrc_work", "qsrc_personal"]
        let reordered = ProviderQuotaWidgetSnapshot(
            updatedAt: Date(),
            sources: [
                makeSource(id: "qsrc_personal", account: "Personal renamed"),
                makeSource(id: "qsrc_work", account: "Work"),
            ]
        )

        let resolved = ProviderQuotaWidgetSelection.resolve(sourceIDs: selected, snapshot: reordered)

        XCTAssertEqual(resolved.compactMap { $0?.sourceID }, selected)
        XCTAssertEqual(resolved.compactMap { $0?.accountLabel }, ["Work", "Personal renamed"])
        XCTAssertEqual(Set(resolved.compactMap { $0?.providerLabel }), ["Codex"])
    }

    func testRemovedConfiguredSourceDoesNotSubstituteAnotherAccount() {
        let snapshot = ProviderQuotaWidgetSnapshot(
            updatedAt: Date(),
            sources: [makeSource(id: "qsrc_other", account: "Other")]
        )

        let resolved = ProviderQuotaWidgetSelection.resolve(sourceIDs: ["qsrc_removed"], snapshot: snapshot)

        XCTAssertEqual(resolved.count, 1)
        XCTAssertNil(resolved[0])
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

    func testSharedStatusAndPercentagePresentationCoversDegradedStates() {
        XCTAssertEqual(ProviderQuotaPresentation.statusLabel("dead"), "Credential unavailable")
        XCTAssertEqual(
            ProviderQuotaPresentation.usedPercent(
                ProviderQuotaWindow(label: "Weekly", remainingPercent: 60)
            ),
            40
        )
        XCTAssertEqual(
            ProviderQuotaPresentation.percent(
                ProviderQuotaWindow(label: "Weekly", usedPercent: 40),
                mode: .remaining
            ),
            60
        )
    }

    func testProviderIconRegistryResolvesAliasesStylesAndFallbacks() {
        XCTAssertEqual(ProviderIconRegistry.assetName(providerID: "openai-codex"), "ProviderIconCodex")
        XCTAssertEqual(ProviderIconRegistry.assetName(providerID: "qwen-oauth"), "ProviderIconQwen")
        XCTAssertEqual(ProviderIconRegistry.assetName(providerID: "azure"), "ProviderIconAzureAI")
        XCTAssertNil(ProviderIconRegistry.assetName(providerID: "custom:private"))

        let huggingFace = ProviderIconRegistry.descriptor(providerID: "huggingface", label: "Hugging Face")
        XCTAssertEqual(huggingFace.silhouetteAssetName, "ProviderIconHuggingFaceSilhouette")
        XCTAssertTrue(huggingFace.hasOriginalColor)

        let nous = ProviderIconRegistry.descriptor(providerID: "nous", label: "Nous Portal")
        XCTAssertTrue(nous.alwaysUsesOriginalRendering)

        let unknown = ProviderIconRegistry.descriptor(providerID: "custom:private", label: "Private Model")
        XCTAssertNil(unknown.assetName)
        XCTAssertEqual(unknown.fallbackInitials, "PM")
    }

    func testRefreshCredentialStoreRoundTripsThroughSimulatorKeychain() throws {
        let service = "ProviderQuotaWidgetTests.\(UUID().uuidString)"
        let query = ProviderQuotaWidgetRefreshCredentialStore.query(
            accessGroup: nil,
            service: service,
            account: "refresh"
        )
        defer { ProviderQuotaWidgetRefreshCredentialStore.clear(query: query) }
        let credentials = makeRefreshCredentials()

        guard ProviderQuotaWidgetRefreshCredentialStore.save(credentials, query: query) else {
            throw XCTSkip("Simulator Keychain is unavailable to this unsigned test host")
        }
        XCTAssertEqual(ProviderQuotaWidgetRefreshCredentialStore.load(query: query), credentials)
        XCTAssertTrue(ProviderQuotaWidgetRefreshCredentialStore.clear(query: query))
        XCTAssertNil(ProviderQuotaWidgetRefreshCredentialStore.load(query: query))
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
        let credentials = makeRefreshCredentials(now: now)
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

    @MainActor
    func testBackgroundAndTimelineRequestsHonorConfiguredIntervals() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let oneMinute = makeRefreshCredentials(refreshIntervalSeconds: 60)
        let backgroundRequest = ProviderQuotaBackgroundRefresh.request(credentials: oneMinute, now: now)
        XCTAssertEqual(backgroundRequest.identifier, ProviderQuotaBackgroundRefresh.identifier)
        XCTAssertEqual(backgroundRequest.earliestBeginDate, now.addingTimeInterval(60))

        XCTAssertEqual(
            ProviderQuotaWidgetTimelinePolicy.nextRefreshDate(credentials: oneMinute, now: now),
            now.addingTimeInterval(300)
        )
        let thirtyMinutes = makeRefreshCredentials(refreshIntervalSeconds: 1_800)
        XCTAssertEqual(
            ProviderQuotaWidgetTimelinePolicy.nextRefreshDate(credentials: thirtyMinutes, now: now),
            now.addingTimeInterval(1_800)
        )
    }

    func testWidgetProfileCRUDDefaultApplyAndDelete() throws {
        let suite = "ProviderQuotaProfiles.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(ProviderQuotaWidgetArcColor.blue.rawValue, forKey: ProviderQuotaWidgetArcColor.storageKey)
        let profile = try XCTUnwrap(
            ProviderQuotaWidgetProfileStore.saveCurrent(name: " Blue ", defaults: defaults)
        )
        XCTAssertEqual(profile.name, "Blue")
        XCTAssertEqual(ProviderQuotaWidgetProfileStore.profiles(defaults: defaults), [profile])

        ProviderQuotaWidgetProfileStore.setDefault(id: profile.id, defaults: defaults)
        XCTAssertEqual(ProviderQuotaWidgetProfileStore.selectedDefaultProfileID(defaults: defaults), profile.id)
        XCTAssertEqual(
            ProviderQuotaWidgetResolvedProfile.resolve(id: nil, defaults: defaults).id,
            profile.id
        )

        defaults.set(ProviderQuotaWidgetArcColor.red.rawValue, forKey: ProviderQuotaWidgetArcColor.storageKey)
        ProviderQuotaWidgetProfileStore.apply(profile, defaults: defaults)
        XCTAssertEqual(defaults.string(forKey: ProviderQuotaWidgetArcColor.storageKey), "blue")

        _ = ProviderQuotaWidgetProfileStore.saveCurrent(name: "Updated", id: profile.id, defaults: defaults)
        XCTAssertEqual(ProviderQuotaWidgetProfileStore.profiles(defaults: defaults).map(\.name), ["Updated"])
        ProviderQuotaWidgetProfileStore.delete(id: profile.id, defaults: defaults)
        XCTAssertTrue(ProviderQuotaWidgetProfileStore.profiles(defaults: defaults).isEmpty)
        XCTAssertNil(ProviderQuotaWidgetProfileStore.selectedDefaultProfileID(defaults: defaults))
    }

    func testSidebarDetailModesUseSharedPresentationState() {
        let source = makeSource(id: "qsrc_work", account: "Work")
        let settings = ProviderQuotaEvaluationSettings(
            percentageMode: .used,
            colorBasis: .pace,
            windowSelection: .automatic
        )
        let state = ProviderQuotaPresentationState(
            window: source.windows.first,
            percent: 20,
            remainingPercent: 80,
            resetAt: nil,
            referenceDate: Date(timeIntervalSince1970: 1_900_000_000),
            freshnessDate: Date(timeIntervalSince1970: 1_899_999_900),
            isStale: false,
            pace: ProviderQuotaWindowPace(
                expectedRemainingPercent: 75,
                paceDeltaPercent: 5,
                burnRate: 0.8,
                minutesToReset: 60,
                elapsedMinutes: 240,
                status: "under"
            ),
            urgency: .healthy,
            settings: settings
        )

        XCTAssertEqual(
            ProviderQuotaSidebarPresentation.detail(mode: .percentage, source: source, state: state),
            "20% used"
        )
        XCTAssertEqual(
            ProviderQuotaSidebarPresentation.detail(mode: .pace, source: source, state: state),
            "5% under pace"
        )
        XCTAssertNotNil(
            ProviderQuotaSidebarPresentation.detail(mode: .freshness, source: source, state: state)
        )
        XCTAssertEqual(
            ProviderQuotaSidebarPresentation.detail(mode: .reset, source: source, state: state),
            "Available"
        )
        XCTAssertNil(
            ProviderQuotaSidebarPresentation.detail(mode: .hidden, source: source, state: state)
        )
    }

    func testSidebarDisplayOptionsCoverIconRailMarkerAndColorCombinations() {
        let full = ProviderQuotaSidebarDisplayOptions(
            detail: .percentage,
            showsRail: true,
            requestsPaceMarker: true,
            showsIcon: true,
            colorsByState: true
        )
        XCTAssertTrue(full.showsPaceMarker)

        let noRail = ProviderQuotaSidebarDisplayOptions(
            detail: .hidden,
            showsRail: false,
            requestsPaceMarker: true,
            showsIcon: false,
            colorsByState: false
        )
        XCTAssertFalse(noRail.showsPaceMarker)
        XCTAssertFalse(noRail.showsIcon)
        XCTAssertFalse(noRail.colorsByState)
        XCTAssertEqual(noRail.detail, .hidden)
    }

    private func makeRefreshCredentials(
        now: Date = Date(),
        refreshIntervalSeconds: Int = 300
    ) -> ProviderQuotaWidgetRefreshCredentials {
        ProviderQuotaWidgetRefreshCredentials(
            serverURLString: "https://example.test",
            serverLabel: "Test server",
            refreshIntervalSeconds: refreshIntervalSeconds,
            headers: [
                ProviderQuotaWidgetRefreshHeader(name: "X-Test", value: "widget"),
                ProviderQuotaWidgetRefreshHeader(name: "x-talaria-client", value: "forged identity"),
            ],
            cookies: [
                ProviderQuotaWidgetRefreshCookie(
                    HTTPCookie(properties: [
                        .name: "live", .value: "value", .domain: "example.test", .path: "/",
                        .secure: "TRUE", .expires: now.addingTimeInterval(60),
                    ])!
                ),
                ProviderQuotaWidgetRefreshCookie(
                    HTTPCookie(properties: [
                        .name: "expired", .value: "value", .domain: "example.test", .path: "/",
                        .secure: "TRUE", .expires: now.addingTimeInterval(-60),
                    ])!
                ),
            ]
        )
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

    private func makeSource(
        id: String,
        account: String,
        scopeID: String = "qscope_default",
        cachedAt: Date = Date()
    ) -> ProviderQuotaWidgetSource {
        ProviderQuotaWidgetSource(
            sourceID: id,
            scopeID: scopeID,
            scopeLabel: "Test server · default",
            cachedAt: cachedAt,
            providerID: "openai-codex",
            providerLabel: "Codex",
            accountLabel: account,
            isActiveProvider: true,
            status: "available",
            plan: "Pro",
            windows: [
                ProviderQuotaWindow(label: "Session", usedPercent: 20, remainingPercent: 80),
                ProviderQuotaWindow(label: "Weekly", usedPercent: 40, remainingPercent: 60),
            ],
            retryAfter: nil,
            fetchedAt: "2030-03-17T12:30:00Z"
        )
    }
}

import XCTest
import Security
@testable import Talaria
@testable import TalariaKit

final class ProviderQuotaWidgetTests: XCTestCase {
    func testExplicitSlotCapacityUsesOneTwoAndFourWithoutAutoFill() {
        let slots = ["one", nil, "three", "four"]

        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 1), ["one"])
        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 2), ["one"])
        XCTAssertEqual(ProviderQuotaWidgetSelection.sourceIDs(slotIDs: slots, capacity: 4), ["one", "three", "four"])
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

    func testSharedSlotGeometryKeepsSingleAndDualPrimaryGaugeBoundsIdentical() {
        let bounds = CGRect(x: 0, y: 0, width: 300, height: 140)
        let twoSlots = ProviderQuotaWidgetSlotGeometry.frames(count: 2, in: bounds, spacing: 12)
        XCTAssertEqual(twoSlots[0], CGRect(x: 0, y: 0, width: 144, height: 140))

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

    /// TAL-1533: the App renders the server's `is_stale`, `stale_since` and `pace_needs_refresh`, and on the shared
    /// fixture they give the values the App computed itself before the server sent them.
    func testServerFreshnessFieldsRenderTheValuesTheAppComputed() throws {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/provider-quotas.json"))
        ) as? [String: Any])
        func source(_ edit: (inout [String: Any]) -> Void) throws -> ProviderQuotaWidgetSource {
            var body = fixture
            var sources = try XCTUnwrap(body["sources"] as? [[String: Any]])
            edit(&sources[0])
            body["sources"] = sources
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let response = try decoder.decode(ProviderQuotasResponse.self, from: JSONSerialization.data(withJSONObject: body))
            return ProviderQuotaWidgetSource(try XCTUnwrap(response.sources.first), scopeID: "qscope_fixture", scopeLabel: "Fixture")
        }
        let served = try source { _ in }
        let preServer = try source { row in
            row["is_stale"] = nil
            row["stale_since"] = nil
            row["windows"] = (row["windows"] as? [[String: Any]])?.map { var window = $0; window["pace_needs_refresh"] = nil; return window }
        }
        let fetched = served.freshnessDate
        let sessionReset = try XCTUnwrap(ProviderQuotaDateParser.date(from: served.windows[0].resetAt))
        let state = { (source: ProviderQuotaWidgetSource, settings: ProviderQuotaEvaluationSettings, date: Date) in
            ProviderQuotaPresentation.state(for: source, settings: settings, at: date)
        }
        // What the screens render; the decoded window itself differs by the new field.
        let rendered = { (state: ProviderQuotaPresentationState) in
            "\((state.percent, state.remainingPercent, state.resetAt, state.isStale, state.urgency, state.pace, state.forecast, state.paceNeedsRefresh, state.computedAt))"
        }
        for date in [fetched, fetched.addingTimeInterval(900), fetched.addingTimeInterval(901), sessionReset] {
            for mode in [ProviderQuotaPercentageMode.used, .remaining] {
                for selection in [ProviderQuotaWidgetWindowSelection.automatic, .session, .weekly] {
                    for basis in [ProviderQuotaWidgetColorBasis.overall, .pace] {
                        let settings = ProviderQuotaEvaluationSettings(percentageMode: mode, colorBasis: basis, windowSelection: selection)
                        XCTAssertEqual(rendered(state(served, settings, date)), rendered(state(preServer, settings, date)), "\(date) \(mode) \(selection) \(basis)")
                    }
                }
            }
        }
        let session = ProviderQuotaEvaluationSettings(percentageMode: .used, colorBasis: .overall, windowSelection: .session)
        XCTAssertFalse(state(served, session, fetched.addingTimeInterval(900)).isStale)
        XCTAssertTrue(state(served, session, fetched.addingTimeInterval(901)).isStale)
        XCTAssertEqual(state(served, session, fetched).percent, 10)
        XCTAssertNotNil(state(served, session, sessionReset.addingTimeInterval(-1)).pace)
        XCTAssertTrue(state(served, session, sessionReset).paceNeedsRefresh)

        // The server's decisions win over the App's clock: a stale copy, and a pace its read saw expire.
        let decided = try source { row in
            row["is_stale"] = true
            row["windows"] = (row["windows"] as? [[String: Any]])?.map { var window = $0; window["pace_needs_refresh"] = true; return window }
        }
        let decidedState = state(decided, session, fetched)
        XCTAssertTrue(decidedState.isStale)
        XCTAssertEqual(decidedState.urgency, .stale)
        XCTAssertTrue(decidedState.paceNeedsRefresh)
        XCTAssertNil(decidedState.pace)
        // `stale_since` decides when a copy turns stale.
        let early = try source { row in row["stale_since"] = "2026-09-28T08:00:00Z" }
        XCTAssertTrue(state(early, session, fetched.addingTimeInterval(31)).isStale)
    }

    /// TAL-45: a credit source shows the server's percents of its cap, the sidebar names an uncapped one's amount, and
    /// only a payload from before the server block keeps the App's own percent (TAL-2624 deletes that fallback).
    func testCreditPercentsAndAmountsComeFromTheServerBlock() throws {
        // app/TalariaTests/<file> -> repository root
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(
            with: Data(contentsOf: root.appendingPathComponent("contracts/fixtures/provider-quotas.json"))
        ) as? [String: Any])
        func credits(_ edit: (inout [String: Any]) -> Void) throws -> ProviderQuotaWidgetSource {
            var body = fixture
            var sources = try XCTUnwrap(body["sources"] as? [[String: Any]])
            let index = try XCTUnwrap(sources.firstIndex { $0["provider_id"] as? String == "openrouter" })
            var quota = try XCTUnwrap(sources[index]["quota"] as? [String: Any])
            edit(&quota)
            sources[index]["quota"] = quota
            body["sources"] = [sources[index]]
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let response = try decoder.decode(ProviderQuotasResponse.self, from: JSONSerialization.data(withJSONObject: body))
            return ProviderQuotaWidgetSource(try XCTUnwrap(response.sources.first), scopeID: "qscope_fixture", scopeLabel: "Fixture")
        }
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        func state(_ source: ProviderQuotaWidgetSource, _ mode: ProviderQuotaPercentageMode) -> ProviderQuotaPresentationState {
            ProviderQuotaPresentation.state(
                for: source,
                settings: ProviderQuotaEvaluationSettings(percentageMode: mode, colorBasis: .overall, windowSelection: .automatic),
                at: now
            )
        }

        let served = try credits { _ in }
        XCTAssertEqual(served.quota?.currency, "USD")
        XCTAssertEqual(state(served, .used).percent, 37.5)
        XCTAssertEqual(state(served, .remaining).percent, 62.5)
        // The server's percent wins over amounts that disagree with it.
        let disagreeing = try credits { $0["percent_used"] = 90; $0["percent_remaining"] = 10 }
        XCTAssertEqual(state(disagreeing, .used).percent, 90)
        XCTAssertEqual(state(disagreeing, .remaining).remainingPercent, 10)
        XCTAssertEqual(
            ProviderQuotaSidebarPresentation.detail(mode: .percentage, source: disagreeing, state: state(disagreeing, .remaining)),
            "10% remaining"
        )
        // Uncapped: no percent or meter, and the sidebar shows the remaining amount, else the usage.
        let uncapped = try credits { quota in
            quota["limit"] = NSNull(); quota["is_capped"] = false; quota["percent_used"] = NSNull(); quota["percent_remaining"] = NSNull()
        }
        XCTAssertNil(state(uncapped, .used).percent)
        XCTAssertEqual(ProviderQuotaSidebarPresentation.detail(mode: .percentage, source: uncapped, state: state(uncapped, .used)), "$12.50 remaining")
        let usageOnly = try credits { quota in
            quota["limit_remaining"] = NSNull(); quota["limit"] = NSNull(); quota["is_capped"] = false
            quota["percent_used"] = NSNull(); quota["percent_remaining"] = NSNull()
        }
        XCTAssertEqual(ProviderQuotaSidebarPresentation.detail(mode: .percentage, source: usageOnly, state: state(usageOnly, .used)), "$7.50 used")
        // A server without the block keeps the device percent until TAL-2624.
        let preServer = try credits { quota in
            for key in ["currency", "is_capped", "percent_used", "percent_remaining", "over_limit"] { quota[key] = nil }
        }
        XCTAssertEqual(state(preServer, .used).percent, 37.5)
        XCTAssertEqual(preServer.quota?.usageLabel, "7.5 used of 20")
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

    func testWidgetEntityQueryEnumeratesSavedProviderAccounts() async throws {
        let store = ProviderQuotaWidgetSnapshotStore()
        defer { store.clear() }
        XCTAssertTrue(
            store.save(
                scopeID: "qscope_default",
                sources: [
                    makeQuotaWidgetSource(id: "qsrc_work", account: "Work"),
                    makeQuotaWidgetSource(id: "qsrc_personal", account: "Personal"),
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
                makeQuotaWidgetSource(id: "qsrc_personal", account: "Personal renamed"),
                makeQuotaWidgetSource(id: "qsrc_work", account: "Work"),
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
            sources: [makeQuotaWidgetSource(id: "qsrc_other", account: "Other")]
        )

        let resolved = ProviderQuotaWidgetSelection.resolve(sourceIDs: ["qsrc_removed"], snapshot: snapshot)

        XCTAssertEqual(resolved.count, 1)
        XCTAssertNil(resolved[0])
    }

    func testSharedStatusPresentationCoversDegradedStates() {
        XCTAssertEqual(ProviderQuotaPresentation.statusLabel("dead"), "Credential unavailable")
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
        let credentials = makeQuotaRefreshCredentials()

        guard ProviderQuotaWidgetRefreshCredentialStore.save(credentials, query: query) else {
            throw XCTSkip("Simulator Keychain is unavailable to this unsigned test host")
        }
        XCTAssertEqual(ProviderQuotaWidgetRefreshCredentialStore.load(query: query), credentials)
        XCTAssertTrue(ProviderQuotaWidgetRefreshCredentialStore.clear(query: query))
        XCTAssertNil(ProviderQuotaWidgetRefreshCredentialStore.load(query: query))
    }

    @MainActor
    func testBackgroundAndTimelineRequestsHonorConfiguredIntervals() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let oneMinute = makeQuotaRefreshCredentials(refreshIntervalSeconds: 60)
        let backgroundRequest = ProviderQuotaBackgroundRefresh.request(credentials: oneMinute, now: now)
        XCTAssertEqual(backgroundRequest.identifier, ProviderQuotaBackgroundRefresh.identifier)
        XCTAssertEqual(backgroundRequest.earliestBeginDate, now.addingTimeInterval(60))

        XCTAssertEqual(
            ProviderQuotaWidgetTimelinePolicy.nextRefreshDate(credentials: oneMinute, now: now),
            now.addingTimeInterval(300)
        )
        let thirtyMinutes = makeQuotaRefreshCredentials(refreshIntervalSeconds: 1_800)
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
        let source = makeQuotaWidgetSource(id: "qsrc_work", account: "Work")
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
}

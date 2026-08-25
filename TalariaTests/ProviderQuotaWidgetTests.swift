import XCTest
@testable import Talaria

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
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultWarningRemainingPercent, 25)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultCriticalRemainingPercent, 10)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultPaceTolerancePercent, 3)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultPaceWarningBurnRatePercent, 125)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultPaceCriticalBurnRatePercent, 175)
        XCTAssertEqual(ProviderQuotaWidgetAppearanceSettings.defaultPaceMinimumElapsedHours, 12)
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

    func testAutomaticUrgencyDefaultsToWeeklyPaceAndCanUseOverallPercentage() {
        let now = Date(timeIntervalSince1970: 1_900_000_000)
        let resetInFiveDays = ISO8601DateFormatter().string(from: now.addingTimeInterval(5 * 24 * 60 * 60))

        func urgency(used: Double, basis: ProviderQuotaWidgetColorBasis) -> ProviderQuotaUrgency {
            ProviderQuotaUrgencyCalculator.urgency(
                windows: [ProviderQuotaWindow(label: "Weekly", usedPercent: used, resetAt: resetInFiveDays)],
                status: "available",
                isStale: false,
                referenceDate: now,
                basis: basis,
                warningRemainingPercent: 25,
                criticalRemainingPercent: 10,
                paceTolerancePercent: 3,
                paceWarningBurnRatePercent: 125,
                paceCriticalBurnRatePercent: 175,
                paceMinimumElapsedHours: 12
            )
        }

        XCTAssertEqual(urgency(used: 10, basis: .pace), .healthy)
        XCTAssertEqual(urgency(used: 30, basis: .pace), .healthy)
        XCTAssertEqual(urgency(used: 32, basis: .pace), .warning)
        XCTAssertEqual(urgency(used: 90, basis: .pace), .critical)
        XCTAssertEqual(urgency(used: 90, basis: .overall), .critical)

        let windows = [
            ProviderQuotaWindow(label: "Session", usedPercent: 10),
            ProviderQuotaWindow(label: "Weekly", usedPercent: 30, resetAt: resetInFiveDays),
        ]
        XCTAssertEqual(ProviderQuotaUrgencyCalculator.displayWindow(from: windows, basis: .pace)?.label, "Weekly")
        XCTAssertEqual(ProviderQuotaUrgencyCalculator.displayWindow(from: windows, basis: .overall)?.label, "Session")

        let sessionReset = ISO8601DateFormatter().string(from: now.addingTimeInterval(4 * 60 * 60))
        let sessionPace = ProviderQuotaUrgencyCalculator.pace(
            for: ProviderQuotaWindow(label: "Session", usedPercent: 10, resetAt: sessionReset),
            referenceDate: now,
            minimumElapsedHours: 0
        )
        XCTAssertEqual(sessionPace?.expectedRemainingPercent, 80)
        XCTAssertEqual(sessionPace?.paceDeltaPercent, 10)

        let collapsedWeeklyReset = ISO8601DateFormatter().string(
            from: now.addingTimeInterval((6 * 24 + 6) * 60 * 60)
        )
        let collapsedWeeklyPace = ProviderQuotaUrgencyCalculator.pace(
            for: ProviderQuotaWindow(label: "Session", usedPercent: 12, resetAt: collapsedWeeklyReset),
            referenceDate: now,
            minimumElapsedHours: 0
        )
        XCTAssertEqual(collapsedWeeklyPace?.expectedRemainingPercent, 89.3)
        XCTAssertEqual(collapsedWeeklyPace?.paceDeltaPercent, -1.3)
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

        XCTAssertEqual(entities.map(\.id), ["qsrc_work", "qsrc_personal"])
        XCTAssertEqual(entities.map(\.name), ["Codex", "Codex"])
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

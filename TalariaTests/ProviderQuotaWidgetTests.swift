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
            ["sourceID", "scopeID", "scopeLabel", "cachedAt", "providerLabel", "accountLabel", "isActiveProvider", "status", "plan", "windows", "fetchedAt"]
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

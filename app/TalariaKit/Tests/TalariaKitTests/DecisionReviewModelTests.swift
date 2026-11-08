import XCTest
@testable import TalariaKit

/// TAL-1965: the review screen's model against the shared `contracts/fixtures/decision-review.json`.
@MainActor
final class DecisionReviewModelTests: XCTestCase {
    /// One key of the shared fixture, as JSON.
    nonisolated static func fixture(_ key: String) throws -> String {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("decision-review")) as? [String: Any])
        return String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(root[key])), as: UTF8.self)
    }

    /// The fixture review with `item`'s answer replaced by `answer` (JSON, or `null`) at `version`.
    nonisolated static func review(answering item: String, with answer: String, version: Int) throws -> String {
        var root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fixture("review").utf8)) as? [String: Any])
        var items = try XCTUnwrap(root["items"] as? [[String: Any]])
        let index = try XCTUnwrap(items.firstIndex { $0["id"] as? String == item })
        items[index]["answer"] = try JSONSerialization.jsonObject(with: Data(answer.utf8), options: .fragmentsAllowed)
        items[index]["answer_version"] = version
        // Each write is a later server copy.
        root["updated_at"] = 1_893_456_600 + version * 10
        root["items"] = items
        return String(decoding: try JSONSerialization.data(withJSONObject: root), as: UTF8.self)
    }

    private func model(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> DecisionReviewModel {
        let host = "decisions-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)")!, session: URLSession(configuration: config))
        return DecisionReviewModel(reviewID: "dr_0a1b2c3d", client: client)
    }

    private static func isAnswerWrite(_ request: URLRequest) -> Bool {
        request.httpMethod == "PUT" && request.url?.path == "/api/decisions/dr_0a1b2c3d/answers/retention"
    }

    func testTheReviewOpensOnTheServersFirstItemAndListsTheServersFilters() async throws {
        let review = try Self.fixture("review")
        let model = model { $0.complete(withJSON: review) }
        await model.load()

        XCTAssertEqual(model.review?.items.map(\.id), ["retention", "notify", "theme"], "The server's order, never re-sorted")
        XCTAssertEqual(model.currentItem?.id, "retention")
        model.filter = .new
        XCTAssertEqual(model.filteredItems.map(\.id), ["retention", "notify"])
        model.filter = .pending
        XCTAssertEqual(model.filteredItems.map(\.id), ["retention"])
        model.open(itemID: "theme")
        model.continueReview()
        XCTAssertEqual(model.currentItem?.id, "retention", "Continue opens the server's next_item_id")
    }

    func testSaveAndNextShowsTheChoiceAtOnceAdvancesAndSendsOneWrite() async throws {
        let review = try Self.fixture("review")
        let saved = try Self.review(answering: "retention", with: #"{"value":"week","label":"Archive after a week","effect":"Chats older than seven days move to the archive.","notes":"","deferred":false,"custom":false,"version":3,"updated_at":1893456800}"#, version: 3)
        let changedElsewhere = try Self.review(answering: "retention", with: #"{"value":"never","label":"Never archive","effect":"The sidebar keeps every chat until you archive it.","notes":"","deferred":false,"custom":false,"version":4,"updated_at":1893456900}"#, version: 4)
        let readsChanged = LockedTestValue(false)
        let writes = DeferredRequests()
        let arrived = expectation(description: "answer write held")
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                _ = writes.append(request)
                arrived.fulfill()
            } else { request.complete(withJSON: readsChanged.value ? changedElsewhere : review) }
        }
        await model.load()
        let item = try XCTUnwrap(model.currentItem)
        model.setDraft(.init(value: "week", notes: ""), for: item)

        let save = Task { await model.saveAndNext() }
        await fulfillment(of: [arrived], timeout: 5)
        XCTAssertEqual(model.review?.item(id: "retention")?.answer?.label, "Archive after a week", "Shown before the server answers")
        XCTAssertEqual(model.currentItem?.id, "notify", "The next item opens at once")
        let body = try apiTestJSONBody(from: writes.request(at: 0).request)
        XCTAssertEqual(body["expected_version"] as? Int, 2, "The item's answer_version, which a clear never resets")
        XCTAssertEqual(body["value"] as? String, "week")
        XCTAssertEqual(body["content_hash"] as? String, "synthetic-hash-retention")

        writes.request(at: 0).complete(withJSON: saved)
        await save.value
        XCTAssertEqual(writes.count, 1)
        XCTAssertEqual(model.review?.item(id: "retention")?.answerVersion, 3)
        XCTAssertNil(model.lastError)

        // The settled draft gives way to the server: another client's later answer shows.
        readsChanged.value = true
        await model.load()
        let shown = try XCTUnwrap(model.review?.item(id: "retention"))
        XCTAssertEqual(model.draft(for: shown).value, "never")
    }

    func testAnAnswerConflictRestoresTheStoredAnswerAndKeepsTheTypedNotes() async throws {
        let review = try Self.fixture("review")
        let conflict = try Self.fixture("answer_conflict")
        let stored = try Self.review(answering: "retention", with: String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(
            (JSONSerialization.jsonObject(with: Data(conflict.utf8)) as? [String: Any])?["answer"]
        )), as: UTF8.self), version: 3)
        let readsStored = LockedTestValue(false)
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                request.complete(withJSON: conflict, statusCode: 409)
            } else { request.complete(withJSON: readsStored.value ? stored : review) }
        }
        await model.load()
        readsStored.value = true
        let item = try XCTUnwrap(model.currentItem)
        model.setDraft(.init(value: "week", notes: "Only on weekdays"), for: item)

        await model.saveAndNext()

        let shown = try XCTUnwrap(model.review?.item(id: "retention"))
        XCTAssertEqual(shown.answer?.value, "month", "The server's stored answer replaces the refused one")
        XCTAssertEqual(shown.answerVersion, 3)
        XCTAssertEqual(model.refusal, .conflict(itemID: "retention"))
        XCTAssertEqual(model.currentItem?.id, "retention", "The refused item opens again")
        XCTAssertEqual(model.draft(for: shown).notes, "Only on weekdays")
        XCTAssertEqual(model.draft(for: shown).value, "month")
    }

    func testAnUnknownOutcomeRereadsTheReviewAndNeverResendsTheWrite() async throws {
        let review = try Self.fixture("review")
        let landed = try Self.review(answering: "retention", with: #"{"value":null,"label":null,"effect":null,"notes":"","deferred":true,"custom":false,"version":3,"updated_at":1893456800}"#, version: 3)
        let writes = LockedTestValue(0)
        let reads = LockedTestValue(0)
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                writes.value += 1
                request.fail(with: URLError(.timedOut))
            } else {
                reads.value += 1
                request.complete(withJSON: reads.value > 1 ? landed : review)
            }
        }
        await model.load()

        await model.deferCurrent()

        XCTAssertEqual(writes.value, 1, "An unknown outcome is never replayed blind")
        XCTAssertEqual(reads.value, 2, "The review is reread before anything else")
        XCTAssertEqual(model.review?.item(id: "retention")?.answer?.deferred, true, "The reread shows the save landed")
        XCTAssertNil(model.lastError, "A save the reread confirms reports no error")
    }

    func testAnUnknownOutcomeTheRereadDoesNotConfirmRollsBackWithTheError() async throws {
        let review = try Self.fixture("review")
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                request.fail(with: URLError(.networkConnectionLost))
            } else { request.complete(withJSON: review) }
        }
        await model.load()
        model.setDraft(.init(value: nil, notes: "Ask me again next week"), for: try XCTUnwrap(model.currentItem))

        await model.useNotesForCurrent()

        XCTAssertNil(model.review?.item(id: "retention")?.answer)
        XCTAssertNotNil(model.lastError)
    }

    func testSubmitShowsAtOnceAndWaitsForASaveStillInFlight() async throws {
        let review = try Self.fixture("review")
        let order = LockedTestValue<[String]>([])
        let writes = DeferredRequests()
        let arrived = expectation(description: "answer write held")
        let submitWhileSaving = expectation(description: "submit reached the server while the save was held")
        submitWhileSaving.isInverted = true
        let saveHeld = LockedTestValue(true)
        let model = model { request in
            order.value.append("\(request.request.httpMethod ?? "") \(request.request.url?.path ?? "")")
            if request.request.url?.path.hasSuffix("/submit") == true, saveHeld.value { submitWhileSaving.fulfill() }
            if Self.isAnswerWrite(request.request) {
                _ = writes.append(request)
                arrived.fulfill()
            } else { request.complete(withJSON: review) }
        }
        await model.load()
        model.setDraft(.init(value: "week", notes: ""), for: try XCTUnwrap(model.currentItem))
        let save = Task { await model.saveAndNext() }
        await fulfillment(of: [arrived], timeout: 5)

        let submit = Task { await model.submit() }
        await drainMainActor()
        XCTAssertEqual(model.review?.status, .submitted, "Submit shows at once")
        await fulfillment(of: [submitWhileSaving], timeout: 0.5)

        saveHeld.value = false
        writes.request(at: 0).complete(withJSON: review)
        await save.value
        await submit.value
        let saveIndex = try XCTUnwrap(order.value.firstIndex { $0.hasPrefix("PUT") })
        let submitIndex = try XCTUnwrap(order.value.firstIndex { $0.hasSuffix("/submit") })
        XCTAssertLessThan(saveIndex, submitIndex)
    }

    func testASaveThatFailsStopsTheSubmitQueuedBehindIt() async throws {
        let review = try Self.fixture("review")
        let conflict = try Self.fixture("answer_conflict")
        let order = LockedTestValue<[String]>([])
        let writes = DeferredRequests()
        let arrived = expectation(description: "answer write held")
        let model = model { request in
            order.value.append(request.request.url?.path ?? "")
            if Self.isAnswerWrite(request.request) {
                _ = writes.append(request)
                arrived.fulfill()
            } else { request.complete(withJSON: review) }
        }
        await model.load()
        model.setDraft(.init(value: "week", notes: ""), for: try XCTUnwrap(model.currentItem))
        let save = Task { await model.saveAndNext() }
        await fulfillment(of: [arrived], timeout: 5)
        let submit = Task { await model.submit() }
        await drainMainActor()

        writes.request(at: 0).complete(withJSON: conflict, statusCode: 409)
        await save.value
        await submit.value

        XCTAssertFalse(order.value.contains { $0.hasSuffix("/submit") }, "A refused save stops the queued submit")
        XCTAssertEqual(model.review?.status, .open)
        XCTAssertEqual(model.refusal, .conflict(itemID: "retention"))
    }

    func testAnUnknownOutcomeWhoseRereadFailsStaysShownUntilARead() async throws {
        let review = try Self.fixture("review")
        let landed = try Self.review(answering: "retention", with: #"{"value":null,"label":null,"effect":null,"notes":"","deferred":true,"custom":false,"version":3,"updated_at":1893456800}"#, version: 3)
        let offline = LockedTestValue(false)
        let wrote = LockedTestValue(false)
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                offline.value = true
                wrote.value = true
                request.fail(with: URLError(.networkConnectionLost))
            } else if offline.value {
                request.fail(with: URLError(.notConnectedToInternet))
            } else { request.complete(withJSON: wrote.value ? landed : review) }
        }
        await model.load()

        await model.deferCurrent()
        XCTAssertEqual(model.review?.item(id: "retention")?.answer?.deferred, true, "No read decided, so nothing rolls back")
        XCTAssertNotNil(model.lastError)

        offline.value = false
        await model.load()
        XCTAssertEqual(model.review?.item(id: "retention")?.answerVersion, 3, "The read settles it")
    }

    func testAnotherClientsAnswerAtTheExpectedVersionIsNotTakenForALostSave() async throws {
        let review = try Self.fixture("review")
        let theirs = try Self.review(answering: "retention", with: #"{"value":"never","label":"Never archive","effect":"The sidebar keeps every chat until you archive it.","notes":"","deferred":false,"custom":false,"version":3,"updated_at":1893456800}"#, version: 3)
        let wrote = LockedTestValue(false)
        let submits = LockedTestValue(0)
        let writes = DeferredRequests()
        let arrived = expectation(description: "answer write held")
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                wrote.value = true
                _ = writes.append(request)
                arrived.fulfill()
            } else if request.request.url?.path.hasSuffix("/submit") == true {
                submits.value += 1
                request.complete(withJSON: theirs)
            } else { request.complete(withJSON: wrote.value ? theirs : review) }
        }
        await model.load()
        let item = try XCTUnwrap(model.currentItem)
        model.setDraft(.init(value: "week", notes: ""), for: item)
        let save = Task { await model.saveAndNext() }
        await fulfillment(of: [arrived], timeout: 5)
        let submit = Task { await model.submit() }
        await drainMainActor()

        // The response is lost, and the reread finds another client's answer at the version this save would have made.
        writes.request(at: 0).fail(with: URLError(.networkConnectionLost))
        await save.value
        await submit.value

        XCTAssertEqual(submits.value, 0, "A save that did not land stops the queued submit")
        XCTAssertEqual(model.review?.status, .open)
        XCTAssertEqual(model.draft(for: try XCTUnwrap(model.review?.item(id: "retention"))).value, "week", "The user's choice is kept")
    }

    func testARefreshThatStartedBeforeASaveCannotUndoIt() async throws {
        let review = try Self.fixture("review")
        let saved = try Self.review(answering: "retention", with: #"{"value":"week","label":"Archive after a week","effect":"Chats older than seven days move to the archive.","notes":"","deferred":false,"custom":false,"version":3,"updated_at":1893456800}"#, version: 3)
        let reads = DeferredRequests()
        let readHeld = expectation(description: "refresh held")
        let model = model { request in
            if Self.isAnswerWrite(request.request) {
                request.complete(withJSON: saved)
            } else {
                _ = reads.append(request)
                if reads.count == 2 { readHeld.fulfill() } else { request.complete(withJSON: review) }
            }
        }
        await model.load()
        model.setDraft(.init(value: "week", notes: ""), for: try XCTUnwrap(model.currentItem))
        let refresh = Task { await model.load() }
        await fulfillment(of: [readHeld], timeout: 5)

        await model.saveAndNext()
        reads.request(at: 1).complete(withJSON: review)
        await refresh.value

        XCTAssertEqual(model.review?.item(id: "retention")?.answerVersion, 3, "The older read is ignored")
        XCTAssertEqual(model.review?.item(id: "retention")?.answer?.value, "week")
    }

    func testDeferUseNotesAndClearSendTheirAnswerShapes() async throws {
        let review = try Self.fixture("review")
        let bodies = LockedTestValue<[[String: Any]]>([])
        let model = model { request in
            if request.request.httpMethod == "PUT", let body = try? apiTestJSONBody(from: request.request) { bodies.value.append(body) }
            request.complete(withJSON: review)
        }
        await model.load()
        let item = try XCTUnwrap(model.currentItem)

        await model.useNotesForCurrent()
        XCTAssertTrue(bodies.value.isEmpty, "Empty notes cannot be the answer")
        model.setDraft(.init(value: nil, notes: "Archive drafts only"), for: item)
        await model.useNotesForCurrent()
        model.open(itemID: "retention")
        await model.deferCurrent()
        await model.clearAnswer(itemID: "theme")

        XCTAssertEqual(bodies.value.count, 3)
        XCTAssertEqual(bodies.value[0]["custom"] as? Bool, true)
        XCTAssertEqual(bodies.value[0]["notes"] as? String, "Archive drafts only")
        XCTAssertTrue(bodies.value[0]["value"] is NSNull, "A custom answer sends value null")
        XCTAssertEqual(bodies.value[1]["deferred"] as? Bool, true)
        XCTAssertEqual(bodies.value[2]["expected_version"] as? Int, 1)
        XCTAssertTrue(bodies.value[2]["value"] is NSNull)
        XCTAssertEqual(bodies.value[2]["deferred"] as? Bool, false)
        XCTAssertEqual(bodies.value[2]["custom"] as? Bool, false)
    }
}

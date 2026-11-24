import XCTest
@testable import TalariaKit

/// TAL-1176: the server names each reasoning segment with a `disclosure_key` on its live `reasoning` events and on its
/// settled scene row, so a thinking card the reader opened while live keeps that choice once its turn settles.
@MainActor
extension ChatViewModelSendTests {
    func testLiveReasoningAndItsSettledRowShareTheServersDisclosureKey() async throws {
        let scenario = try RunningReasoningScenario()
        let settledRow = try XCTUnwrap(scenario.settledReasoningRows().first)
        let streamClient = SpySSEStreamingClient()
        let viewModel = try makeViewModel(streamClient: streamClient) { request in
            apiTestJSONResponse(#"{"session_id":"session-abc","stream_id":"\#(scenario.streamID)"}"#, for: request)
        }
        let started = await viewModel.sendMessage("Read both files")
        XCTAssertTrue(started)

        streamClient.emit(.reasoning(try scenario.liveEvent(#"{"text":"Plan the read.","disclosure_key":"\#(scenario.disclosureKey)"}"#)))
        streamClient.emit(.token("Reading a.txt."))
        streamClient.emit(.reasoning(try scenario.liveEvent(#"{"text":"Check it.","disclosure_key":"\#(scenario.streamID):later"}"#)))
        streamClient.emit(.token(" Done."))

        let liveKeys = viewModel.liveActivityRows.filter { $0.kind == "reasoning" }.map(\.disclosureStateID)
        XCTAssertEqual(liveKeys.first, settledRow.disclosureStateID, "The live card and its settled row keep their open state apart")
        XCTAssertEqual(liveKeys, [scenario.disclosureKey, "\(scenario.streamID):later"], "Each live segment keeps the key its events name")
    }

    /// An older server sends no `disclosure_key`: the live card and the settled card keep their own row ids, as before.
    func testReasoningWithoutADisclosureKeyKeepsItsRowID() throws {
        let scenario = try RunningReasoningScenario()
        let event = try scenario.liveEvent(#"{"text":"Plan the read."}"#)
        XCTAssertNil(event.disclosureKey)
        var live = AssistantActivityTimeline()
        live.appendReasoning(event.text, disclosureKey: event.disclosureKey)
        XCTAssertEqual(live.rows.map(\.disclosureStateID), ["reasoning:0"])
        let settled = try scenario.settledReasoningRows(keepingKeys: false)
        XCTAssertFalse(settled.isEmpty)
        XCTAssertEqual(settled.map(\.disclosureStateID), settled.map(\.id))
    }
}

/// The shared `running_scene_session` contract fixture: a running turn whose settled reasoning row carries the
/// `disclosure_key` its live `reasoning` events carry.
struct RunningReasoningScenario {
    let streamID: String
    let disclosureKey: String
    let messages: [JSONValue]

    init() throws {
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("web-session")) as? [String: Any])
        let scenario = try XCTUnwrap(object["running_scene_session"] as? [String: Any])
        streamID = try XCTUnwrap(scenario["active_stream_id"] as? String)
        messages = try JSONDecoder().decode([JSONValue].self, from: JSONSerialization.data(withJSONObject: scenario["messages"]!))
        disclosureKey = try XCTUnwrap(messages.lazy.compactMap { message -> String? in
            guard case .object(let fields) = message, case .object(let scene)? = fields["_anchor_activity_scene"],
                  case .array(let rows)? = scene["activity_rows"] else { return nil }
            return rows.lazy.compactMap { row -> String? in
                guard case .object(let row) = row, case .string(let key)? = row["disclosure_key"] else { return nil }
                return key
            }.first
        }.first)
    }

    func liveEvent(_ json: String) throws -> ReasoningStreamEvent {
        try JSONDecoder().decode(ReasoningStreamEvent.self, from: Data(json.utf8))
    }

    /// The scenario's messages as the App decodes them, with every `disclosure_key` dropped for an older server.
    func decodedMessages(keepingKeys: Bool = true) throws -> [ChatMessage] {
        func dropKeys(_ value: JSONValue) -> JSONValue {
            switch value {
            case .object(let fields): .object(fields.filter { $0.key != "disclosure_key" }.mapValues(dropKeys))
            case .array(let values): .array(values.map(dropKeys))
            default: value
            }
        }
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode([ChatMessage].self, from: JSONEncoder().encode(keepingKeys ? messages : messages.map(dropKeys)))
    }

    /// The settled turn's reasoning rows.
    func settledReasoningRows(keepingKeys: Bool = true) throws -> [AssistantActivityRow] {
        try decodedMessages(keepingKeys: keepingKeys).filter { $0.activityScene != nil }.flatMap { message in
            AssistantTurnLayout(message: message, liveRows: [], archivedRows: []).rows.filter { $0.kind == "reasoning" }
        }
    }
}

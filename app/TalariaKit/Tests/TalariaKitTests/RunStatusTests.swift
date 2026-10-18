import XCTest
@testable import TalariaKit

final class RunStatusTests: XCTestCase {
    private func decode(_ json: String) throws -> SessionDetail {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(SessionDetail.self, from: Data(json.utf8))
    }

    func testSharedSessionAndStreamDecodeProgressUnknownAndClear() throws {
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("prompt-reading")) as? [String: Any])
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let session = try decoder.decode(SessionDetail.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(fixture["session"])))
        XCTAssertTrue(session.hasRunStatus)
        XCTAssertEqual(session.runStatus?.phase, "prompt_reading")
        XCTAssertEqual(session.runStatus?.progressPercent, 42)
        for (key, percent) in [("progress", 42.0), ("unknown", nil)] {
            let frame = try XCTUnwrap(fixture[key] as? [String: Any])
            let json = try JSONSerialization.data(withJSONObject: XCTUnwrap(frame["data"]))
            guard case .runStatus(let sessionID, let status) = SSEEventDecoder.decode(eventType: "run_status", data: String(decoding: json, as: UTF8.self)) else { return XCTFail("Missing status") }
            XCTAssertEqual(sessionID, session.sessionId)
            XCTAssertEqual(status?.phase, "prompt_reading")
            XCTAssertEqual(status?.progressPercent, percent)
        }
        XCTAssertEqual(SSEEventDecoder.decode(eventType: "run_status", data: #"{"session_id":"s","status":null}"#), .runStatus(sessionID: "s", status: nil))
        for invalid in [#"{"session_id":"s"}"#, #"{"session_id":"s","status":"bad"}"#] {
            XCTAssertEqual(SSEEventDecoder.decode(eventType: "run_status", data: invalid), .ignored)
        }
        XCTAssertFalse(try decode(#"{"session_id":"s"}"#).hasRunStatus)
        XCTAssertTrue(try decode(#"{"session_id":"s","run_status":null}"#).hasRunStatus)
        XCTAssertFalse(try decode(#"{"session_id":"s","run_status":"bad"}"#).hasRunStatus)
        XCTAssertEqual(try decode(#"{"session_id":"s","run_status":{"phase":"future_phase"}}"#).runStatus?.phase, "future_phase")
        XCTAssertNil(try decode(#"{"session_id":"s","run_status":{"phase":"prompt_reading"}}"#).runStatus?.progressPercent)
    }

    func testPresentationRendersServerChoiceBeforeLegacyCompressionAndBackground() throws {
        func presentation(_ json: String, stopping: Bool = false, recovery: ActiveStreamRecoveryState = .idle) throws -> ChatActiveRunStatusPresentation? {
            let session = try decode(json)
            return ChatActiveRunStatusPolicy.presentation(
                isStartingChat: false, hasActiveStream: true,
                activeStreamRecoveryState: recovery, isCancellingStream: stopping,
                isBackgroundTurn: true, compressionStartedAt: Date(),
                serverRunStatus: session.runStatus, hasServerRunStatus: session.hasRunStatus)
        }
        let known = #"{"run_status":{"phase":"prompt_reading","progress_percent":42}}"#
        XCTAssertEqual(try presentation(known)?.label(agentName: "Hermes"), "Reading prompt 42%")
        XCTAssertEqual(try presentation(known)?.accessibilityLabel(agentName: "Hermes"), "Hermes is reading the prompt, 42%")
        XCTAssertEqual(try presentation(#"{"run_status":{"phase":"prompt_reading","progress_percent":null}}"#)?.label(agentName: "Hermes"), "Reading prompt")
        XCTAssertEqual(try presentation(#"{"run_status":{"phase":"working"}}"#)?.label(agentName: "Hermes"), "Working")
        XCTAssertEqual(try presentation(#"{"run_status":{"phase":"compressing"}}"#)?.kind, .compressing)
        XCTAssertEqual(try presentation(#"{"run_status":{"phase":"rate_limit_wait","wait":{"provider_label":"Local","until":1800000000,"until_kind":"retry"}}}"#)?.label(agentName: "Hermes"), "Waiting for Local")
        XCTAssertNil(try presentation(#"{"run_status":null}"#))
        XCTAssertEqual(ChatActiveRunStatusPolicy.presentation(isStartingChat: false, hasActiveStream: false,
            activeStreamRecoveryState: .idle, isCancellingStream: false, isCompressing: true,
            hasServerRunStatus: true)?.kind, .compressing, "A pending manual command must survive the idle session's clear")
        XCTAssertEqual(try presentation(known, stopping: true)?.kind, .stopping)
        XCTAssertEqual(try presentation(known, recovery: .reconnecting)?.kind, .reconnecting)
        // Older servers keep the pre-contract compression/working presentation.
        XCTAssertEqual(try presentation("{}")?.kind, .compressing)
    }
}

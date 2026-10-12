import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-759: "Summarize with AI" shows the server's summary of one pending update in a bottom sheet.
final class UpdateSummaryTests: APIClientTestCase {
    private static let sectionsJSON = """
    {
      "ok": true, "target": "agent", "summary": "", "generated_by": "llm", "source": "release_notes", "cached": false,
      "current_version": "v2026.9.24", "target_version": "v0.21.7",
      "summary_sections": [
        { "title": "What you'll notice", "items": ["Chats open faster."] },
        { "title": "Worth knowing", "items": ["This summary covers v0.21.6 and v0.21.7."] }
      ]
    }
    """

    private static func target(_ json: String) throws -> UpdateTargetInfo {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UpdateTargetInfo.self, from: Data(json.utf8))
    }

    @MainActor
    func testTheModelLoadsTheServerSectionsForEitherTarget() async throws {
        for target in [UpdateTarget.webui, .agent] {
            var bodies: [NSDictionary] = []
            let client = makeClient { request in
                XCTAssertEqual(request.url?.path, "/api/updates/summary")
                let body = try XCTUnwrap(apiTestBodyData(from: request))
                try bodies.append(XCTUnwrap(JSONSerialization.jsonObject(with: body) as? NSDictionary))
                return apiTestJSONResponse(Self.sectionsJSON, for: request)
            }
            let model = UpdateSummaryModel(target: target, client: client)
            XCTAssertEqual(model.phase, .loading)

            await model.load()

            XCTAssertEqual(bodies, [["target": target.rawValue]])
            guard case let .loaded(summary) = model.phase else { return XCTFail("Not loaded: \(model.phase)") }
            XCTAssertEqual(summary.summarySections, [
                .init(title: "What you'll notice", items: ["Chats open faster."]),
                .init(title: "Worth knowing", items: ["This summary covers v0.21.6 and v0.21.7."])
            ])
        }
    }

    @MainActor
    func testTheSheetShowsProgressThenOffersRetryAfterAFailure() throws {
        let answered = DispatchSemaphore(value: 0)
        var requests = 0
        let client = makeClient { request in
            requests += 1
            if requests == 1 {
                answered.wait()
                return apiTestJSONResponse(
                    #"{ "error": "model unavailable" }"#, statusCode: 500, for: request
                )
            }
            return apiTestJSONResponse(Self.sectionsJSON, for: request)
        }
        let window = try hostWindow(UpdateSummarySheet(
            model: UpdateSummaryModel(target: .agent, client: client),
            name: "Hermes Agent"
        ))

        let loading = { !HostedAccessibility.elements(in: window, labelContaining: "Summarizing what's new").isEmpty }
        XCTAssertTrue(waitUntil(loading), "Elements: \(HostedAccessibility.labels(in: window))")
        answered.signal()

        XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, label: "Retry") != nil },
                      "Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Couldn't summarize").isEmpty)
        try HostedAccessibility.activate(XCTUnwrap(HostedAccessibility.element(in: window, label: "Retry")))

        XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, label: "Chats open faster.") != nil },
                      "Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Worth knowing").isEmpty)
        // The range shown is the one the server summarized.
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "v2026.9.24 → v0.21.7"))
        XCTAssertEqual(requests, 2)
    }

    @MainActor
    func testTheButtonAppearsOnlyWhenTheServerOffersASummary() throws {
        let offered = try Self.target(#"{ "behind": 3, "state": "release_ready", "summary_available": true }"#)
        let current = try Self.target(#"{ "behind": 0, "state": "up_to_date", "summary_available": false }"#)
        var taps = 0
        let window = try hostWindow(VStack {
            UpdateSummaryButton(info: offered) { taps += 1 }
            UpdateSummaryButton(info: current) { taps += 10 }
        })

        let buttons = HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI")
        XCTAssertEqual(buttons.count, 1, "Elements: \(HostedAccessibility.labels(in: window))")
        try HostedAccessibility.activate(XCTUnwrap(buttons.first))
        XCTAssertEqual(taps, 1)
    }

    func testTheSheetNamesEachTargetAndFormatsAKnownRange() {
        XCTAssertEqual(UpdateSummaryRequest(target: .agent).name, "Hermes Agent")
        XCTAssertEqual(UpdateSummaryRequest(target: .webui).name, "Talaria Web")
        XCTAssertEqual(versionRange("v2026.9.24", "v0.21.7"), "v2026.9.24 → v0.21.7")
        XCTAssertNil(versionRange("v2026.9.24", nil))
    }

    func testTheAgentRowWordsEveryServerState() throws {
        let status = { (json: String) in try UpdateNote(agent: Self.target(json)).text }
        XCTAssertEqual(try status(#"{ "state": "release_ready", "target_version": "v0.21.7" }"#), "v0.21.7 available")
        XCTAssertEqual(try status(#"{ "state": "commits_behind", "behind": 14 }"#), "14 commits behind")
        XCTAssertEqual(try status(#"{ "state": "up_to_date", "behind": 0 }"#), "Up to date")
        XCTAssertEqual(try status(#"{ "state": "off", "behind": 0 }"#), "Update checks are off")
        XCTAssertEqual(try status(#"{ "behind": null }"#), "Unknown")
    }
}

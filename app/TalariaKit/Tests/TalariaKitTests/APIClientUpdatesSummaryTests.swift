import XCTest
@testable import TalariaKit

/// TAL-759: "Summarize with AI" sends only the target and renders the server's sections.
final class APIClientUpdatesSummaryTests: APIClientTestCase {
    func testUpdatesCheckDecodesTheSummaryOfferAndVersions() async throws {
        let client = makeClient { request in
            apiTestJSONResponse("""
            {
              "webui": { "name": "webui", "behind": 0, "state": "up_to_date", "summary_available": false },
              "agent": {
                "name": "agent", "behind": 3, "state": "release_ready", "can_apply": true,
                "current_version": "v2026.9.24", "target_version": "v0.21.7", "summary_available": true
              }
            }
            """, for: request)
        }

        let response = try await client.updatesCheck()

        XCTAssertEqual(response.webui?.offersSummary, false)
        XCTAssertEqual(response.agent?.offersSummary, true)
        XCTAssertEqual(response.agent?.currentVersion, "v2026.9.24")
        XCTAssertEqual(response.agent?.targetVersion, "v0.21.7")
    }

    func testAnOlderServerOffersNoSummary() throws {
        let json = #"{ "behind": 2, "state": "commits_behind" }"#
        let info = try JSONDecoder.snakeCase.decode(UpdateTargetInfo.self, from: Data(json.utf8))
        XCTAssertFalse(info.offersSummary)
    }

    func testSummaryPostsOnlyTheTargetAndDecodesSections() async throws {
        let client = makeClient { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/updates/summary")
            let body = try XCTUnwrap(apiTestBodyData(from: request))
            let sent = try JSONSerialization.jsonObject(with: body) as? NSDictionary
            XCTAssertEqual(sent, ["target": "agent"])
            return apiTestJSONResponse("""
            {
              "ok": true, "target": "agent", "summary": "", "generated_by": "llm",
              "source": "release_notes", "cached": false,
              "summary_sections": [
                { "title": "What you'll notice", "items": ["Chats open faster."] },
                { "title": "Worth knowing", "items": ["This summary covers v0.21.6 and v0.21.7."] }
              ]
            }
            """, for: request)
        }

        let response = try await client.updatesSummary(target: .agent)

        XCTAssertEqual(response.source, "release_notes")
        XCTAssertEqual(response.generatedBy, "llm")
        XCTAssertEqual(response.summarySections, [
            .init(title: "What you'll notice", items: ["Chats open faster."]),
            .init(title: "Worth knowing", items: ["This summary covers v0.21.6 and v0.21.7."])
        ])
    }

    func testMissingSectionsDecodeAsEmpty() throws {
        let json = #"{ "ok": true, "generated_by": "none" }"#
        let response = try JSONDecoder.snakeCase.decode(UpdatesSummaryResponse.self, from: Data(json.utf8))
        XCTAssertEqual(response.summarySections, [])
    }
}

private extension JSONDecoder {
    static var snakeCase: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

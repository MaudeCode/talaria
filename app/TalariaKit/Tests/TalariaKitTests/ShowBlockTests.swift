import Foundation
@testable import TalariaKit
import XCTest

/// TAL-1968: `show` blocks from the shared contract fixture, read through the client as the transcript reads them.
final class ShowBlockTests: XCTestCase {
    private static func fixture(_ key: String) throws -> String {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("show")) as? [String: Any])
        return String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(root[key])), as: UTF8.self)
    }

    private func block(_ key: String) async throws -> (ShowBlock, APIClient) {
        let host = "show-\(UUID().uuidString).test"
        let body = try Self.fixture(key)
        DeferredMockURLProtocol.setOnRequest({ request in
            XCTAssertEqual(request.request.url?.path.hasPrefix("/talaria/api/show/sb_"), true)
            request.complete(withJSON: body)
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://\(host)/talaria")!, session: URLSession(configuration: config))
        let id = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["block_id"] as? String)
        return (try await client.showBlock(id: id), client)
    }

    func testATableKeepsTheServersCellsTruncationAndTSV() async throws {
        let (table, _) = try await block("table")
        XCTAssertEqual(table.kind, .table)
        XCTAssertEqual(table.columns, ["Region", "p50 ms", "p99 ms"])
        XCTAssertEqual(table.rows.last, ["ap-south", "88", "340"])
        XCTAssertEqual(table.truncation?.totalRows, 812)
        XCTAssertEqual(table.tsv.split(separator: "\n").first, "Region\tp50 ms\tp99 ms")
    }

    func testAChartKeepsTheServersFormattedValues() async throws {
        let (line, _) = try await block("chart_line")
        XCTAssertEqual(line.chart, "line")
        XCTAssertEqual(line.series.map(\.name), ["API", "Web"])
        XCTAssertEqual(line.series[1].points.map(\.display), ["0.5%", "0.25%", "1%"])
        XCTAssertEqual(line.series[0].maxDisplay, "2%")
        XCTAssertEqual(line.series[1].peak, ShowBlock.Peak(label: "Wed", display: "1%"))
    }

    func testFilesAndPagesNameTheirServerURLsUnderTheBasePath() async throws {
        let (image, client) = try await block("file_image")
        XCTAssertEqual(image.media?.kind, "image")
        XCTAssertNil(image.focusPath)
        let (text, _) = try await block("file_text")
        XCTAssertNil(text.media)
        XCTAssertEqual(text.focusPath, "docs/notes.md")
        let (page, _) = try await block("html")
        let frame = try XCTUnwrap(page.frameUrl.flatMap(client.showBlockURL))
        XCTAssertEqual(frame.path, "/talaria/show-frame/c2JfMTAwMDAwMDAwMDA1.1794103200.0f3c")
    }

    func testAToolResultCarriesItsBlockReference() throws {
        let view = try XCTUnwrap(ToolResultView(.object(["block": try JSONDecoder().decode(JSONValue.self, from: Data(Self.fixture("ref").utf8))])))
        XCTAssertEqual(view.block, ShowBlockRef(blockId: "sb_0a1b2c3d4e5f", kind: "table", title: "Latency by region"))
    }
}

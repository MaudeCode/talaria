import SwiftUI
import WebKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1968: `show` blocks under their transcript row, drawn from the shared `contracts/fixtures/show.json` on the phone
/// and both Duo displays.
@MainActor
final class ShowBlockHostedTests: XCTestCase {
    private static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGPQqDhBEmIY1TCqYfhqAADDSmgQBaIOewAAAABJRU5ErkJggg==")!

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func fixture() throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("show")) as? [String: Any])
    }

    /// One tool card per fixture block, its reads answered from the fixture (and an image's bytes from a PNG).
    private func transcript(_ keys: [String], opened: @escaping (String) -> Void = { _ in }) throws -> some View {
        let root = try fixture()
        var bodies: [String: Data] = [:]
        var calls: [ToolCall] = []
        for key in keys {
            let block = try XCTUnwrap(root[key] as? [String: Any])
            let id = try XCTUnwrap(block["block_id"] as? String)
            bodies[id] = try JSONSerialization.data(withJSONObject: block)
            let reference = ShowBlockRef(blockId: id, kind: try XCTUnwrap(block["kind"] as? String), title: try XCTUnwrap(block["title"] as? String))
            calls.append(ToolCall(id: "call-\(key)", name: "show", preview: nil, args: nil, resultView: ToolResultView(block: reference), isCompleted: true))
        }
        MockURLProtocol.requestHandler = { request in
            let url = request.url!
            let id = url.lastPathComponent
            let body = url.path.hasPrefix("/api/show/") ? bodies[id] ?? Data() : Self.png
            let type = url.path.hasPrefix("/api/show/") ? "application/json" : "image/png"
            return (HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": type])!, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://show.test")!, session: URLSession(configuration: configuration))
        return ScrollView { VStack { ForEach(calls) { ToolCallCardView(toolCall: $0) } }.padding() }
            .chatEnvironmentAction(\.chatShowBlockModel) { ShowBlockCardModel(blockID: $0, client: client) }
            .chatEnvironmentAction(\.chatOpenWorkspaceFile) { opened($0) }
    }

    func testTablesAndChartsShowTheServersValuesOnThePhoneAndBothDuoDisplays() throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            let window = try hostWindow(transcript(["table", "chart", "chart_line"]), size: size)
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "show-block-copy-sb_0a1b2c3d4e5f") != nil }, name)
            for label in ["Latency by region", "ap-south", "Showing 3 of 812 rows and 3 of 3 columns", "Max 1,850.5", "Error rate · API", "Max 2%"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
            }
            attachHostedScreenshot(window, name: "show-table-chart-\(name)")
        }
    }

    func testFilesShowAnImageInlineAndOpenTheirFileAndAPageLoadsItsGrantURL() throws {
        var opened: [String] = []
        let window = try hostWindow(transcript(["file_image", "file_text", "html"]) { opened.append($0) })
        XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "docs/notes.md").isEmpty })
        XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "show-block-open-sb_100000000005") != nil })
        XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "show-block-sb_100000000005"))
        XCTAssertTrue(waitUntil { window.firstSubview(of: WKWebView.self) != nil })
        let web = try XCTUnwrap(window.firstSubview(of: WKWebView.self))
        XCTAssertTrue(waitUntil { web.url?.absoluteString == "https://show.test/show-frame/c2JfMTAwMDAwMDAwMDA1.1794103200.0f3c" })
        XCTAssertFalse(web.configuration.websiteDataStore.isPersistent)
        let open = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "show-block-open-sb_100000000002"))
        XCTAssertTrue(open.accessibilityActivate())
        XCTAssertEqual(opened, ["docs/notes.md"])
        attachHostedScreenshot(window, name: "show-files-page-phone")
    }

    func testADeliveredFileOffersShareAndSaveToFilesWithItsSizeTypeAndChangedNote() throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            let window = try hostWindow(transcript(["file_delivered"]), size: size)
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "show-block-share-sb_100000000006") != nil }, name)
            XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "show-block-save-sb_100000000006"), name)
            XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "show-block-changed-sb_100000000006"), name)
            for label in ["Weekly report", "week-45.xlsx · 1.8 MB · application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Changed since delivered"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
            }
            attachHostedScreenshot(window, name: "deliver-file-\(name)")
        }
    }
}

private extension UIView {
    func firstSubview<View: UIView>(of type: View.Type) -> View? {
        if let match = self as? View { return match }
        return subviews.lazy.compactMap { $0.firstSubview(of: type) }.first
    }
}

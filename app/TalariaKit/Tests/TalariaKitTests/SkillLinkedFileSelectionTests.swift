import XCTest
@testable import TalariaKit

@MainActor
final class SkillLinkedFileSelectionTests: XCTestCase {
    private static let serverURL = URL(string: "https://skill-linked-files.test")!

    /// Stands in for `SkillDetailView`'s sheet state: the presented selection plus
    /// the load that only applies a response to the file that asked for it.
    private final class LinkedFileSheet {
        var selection: SkillLinkedFileSelection?

        func present(_ fileName: String) {
            selection = SkillLinkedFileSelection(fileName: fileName)
        }

        func load(fileName: String, client: APIClient) async {
            let content = await SkillLinkedFileSelection.load(
                fileName: fileName,
                skill: "fixture-skill",
                client: client
            )
            selection?.apply(content, for: fileName)
        }
    }

    func testResponseForADismissedFileCannotChangeTheNextSheet() async {
        let (client, requests, arrivals) = makeDeferredClient(expecting: 2)
        let sheet = LinkedFileSheet()

        sheet.present("OVERVIEW.md")
        let overviewLoad = Task { await sheet.load(fileName: "OVERVIEW.md", client: client) }
        await fulfillment(of: [arrivals[0]], timeout: 5)

        // The user closes the first sheet and opens a different linked file.
        sheet.selection = nil
        sheet.present("CHANGELOG.md")
        let changelogLoad = Task { await sheet.load(fileName: "CHANGELOG.md", client: client) }
        await fulfillment(of: [arrivals[1]], timeout: 5)

        // The dismissed file answers last.
        requests.request(at: 0).complete(withJSON: #"{"name":"fixture-skill","content":"Overview body"}"#)
        await overviewLoad.value

        XCTAssertEqual(sheet.selection?.fileName, "CHANGELOG.md")
        XCTAssertNil(sheet.selection?.content)
        XCTAssertEqual(sheet.selection?.isLoading, true)

        requests.request(at: 1).complete(withJSON: #"{"name":"fixture-skill","content":"Changelog body"}"#)
        await changelogLoad.value

        XCTAssertEqual(sheet.selection?.content, "Changelog body")
        XCTAssertEqual(sheet.selection?.isLoading, false)
    }

    func testDismissingASheetIgnoresItsLateResponse() async {
        let (client, requests, arrivals) = makeDeferredClient(expecting: 1)
        let sheet = LinkedFileSheet()

        sheet.present("OVERVIEW.md")
        let overviewLoad = Task { await sheet.load(fileName: "OVERVIEW.md", client: client) }
        await fulfillment(of: [arrivals[0]], timeout: 5)

        sheet.selection = nil
        requests.request(at: 0).complete(withJSON: #"{"name":"fixture-skill","content":"Overview body"}"#)
        await overviewLoad.value

        XCTAssertNil(sheet.selection)
    }

    func testFailureCopyStaysWithItsFileAndReopeningReloads() async {
        let (client, requests, arrivals) = makeDeferredClient(expecting: 2)
        let sheet = LinkedFileSheet()

        sheet.present("OVERVIEW.md")
        let failingLoad = Task { await sheet.load(fileName: "OVERVIEW.md", client: client) }
        await fulfillment(of: [arrivals[0]], timeout: 5)
        requests.request(at: 0).fail(with: URLError(.timedOut))
        await failingLoad.value

        XCTAssertEqual(sheet.selection?.isLoading, false)
        XCTAssertEqual(sheet.selection?.content?.hasPrefix("Could not load file: "), true)

        // Reopening the same file starts over instead of keeping the failure.
        sheet.selection = nil
        sheet.present("OVERVIEW.md")
        XCTAssertEqual(sheet.selection?.isLoading, true)

        let retry = Task { await sheet.load(fileName: "OVERVIEW.md", client: client) }
        await fulfillment(of: [arrivals[1]], timeout: 5)
        requests.request(at: 1).complete(withJSON: #"{"name":"fixture-skill"}"#)
        await retry.value

        // A response without content is an empty file, not a stuck spinner.
        XCTAssertEqual(sheet.selection?.content, "")
        XCTAssertEqual(sheet.selection?.isLoading, false)
    }

    private func makeDeferredClient(
        expecting count: Int
    ) -> (APIClient, DeferredRequests, [XCTestExpectation]) {
        let requests = DeferredRequests()
        let arrivals = (0..<count).map { expectation(description: "linked file request \($0) arrived") }
        let host = Self.serverURL.host!

        DeferredMockURLProtocol.setOnRequest({ pendingRequest in
            let index = requests.append(pendingRequest) - 1
            guard index < arrivals.count else {
                XCTFail("Unexpected extra linked file request")
                return
            }
            arrivals[index].fulfill()
        }, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [DeferredMockURLProtocol.self]
        let client = APIClient(baseURL: Self.serverURL, session: URLSession(configuration: configuration))
        return (client, requests, arrivals)
    }
}

import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-1965: the decision review screen's Decide and Answers views, drawn from the shared
/// `contracts/fixtures/decision-review.json` on the phone and both Duo displays.
@MainActor
final class DecisionReviewHostedTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    private func reviewFixture(_ key: String) throws -> Data {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("decision-review")) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: XCTUnwrap(root[key]))
    }

    /// A model holding the fixture review, whose reads answer with it again.
    private func model() throws -> DecisionReviewModel {
        let body = try reviewFixture("review")
        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://decisions.test")!, session: URLSession(configuration: configuration))
        let review = try DecisionReview.decoder.decode(DecisionReview.self, from: body)
        return DecisionReviewModel(reviewID: review.reviewId, client: client, review: review)
    }

    func testDecideAndAnswersRenderTheFixtureOnThePhoneAndBothDuoDisplays() throws {
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            let model = try model()
            let window = try hostWindow(NavigationStack { DecisionReviewView(model: model, onAPIError: { _ in }) }, size: size)
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "decision-choice-retention-week") != nil }, name)

            let tabs = window.firstView(ofType: UISegmentedControl.self)
            XCTAssertEqual(tabs?.accessibilityIdentifier, "decisions-tabs", name)
            XCTAssertEqual(tabs.map { (0..<$0.numberOfSegments).compactMap($0.titleForSegment(at:)) }, ["Decide", "Answers"], name)
            for identifier in ["decision-item-retention", "decision-choice-retention-week", "decision-choice-retention-month"] {
                XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: identifier), "\(name): \(identifier)")
            }
            for label in ["For example", "What happens today", "Recommendation"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
            }
            // A plain list builds only the rows on screen; the inner display shows the whole item.
            if size == HostedSize.duoInner {
                for identifier in ["decision-choice-retention-never", "decision-notes", "decision-use-notes"] {
                    XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: identifier), "\(name): \(identifier)")
                }
                for label in ["Come back to this later", "Technical details and sources"] {
                    XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: label).isEmpty, "\(name): \(label)")
                }
            }
            XCTAssertNotNil(HostedAccessibility.toolbarAction("Save & next", in: window), "\(name): Save & next")
            XCTAssertNotNil(HostedAccessibility.toolbarAction("Back", in: window), "\(name): Back")
            attachHostedScreenshot(window, name: "decision-decide-\(name)")

            model.page = .answers
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "decision-item-row-theme") != nil }, name)
            for item in ["retention", "notify", "theme"] {
                XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "decision-item-row-\(item)"), "\(name): row \(item)")
            }
            XCTAssertNotNil(HostedAccessibility.toolbarAction("Submit", in: window), "\(name): Submit")
            XCTAssertNotNil(HostedAccessibility.toolbarAction("Continue", in: window), "\(name): Continue")
            attachHostedScreenshot(window, name: "decision-answers-\(name)")
        }
    }

    /// The transcript card shows the review's title, status and progress, and Open asks the chat to push the review.
    func testTheTranscriptCardShowsTheReviewAndOpensIt() throws {
        let reference = try DecisionReview.decoder.decode(DecisionReviewRef.self, from: reviewFixture("ref"))
        let review = try DecisionReview.decoder.decode(DecisionReview.self, from: reviewFixture("review"))
        var opened: [String] = []
        let card = DecisionReviewResultSection(reference: reference)
            .chatEnvironmentAction(\.chatDecisionReviewLoader) { _ in { review } }
            .chatEnvironmentAction(\.chatOpenDecisionReview) { opened.append($0) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .padding()
        let window = try hostWindow(card)
        XCTAssertTrue(waitUntil { !HostedAccessibility.elements(in: window, labelContaining: "Open · 2 of 3 answered").isEmpty })
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Workspace defaults").isEmpty)
        let open = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "decision-review-open-dr_0a1b2c3d"))
        XCTAssertTrue(HostedAccessibility.activate(open))
        XCTAssertEqual(opened, ["dr_0a1b2c3d"])
        attachHostedScreenshot(window, name: "decision-transcript-card")
    }

    /// TAL-1966: the Decisions list draws the fixture's rows in the server's order on the phone and both Duo displays,
    /// and a row opens its review.
    func testTheDecisionsListRendersTheFixtureRowsAndARowOpensItsReview() throws {
        let body = try reviewFixture("list")
        MockURLProtocol.requestHandler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockURLProtocol.self]
        let client = APIClient(baseURL: URL(string: "https://decisions.test")!, session: URLSession(configuration: configuration))
        for (name, size) in [("phone", HostedSize.phone), ("duo-outer", HostedSize.duoOuter), ("duo-inner", HostedSize.duoInner)] {
            var selection: SectionItem?
            var chats: [String] = []
            let list = DecisionsListView(
                model: DecisionsListModel(client: client), selection: Binding(get: { selection }, set: { selection = $0 }),
                openChat: { chats.append($0) }, onAPIError: { _ in }
            )
            let window = try hostWindow(NavigationStack { list }, size: size)
            XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, identifier: "decision-review-row-dr_0a1b2c3e") != nil }, name)
            for text in ["Workspace defaults", "Workspace setup", "2 of 3 answered", "Retention choices", "Submitted", "Untitled"] {
                XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: text).isEmpty, "\(name): \(text)")
            }
            attachHostedScreenshot(window, name: "decisions-list-\(name)")
            let row = try XCTUnwrap(HostedAccessibility.element(in: window, identifier: "decision-review-row-dr_0a1b2c3d"), name)
            XCTAssertTrue(HostedAccessibility.activate(row), name)
            XCTAssertEqual(selection, .decisionReview(id: "dr_0a1b2c3d"), name)
            XCTAssertEqual(chats, [], name)
        }
    }

    /// The composer chip's status copy fits one line at the phone's width, Open included.
    func testTheComposerChipFitsOneLineOnThePhone() {
        let chip = StatusChip(label: "Decision review: 12 of 20 answered", icon: .symbol("checklist"), action: "Open")
        let fitted = UIHostingController(rootView: chip).sizeThatFits(in: CGSize(width: 10_000, height: 200))
        let phoneRow = HostedSize.phone.width - 32
        XCTAssertLessThanOrEqual(fitted.width, phoneRow)
    }
}

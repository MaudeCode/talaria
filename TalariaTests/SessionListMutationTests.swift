import XCTest
import AVFoundation
import ImageIO
import SwiftData
import UIKit
import UniformTypeIdentifiers
@testable import Talaria


final class SessionListMutationTests: XCTestCase {
    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        super.tearDown()
    }

    func testReadOnlyRowsOfferExportButNoMutationActions() {
        let currentShape = SessionSummary(sessionId: "current", readOnly: true)
        let legacyShape = SessionSummary(sessionId: "legacy", isReadOnly: true)
        let normal = SessionSummary(sessionId: "normal")

        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: currentShape))
        XCTAssertFalse(SessionRowActionPolicy.offersMutationActions(for: legacyShape))
        XCTAssertFalse(
            SessionRowActionPolicy.offersMutationActions(
                for: SessionSummary(sessionId: "subagent", sourceTag: "subagent")
            )
        )
        XCTAssertTrue(SessionRowActionPolicy.offersMutationActions(for: normal))

        XCTAssertTrue(SessionRowActionPolicy.canExport(currentShape, isViewingCachedData: false))
        XCTAssertFalse(SessionRowActionPolicy.canExport(currentShape, isViewingCachedData: true))
        XCTAssertFalse(
            SessionRowActionPolicy.canExport(
                SessionSummary(sessionId: nil, readOnly: true),
                isViewingCachedData: false
            )
        )
    }

    @MainActor
    func testDuplicatePolicyRejectsExternalSessionsBeforeAnyRequest() async throws {
        var requestedPaths: [String] = []
        let viewModel = try makeViewModel { request in
            requestedPaths.append(request.url?.path ?? "nil")
            XCTFail("External sessions must not reach the duplicate endpoint.")
            throw URLError(.badURL)
        }
        let cliSession = SessionSummary(sessionId: "cli", isCliSession: true)
        let messagingSession = SessionSummary(
            sessionId: "telegram",
            rawSource: "telegram",
            sessionSource: "messaging"
        )

        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(cliSession))
        XCTAssertFalse(SessionRowActionPolicy.canDuplicate(messagingSession))
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(SessionSummary(sessionId: "webui")))
        XCTAssertTrue(SessionRowActionPolicy.canDuplicate(SessionSummary(
            sessionId: "webui-override",
            isCliSession: true,
            sessionSource: "webui"
        )))
        let duplicatedCLI = await viewModel.duplicate(cliSession)
        let duplicatedMessaging = await viewModel.duplicate(messagingSession)

        XCTAssertNil(duplicatedCLI)
        XCTAssertNil(duplicatedMessaging)
        XCTAssertEqual(viewModel.actionErrorMessage, "This command is not available in the mobile app.")
        XCTAssertTrue(requestedPaths.isEmpty)
    }

    func testCopyDeepLinkUsesExportAvailabilityRules() throws {
        let session = SessionSummary(sessionId: "session & /?=✓", readOnly: true)

        let url = try XCTUnwrap(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: false,
                isMutating: false
            )
        )
        XCTAssertEqual(TalariaDeepLink.sessionID(from: url), session.sessionId)
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: true,
                isMutating: false
            )
        )
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: session,
                isViewingCachedData: false,
                isMutating: true
            )
        )
        XCTAssertNil(
            SessionRowActionPolicy.deepLinkURL(
                for: SessionSummary(sessionId: nil),
                isViewingCachedData: false,
                isMutating: false
            )
        )
    }

}

import XCTest
import AppIntents
@testable import TalariaKit

/// Covers the New Chat App Intent plumbing (issue #337): the parameter-less deep-link URL,
/// its round-trip detection, the router bridge an intent writes to, and the intent itself.
final class AppIntentNewChatTests: XCTestCase {

    // `AppIntentRouter` is a shared singleton, so reset its pending link around every
    // test. Doing it in setUp/tearDown (rather than inline) guarantees a clean slate
    // before each test and cleanup after every exit path — including a failed assertion
    // or a thrown error mid-test — so router state can't leak between tests.
    override func setUp() async throws {
        try await super.setUp()
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
    }

    override func tearDown() async throws {
        await MainActor.run { AppIntentRouter.shared.pendingDeepLink = nil }
        try await super.tearDown()
    }

    func testNewChatURLUsesNewChatHostOnTheAppScheme() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatURL)
        XCTAssertEqual(url.scheme, TalariaDeepLink.scheme)
        XCTAssertEqual(url.host, TalariaDeepLink.newChatHost)
    }

    func testIsNewChatURLAcceptsItsOwnURL() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatURL)
        XCTAssertTrue(TalariaDeepLink.isNewChatURL(url))
    }

    func testIsNewChatURLIsCaseInsensitiveOnHost() throws {
        let url = try XCTUnwrap(URL(string: "\(TalariaDeepLink.scheme)://New-Chat"))
        XCTAssertTrue(TalariaDeepLink.isNewChatURL(url))
    }

    func testSessionURLIsNotANewChatURL() throws {
        let session = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: "abc123"))
        XCTAssertFalse(TalariaDeepLink.isNewChatURL(session))
    }

    func testNewChatURLDoesNotParseAsASessionID() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatURL)
        XCTAssertNil(TalariaDeepLink.sessionID(from: url))
    }

    func testForeignSchemeIsNotANewChatURL() throws {
        let url = try XCTUnwrap(URL(string: "https://new-chat"))
        XCTAssertFalse(TalariaDeepLink.isNewChatURL(url))
    }

    @MainActor
    func testRouterRecordsDeepLink() {
        let router = AppIntentRouter.shared
        router.requestDeepLink(TalariaDeepLink.newChatURL)
        XCTAssertEqual(router.pendingDeepLink, TalariaDeepLink.newChatURL)
    }

    @MainActor
    func testRouterIgnoresNilDeepLink() {
        let router = AppIntentRouter.shared
        router.requestDeepLink(nil)
        XCTAssertNil(router.pendingDeepLink)
    }

    // MARK: - New Chat with Voice (issue #338)

    func testNewChatVoiceURLUsesVoiceHostOnTheAppScheme() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatVoiceURL)
        XCTAssertEqual(url.scheme, TalariaDeepLink.scheme)
        XCTAssertEqual(url.host, TalariaDeepLink.newChatVoiceHost)
    }

    func testIsNewChatVoiceURLAcceptsItsOwnURL() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatVoiceURL)
        XCTAssertTrue(TalariaDeepLink.isNewChatVoiceURL(url))
    }

    func testIsNewChatVoiceURLIsCaseInsensitiveOnHost() throws {
        let url = try XCTUnwrap(URL(string: "\(TalariaDeepLink.scheme)://New-Chat-Voice"))
        XCTAssertTrue(TalariaDeepLink.isNewChatVoiceURL(url))
    }

    func testVoiceAndPlainNewChatURLsDoNotAlias() throws {
        let voiceURL = try XCTUnwrap(TalariaDeepLink.newChatVoiceURL)
        let plainURL = try XCTUnwrap(TalariaDeepLink.newChatURL)
        // The two intents must route distinctly: a voice URL is not a plain new-chat URL,
        // and vice versa.
        XCTAssertFalse(TalariaDeepLink.isNewChatURL(voiceURL))
        XCTAssertFalse(TalariaDeepLink.isNewChatVoiceURL(plainURL))
    }

    func testNewChatVoiceURLDoesNotParseAsASessionID() throws {
        let url = try XCTUnwrap(TalariaDeepLink.newChatVoiceURL)
        XCTAssertNil(TalariaDeepLink.sessionID(from: url))
    }

    func testSessionURLIsNotAVoiceURL() throws {
        let session = try XCTUnwrap(TalariaDeepLink.sessionURL(sessionID: "abc123"))
        XCTAssertFalse(TalariaDeepLink.isNewChatVoiceURL(session))
    }

    func testForeignSchemeIsNotAVoiceURL() throws {
        let url = try XCTUnwrap(URL(string: "https://new-chat-voice"))
        XCTAssertFalse(TalariaDeepLink.isNewChatVoiceURL(url))
    }

    func testNewChatRequestDefaultsToVoiceOff() {
        XCTAssertFalse(NewChatRequest().autoStartsVoiceInput)
    }

    func testNewChatRequestCarriesVoiceFlag() {
        XCTAssertTrue(NewChatRequest(autoStartsVoiceInput: true).autoStartsVoiceInput)
    }
}

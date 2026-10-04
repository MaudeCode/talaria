import XCTest
@testable import TalariaKit

/// Slash suggestions, aliases, and unsupported messages come from the server catalog (`GET /api/commands`, TAL-314).
final class SlashCommandCatalogTests: XCTestCase {
    /// A synthetic `/api/commands` payload in server display order.
    private static let catalog = decode("""
    {"commands": [
      {"name": "help", "description": "Show available commands", "aliases": [], "handler": "client", "clients": ["web", "ios"]},
      {"name": "stop", "description": "Stop the running response", "aliases": [], "handler": "client", "clients": ["web", "ios"]},
      {"name": "terminal", "aliases": [], "handler": "client", "clients": ["web"], "unsupported_message": "Terminal stays on the web."},
      {"name": "compress", "aliases": ["compact"], "handler": "client", "clients": ["web", "ios"]},
      {"name": "usage", "aliases": [], "handler": "client", "clients": ["web"], "unsupported_message": "No usage here."},
      {"name": "branch", "aliases": ["fork"], "handler": "client", "clients": ["web", "ios"]},
      {"name": "background", "aliases": ["bg"], "handler": "client", "clients": ["web", "ios"]},
      {"name": "status", "aliases": [], "handler": "client", "clients": ["web", "ios"]},
      {"name": "summarize", "description": "Summarize the chat", "aliases": ["digest"], "handler": "agent", "clients": ["web", "ios"]},
      {"name": "history", "aliases": [], "handler": "agent", "clients": [], "cli_only": true, "unsupported_message": "/history runs only in the Hermes CLI."}
    ]}
    """)

    private static func decode(_ json: String) -> [AgentCommand] {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        // swiftlint:disable:next force_try
        return try! decoder.decode(CommandsResponse.self, from: Data(json.utf8)).commands ?? []
    }

    private func suggestedNames(_ query: String, in catalog: [AgentCommand] = catalog) -> [String] {
        SlashCommandCatalog.matching(query, in: catalog).map(\.name)
            + AgentSlashCommandSuggestion.matching(query, in: catalog).map(\.name)
    }

    func testSuggestionsFollowServerOrderRestrictedToIOS() {
        XCTAssertEqual(suggestedNames(""), ["help", "stop", "compress", "branch", "background", "status", "summarize"])
        XCTAssertEqual(suggestedNames("s"), ["stop", "status", "summarize"])
        XCTAssertEqual(suggestedNames("t"), [])
        XCTAssertEqual(suggestedNames("us"), [])
    }

    func testAliasesSuggestAndResolveToTheirServerEntry() {
        XCTAssertEqual(suggestedNames("COMPA"), ["compress"])
        XCTAssertEqual(suggestedNames("fo"), ["branch"])
        XCTAssertEqual(suggestedNames("bg"), ["background"])
        XCTAssertEqual(suggestedNames("dig"), ["summarize"])

        XCTAssertEqual(SlashCommandCatalog.command(named: "compact", in: Self.catalog)?.name, "compress")
        XCTAssertEqual(SlashCommandCatalog.command(named: "compact", in: Self.catalog)?.handler, .serverSide(.compress))
        XCTAssertEqual(SlashCommandCatalog.command(named: "FORK", in: Self.catalog)?.handler, .serverSide(.branch))
        XCTAssertEqual(SlashCommandCatalog.command(named: "bg", in: Self.catalog)?.name, "background")
        XCTAssertEqual(SlashCommandExecutor.parse("/fork Planning Copy", catalog: Self.catalog)?.command?.name, "branch")
    }

    func testSuggestionsIgnoreDescriptions() {
        XCTAssertEqual(suggestedNames("response"), [])
    }

    func testCommandsOutsideIOSShowTheServerMessage() {
        XCTAssertEqual(SlashCommandExecutor.unsupportedMessage(for: "terminal", in: Self.catalog), "Terminal stays on the web.")
        XCTAssertEqual(SlashCommandExecutor.unsupportedMessage(for: "usage", in: Self.catalog), "No usage here.")
        XCTAssertEqual(SlashCommandExecutor.unsupportedMessage(for: "history", in: Self.catalog), "/history runs only in the Hermes CLI.")
        XCTAssertNil(SlashCommandExecutor.unsupportedMessage(for: "stop", in: Self.catalog))
        XCTAssertNil(SlashCommandExecutor.unsupportedMessage(for: "nope", in: Self.catalog))
        // No hard-coded unsupported set: without the catalog nothing is refused.
        XCTAssertNil(SlashCommandExecutor.unsupportedMessage(for: "terminal", in: []))
        XCTAssertNil(SlashCommandCatalog.command(named: "terminal", in: Self.catalog))
    }

    func testOldServerShapeSuggestsNothing() {
        let old = Self.decode(#"{"commands": [{"name": "status", "description": "Show status"}, {"name": "resume"}]}"#)
        XCTAssertEqual(suggestedNames("", in: old), [])
        XCTAssertEqual(suggestedNames("", in: []), [])
    }

    @MainActor
    func testHelpListsTheIOSCommandsFromTheCatalog() {
        let help = ChatViewModel.slashCommandHelpText(catalog: Self.catalog)
        XCTAssertTrue(help.contains("`/compress"), help)
        XCTAssertTrue(help.contains("`/compact`"), help)
        XCTAssertFalse(help.contains("/terminal"), help)
        XCTAssertFalse(help.contains("/undo"), help)
    }
}

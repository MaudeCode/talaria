import Foundation
import XCTest
@testable import TalariaKit

@MainActor
final class ServerSettingsStoreTests: XCTestCase {
    private let initial = #"{"agent_approvals":true,"update_channel":"stable","max_tokens":8192,"bot_name":"Hermes"}"#

    private func store(_ handler: @escaping (DeferredMockURLProtocol) -> Void) -> ServerSettingsStore {
        let host = "settings-\(UUID().uuidString).test"
        DeferredMockURLProtocol.setOnRequest(handler, forHost: host)
        addTeardownBlock { DeferredMockURLProtocol.setOnRequest(nil, forHost: host) }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [DeferredMockURLProtocol.self]
        return ServerSettingsStore(client: APIClient(baseURL: URL(string: "https://\(host)")!,
                                                     session: URLSession(configuration: config)))
    }

    private enum Choice: CaseIterable {
        case approval, channel, maximum, noLimit, botName
        var key: String {
            switch self {
            case .botName: "bot_name"
            case .approval: "agent_approvals"
            case .channel: "update_channel"
            case .maximum, .noLimit: "max_tokens"
            }
        }
        var chosen: JSONValue {
            switch self {
            case .botName: .string("Assistant")
            case .approval: .bool(false)
            case .channel: .string("nightly")
            case .maximum: .number(4096)
            case .noLimit: .null
            }
        }
        @MainActor
        func value(_ store: ServerSettingsStore) -> JSONValue {
            switch self {
            case .botName: .string(store.settings?.botName ?? "")
            case .approval: .bool(store.settings?.agentApprovals ?? false)
            case .channel: .string(store.settings?.updateChannel ?? "")
            case .maximum, .noLimit: store.settings?.maxTokens.map { .number(Double($0)) } ?? .null
            }
        }
        @MainActor
        func write(_ store: ServerSettingsStore) -> Task<Void, Never> {
            switch self {
            case .botName: store.setBotName("Assistant")
            case .approval: store.setAgentApprovals(false)
            case .channel: store.setUpdateChannel("nightly")
            case .maximum: store.setMaxTokensText("4096")!
            case .noLimit: store.setMaxTokensText("")!
            }
        }
    }

    func testTypedWritesShowImmediatelyConfirmRollBackOrReconcileWithoutReplay() async throws {
        for choice in Choice.allCases {
            for outcome in ["saved", "refused", "lost-saved", "lost-unsaved"] {
                let requests = DeferredRequests()
                let payload = LockedTestValue(initial)
                let posted = expectation(description: "\(choice)-\(outcome) write reached transport")
                let model = store { request in
                    XCTAssertEqual(request.request.url?.path, "/api/settings")
                    if request.request.httpMethod == "POST" {
                        _ = requests.append(request)
                        posted.fulfill()
                    } else { request.complete(withJSON: payload.value) }
                }
                await model.loadIfNeeded()
                let original = choice.value(model)
                let write = choice.write(model)
                XCTAssertEqual(choice.value(model), choice.chosen, "The visible value changes before any response")
                await fulfillment(of: [posted], timeout: 5)
                let request = requests.request(at: 0)
                let sent = try JSONDecoder().decode([String: JSONValue].self, from: XCTUnwrap(apiTestBodyData(from: request.request)))
                XCTAssertEqual(sent, [choice.key: choice.chosen], "Every write sends just its field, including explicit null")
                if outcome == "saved" || outcome == "lost-saved" {
                    var saved = try JSONDecoder().decode([String: JSONValue].self, from: Data(initial.utf8))
                    saved[choice.key] = choice.chosen
                    payload.value = String(decoding: try JSONEncoder().encode(saved), as: UTF8.self)
                }
                switch outcome {
                case "saved": request.complete(withJSON: payload.value)
                case "refused": request.complete(withJSON: #"{"error":"Owner only"}"#, statusCode: 403)
                default: request.fail(with: URLError(.timedOut))
                }
                await write.value
                XCTAssertEqual(choice.value(model), outcome == "saved" || outcome == "lost-saved" ? choice.chosen : original)
                XCTAssertEqual(requests.count, 1, "Unknown outcomes must never replay a save")
                XCTAssertEqual(model.errorMessage == nil, outcome == "saved")
            }
        }
    }

    func testQueuedWritesRetainNewerChoicesAndRefreshWaitsForTheQueue() async throws {
        let requests = DeferredRequests()
        let reads = LockedTestValue(0)
        let arrived = (0..<3).map { expectation(description: "write \($0)") }
        let model = store { request in
            if request.request.httpMethod == "POST" {
                let count = requests.append(request)
                arrived[count - 1].fulfill()
            } else {
                reads.value += 1
                request.complete(withJSON: self.initial)
            }
        }
        await model.loadIfNeeded()
        await model.loadIfNeeded()
        XCTAssertEqual(reads.value, 1, "Settings pages share one initial read")
        let first = model.setAgentApprovals(false)
        let second = model.setUpdateChannel("nightly")
        let third = model.setAgentApprovals(true)
        let refresh = Task { await model.load() }
        await fulfillment(of: [arrived[0]], timeout: 5)
        XCTAssertEqual(requests.count, 1)
        XCTAssertEqual(reads.value, 1)
        requests.request(at: 0).complete(withJSON: #"{"agent_approvals":false,"update_channel":"stable"}"#)
        await first.value
        XCTAssertEqual(model.settings?.agentApprovals, true)
        XCTAssertEqual(model.settings?.updateChannel, "nightly")
        await fulfillment(of: [arrived[1]], timeout: 5)
        requests.request(at: 1).complete(withJSON: #"{"agent_approvals":false,"update_channel":"nightly"}"#)
        await second.value
        XCTAssertEqual(model.settings?.agentApprovals, true)
        await fulfillment(of: [arrived[2]], timeout: 5)
        requests.request(at: 2).complete(withJSON: #"{"agent_approvals":true,"update_channel":"nightly"}"#)
        await third.value
        await refresh.value
        XCTAssertEqual(reads.value, 2)
        XCTAssertEqual(model.settings?.updateChannel, "stable", "An explicit read converges on the server")
    }

    func testFailedReconciliationRetainsChoiceUntilAReadSucceedsAndInvalidInputNeverWrites() async throws {
        let online = LockedTestValue(true)
        let posts = LockedTestValue(0)
        let model = store { request in
            if request.request.httpMethod == "POST" {
                posts.value += 1
                online.value = false
                request.fail(with: URLError(.timedOut))
            } else if online.value { request.complete(withJSON: self.initial) }
            else { request.fail(with: URLError(.notConnectedToInternet)) }
        }
        await model.loadIfNeeded()
        XCTAssertNil(model.setMaxTokensText("12oops"))
        XCTAssertEqual(model.settings?.maxTokens, 8192)
        XCTAssertEqual(posts.value, 0)
        await model.setUpdateChannel("nightly").value
        XCTAssertEqual(model.settings?.updateChannel, "nightly")
        XCTAssertNotNil(model.errorMessage)
        online.value = true
        await model.load()
        XCTAssertEqual(model.settings?.updateChannel, "stable")
        XCTAssertEqual(posts.value, 1)
    }

    func testSettingsDecodeAllMissingNullAndFutureFieldsTolerantly() throws {
        let full = #"{"agent_approvals":false,"compression_prepare_ahead":true,"max_tokens":null,"auto_title_refresh_every":"20","check_for_updates":true,"auto_apply_updates":false,"summarize_updates_automatically":true,"update_channel":"nightly","update_channels":["experimental","stable","nightly"],"agent_update_channel":"experimental","ignore_agent_updates":false,"future":{}}"#
        let settings = try APIClient.responseDecoder().decode(SettingsResponse.self, from: Data(full.utf8))
        XCTAssertEqual(settings.agentApprovals, false)
        XCTAssertEqual(settings.compressionPrepareAhead, true)
        XCTAssertEqual(settings.autoTitleRefreshEvery, "20")
        XCTAssertEqual(settings.checkForUpdates, true)
        XCTAssertEqual(settings.autoApplyUpdates, false)
        XCTAssertEqual(settings.summarizeUpdatesAutomatically, true)
        XCTAssertEqual(settings.updateChannel, "nightly")
        XCTAssertEqual(settings.updateChannels, ["experimental", "stable", "nightly"])
        XCTAssertEqual(settings.agentUpdateChannel, "experimental")
        XCTAssertEqual(settings.ignoreAgentUpdates, false)
        XCTAssertNil(settings.maxTokens)
        XCTAssertTrue(settings.hasMaxTokens)
        let allFields = try JSONDecoder().decode([String: JSONValue].self, from: Data(full.utf8))
        let nulls = String(decoding: try JSONEncoder().encode(allFields.mapValues { _ in JSONValue.null }), as: UTF8.self)
        for json in ["{}", nulls, #"{"agent_approvals":null,"compression_prepare_ahead":null,"update_channels":null,"max_tokens":null}"#,
                     #"{"agent_approvals":"true","compression_prepare_ahead":"false","update_channels":42,"max_tokens":{}}"#] {
            let absent = try APIClient.responseDecoder().decode(SettingsResponse.self, from: Data(json.utf8))
            XCTAssertNil(absent.agentApprovals)
            XCTAssertNil(absent.compressionPrepareAhead)
            XCTAssertNil(absent.updateChannels)
            XCTAssertNil(absent.maxTokens)
            XCTAssertEqual(absent.hasMaxTokens, json != "{}")
        }
    }
}

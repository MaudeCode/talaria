import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

@MainActor
final class AgentBackupHostedTests: XCTestCase {
    func testCreatesAndSharesBackupAfterLostStartResponse() async throws {
        let server = try Server(test: self, initial: "idle")
        let window = try server.open()
        let createElement = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-backup-create" }
        let create = try XCTUnwrap(createElement, "Missing agent-backup-create in System settings")
        attachHostedScreenshot(window, name: "agent-backup-available")
        XCTAssertTrue(HostedAccessibility.activate(create))

        let presented = await presentedController(in: window)
        let confirmation = try XCTUnwrap(presented as? UIAlertController)
        XCTAssertTrue(confirmation.message?.contains("talaria-host") == true)
        XCTAssertTrue(confirmation.message?.contains("default") == true)
        attachHostedScreenshot(window, name: "agent-backup-confirmation")
        XCTAssertTrue(HostedAccessibility.tap("Create Backup", in: confirmation))

        let downloadElement = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-backup-download" }
        let download = try XCTUnwrap(downloadElement, "Missing agent-backup-download in System settings")
        XCTAssertEqual(server.posts.value, 1, "A lost create response must only trigger a status read.")
        attachHostedScreenshot(window, name: "agent-backup-ready")
        XCTAssertTrue(HostedAccessibility.activate(download))
        let shared = await presentedController(in: window) {
            $0.firstDescendant(ofType: UIActivityViewController.self) != nil
        }
        XCTAssertNotNil(shared, "A downloaded file opens the native share sheet.")
        XCTAssertEqual(server.downloads.value, 1)
        attachHostedScreenshot(window, name: "agent-backup-share")

        if keepsHostedScreenshots {
            window.isHidden = true
            window.rootViewController = nil
            try await renderHostedPage("settings-backup-ready") {
                server.page
            } inspect: { window, variant in
                let list = try XCTUnwrap(window.firstView(ofType: UICollectionView.self))
                _ = try await requireElementScrolling(in: window, "\(variant.name) must show Download Backup") {
                    let frame = window.convert($0.accessibilityFrame, from: window.screen.coordinateSpace)
                    let viewport = window.convert(list.bounds.inset(by: list.adjustedContentInset), from: list)
                    return HostedAccessibility.identifier(of: $0) == "agent-backup-download" && viewport.contains(frame)
                }
            }
        }
    }

    func testCancelsRunningBackupAndUsesServerResult() async throws {
        let server = try Server(test: self, initial: "running")
        let window = try server.open()
        let cancelElement = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-backup-cancel" }
        let cancel = try XCTUnwrap(cancelElement, "Missing agent-backup-cancel in System settings")
        attachHostedScreenshot(window, name: "agent-backup-running")
        XCTAssertTrue(HostedAccessibility.activate(cancel))
        let reconciled = await awaitCondition {
            HostedAccessibility.elements(in: window, labelContaining: "Backup cancelled").count == 1
        }
        XCTAssertTrue(reconciled)
        XCTAssertEqual(server.discards.value, 1)
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "agent-backup-download"))
        attachHostedScreenshot(window, name: "agent-backup-cancelled")
    }

    func testRefusalHidesActionAndDoesNotShowRawError() async throws {
        let server = try Server(test: self, initial: "idle", refusesStart: true)
        let window = try server.open()
        let createElement = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-backup-create" }
        let create = try XCTUnwrap(createElement, "Missing agent-backup-create in System settings")
        XCTAssertTrue(HostedAccessibility.activate(create))
        let presented = await presentedController(in: window)
        let confirmation = try XCTUnwrap(presented as? UIAlertController)
        XCTAssertTrue(HostedAccessibility.tap("Create Backup", in: confirmation))

        let refused = await awaitCondition {
            HostedAccessibility.elements(in: window, labelContaining: "The server refused the backup request.").count == 1
                && HostedAccessibility.element(in: window, identifier: "agent-backup-create") == nil
        }
        XCTAssertTrue(refused, "The unavailable status removes the action and leaves a safe error.")
        XCTAssertFalse(HostedAccessibility.labels(in: window).contains { $0.contains("fixture-secret") })
        XCTAssertEqual(server.posts.value, 1)
        attachHostedScreenshot(window, name: "agent-backup-refused")
    }

    private struct Server {
        let posts = LockedTestValue(0)
        let discards = LockedTestValue(0)
        let downloads = LockedTestValue(0)
        let fixture: FixtureApp
        let url: URL
        unowned let test: AgentBackupHostedTests

        @MainActor
        init(test: AgentBackupHostedTests, initial: String, refusesStart: Bool = false) throws {
            self.test = test
            fixture = try FixtureApp(for: test)
            let host = "agent-backup-\(UUID().uuidString.lowercased()).test"
            url = try XCTUnwrap(URL(string: "https://\(host)"))
            let fixtures = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("agent-backup")) as? [String: [String: Any]])
            func json(_ name: String) throws -> String {
                String(decoding: try JSONSerialization.data(withJSONObject: XCTUnwrap(fixtures[name])), as: UTF8.self)
            }
            let current = LockedTestValue(try json(initial))
            let ready = try json("ready")
            let unavailable = try json("named_profile")
            var cancelledStatus = try XCTUnwrap(fixtures["running"])
            var cancelledJob = try XCTUnwrap(cancelledStatus["job"] as? [String: Any])
            let jobID = try XCTUnwrap(cancelledJob["id"] as? String)
            cancelledJob["state"] = "cancelled"
            cancelledJob["phase"] = NSNull()
            cancelledStatus["job"] = cancelledJob
            let cancelled = String(decoding: try JSONSerialization.data(withJSONObject: cancelledStatus), as: UTF8.self)

            DeferredMockURLProtocol.setOnRequest({ [posts, discards, downloads] load in
                switch (load.request.httpMethod, load.request.url?.path) {
                case ("GET", "/api/agent-backup"):
                    load.complete(withJSON: current.value)
                case ("POST", "/api/agent-backup"):
                    posts.value += 1
                    current.value = refusesStart ? unavailable : ready
                    if refusesStart {
                        load.complete(withJSON: #"{"code":"agent_backup_unavailable","error":"fixture-secret"}"#, statusCode: 403)
                    } else {
                        load.fail(with: URLError(.networkConnectionLost))
                    }
                case ("DELETE", "/api/agent-backup/\(jobID)"):
                    discards.value += 1
                    current.value = cancelled
                    load.complete(withJSON: cancelled)
                case ("GET", "/api/agent-backup/download") where load.request.url?.query == "id=\(jobID)":
                    downloads.value += 1
                    let response = HTTPURLResponse(url: load.request.url!, statusCode: 200, httpVersion: nil,
                                                   headerFields: ["Content-Type": "application/zip"])!
                    load.client?.urlProtocol(load, didReceive: response, cacheStoragePolicy: .notAllowed)
                    load.client?.urlProtocol(load, didLoad: Data([0x50, 0x4b, 0x05, 0x06] + Array(repeating: 0, count: 18)))
                    load.client?.urlProtocolDidFinishLoading(load)
                case (_, "/api/settings"):
                    load.complete(withJSON: #"{"webui_version":"0.0.1"}"#)
                case (_, "/api/toolsets/defaults"):
                    load.complete(withJSON: #"{"toolsets":[],"selected_toolsets":[]}"#)
                default:
                    load.complete(withJSON: "{}")
                }
            }, forHost: host)
            let previousHook = UITestURLSessionHook.configure
            UITestURLSessionHook.configure = { $0.protocolClasses = [DeferredMockURLProtocol.self] }
            test.addTeardownBlock {
                UITestURLSessionHook.configure = previousHook
                DeferredMockURLProtocol.setOnRequest(nil, forHost: host)
            }
        }

        @MainActor
        var page: some View {
            NavigationStack {
                SettingsPaneView(authManager: fixture.environment.authManager, server: url, pane: .category(.system))
            }
        }

        @MainActor
        func open() throws -> UIWindow { try test.hostWindow(page) }
    }
}

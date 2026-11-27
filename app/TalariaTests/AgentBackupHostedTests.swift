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

    func testFileImporterStagesAnArchiveWithoutConfirmingIt() async throws {
        let restore = try RestoreServer(initial: nil)
        let window = try Server(test: self, initial: "idle", restore: restore).open()
        let action = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-restore-upload" }
        let button = try XCTUnwrap(action, "A server that accepts uploads must offer Choose Restore Archive.")
        attachHostedScreenshot(window, name: "agent-restore-available")
        XCTAssertTrue(HostedAccessibility.activate(button))
        let presented = await presentedController(in: window)
        let picker = try XCTUnwrap(presented as? UIDocumentPickerViewController)
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let archive = directory.appending(path: restore.filename)
        try Data([0x50, 0x4b, 0x05, 0x06] + Array(repeating: 0, count: 18)).write(to: archive)
        let delegate = try XCTUnwrap(picker.delegate)
        delegate.documentPicker?(picker, didPickDocumentsAt: [archive])

        let staged = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-restore-confirm" }
        XCTAssertNotNil(staged, "The server's staged receipt must become confirmable.")
        XCTAssertEqual(restore.uploads.value, [restore.filename])
        XCTAssertTrue(restore.confirmations.value.isEmpty, "Choosing a file may stage it, never restore it.")
        attachHostedScreenshot(window, name: "agent-restore-staged")
    }

    func testConfirmsStagedRestoreBeforeSendingTheReceipt() async throws {
        let restore = try RestoreServer(initial: "staged", outcome: "restored")
        let server = try Server(test: self, initial: "idle", restore: restore)
        let window = try server.open()
        let action = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-restore-confirm" }
        let button = try XCTUnwrap(action, "A server-confirmable restore must offer Restore in System settings.")
        XCTAssertTrue(HostedAccessibility.activate(button))
        let presented = await presentedController(in: window)
        let alert = try XCTUnwrap(presented as? UIAlertController)
        for value in [restore.serverName, restore.profile, restore.filename] {
            XCTAssertTrue(alert.message?.contains(value) == true, "The confirmation must name \(value).")
        }
        XCTAssertTrue(restore.confirmations.value.isEmpty)
        attachHostedScreenshot(window, name: "agent-restore-confirmation")
        XCTAssertTrue(HostedAccessibility.tap("Restore", in: alert))
        let restored = await awaitCondition {
            HostedAccessibility.elements(in: window, labelContaining: "Agent home restored.").count == 1
        }
        XCTAssertTrue(restored)
        XCTAssertEqual(restore.confirmations.value, [restore.id], "Confirm the displayed receipt exactly once.")
        attachHostedScreenshot(window, name: "agent-restore-success")
    }

    func testRendersNativeRestoreRefusal() async throws {
        let restore = try RestoreServer(initial: "refused")
        let window = try Server(test: self, initial: "idle", restore: restore).open()
        let refused = await awaitCondition {
            HostedAccessibility.elements(in: window, labelContaining: "The destination failed a safety check.").count == 1
        }
        XCTAssertTrue(refused)
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "agent-restore-recovery"))
        attachHostedScreenshot(window, name: "agent-restore-refused")
    }

    func testSharesThePartialRestoresRecoveryBackup() async throws {
        let restore = try RestoreServer(initial: "partial")
        let server = try Server(test: self, initial: "idle", restore: restore)
        let window = try server.open()
        let action = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-restore-recovery" }
        let button = try XCTUnwrap(action, "A partial restore must offer the server's recovery backup.")
        XCTAssertTrue(HostedAccessibility.labels(in: window).contains { $0.contains("Some data may have changed.") })
        attachHostedScreenshot(window, name: "agent-restore-partial")
        XCTAssertTrue(HostedAccessibility.activate(button))
        let shared = await presentedController(in: window) { $0.firstDescendant(ofType: UIActivityViewController.self) != nil }
        XCTAssertNotNil(shared)
        XCTAssertEqual(restore.downloads.value, 1)
        attachHostedScreenshot(window, name: "agent-restore-share")

        if keepsHostedScreenshots {
            HostedScene.dismantle(window)
            try await renderHostedPage("settings-agent-restore-partial") {
                server.page
            } inspect: { window, variant in
                let list = try XCTUnwrap(window.firstView(ofType: UICollectionView.self))
                let recovery = try await requireElementScrolling(in: window, "\(variant.name) must show Download Recovery Backup") {
                    let frame = window.convert($0.accessibilityFrame, from: window.screen.coordinateSpace)
                    let viewport = window.convert(list.bounds.inset(by: list.adjustedContentInset), from: list)
                    return HostedAccessibility.identifier(of: $0) == "agent-restore-recovery" && viewport.contains(frame)
                }
                if variant.textSize.isAccessibilityCategory {
                    let frame = list.convert(recovery.accessibilityFrame, from: window.screen.coordinateSpace)
                    let index = try XCTUnwrap(list.indexPathForItem(at: CGPoint(x: frame.midX, y: frame.midY)))
                    list.scrollToItem(at: index, at: .centeredVertically, animated: false)
                    settle(window: window)
                }
            }
        }
    }

    func testReconcilesLostRestoreConfirmationWithoutReplayingIt() async throws {
        let restore = try RestoreServer(initial: "staged", outcome: "unknown")
        let window = try Server(test: self, initial: "idle", restore: restore).open()
        let action = await awaitElement(in: window) { HostedAccessibility.identifier(of: $0) == "agent-restore-confirm" }
        XCTAssertTrue(HostedAccessibility.activate(try XCTUnwrap(action)))
        let presented = await presentedController(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Restore", in: try XCTUnwrap(presented as? UIAlertController)))
        let unknown = await awaitCondition {
            HostedAccessibility.elements(in: window, labelContaining: "The restore outcome is unknown.").count == 1
        }
        XCTAssertTrue(unknown)
        XCTAssertEqual(restore.confirmations.value, [restore.id])
        XCTAssertNil(HostedAccessibility.element(in: window, identifier: "agent-restore-upload"))
        XCTAssertNotNil(HostedAccessibility.element(in: window, identifier: "agent-restore-recovery"))
        attachHostedScreenshot(window, name: "agent-restore-unknown")
    }

    private struct RestoreServer {
        let serverName: String
        let profile: String
        let filename: String
        let id: String
        let current: LockedTestValue<String>
        let stagedJSON: String
        let outcome: String?
        let outcomeJSON: String?
        let uploads = LockedTestValue([String]())
        let confirmations = LockedTestValue([String]())
        let downloads = LockedTestValue(0)

        init(initial: String?, outcome: String? = nil) throws {
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: sharedContractFixture("agent-restore")) as? [String: Any])
            let job = try XCTUnwrap(fixture["job"] as? [String: Any])
            id = try XCTUnwrap(job["id"] as? String)
            filename = try XCTUnwrap(job["file_name"] as? String)
            serverName = try XCTUnwrap(fixture["server"] as? String)
            profile = try XCTUnwrap(fixture["profile"] as? String)
            func status(_ state: String?) throws -> String {
                var body = fixture
                if let state {
                    var receipt = job
                    receipt["state"] = state
                    receipt["can_confirm"] = state == "staged"
                    if !["restored", "partial", "unknown"].contains(state) { receipt["recovery_url"] = NSNull() }
                    body["job"] = receipt
                } else {
                    body["job"] = NSNull()
                }
                body["can_upload"] = state != "unknown"
                return String(decoding: try JSONSerialization.data(withJSONObject: body), as: UTF8.self)
            }
            current = LockedTestValue(try status(initial))
            stagedJSON = try status("staged")
            self.outcome = outcome
            outcomeJSON = try outcome.map { try status($0) }
        }

        func stage(_ load: DeferredMockURLProtocol) {
            let name = load.request.url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }?
                .queryItems?.first { $0.name == "name" }?.value
            guard name == filename, load.request.value(forHTTPHeaderField: "Content-Type") == "application/zip" else {
                load.complete(withJSON: "{}", statusCode: 415)
                return
            }
            uploads.value.append(name ?? "")
            current.value = stagedJSON
            load.complete(withJSON: stagedJSON)
        }

        func confirm(_ load: DeferredMockURLProtocol) {
            let body = UITestFixtureURLProtocol.requestJSON(load.request)
            confirmations.value.append(body["confirmed"] as? Bool == true ? body["id"] as? String ?? "" : "")
            if let outcomeJSON { current.value = outcomeJSON }
            if outcome == "unknown" {
                load.fail(with: URLError(.networkConnectionLost))
            } else {
                load.complete(withJSON: current.value)
            }
        }
    }

    private struct Server {
        let posts = LockedTestValue(0)
        let discards = LockedTestValue(0)
        let downloads = LockedTestValue(0)
        let fixture: FixtureApp
        let url: URL
        unowned let test: AgentBackupHostedTests

        @MainActor
        init(test: AgentBackupHostedTests, initial: String, refusesStart: Bool = false, restore: RestoreServer? = nil) throws {
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
                case ("GET", "/api/agent-backup/restore"):
                    if let restore { load.complete(withJSON: restore.current.value) }
                    else { load.complete(withJSON: "{}", statusCode: 404) }
                case ("POST", "/api/agent-backup/restore/upload"):
                    if let restore { restore.stage(load) }
                    else { load.complete(withJSON: "{}", statusCode: 404) }
                case ("POST", "/api/agent-backup/restore"):
                    if let restore { restore.confirm(load) }
                    else { load.complete(withJSON: "{}", statusCode: 404) }
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
                case ("GET", "/api/agent-backup/download") where load.request.url?.query == "id=\(jobID)",
                     ("GET", "/api/agent-backup/recovery") where load.request.url?.query == restore.map({ "id=\($0.id)" }):
                    if load.request.url?.path == "/api/agent-backup/recovery" { restore?.downloads.value += 1 }
                    else { downloads.value += 1 }
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
                    load.complete(withJSON: "{}", statusCode: 404)
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

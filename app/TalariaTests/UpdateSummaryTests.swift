import SwiftUI
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-759: "Summarize with AI" shows the server's summary of one pending update in a bottom sheet.
final class UpdateSummaryTests: APIClientTestCase {
    private static let sectionsJSON = """
    {
      "ok": true, "target": "agent", "summary": "", "generated_by": "llm", "source": "release_notes", "cached": false,
      "current_version": "v2026.9.24", "target_version": "v0.21.7",
      "summary_sections": [
        { "title": "What you'll notice", "items": ["Chats open faster."] },
        { "title": "Worth knowing", "items": ["This summary covers v0.21.6 and v0.21.7."] }
      ]
    }
    """

    private static func target(_ json: String) throws -> UpdateTargetInfo {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(UpdateTargetInfo.self, from: Data(json.utf8))
    }

    @MainActor
    func testTheSheetShowsProgressThenOffersRetryAfterAFailure() throws {
        let answered = DispatchSemaphore(value: 0)
        var requests = 0
        let client = makeClient { request in
            requests += 1
            if requests == 1 {
                answered.wait()
                return apiTestJSONResponse(
                    #"{ "error": "model unavailable" }"#, statusCode: 500, for: request
                )
            }
            return apiTestJSONResponse(Self.sectionsJSON, for: request)
        }
        let window = try hostWindow(UpdateSummarySheet(
            model: UpdateSummaryModel(target: .agent, client: client),
            name: "Hermes Agent"
        ))

        let loading = { !HostedAccessibility.elements(in: window, labelContaining: "Summarizing what's new").isEmpty }
        XCTAssertTrue(waitUntil(loading), "Elements: \(HostedAccessibility.labels(in: window))")
        answered.signal()

        XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, label: "Retry") != nil },
                      "Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Couldn't summarize").isEmpty)
        try HostedAccessibility.activate(XCTUnwrap(HostedAccessibility.element(in: window, label: "Retry")))

        XCTAssertTrue(waitUntil { HostedAccessibility.element(in: window, label: "Chats open faster.") != nil },
                      "Elements: \(HostedAccessibility.labels(in: window))")
        XCTAssertFalse(HostedAccessibility.elements(in: window, labelContaining: "Worth knowing").isEmpty)
        // The range shown is the one the server summarized.
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "v2026.9.24 → v0.21.7"))
        XCTAssertEqual(requests, 2)
    }

    @MainActor
    func testTheButtonAppearsOnlyWhenTheServerOffersASummary() throws {
        let offered = try Self.target(#"{ "behind": 3, "state": "release_ready", "summary_available": true }"#)
        let current = try Self.target(#"{ "behind": 0, "state": "up_to_date", "summary_available": false }"#)
        var taps = 0
        let window = try hostWindow(VStack {
            UpdateSummaryButton(info: offered) { taps += 1 }
            UpdateSummaryButton(info: current) { taps += 10 }
        })

        let buttons = HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI")
        XCTAssertEqual(buttons.count, 1, "Elements: \(HostedAccessibility.labels(in: window))")
        try HostedAccessibility.activate(XCTUnwrap(buttons.first))
        XCTAssertEqual(taps, 1)
    }

    @MainActor
    func testSystemWebSummaryPresentsOverSettingsOnPhone() async throws {
        try await assertSystemSummaryPresentsOverSettings(index: 0, name: "Talaria Web", size: HostedSize.phone)
    }

    @MainActor
    func testSystemWebSummaryPresentsOverSettingsOnDuo() async throws {
        try await assertSystemSummaryPresentsOverSettings(index: 0, name: "Talaria Web", size: HostedSize.duoInner)
    }

    @MainActor
    func testSystemAgentSummaryPresentsOverSettingsOnPhone() async throws {
        try await assertSystemSummaryPresentsOverSettings(index: 1, name: "Hermes Agent", size: HostedSize.phone)
    }

    @MainActor
    func testSystemAgentSummaryPresentsOverSettingsOnDuo() async throws {
        try await assertSystemSummaryPresentsOverSettings(index: 1, name: "Hermes Agent", size: HostedSize.duoInner)
    }

    /// TAL-2248: Each summary presents once over Settings and dismisses back to it.
    @MainActor
    private func assertSystemSummaryPresentsOverSettings(index: Int, name: String, size: CGSize) async throws {
        let system = try SystemSettingsFixture(test: self)
        let (window, settings) = try await system.present(size: size)
        defer { system.close(window) }
        func chain() -> String {
            var controller = window.rootViewController
            var names: [String] = []
            while let next = controller?.presentedViewController {
                names.append("\(type(of: next))\(next === settings ? " (Settings)" : "")")
                controller = next
            }
            return names.joined(separator: " > ")
        }
        let buttons = HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI")
        let button = try XCTUnwrap(buttons.dropFirst(index).first)
        XCTAssertTrue(HostedAccessibility.activate(button))
        let loaded = await awaitElement(in: window, label: "Chats open faster.")
        XCTAssertNotNil(loaded, "\(name)'s summary loads: \(chain())")
        let summary = try XCTUnwrap(settings.presentedViewController, "\(name)'s summary presents over Settings: \(chain())")
        // The presentation's own record once its transition ends: Settings and the summary stay up, nothing leaves.
        let presented = await awaitCondition { summary.transitionCoordinator == nil && settings.transitionCoordinator == nil }
        XCTAssertTrue(presented, "\(name)'s summary finishes presenting: \(chain())")
        XCTAssertTrue(window.rootViewController?.presentedViewController === settings, "Settings closed: \(chain())")
        XCTAssertTrue(settings.presentedViewController === summary, "\(name)'s summary was replaced: \(chain())")
        XCTAssertFalse(settings.isBeingDismissed || summary.isBeingDismissed, "\(name)'s summary or Settings is closing: \(chain())")
        XCTAssertNil(summary.presentedViewController, "Exactly one summary sheet presents")
        XCTAssertNotNil(HostedAccessibility.element(in: window, label: "What's new in \(name)"))

        try HostedAccessibility.activate(XCTUnwrap(HostedAccessibility.toolbarAction("Done", in: window)))
        let dismissed = await awaitCondition { settings.presentedViewController == nil }
        XCTAssertTrue(dismissed, "Done dismisses \(name)'s summary")
        XCTAssertTrue(window.rootViewController?.presentedViewController === settings, "Done leaves Settings open")
        XCTAssertEqual(system.checks.value, 1, "Opening System checks for updates once, not once per row")
    }

    /// TAL-2248: Check Now and Update present their alerts over Settings, once, and cancelling leaves Settings open.
    @MainActor
    func testSystemAlertsPresentOverSettingsOnce() async throws {
        let system = try SystemSettingsFixture(test: self)
        for size in [HostedSize.phone, HostedSize.duoInner] {
            let (window, settings) = try await system.present(size: size)
            for (control, cancel) in [(SettingsIndex.systemCheckNow.title, "Dismiss"), (SettingsIndex.systemUpdate.title, "Cancel")] {
                let button = try await requireElement(in: window, label: control)
                XCTAssertTrue(HostedAccessibility.activate(button))
                _ = await awaitCondition { settings.presentedViewController is UIAlertController }
                let alert = try XCTUnwrap(settings.presentedViewController as? UIAlertController,
                                          "\(control)'s alert presents over Settings")
                XCTAssertTrue(HostedAccessibility.tap(cancel, in: alert))
                let dismissed = await awaitCondition { settings.presentedViewController == nil && alert.presentingViewController == nil }
                XCTAssertTrue(dismissed, "\(control)'s alert presents once")
                XCTAssertTrue(window.rootViewController?.presentedViewController === settings, "\(control)'s alert leaves Settings open")
                XCTAssertFalse(settings.isBeingDismissed, "\(control)'s alert closes Settings")
            }
            system.close(window)
        }
    }

    @MainActor
    func testSystemOffersUpdateAnywayAndRequiresConsent() async throws {
        let responses = try XCTUnwrap(
            JSONSerialization.jsonObject(with: sharedContractFixture("web-update-interrupt")) as? [String: [String: Any]]
        )
        let offer = try XCTUnwrap(responses["offered"])
        let confirmation = try XCTUnwrap(offer["interrupt_confirmation"] as? [String: Any])
        let token = try XCTUnwrap(confirmation["token"] as? String)
        let count = try XCTUnwrap(confirmation["runs"] as? Int)
        let offered = String(decoding: try JSONSerialization.data(withJSONObject: offer), as: UTF8.self)
        let refusal = try XCTUnwrap(responses["not_offered"])
        let refused = String(decoding: try JSONSerialization.data(withJSONObject: refusal), as: UTF8.self)
        let tokens = LockedTestValue<[String]>([])
        let system = try SystemSettingsFixture(test: self) { request in
            let body = apiTestBodyData(from: request.request).flatMap {
                try? JSONSerialization.jsonObject(with: $0) as? [String: String]
            }
            tokens.value.append(body?["interrupt_token"] ?? "")
            request.complete(withJSON: tokens.value.count == 1 ? offered : refused)
        }
        let (window, settings) = try await system.present(size: HostedSize.phone)
        defer { system.close(window) }
        let update = try await requireElement(in: window, label: SettingsIndex.systemUpdate.title)
        attachHostedScreenshot(window, name: "web-update-before")
        XCTAssertTrue(HostedAccessibility.activate(update))
        let firstAlert = await presentedAlert(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Update", in: try XCTUnwrap(firstAlert)))

        let action = try await requireElement(in: window, label: "Update anyway")
        let message = try XCTUnwrap(offer["message"] as? String)
        XCTAssertEqual(HostedAccessibility.element(in: window, identifier: "settings-system-status-update")?.accessibilityValue, message)
        attachHostedScreenshot(window, name: "web-update-offered")
        XCTAssertTrue(HostedAccessibility.activate(action))
        let presented = await presentedAlert(in: window)
        let alert = try XCTUnwrap(presented)
        XCTAssertTrue(alert.message?.contains("\(count) running chats") == true)
        attachHostedScreenshot(window, name: "web-update-consent")
        XCTAssertTrue(HostedAccessibility.tap("Cancel", in: alert))
        let dismissed = await awaitCondition { settings.presentedViewController == nil }
        XCTAssertTrue(dismissed)
        XCTAssertEqual(tokens.value, [""])

        let retry = try await requireElement(in: window, label: "Update anyway")
        XCTAssertTrue(HostedAccessibility.activate(retry))
        let confirmed = await presentedAlert(in: window)
        XCTAssertTrue(HostedAccessibility.tap("Update anyway", in: try XCTUnwrap(confirmed)))
        let refusedMessage = try XCTUnwrap(refusal["message"] as? String)
        let settled = await awaitCondition {
            HostedAccessibility.element(in: window, identifier: "settings-system-status-update")?.accessibilityValue == refusedMessage
        }
        XCTAssertTrue(settled)
        XCTAssertEqual(tokens.value, ["", token])
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Update anyway"))
        attachHostedScreenshot(window, name: "web-update-refused")
    }

    /// Settings > System on a fresh window against a server whose both targets offer a summarized update.
    @MainActor
    private struct SystemSettingsFixture {
        let checks = LockedTestValue(0)
        private let fixture: FixtureApp
        private let server: URL
        private unowned let test: UpdateSummaryTests

        init(test: UpdateSummaryTests, apply: ((DeferredMockURLProtocol) -> Void)? = nil) throws {
            self.test = test
            fixture = try FixtureApp(for: test)
            let host = "system-summary-\(UUID().uuidString.lowercased()).test"
            server = try XCTUnwrap(URL(string: "https://\(host)"))
            let checks = checks
            let check = #"""
            { "webui": { "state": "release_ready", "can_apply": true, "behind": 1, "current_version": "0.0.1",
                         "target_version": "0.0.2", "summary_available": true },
              "agent": { "state": "release_ready", "behind": 1, "current_version": "v2026.9.24",
                         "target_version": "v0.21.7", "summary_available": true } }
            """#
            DeferredMockURLProtocol.setOnRequest({ request in
                switch (request.request.httpMethod, request.request.url?.path) {
                case ("GET", "/api/updates/check"):
                    checks.value += 1
                    request.complete(withJSON: check)
                case (_, "/api/updates/check"): request.complete(withJSON: check)
                case (_, "/api/updates/summary"): request.complete(withJSON: UpdateSummaryTests.sectionsJSON)
                case (_, "/api/settings"): request.complete(withJSON: #"{ "webui_version": "0.0.1" }"#)
                case ("POST", "/api/updates/apply") where apply != nil: apply?(request)
                default: request.complete(withJSON: "{}")
                }
            }, forHost: host)
            let previousHook = UITestURLSessionHook.configure
            UITestURLSessionHook.configure = { $0.protocolClasses = [DeferredMockURLProtocol.self] }
            test.addTeardownBlock {
                UITestURLSessionHook.configure = previousHook
                DeferredMockURLProtocol.setOnRequest(nil, forHost: host)
            }
        }

        /// Hosts Settings > System in its sheet and waits until both rows offer their summary.
        func present(size: CGSize) async throws -> (UIWindow, UIViewController) {
            checks.value = 0
            let window = try test.hostWindow(Color.clear.sheet(isPresented: .constant(true)) {
                NavigationStack {
                    SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .category(.system))
                }
            }, size: size)
            let presented = await test.presentedController(in: window)
            let settings = try XCTUnwrap(presented, "Settings presents")
            let offered = await test.awaitCondition {
                HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI").count == 2
            }
            XCTAssertTrue(offered, "Elements: \(HostedAccessibility.labels(in: window))")
            return (window, settings)
        }

        func close(_ window: UIWindow) {
            window.isHidden = true
            window.rootViewController = nil
        }
    }

    func testTheSheetNamesEachTargetAndFormatsAKnownRange() {
        XCTAssertEqual(UpdateSummaryRequest(target: .agent).name, "Hermes Agent")
        XCTAssertEqual(UpdateSummaryRequest(target: .webui).name, "Talaria Web")
        XCTAssertEqual(versionRange("v2026.9.24", "v0.21.7"), "v2026.9.24 → v0.21.7")
        XCTAssertNil(versionRange("v2026.9.24", nil))
    }

    func testTheAgentRowWordsEveryServerState() throws {
        let status = { (json: String) in try UpdateNote(agent: Self.target(json)).text }
        XCTAssertEqual(try status(#"{ "state": "release_ready", "target_version": "v0.21.7" }"#), "v0.21.7 available")
        XCTAssertEqual(try status(#"{ "state": "commits_behind", "behind": 14 }"#), "14 commits behind")
        XCTAssertEqual(try status(#"{ "state": "up_to_date", "behind": 0 }"#), "Up to date")
        XCTAssertEqual(try status(#"{ "state": "off", "behind": 0 }"#), "Update checks are off")
        XCTAssertEqual(try status(#"{ "behind": null }"#), "Unknown")
    }
}

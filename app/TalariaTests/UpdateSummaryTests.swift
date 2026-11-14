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
    func testTheModelLoadsTheServerSectionsForEitherTarget() async throws {
        for target in [UpdateTarget.webui, .agent] {
            var bodies: [NSDictionary] = []
            let client = makeClient { request in
                XCTAssertEqual(request.url?.path, "/api/updates/summary")
                let body = try XCTUnwrap(apiTestBodyData(from: request))
                try bodies.append(XCTUnwrap(JSONSerialization.jsonObject(with: body) as? NSDictionary))
                return apiTestJSONResponse(Self.sectionsJSON, for: request)
            }
            let model = UpdateSummaryModel(target: target, client: client)
            XCTAssertEqual(model.phase, .loading)

            await model.load()

            XCTAssertEqual(bodies, [["target": target.rawValue]])
            guard case let .loaded(summary) = model.phase else { return XCTFail("Not loaded: \(model.phase)") }
            XCTAssertEqual(summary.summarySections, [
                .init(title: "What you'll notice", items: ["Chats open faster."]),
                .init(title: "Worth knowing", items: ["This summary covers v0.21.6 and v0.21.7."])
            ])
        }
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

    /// TAL-2248: the System section presents its summary sheet and alerts over Settings, once, and loads once.
    @MainActor
    func testSystemSettingsPresentOverSettingsAndLoadOnce() async throws {
        let fixture = try FixtureApp(for: self)
        let host = "system-summary-\(UUID().uuidString.lowercased()).test"
        let server = try XCTUnwrap(URL(string: "https://\(host)"))
        let checks = LockedTestValue(0)
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
            case (_, "/api/updates/summary"): request.complete(withJSON: Self.sectionsJSON)
            case (_, "/api/settings"): request.complete(withJSON: #"{ "webui_version": "0.0.1" }"#)
            default: request.complete(withJSON: "{}")
            }
        }, forHost: host)
        let previousHook = UITestURLSessionHook.configure
        UITestURLSessionHook.configure = { $0.protocolClasses = [DeferredMockURLProtocol.self] }
        addTeardownBlock {
            UITestURLSessionHook.configure = previousHook
            DeferredMockURLProtocol.setOnRequest(nil, forHost: host)
        }

        // Compact phone and the open Duo's regular display; the Settings sheet stands in for SessionListView's.
        for (sizeName, size) in [("phone", HostedSize.phone), ("duo-inner", HostedSize.duoInner)] {
            checks.value = 0
            let window = try hostWindow(Color.clear.sheet(isPresented: .constant(true)) {
                NavigationStack {
                    SettingsPaneView(authManager: fixture.environment.authManager, server: server, pane: .category(.system))
                }
            }, size: size)
            let presented = await presentedController(in: window)
            let settings = try XCTUnwrap(presented, "Settings presents")
            let offered = await awaitCondition {
                HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI").count == 2
            }
            XCTAssertTrue(offered, "Elements: \(HostedAccessibility.labels(in: window))")
            settle(0.5)
            XCTAssertEqual(checks.value, 1, "Opening System checks for updates once, not once per row")

            for (index, name) in ["Talaria Web", "Hermes Agent"].enumerated() {
                func chain() -> String {
                    var controller = window.rootViewController
                    var names: [String] = []
                    while let next = controller?.presentedViewController {
                        names.append("\(type(of: next))\(next === settings ? " (Settings)" : "")")
                        controller = next
                    }
                    return names.joined(separator: " > ")
                }
                let button = HostedAccessibility.elements(in: window, labelContaining: "Summarize with AI")[index]
                XCTAssertTrue(HostedAccessibility.activate(button))
                let loaded = await awaitElement(in: window, label: "Chats open faster.")
                XCTAssertNotNil(loaded, "\(name)'s summary loads: \(chain())")
                XCTAssertTrue(window.rootViewController?.presentedViewController === settings, "Settings closed: \(chain())")
                let summary = try XCTUnwrap(settings.presentedViewController, "\(name)'s summary presents over Settings: \(chain())")
                let closed = await awaitCondition(timeout: 2) {
                    window.rootViewController?.presentedViewController !== settings || settings.presentedViewController !== summary
                }
                XCTAssertFalse(closed, "\(name)'s summary and Settings stay presented after it loads")
                attachHostedScreenshot(window, name: "system-summary-over-settings-\(sizeName)-\(index)")
                XCTAssertNil(summary.presentedViewController, "Exactly one summary sheet presents")
                XCTAssertNotNil(HostedAccessibility.element(in: window, label: "What's new in \(name)"))

                try HostedAccessibility.activate(XCTUnwrap(HostedAccessibility.toolbarAction("Done", in: window)))
                let dismissed = await awaitCondition { settings.presentedViewController == nil }
                XCTAssertTrue(dismissed, "Done dismisses \(name)'s summary")
                XCTAssertTrue(window.rootViewController?.presentedViewController === settings, "Done leaves Settings open")
            }

            for (control, cancel) in [(SettingsIndex.systemCheckNow.title, "Dismiss"), (SettingsIndex.systemUpdate.title, "Cancel")] {
                let button = try await requireElement(in: window, label: control)
                XCTAssertTrue(HostedAccessibility.activate(button))
                _ = await awaitCondition { settings.presentedViewController is UIAlertController }
                let alert = try XCTUnwrap(settings.presentedViewController as? UIAlertController,
                                          "\(control)'s alert presents over Settings")
                XCTAssertTrue(HostedAccessibility.tap(cancel, in: alert))
                let closed = await awaitCondition(timeout: 1) { window.rootViewController?.presentedViewController !== settings }
                XCTAssertFalse(closed, "\(control)'s alert leaves Settings open")
                XCTAssertNil(settings.presentedViewController, "\(control)'s alert presents once")
            }
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

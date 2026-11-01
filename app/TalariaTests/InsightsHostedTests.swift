import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The Insights overhaul (TAL-1750): a Quotas tab of widget tiles opening an account's detail with every window,
/// pace and forecast, and a Usage tab with the stat grid and the charts drawn from the server series.
@MainActor
final class InsightsHostedTests: XCTestCase {
    /// Rendering clock: both fixture windows are live, their paces valid, and the fetch is twelve minutes old.
    static let now = ISO8601DateFormatter().date(from: "2030-01-01T00:12:00Z")!
    /// Clock times render in UTC, so the same strings and pixels come out on every machine (CI runs in UTC).
    static let utc = TimeZone(identifier: "UTC")!

    static let pacedSource = """
    {"version": 1, "scope_id": "qscope_test", "profile_id": "default", "computed_at": "2030-01-01T00:00:00Z", "sources": [{
      "source_id": "qsrc_paced", "provider_id": "anthropic", "provider_label": "Claude", "account_label": "Claude Max", "plan": "Max",
      "is_active_provider": true, "supported": true, "status": "available", "fetched_at": "2030-01-01T00:00:00Z",
      "session_window_index": 0, "weekly_window_index": 1, "pace_window_index": 1,
      "urgency": {"remaining": "healthy", "pace": "warning"},
      "windows": [
        {"label": "Session", "window_seconds": 18000, "used_percent": 25, "remaining_percent": 75, "reset_at": "2030-01-01T03:00:00Z",
         "urgency": {"remaining": "healthy", "pace": "healthy"},
         "pace": {"expected_remaining_percent": 60, "pace_delta_percent": 15, "burn_rate": 0.62, "minutes_to_reset": 180,
                  "projected_minutes_to_empty": 540, "elapsed_minutes": 120, "valid_until": "2030-01-01T03:00:00Z", "status": "under"},
         "forecast": {"outcome": "safe", "budget_unit": "hour", "budget_percent": 25, "depletion_margin_minutes": 360}},
        {"label": "Weekly", "window_seconds": 604800, "used_percent": 70, "remaining_percent": 30, "reset_at": "2030-01-03T12:00:00Z",
         "urgency": {"remaining": "warning", "pace": "warning"},
         "pace": {"expected_remaining_percent": 36, "pace_delta_percent": -6, "burn_rate": 1.1, "minutes_to_reset": 3600,
                  "projected_minutes_to_empty": 3270, "elapsed_minutes": 6480, "valid_until": "2030-01-03T12:00:00Z", "status": "over"},
         "forecast": {"outcome": "warning", "budget_unit": "day", "budget_percent": 12, "depletion_margin_minutes": -330}},
        {"label": "Monthly", "window_seconds": 2592000, "used_percent": 10, "remaining_percent": 90, "reset_at": "2030-01-20T00:00:00Z",
         "urgency": {"remaining": "healthy", "pace": "healthy"}},
        {"label": "Opus", "used_percent": 5, "remaining_percent": 95, "reset_at": "2030-01-01T03:00:00Z",
         "urgency": {"remaining": "healthy", "pace": "healthy"}}
      ]}]}
    """

    static let plainSource = """
    {"version": 1, "scope_id": "qscope_test", "profile_id": "default", "sources": [{
      "source_id": "qsrc_plain", "provider_id": "openai-codex", "provider_label": "OpenAI Codex", "account_label": "Codex",
      "supported": true, "status": "available", "fetched_at": "2030-01-01T00:00:00Z",
      "windows": [{"label": "Session", "used_percent": 40, "remaining_percent": 60, "reset_at": "2030-01-01T02:00:00Z"}]}]}
    """

    static func decode(_ json: String) throws -> ProviderQuotasResponse {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return try decoder.decode(ProviderQuotasResponse.self, from: Data(json.utf8))
    }

    /// The windows block alone, for `ImageRenderer` references (which draw a `List` as a placeholder).
    static func quotaWindowsView(_ json: String, referenceDate: Date = now) throws -> some View {
        let response = try decode(json)
        return ProviderQuotaWindowsView(
            source: response.sources[0],
            scopeID: response.scopeID ?? "",
            percentageMode: .remaining,
            referenceDate: referenceDate
        )
        .environment(\.timeZone, utc)
    }

    static func detail(_ json: String, referenceDate: Date = now, isPinned: Bool = false, canPin: Bool = true) throws -> some View {
        let response = try decode(json)
        return NavigationStack {
            ProviderQuotaDetailView(
                source: response.sources[0],
                scopeID: response.scopeID ?? "",
                displayName: response.sources[0].providerLabel,
                percentageMode: .remaining,
                isRefreshing: false,
                isPinned: isPinned,
                canPin: canPin,
                referenceDate: referenceDate,
                refresh: {},
                togglePin: {},
                hide: {},
                openProviderSettings: {}
            )
        }
        .environment(\.timeZone, utc)
    }

    private static func identified(_ identifier: String) -> (NSObject) -> Bool {
        { HostedAccessibility.identifier(of: $0) == identifier }
    }

    private static func labelled(prefix: String) -> (NSObject) -> Bool {
        { $0.accessibilityLabel?.hasPrefix(prefix) == true }
    }

    /// Finds `match` on a lazily built screen: checks what is on screen, then pages the main list down until the
    /// element appears or the list ends. Cells above and below the viewport do not exist, so a single scan misses them.
    private func requireElementScrolling(
        in window: UIWindow, _ message: String, file: StaticString = #filePath, line: UInt = #line,
        where match: @escaping (NSObject) -> Bool
    ) async throws -> NSObject {
        let scroll = try XCTUnwrap(window.rootViewController?.view.firstView(ofType: UIScrollView.self) {
            $0.accessibilityIdentifier != "app-sidebar" && $0.bounds.height > 300
        }, "No scrolling list", file: file, line: line)
        for _ in 0..<12 {
            if await awaitCondition(timeout: 1, { HostedAccessibility.elements(in: window).contains(where: match) }),
               let found = HostedAccessibility.elements(in: window).first(where: match) {
                return found
            }
            let bottom = max(0, scroll.contentSize.height + scroll.adjustedContentInset.bottom - scroll.bounds.height)
            if scroll.contentOffset.y >= bottom - 1 { break }
            scroll.setContentOffset(CGPoint(x: 0, y: min(bottom, scroll.contentOffset.y + scroll.bounds.height * 0.8)), animated: false)
            settle(0.2)
        }
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        return try XCTUnwrap(HostedAccessibility.elements(in: window).first(where: match), "\(message); on screen:\n\(labels)", file: file, line: line)
    }

    // MARK: Detail

    func testDetailShowsEveryWindowWithPaceForecastScheduleAccountAndActions() async throws {
        let window = try hostWindow(try Self.detail(Self.pacedSource))
        var seen: [String] = []
        let checks: [(String, (NSObject) -> Bool)] = [
            ("session pace", Self.labelled(prefix: "Session, 75% remaining")),
            ("fourth window", Self.labelled(prefix: "Opus, 95% remaining")),
            ("reset schedule", { $0.accessibilityLabel?.hasPrefix("Monthly") == true && $0.accessibilityLabel?.contains("Jan 20") == true }),
            ("account label", Self.labelled(prefix: "Account, Claude Max")),
            ("plan", Self.labelled(prefix: "Plan, Max")),
            ("pin action", { $0.accessibilityLabel == "Pin to Sidebar" }),
            ("new chat action", { $0.accessibilityLabel == "New Chat with Claude" }),
            ("hide action", { $0.accessibilityLabel == "Hide from Insights" }),
        ]
        for (name, match) in checks {
            _ = try await requireElementScrolling(in: window, "No \(name)", where: match)
            seen += HostedAccessibility.labels(in: window)
        }
        let labels = seen.joined(separator: "\n")
        for expected in [
            "15% under pace", "Lasts through reset", "0.62× burn · 25%/hr budget",
            "Weekly, 30% remaining", "6% over pace", "Empty 5h early", "1.10× burn · 12%/day budget",
            // Clock times end in a narrow no-break space before AM/PM, so the expectations stop at the minutes.
            "Monthly, 90% remaining", "Resets Jan 20 at 12:00", "Session, 75% remaining, Resets Tue 3:00", "As of Tue 12:00", "Updated 12 min. ago", "Last checked",
        ] {
            XCTAssertTrue(labels.contains(expected), "Missing \(expected) in:\n\(labels)")
        }
        XCTAssertFalse(labels.contains("Stale"), labels)
        attachHostedScreenshot(window, name: "quota-detail-paced")
    }

    func testWindowsWithoutPaceShowNoPaceLine() throws {
        let windows = try Self.quotaWindowsView(Self.plainSource)
        let window = try hostWindow(List { windows })
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("60% remaining"), labels)
        XCTAssertTrue(labels.contains("Resets"), labels)
        for absent in ["burn", "pace", "Lasts through reset", "budget", "Refresh needed"] {
            XCTAssertFalse(labels.contains(absent), "\(absent) shown without a server pace:\n\(labels)")
        }
    }

    func testWindowsMarkAStaleFetch() throws {
        let windows = try Self.quotaWindowsView(Self.plainSource, referenceDate: Self.now.addingTimeInterval(3 * 3600))
        let window = try hostWindow(List { windows })
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("Stale"), labels)
        XCTAssertTrue(labels.contains("Updated 3 hr. ago"), labels)
    }

    func testDetailPinActionReflectsTheSlots() throws {
        let pinned = try hostWindow(try Self.detail(Self.plainSource, isPinned: true))
        XCTAssertTrue(HostedAccessibility.labels(in: pinned).contains("Unpin from Sidebar"))
        pinned.isHidden = true
        let full = try hostWindow(try Self.detail(Self.plainSource, isPinned: false, canPin: false))
        let pin = try XCTUnwrap(HostedAccessibility.element(in: full, label: "Pin to Sidebar"))
        XCTAssertTrue(pin.accessibilityTraits.contains(.notEnabled), "Both slots held must disable pinning")
    }

    // MARK: Screen

    /// The Insights screen against the fixture server: Quotas opens on the widget tiles and a tile pushes the account's
    /// detail; Usage holds the stat grid and the three charts.
    func testInsightsOpensOnQuotaTilesAndUsageHoldsTheAnalytics() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Insights"))

        let tileID = "provider-quota-tile-ui-fixture-source"
        _ = try await requireElement(in: window, "No quota tile") { HostedAccessibility.identifier(of: $0) == tileID }
        XCTAssertNil(HostedAccessibility.element(in: window, label: "Loading analytics…"), "Usage content must stay off the Quotas tab")
        attachHostedScreenshot(window, name: "insights-quotas-tab")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Usage"))
        var seen: [String] = []
        let checks: [(String, (NSObject) -> Bool)] = [
            ("sessions stat", Self.labelled(prefix: "Sessions, ")),
            ("total tokens stat", Self.labelled(prefix: "Total tokens, ")),
            ("cache hit stat", Self.labelled(prefix: "Cache hit rate, ")),
            ("daily chart", Self.identified("insights-daily-chart")),
            ("model share row", { $0.accessibilityLabel?.contains("fixture-model") == true && $0.accessibilityLabel?.contains("% share") == true }),
            ("weekday peak", Self.labelled(prefix: "Peak Tue · 9 sessions")),
            ("weekday chart", Self.identified("insights-weekday-chart")),
            ("hour chart", Self.identified("insights-hour-chart")),
        ]
        for (name, match) in checks {
            _ = try await requireElementScrolling(in: window, "No \(name)", where: match)
            seen += HostedAccessibility.labels(in: window)
            if name == "daily chart" { attachHostedScreenshot(window, name: "insights-usage-analytics") }
        }
        let labels = seen.joined(separator: "\n")
        for retired in ["Recent Daily Tokens", "Peak Day", "Peak Hour"] {
            XCTAssertFalse(labels.contains(retired), "\(retired) is still on screen:\n\(labels)")
        }
        XCTAssertFalse(labels.contains("Lasts through reset"), "Quota detail must stay off the Usage tab")
        attachHostedScreenshot(window, name: "insights-usage-activity")

        HostedAccessibility.activate(try await requireElement(in: window, label: "Quotas"))
        HostedAccessibility.activate(try await requireElement(in: window) { HostedAccessibility.identifier(of: $0) == tileID })
        _ = try await requireElement(in: window, "Tapping a tile did not open the detail") { $0.accessibilityLabel?.contains("Lasts through reset") == true }
        _ = try await requireElement(in: window, "No weekly forecast") { $0.accessibilityLabel?.contains("Empty 5h early") == true }
        _ = try await requireElementScrolling(in: window, "No pin action") { $0.accessibilityLabel == "Pin to Sidebar" }
        attachHostedScreenshot(window, name: "insights-quota-detail")
    }
}

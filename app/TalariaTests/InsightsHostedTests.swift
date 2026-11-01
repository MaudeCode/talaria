import SwiftUI
import XCTest
@testable import Talaria
import TalariaKit

/// The Insights overhaul (TAL-1750): every quota window with its pace and forecast, and the analytics stat grid
/// and charts the screen draws from the server series.
@MainActor
final class InsightsHostedTests: XCTestCase {
    /// Rendering clock: both fixture windows are live, their paces valid, and the fetch is twelve minutes old.
    static let now = ISO8601DateFormatter().date(from: "2030-01-01T00:12:00Z")!

    static let pacedSource = """
    {"version": 1, "scope_id": "qscope_test", "profile_id": "default", "computed_at": "2030-01-01T00:00:00Z", "sources": [{
      "source_id": "qsrc_paced", "provider_id": "anthropic", "provider_label": "Claude", "account_label": "Claude", "plan": "Max",
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
         "forecast": {"outcome": "warning", "budget_unit": "day", "budget_percent": 12, "depletion_margin_minutes": -330}}
      ]}]}
    """

    static let plainSource = """
    {"version": 1, "scope_id": "qscope_test", "profile_id": "default", "sources": [{
      "source_id": "qsrc_plain", "provider_id": "openai-codex", "provider_label": "OpenAI Codex", "account_label": "Codex",
      "supported": true, "status": "available", "fetched_at": "2030-01-01T00:00:00Z",
      "windows": [{"label": "Session", "used_percent": 40, "remaining_percent": 60, "reset_at": "2030-01-01T02:00:00Z"}]}]}
    """

    /// The bare row, for `ImageRenderer` references (which draw a `List` as a placeholder).
    static func quotaRowView(_ json: String, referenceDate: Date = now) throws -> some View {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        let response = try decoder.decode(ProviderQuotasResponse.self, from: Data(json.utf8))
        return ProviderQuotaRow(
            source: response.sources[0],
            scopeID: response.scopeID ?? "",
            displayName: response.sources[0].providerLabel,
            percentageMode: .remaining,
            isRefreshing: false,
            isPinned: false,
            canPin: true,
            referenceDate: referenceDate,
            refresh: {},
            togglePin: {},
            hide: {}
        )
    }

    static func quotaRow(_ json: String, referenceDate: Date = now) throws -> some View {
        let row = try quotaRowView(json, referenceDate: referenceDate)
        return List { row }.listStyle(.insetGrouped)
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

    func testQuotaRowShowsEveryWindowWithPaceForecastAndFreshness() throws {
        let window = try hostWindow(try Self.quotaRow(Self.pacedSource))
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        for expected in [
            "Session", "75% remaining", "15% under pace", "Lasts through reset", "0.62× burn · 25%/hr budget",
            "Weekly", "30% remaining", "6% over pace", "Empty 5h early", "1.10× burn · 12%/day budget",
            "Resets", "As of", "Updated 12 min. ago", "Max", "Active provider",
        ] {
            XCTAssertTrue(labels.contains(expected), "Missing \(expected) in:\n\(labels)")
        }
        XCTAssertFalse(labels.contains("Stale"), labels)
        XCTAssertNotNil(HostedAccessibility.elements(in: window).first { HostedAccessibility.identifier(of: $0) == "provider-quota-source-qsrc_paced" })
        attachHostedScreenshot(window, name: "quota-row-paced")
    }

    func testQuotaRowWithoutPaceShowsNoPaceLine() throws {
        let window = try hostWindow(try Self.quotaRow(Self.plainSource))
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("60% remaining"), labels)
        XCTAssertTrue(labels.contains("Resets"), labels)
        for absent in ["burn", "pace", "Lasts through reset", "budget", "Refresh needed"] {
            XCTAssertFalse(labels.contains(absent), "\(absent) shown without a server pace:\n\(labels)")
        }
    }

    func testQuotaRowMarksAStaleFetch() throws {
        let window = try hostWindow(try Self.quotaRow(Self.plainSource, referenceDate: Self.now.addingTimeInterval(3 * 3600)))
        let labels = HostedAccessibility.labels(in: window).joined(separator: "\n")
        XCTAssertTrue(labels.contains("Stale"), labels)
        XCTAssertTrue(labels.contains("Updated 3 hr. ago"), labels)
    }

    /// The Insights screen against the fixture server: the quota pace lines, the stat grid, and the three charts
    /// replace the old text rows.
    func testInsightsScreenRendersQuotaDetailStatGridAndCharts() async throws {
        let fixture = try FixtureApp(for: self)
        let window = try hostWindow(fixture.sessionList())
        try await openSidebar(in: window)
        HostedAccessibility.activate(try await requireElement(in: window, label: "Insights"))

        _ = try await requireElement(in: window, "No quota forecast") { $0.accessibilityLabel?.contains("Lasts through reset") == true }
        _ = try await requireElement(in: window, "No weekly forecast") { $0.accessibilityLabel?.contains("Empty 5h early") == true }
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
            if name == "daily chart" { attachHostedScreenshot(window, name: "insights-phone-analytics") }
        }
        let labels = seen.joined(separator: "\n")
        for retired in ["Recent Daily Tokens", "Peak Day", "Peak Hour"] {
            XCTAssertFalse(labels.contains(retired), "\(retired) is still on screen:\n\(labels)")
        }
        attachHostedScreenshot(window, name: "insights-phone-activity")
    }
}

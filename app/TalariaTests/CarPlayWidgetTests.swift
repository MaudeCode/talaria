import SwiftUI
import WidgetKit
import XCTest
@testable import Talaria
@testable import TalariaKit

/// TAL-2230: CarPlay, and the HomeView it feeds, show small widgets from a locked iPhone. The widgets that only open
/// the app stay off them; the quota and Needs you widgets stay on, read their data while locked, and render legibly
/// once the system removes their background.
@MainActor
final class CarPlayWidgetTests: XCTestCase {
    /// WidgetKit keeps a configuration's descriptor private, so each Home Screen widget routes its CarPlay placement
    /// through `lockedIPhoneUse(_:)` and declares the use this table checks.
    func testWidgetsThatOnlyOpenTheAppStayOffCarPlay() throws {
        guard #available(iOS 26, *) else { throw XCTSkip("CarPlay widgets start in iOS 26.") }
        let homeScreenWidgets: [(name: String, use: LockedIPhoneUse, opensAppOnly: Bool)] = [
            ("NewChatWidget", NewChatWidget.lockedIPhoneUse, true),
            ("ProviderQuotaWidget", ProviderQuotaWidget.lockedIPhoneUse, false),
            ("NeedsYouWidget", NeedsYouWidget.lockedIPhoneUse, false),
        ]
        for widget in homeScreenWidgets {
            XCTAssertEqual(
                widget.use.disfavoredLocations.contains(.carPlay), widget.opensAppOnly,
                "\(widget.name) must \(widget.opensAppOnly ? "stay off" : "stay on") CarPlay"
            )
        }
    }

    /// The App writes the waiting chats to the App Group suite, which the widget reads while the iPhone stays locked,
    /// as the quota widget does.
    func testNeedsYouReadsTheAppGroupSuiteLikeTheQuotaWidget() throws {
        let defaults = ProviderQuotaWidgetSnapshotStore.appGroupDefaults
        let key = NeedsYouSnapshotStore.storageKey
        let previous = defaults.object(forKey: key)
        defer { defaults.set(previous, forKey: key) }
        let snapshot = NeedsYouSnapshot(updatedAt: Date(timeIntervalSince1970: 1_800_000_000), rows: [], waitingCount: 4)

        defaults.set(try JSONEncoder().encode(snapshot), forKey: key)

        XCTAssertEqual(NeedsYouSnapshotStore().load(), snapshot)
    }

    // MARK: Visual references

    /// `ImageRenderer` draws no container background, as CarPlay and HomeView remove it; the padding stands in for
    /// the widget's content margins.
    func testSmallWidgetsWithoutTheirBackgroundReferences() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let needsYou = NeedsYouWidgetView(
            snapshot: NeedsYouSnapshot(updatedAt: now.addingTimeInterval(-60), rows: [
                .init(sessionID: "s-0", title: "Deploy fix", phase: "waiting_for_approval", serverID: "https://example.test"),
                .init(sessionID: "s-1", title: "Release notes", phase: "waiting_for_input", serverID: "https://example.test"),
            ], waitingCount: 2),
            date: now, family: .systemSmall
        )
        // `widgetFamily` cannot be set outside WidgetKit, so this renders the cell the small quota widget shows.
        let quota = ProviderQuotaWidgetSourceView(
            source: ProviderQuotaWidgetSource(
                sourceID: "qsrc_work", providerID: "openai-codex", providerLabel: "Codex", accountLabel: "Work",
                isActiveProvider: true, status: "available", plan: "Pro",
                windows: [ProviderQuotaWindow(label: "Weekly", usedPercent: 38, remainingPercent: 62)],
                retryAfter: nil, fetchedAt: nil
            ),
            configuration: ProviderQuotaWidgetConfigurationIntent(), compact: false, referenceDate: now, windowOverride: nil
        )
        for scheme in [ColorScheme.light, .dark] {
            for mode in [WidgetRenderingMode.fullColor, .accented] {
                let suffix = "\(mode == .accented ? "accented" : "full-color")-\(scheme == .dark ? "dark" : "light")"
                try VisualReference.assertMatchesReference(
                    needsYou.padding().environment(\.widgetRenderingMode, mode),
                    named: "needs-you-small-\(suffix)", size: CGSize(width: 170, height: 170), colorScheme: scheme
                )
                try VisualReference.assertMatchesReference(
                    quota.padding().environment(\.widgetRenderingMode, mode),
                    named: "quota-small-\(suffix)", size: CGSize(width: 170, height: 170), colorScheme: scheme
                )
            }
        }
    }
}

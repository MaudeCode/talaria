import SwiftUI
import TalariaKit
import UIKit

/// The installed release's What's New (TAL-182): its authored rows in their order, under one heading, with one
/// Continue. Closing it any way, Continue or a swipe, acknowledges it; launch and Settings > About both present it.
struct WhatsNewSheet: View {
    static let title = String(localized: "What's New in Talaria")

    let announcement: WhatsNewAnnouncement
    var defaults: UserDefaults = .standard
    @Environment(\.dismiss) private var dismiss
    @AppStorage(HeaderLogoColor.storageKey) private var accentHex = HeaderLogoColor.defaultHex

    var body: some View {
        let accent = HeaderLogoColor.color(for: accentHex)
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                Text(Self.title)
                    .font(.largeTitle.bold())
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .accessibilityAddTraits(.isHeader)

                VStack(alignment: .leading, spacing: 24) {
                    ForEach(announcement.rows) { row in
                        OnboardingFeatureRow(
                            icon: Self.symbol(for: row.icon),
                            color: accent,
                            title: row.title,
                            subtitle: row.description,
                            style: .announcement
                        )
                    }
                }
            }
            .padding(.horizontal, 28)
            .padding(.top, 48)
            .padding(.bottom, 24)
            .onboardingReadableWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
        .safeAreaInset(edge: .bottom) {
            Button { dismiss() } label: {
                Text("Continue")
                    .font(AppFont.body(weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(accent)
            .foregroundStyle(HeaderLogoColor.prefersDarkForeground(for: accentHex) ? Color.black : Color.white)
            .accessibilityIdentifier("whats-new-continue")
            .padding(.horizontal, 28)
            .padding(.vertical, 16)
            .onboardingReadableWidth()
            .background(Color(.systemBackground))
        }
        .background(Color(.systemBackground))
        .onDisappear { announcement.acknowledge(defaults: defaults) }
    }

    /// The symbol for a contract icon key (`contracts/whats-new.schema.json`); a key this build does not know yet
    /// keeps the row with the generic one.
    static func symbol(for icon: String) -> String {
        switch icon {
        case "chat": "bubble.left.and.bubble.right.fill"
        case "voice": "mic.fill"
        case "attachment": "paperclip"
        case "search": "magnifyingglass"
        case "notifications": "bell.badge.fill"
        case "automation": "gearshape.2.fill"
        case "model": "cpu.fill"
        case "appearance": "paintbrush.fill"
        case "speed": "bolt.fill"
        case "reliability": "checkmark.seal.fill"
        case "security": "lock.shield.fill"
        case "sync": "arrow.triangle.2.circlepath"
        case "share": "square.and.arrow.up.fill"
        case "settings": "slider.horizontal.3"
        case "accessibility": "accessibility"
        default: "sparkles"
        }
    }
}

extension View {
    /// Presents `announcement` in the What's New sheet while it is set.
    func whatsNewPresentation(_ announcement: Binding<WhatsNewAnnouncement?>, defaults: UserDefaults = .standard) -> some View {
        sheet(item: announcement) { announcement in
            WhatsNewSheet(announcement: announcement, defaults: defaults)
                .adaptiveFormPresentation()
        }
    }
}

/// Holds the launch's pending What's New until the app is idle, then presents it once (TAL-182). Acknowledgement
/// happens only when the sheet closes, so a launch that never shows or closes it offers it again next time.
@MainActor
@Observable
final class WhatsNewPresenter {
    var presented: WhatsNewAnnouncement?
    @ObservationIgnored private var pending: WhatsNewAnnouncement?
    @ObservationIgnored let defaults: UserDefaults

    init(pending: WhatsNewAnnouncement?, defaults: UserDefaults = .standard) {
        self.pending = pending
        self.defaults = defaults
    }

    /// Presents the pending announcement once no window is presenting a sheet, alert or sign-in of its own. The
    /// caller starts this only while its own startup work is settled, and cancels it when that changes.
    // ponytail: polls once a second; SwiftUI and UIKit post nothing when another presentation closes.
    func offerWhenNothingIsPresented(interval: Duration = .seconds(1)) async {
        while pending != nil {
            try? await Task.sleep(for: interval)
            guard !Task.isCancelled else { return }
            // A Settings replay can acknowledge it while it waits behind Settings.
            if pending?.isAcknowledged(defaults: defaults) == true {
                pending = nil
            } else if Self.nothingIsPresented() {
                presented = pending
                pending = nil
            }
        }
    }

    static func nothingIsPresented() -> Bool {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .allSatisfy { $0.isHidden || $0.rootViewController?.presentedViewController == nil }
    }
}

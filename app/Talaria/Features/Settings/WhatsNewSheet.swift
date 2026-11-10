import SwiftUI
import TalariaKit
import UIKit

/// The installed release's What's New (TAL-182): its authored rows in their order, under one heading, with one
/// Continue. More than four rows turn into pages of four with dots and arrows, where Continue turns the page and a skip
/// line closes the sheet (TAL-2173). Closing it any way, Continue, the skip line or a swipe, acknowledges every row in
/// it, shown or not (TAL-1980); launch presents the unseen rows and Settings > About replays every packaged row.
struct WhatsNewSheet: View {
    static let title = String(localized: "What's New in Talaria")
    /// Layout, not a decision about which rows show: every row shows, this many to a page.
    static let rowsPerPage = 4

    let announcement: WhatsNewAnnouncement
    var defaults: UserDefaults = .standard
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @AppStorage(HeaderLogoColor.storageKey) private var accentHex = HeaderLogoColor.defaultHex
    @State private var page = 0

    /// `rows` in consecutive pages of `rowsPerPage`, in their order.
    static func pages(of rows: [WhatsNewAnnouncement.Row]) -> [[WhatsNewAnnouncement.Row]] {
        stride(from: 0, to: rows.count, by: rowsPerPage).map { Array(rows[$0..<min($0 + rowsPerPage, rows.count)]) }
    }

    var body: some View {
        let accent = HeaderLogoColor.color(for: accentHex)
        let pages = Self.pages(of: announcement.rows)
        Group {
            if pages.count > 1 {
                // The heading stays put while the rows turn. At accessibility sizes it scrolls away with each page
                // instead, so the rows keep room to read.
                let pinsHeading = !typeSize.isAccessibilitySize
                VStack(spacing: 0) {
                    if pinsHeading {
                        heading
                            .padding(.horizontal, 28)
                            .padding(.top, 48)
                            .padding(.bottom, 36)
                            .onboardingReadableWidth()
                    }
                    // The construction onboarding pages with, so a swipe turns the page too.
                    TabView(selection: $page) {
                        ForEach(pages.indices, id: \.self) { index in
                            rowsPage(pages[index], accent: accent, showsHeading: !pinsHeading).tag(index)
                        }
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))
                }
            } else {
                rowsPage(announcement.rows, accent: accent, showsHeading: true)
            }
        }
        .safeAreaInset(edge: .bottom) { controls(pageCount: pages.count, accent: accent) }
        .background(Color(.systemBackground))
        .onDisappear { announcement.acknowledge(defaults: defaults) }
    }

    private var heading: some View {
        Text(Self.title)
            .font(.largeTitle.bold())
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .accessibilityAddTraits(.isHeader)
    }

    /// `rows`, under the heading when it scrolls with them, scrolling on their own so a page at the largest text size
    /// still reads in full.
    private func rowsPage(_ rows: [WhatsNewAnnouncement.Row], accent: Color, showsHeading: Bool) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 36) {
                if showsHeading { heading }

                VStack(alignment: .leading, spacing: 24) {
                    ForEach(rows) { row in
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
            .padding(.top, showsHeading ? 48 : 0)
            .padding(.bottom, 24)
            .onboardingReadableWidth()
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    private func controls(pageCount: Int, accent: Color) -> some View {
        let isPaged = pageCount > 1
        let isLastPage = page >= pageCount - 1
        // The 44pt arrows and skip line carry their own space, so the paged controls add no more around them.
        return VStack(spacing: 0) {
            if isPaged {
                HStack(spacing: 12) {
                    pageArrow("chevron.left", label: "Previous page", to: page - 1, accent: accent)
                        .disabled(page == 0)
                    OnboardingPageIndicator(pageCount: pageCount, currentPage: page,
                                            color: accent, otherColor: Color(.tertiaryLabel))
                    pageArrow("chevron.right", label: "Next page", to: page + 1, accent: accent)
                        .disabled(isLastPage)
                }
            }

            Button { isLastPage ? dismiss() : turn(to: page + 1) } label: {
                Text("Continue")
                    .font(AppFont.body(weight: .semibold))
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .tint(accent)
            .foregroundStyle(HeaderLogoColor.prefersDarkForeground(for: accentHex) ? Color.black : Color.white)
            .accessibilityIdentifier("whats-new-continue")

            if !isLastPage {
                Button { dismiss() } label: {
                    Text("Skip, I like surprises")
                        .frame(minHeight: 44)
                        // A backing view makes the 44pt frame the accessibility hit area.
                        .background(Color(.systemBackground))
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .buttonStyle(.plain)
                .accessibilityIdentifier("whats-new-skip")
            } else if isPaged {
                // Its slot stays, so Continue does not move under the thumb on the last page.
                Color.clear.frame(height: 44)
            }
        }
        .padding(.horizontal, 28)
        .padding(.vertical, isPaged ? 0 : 16)
        .onboardingReadableWidth()
        .background(Color(.systemBackground))
    }

    private func pageArrow(_ symbol: String, label: LocalizedStringKey, to target: Int, accent: Color) -> some View {
        Button { turn(to: target) } label: {
            Image(systemName: symbol)
                .font(.body.weight(.semibold))
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .tint(accent)
        .accessibilityLabel(label)
    }

    /// Turns to `target` with a swipe's slide, or at once under Reduce Motion.
    private func turn(to target: Int) {
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) { page = target }
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

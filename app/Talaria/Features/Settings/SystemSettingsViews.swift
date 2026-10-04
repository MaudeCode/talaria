import SwiftData
import SwiftUI
import UIKit
import TalariaKit

struct LiveActivitiesWidgetsSettingsView: View {
    @AppStorage(AgentRunLiveActivityPrivacy.showsResponseExcerptsKey)
    private var showsLiveActivityResponseExcerpts = false

    var body: some View {
        SettingsCategoryPage(category: .liveActivitiesAndWidgets) {
            RelayLiveActivitySettingsCard()

            SettingsCard(title: String(localized: "Privacy")) {
                SettingsToggleRow(
                    title: String(localized: "Live Activity Excerpts"),
                    systemImage: "lock",
                    isOn: $showsLiveActivityResponseExcerpts
                )

                SettingsFootnote(String(localized: "Shows short response text on the Lock Screen and Dynamic Island."))
            }

            SettingsCard(title: String(localized: "Widgets")) {
                NavigationLink {
                    ProviderQuotaWidgetAppearanceView()
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Provider Quotas"),
                        systemImage: "gauge.open.with.lines.needle.33percent"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens provider quota widget appearance settings.")
            }
        }
    }
}

struct SiriShortcutsSettingsView: View {
    var body: some View {
        SettingsCategoryPage(category: .siriAndShortcuts) {
            SettingsCard(title: String(localized: "Siri & Shortcuts")) {
                if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                    Link(destination: settingsURL) {
                        SettingsAccessoryRow(
                            title: String(localized: "Open Talaria Settings"),
                            systemImage: "gearshape",
                            accessorySystemImage: "arrow.up.forward"
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open Talaria Settings")
                }

                // swiftlint:disable:next line_length
                SettingsFootnote(String(localized: "Run Talaria actions like New Chat from Siri, Spotlight, the Lock Screen, or the iPhone Action button. Open Talaria Settings to manage its Siri & Search options. To assign an action to the Action button, open the iOS Settings app, choose Action Button, then Shortcut, and pick a Talaria action."))
            }
        }
    }
}

struct DataStorageSettingsView: View {
    let server: URL

    @State private var isConfirmingClearCache = false
    @State private var isClearingCache = false
    @State private var cacheStatusMessage: String?
    @Environment(\.modelContext) private var modelContext

    var body: some View {
        SettingsCategoryPage(category: .dataAndStorage) {
            SettingsCard(title: String(localized: "Offline Data")) {
                // swiftlint:disable:next line_length
                SettingsFootnote(cacheStatusMessage ?? String(localized: "Cached sessions and messages are kept for offline viewing. Clearing removes this server's cache only — other servers and the Hermes server are not affected."))

                SettingsButton(String(localized: "Clear Offline Cache"), role: .destructive, isLoading: isClearingCache) {
                    isConfirmingClearCache = true
                }
                .disabled(isClearingCache)
            }
        }
        .alert("Clear this server's cache?", isPresented: $isConfirmingClearCache) {
            Button("Cancel", role: .cancel) {}
            Button("Clear Cache", role: .destructive) {
                Task { await clearOfflineCache() }
            }
        } message: {
            Text("This server's cached sessions and messages will be deleted. Other servers and online server data are not affected.")
        }
    }

    @MainActor
    private func clearOfflineCache() async {
        guard !isClearingCache else { return }
        isClearingCache = true
        do {
            try CacheStore.clearCache(for: server, in: modelContext)
            cacheStatusMessage = String(localized: "This server's offline cache was cleared.")
        } catch {
            cacheStatusMessage = String(localized: "Could not clear offline cache.")
        }
        isClearingCache = false
    }
}

struct AboutSettingsView: View {
    var body: some View {
        SettingsCategoryPage(category: .about) {
            SettingsCard(title: String(localized: "App")) {
                SettingsInfoRow(title: String(localized: "Version"), value: appVersion)
                SettingsInfoRow(title: String(localized: "Build"), value: appBuild)

                SettingsDivider()

                Link(destination: AppConfig.privacyPolicyURL) {
                    SettingsAccessoryRow(
                        title: String(localized: "Privacy Policy"),
                        systemImage: "hand.raised",
                        accessorySystemImage: "arrow.up.forward"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Privacy Policy")

                SettingsDivider()

                Link(destination: AppConfig.supportURL) {
                    SettingsAccessoryRow(
                        title: String(localized: "Support"),
                        systemImage: "questionmark.circle",
                        accessorySystemImage: "arrow.up.forward"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Support")

                SettingsDivider()

                NavigationLink {
                    AcknowledgementsView()
                } label: {
                    SettingsAccessoryRow(title: String(localized: "Acknowledgements"), systemImage: "doc.text")
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the copyright and license notices for the open-source software in Talaria.")
            }
        }
    }

    private var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? String(localized: "Unknown")
    }

    private var appBuild: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? String(localized: "Unknown")
    }
}

/// TAL-57: the bundled `ThirdPartyNotices` listed by its `Acknowledgements.json`, readable offline.
struct AcknowledgementsView: View {
    static let directory = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: nil)
    private static let acknowledgements = directory.flatMap { try? Acknowledgement.load(from: $0) } ?? []

    var body: some View {
        SettingsPage(title: String(localized: "Acknowledgements")) {
            SettingsCard(title: String(localized: "Open Source")) {
                ForEach(Array(Self.acknowledgements.enumerated()), id: \.element.id) { index, acknowledgement in
                    if index > 0 {
                        SettingsDivider()
                    }

                    NavigationLink {
                        AcknowledgementDetailView(acknowledgement: acknowledgement)
                    } label: {
                        SettingsAccessoryRow(
                            title: acknowledgement.name,
                            value: acknowledgement.version,
                            systemImage: "doc.text"
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this component's copyright and license notice.")
                }
            }
        }
    }
}

private struct AcknowledgementDetailView: View {
    let acknowledgement: Acknowledgement

    var body: some View {
        SettingsPage(title: acknowledgement.name) {
            SettingsCard(title: String(localized: "License")) {
                Text(verbatim: notice)
                    .font(AppFont.footnote())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    private var notice: String {
        AcknowledgementsView.directory.flatMap { try? acknowledgement.notice(in: $0) } ?? ""
    }
}

#if DEBUG
struct DeveloperSettingsView: View {
    var body: some View {
        SettingsCategoryPage(category: .developer) {
            SettingsCard(title: String(localized: "Developer")) {
                NavigationLink {
                    StreamingLabView()
                } label: {
                    SettingsAccessoryRow(title: String(localized: "Streaming Lab"), systemImage: "waveform.path.ecg")
                }
                .buttonStyle(.plain)

                SettingsFootnote(String(localized: "Debug builds only. Replay a canned reply and tune the streamed-text fade feel live."))
            }
        }
    }
}
#endif

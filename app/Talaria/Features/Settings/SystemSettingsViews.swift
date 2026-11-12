import SwiftData
import SwiftUI
import UIKit
import TalariaKit

struct LiveActivitiesWidgetsSettingsView: View {
    var body: some View {
        SettingsCategoryPage(category: .liveActivitiesAndWidgets) {
            RelayLiveActivitySettingsSection()

            SettingsSection(title: String(localized: "Widgets")) {
                NavigationLink(value: SettingsPane.providerQuotaWidget) {
                    SettingsAccessoryRow(
                        title: SettingsIndex.liveActivitiesAndWidgetsProviderQuotas.title,
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
            SettingsSection(
                title: String(localized: "Siri & Shortcuts"),
                help: String(localized: """
                Run Talaria actions like New Chat from Siri, Spotlight, the Lock Screen, or the iPhone Action \
                button. Open Talaria Settings to manage its Siri & Search options. To assign an action to the Action \
                button, open the iOS Settings app, choose Action Button, then Shortcut, and pick a Talaria action.
                """)
            ) {
                if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
                    Link(destination: settingsURL) {
                        SettingsAccessoryRow(
                            title: SettingsIndex.siriAndShortcutsOpenTalariaSettings.title,
                            systemImage: "gearshape",
                            accessorySystemImage: "arrow.up.forward"
                        )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(SettingsIndex.siriAndShortcutsOpenTalariaSettings.title)
                }
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
            SettingsSection(
                title: String(localized: "Offline Data"),
                help: String(localized: """
                Cached sessions and messages are kept for offline viewing. Clearing removes this server's cache only \
                — other servers and the Hermes server are not affected.
                """)
            ) {
                if let cacheStatusMessage {
                    SettingsFootnote(cacheStatusMessage)
                }

                SettingsButton(SettingsIndex.dataAndStorageClearOfflineCache.title, role: .destructive, isLoading: isClearingCache) {
                    isConfirmingClearCache = true
                }
                .disabled(isClearingCache)
            }

            AppLockSettingsSection()
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

private struct AppLockSettingsSection: View {
    @State private var lock = AppLockModel.shared
    @State private var needsPasscode = false

    var body: some View {
        let method = lock.method
        SettingsSection(title: SettingsIndex.dataAndStorageAppLock.title) {
            SettingsToggleRow(
                title: SettingsIndex.dataAndStorageAppLock.title,
                systemImage: method.systemImage,
                isOn: Binding(get: { lock.switchPosition }, set: { enabled in
                    Task { needsPasscode = await lock.setEnabled(enabled) == .unavailable && enabled }
                })
            )
            .accessibilityIdentifier("settings-app-lock")
            .accessibilityHint(method.settingsTitle)

            if needsPasscode {
                SettingsErrorFootnote(SettingsErrorText(String(localized: "Set a device passcode to use this.")))
            }
        }
    }
}

struct AboutSettingsView: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    @State private var feedback: FeedbackComposer
    @State private var replayedWhatsNew: WhatsNewAnnouncement?
    /// This build's What's New, replayable here whether or not launch already offered it (TAL-182).
    private let whatsNew: WhatsNewAnnouncement?
    private let defaults: UserDefaults

    init(server: URL? = nil, feedback: FeedbackComposer? = nil,
         whatsNew: WhatsNewAnnouncement? = .installed(), defaults: UserDefaults = .standard) {
        _feedback = State(initialValue: feedback ?? FeedbackComposer(server: server, clientMetadata: .current))
        self.whatsNew = whatsNew
        self.defaults = defaults
    }

    var body: some View {
        SettingsCategoryPage(category: .about) {
            SettingsSection(title: String(localized: "App")) {
                SettingsInfoRow(title: SettingsIndex.aboutVersion.title, value: appVersion)
                SettingsInfoRow(title: SettingsIndex.aboutBuild.title, value: appBuild)

                if whatsNew != nil || scrollAnchor == .setting(.aboutWhatsNew) {
                    Button { replayedWhatsNew = whatsNew } label: {
                            SettingsAccessoryRow(title: SettingsIndex.aboutWhatsNew.title, systemImage: "sparkles")
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("settings-whats-new")
                        .disabled(whatsNew == nil)
                }

                Button { feedback.isPresented = true } label: {
                    SettingsAccessoryRow(title: FeedbackSheet.title, systemImage: FeedbackSheet.systemImage)
                }
                .buttonStyle(.plain)
                .disabled(feedback.server == nil || feedback.isSending)
                .accessibilityIdentifier("settings-send-feedback")

                Link(destination: AppConfig.privacyPolicyURL) {
                    SettingsAccessoryRow(
                        title: SettingsIndex.aboutPrivacyPolicy.title,
                        systemImage: "hand.raised",
                        accessorySystemImage: "arrow.up.forward"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(SettingsIndex.aboutPrivacyPolicy.title)

                Link(destination: AppConfig.supportURL) {
                    SettingsAccessoryRow(
                        title: SettingsIndex.aboutSupport.title,
                        systemImage: "questionmark.circle",
                        accessorySystemImage: "arrow.up.forward"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(SettingsIndex.aboutSupport.title)

                NavigationLink {
                    AcknowledgementsView()
                } label: {
                    SettingsAccessoryRow(title: SettingsIndex.aboutAcknowledgements.title, systemImage: "doc.text")
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens the copyright and license notices for the open-source software in Talaria.")
            }
        }
        .feedbackPresentation(feedback)
        .whatsNewPresentation($replayedWhatsNew, defaults: defaults)
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
        SettingsPage(title: SettingsIndex.aboutAcknowledgements.title) {
            SettingsSection(title: String(localized: "Open Source")) {
                ForEach(Self.acknowledgements) { acknowledgement in

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
            SettingsSection(title: String(localized: "License")) {
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
            SettingsSection(
                title: String(localized: "Developer"),
                help: String(localized: "Debug builds only. Replay a canned reply and tune the streamed-text fade feel live.")
            ) {
                NavigationLink {
                    StreamingLabView()
                } label: {
                    SettingsAccessoryRow(title: SettingsIndex.developerStreamingLab.title, systemImage: "waveform.path.ecg")
                }
                .buttonStyle(.plain)

            }
        }
    }
}
#endif

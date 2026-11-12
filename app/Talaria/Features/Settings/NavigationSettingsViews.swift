import SwiftUI
import TalariaKit

struct NavigationSettingsView: View {
    @AppStorage(SessionRowDisplaySettings.showCronSessionsKey) private var showsCronSessions = true
    @AppStorage(SessionRowDisplaySettings.showWebhookSessionsKey)
    private var showsWebhookSessions = SessionRowDisplaySettings.showsWebhookSessions()
    @AppStorage private var showsCliSessions: Bool
    @AppStorage private var showsClaudeCodeSessions: Bool
    @AppStorage(SessionRowDisplaySettings.showSubagentSessionsKey)
    private var showsSubagentSessions = SessionRowDisplaySettings.defaultShowsSubagentSessions

    init(server: URL) {
        _showsCliSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsCliSessions(for: server),
            SessionRowDisplaySettings.showCliSessionsKey(for: server)
        )
        _showsClaudeCodeSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsClaudeCodeSessions(for: server),
            SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: server)
        )
    }

    @AppStorage(SectionVisibilitySettings.sidebarFeedbackKey)
    private var showsSidebarFeedbackButton = SectionVisibilitySettings
        .defaultShowsSidebarFeedbackButton
    @AppStorage(SectionVisibilitySettings.tasksKey) private var showsTasks = true
    @AppStorage(SectionVisibilitySettings.kanbanKey) private var showsKanban = true
    @AppStorage(SectionVisibilitySettings.skillsKey) private var showsSkills = true
    @AppStorage(SectionVisibilitySettings.memoryKey) private var showsMemory = true
    @AppStorage(SectionVisibilitySettings.insightsKey) private var showsInsights = true

    var body: some View {
        SettingsCategoryPage(category: .navigation) {
            ProviderQuotaDisplaySettingsSection()
            SettingsSection(title: String(localized: "Sidebar sections")) {
                SettingsToggleRow(
                    title: SettingsIndex.navigationTasks.title, systemImage: "checklist", isOn: $showsTasks
                )
                .accessibilityIdentifier("settings-navigation-section-tasks")
                SettingsToggleRow(
                    title: SettingsIndex.navigationKanban.title, systemImage: "rectangle.split.3x1", isOn: $showsKanban
                )
                .accessibilityIdentifier("settings-navigation-section-kanban")
                SettingsToggleRow(
                    title: SettingsIndex.navigationSkills.title, systemImage: "sparkles", isOn: $showsSkills
                )
                .accessibilityIdentifier("settings-navigation-section-skills")
                SettingsToggleRow(
                    title: SettingsIndex.navigationMemory.title, systemImage: "brain", isOn: $showsMemory
                )
                .accessibilityIdentifier("settings-navigation-section-memory")
                SettingsToggleRow(
                    title: SettingsIndex.navigationInsights.title, systemImage: "chart.bar", isOn: $showsInsights
                )
                .accessibilityIdentifier("settings-navigation-section-insights")
                SettingsToggleRow(
                    title: SettingsIndex.navigationFeedbackButton.title, systemImage: FeedbackSheet.systemImage,
                    isOn: $showsSidebarFeedbackButton
                )
                .accessibilityIdentifier("settings-sidebar-feedback-toggle")
            }

            SettingsSection(title: String(localized: "Included Chats")) {
                SettingsToggleRow(
                    title: SettingsIndex.navigationCronSessions.title,
                    systemImage: "clock.arrow.2.circlepath",
                    isOn: $showsCronSessions
                )

                SettingsToggleRow(
                    title: SettingsIndex.navigationWebhookSessions.title,
                    systemImage: "bolt.horizontal.circle",
                    isOn: $showsWebhookSessions
                )

                SettingsToggleRow(
                    title: SettingsIndex.navigationCLISessions.title,
                    systemImage: "terminal",
                    isOn: $showsCliSessions
                )

                SettingsToggleRow(
                    title: SettingsIndex.navigationClaudeCodeSessions.title,
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    isOn: $showsClaudeCodeSessions
                )
                .disabled(!showsCliSessions)

                SettingsToggleRow(
                    title: SettingsIndex.navigationSubagentSessions.title,
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsSubagentSessions
                )
            }

            SettingsSection(title: String(localized: "Quotas")) {
                NavigationLink {
                    ProviderQuotaSidebarDisplayView()
                } label: {
                    SettingsAccessoryRow(
                        title: SettingsIndex.navigationSidebarQuotas.title, systemImage: "sidebar.left")
                }
                .buttonStyle(.plain)
            }
        }
    }
}

struct SpeechSettingsView: View {
    @AppStorage(ComposerSTTProviderPreference.storageKey) private var sttProviderPreferenceRawValue =
        ComposerSTTProviderPreference.defaultValue.rawValue

    var body: some View {
        SettingsCategoryPage(category: .speech) {
            SettingsSection(
                title: String(localized: "Speech"),
                help: String(localized: "On-device only keeps composer dictation audio off your Hermes server.")
            ) {
                SettingsPickerRow(
                    title: SettingsIndex.speechDictationProvider.title,
                    systemImage: "mic",
                    selection: $sttProviderPreferenceRawValue
                ) {
                    ForEach(ComposerSTTProviderPreference.allCases) { preference in
                        Text(preference.title).tag(preference.rawValue)
                    }
                }
            }
        }
    }
}

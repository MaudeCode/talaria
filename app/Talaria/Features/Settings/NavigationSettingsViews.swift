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
            SettingsSection(title: String(localized: "Sidebar sections")) {
                SettingsToggleRow(
                    title: String(localized: "Tasks"), systemImage: "checklist", isOn: $showsTasks
                )
                .accessibilityIdentifier("settings-navigation-section-tasks")
                SettingsToggleRow(
                    title: String(localized: "Kanban"), systemImage: "rectangle.split.3x1", isOn: $showsKanban
                )
                .accessibilityIdentifier("settings-navigation-section-kanban")
                SettingsToggleRow(
                    title: String(localized: "Skills"), systemImage: "sparkles", isOn: $showsSkills
                )
                .accessibilityIdentifier("settings-navigation-section-skills")
                SettingsToggleRow(
                    title: String(localized: "Memory"), systemImage: "brain", isOn: $showsMemory
                )
                .accessibilityIdentifier("settings-navigation-section-memory")
                SettingsToggleRow(
                    title: String(localized: "Insights"), systemImage: "chart.bar", isOn: $showsInsights
                )
                .accessibilityIdentifier("settings-navigation-section-insights")
                SettingsToggleRow(
                    title: String(localized: "Feedback Button"), systemImage: FeedbackSheet.systemImage,
                    isOn: $showsSidebarFeedbackButton
                )
                .accessibilityIdentifier("settings-sidebar-feedback-toggle")
            }

            SettingsSection(title: String(localized: "Included Chats")) {
                SettingsToggleRow(
                    title: String(localized: "Cron Sessions"),
                    systemImage: "clock.arrow.2.circlepath",
                    isOn: $showsCronSessions
                )

                SettingsToggleRow(
                    title: String(localized: "Webhook Sessions"),
                    systemImage: "bolt.horizontal.circle",
                    isOn: $showsWebhookSessions
                )

                SettingsToggleRow(
                    title: String(localized: "CLI Sessions"),
                    systemImage: "terminal",
                    isOn: $showsCliSessions
                )

                SettingsToggleRow(
                    title: String(localized: "Claude Code Sessions"),
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    isOn: $showsClaudeCodeSessions
                )
                .disabled(!showsCliSessions)

                SettingsToggleRow(
                    title: String(localized: "Subagent Sessions"),
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsSubagentSessions
                )
            }

            SettingsSection(title: String(localized: "Quotas")) {
                NavigationLink {
                    ProviderQuotaSidebarDisplayView()
                } label: {
                    SettingsAccessoryRow(
                        title: String(localized: "Sidebar Quotas"), systemImage: "sidebar.left")
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
            SettingsSection(title: String(localized: "Speech")) {
                SettingsPickerRow(
                    title: String(localized: "Dictation Provider"),
                    systemImage: "mic",
                    selection: $sttProviderPreferenceRawValue
                ) {
                    ForEach(ComposerSTTProviderPreference.allCases) { preference in
                        Text(preference.title).tag(preference.rawValue)
                    }
                }

                SettingsFootnote(
                    String(localized: "On-device only keeps composer dictation audio off your Hermes server.")
                )

            }
        }
    }
}

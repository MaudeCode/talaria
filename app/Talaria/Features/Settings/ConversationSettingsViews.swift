import SwiftUI
import TalariaKit

struct ChatsSettingsView: View {
    @Bindable var authManager: AuthManager
    let server: URL

    @AppStorage(StreamingSendBehavior.storageKey) private var streamingSendBehaviorRawValue = StreamingSendBehavior.steer.rawValue
    @AppStorage(ComposerSTTProviderPreference.storageKey) private var sttProviderPreferenceRawValue = ComposerSTTProviderPreference.defaultValue.rawValue
    @AppStorage(ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey) private var showsThinkingAndToolCards = true
    @AppStorage(ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey) private var thinkingCardsStartExpanded = false
    @AppStorage(ChatTranscriptDisplaySettings.toolCardsStartExpandedKey) private var toolCardsStartExpanded = false
    @AppStorage(ChatTranscriptDisplaySettings.hidesAttachmentPathsKey) private var hidesAttachmentPaths = true
    @AppStorage(ChatTranscriptDisplaySettings.showsAssistantTurnTimestampsKey) private var showsAssistantTurnTimestamps = false
    @AppStorage(ChatTranscriptDisplaySettings.showsResponseSpeedKey) private var showsResponseSpeed = false
    @AppStorage(ChatTranscriptDisplaySettings.wrapsCodeBlockLinesKey) private var wrapsCodeBlockLines = false
    @AppStorage(ChatTranscriptDisplaySettings.rtlChatLayoutEnabledKey)
    private var rtlChatLayoutEnabled = ChatTranscriptDisplaySettings.rtlChatLayoutDefaultEnabled
    @AppStorage(ChatScrollToBottomButtonSide.storageKey)
    private var scrollToBottomButtonSideRawValue = ChatScrollToBottomButtonSide.right.rawValue
    @AppStorage(StreamedTextAnimationSettings.isEnabledKey) private var isStreamedTextAnimationEnabled = true
    @AppStorage(SectionVisibilitySettings.chatFilesKey) private var showsChatFilesButton = true
    @AppStorage(SectionVisibilitySettings.chatGitKey) private var showsChatGitControls = true
    @AppStorage(SectionVisibilitySettings.activeProfileKey) private var showsActiveProfileSection = true
    @AppStorage(SectionVisibilitySettings.projectsKey) private var showsProjectsSection = true
    @AppStorage(ComposerVisibilitySettings.workspaceKey) private var showsComposerWorkspace = true
    @AppStorage(ComposerVisibilitySettings.profileKey) private var showsComposerProfile = true
    @AppStorage(ComposerVisibilitySettings.gitBranchKey) private var showsComposerGitBranch = true
    @AppStorage(ComposerVisibilitySettings.contextUsageKey) private var showsComposerContextUsage = true
    @AppStorage(SessionRowDisplaySettings.showMessageCountKey) private var showsSessionMessageCount = true
    @AppStorage(SessionRowDisplaySettings.showWorkspaceKey) private var showsSessionWorkspace = true
    @AppStorage(SessionRowDisplaySettings.showCronSessionsKey) private var showsCronSessions = true
    @AppStorage(SessionRowDisplaySettings.showWebhookSessionsKey)
    private var showsWebhookSessions = SessionRowDisplaySettings.showsWebhookSessions()
    @AppStorage private var showsCliSessions: Bool
    @AppStorage private var showsClaudeCodeSessions: Bool
    @AppStorage(SessionRowDisplaySettings.showSubagentSessionsKey)
    private var showsSubagentSessions = SessionRowDisplaySettings.defaultShowsSubagentSessions

    init(authManager: AuthManager, server: URL) {
        self.authManager = authManager
        self.server = server
        _showsCliSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsCliSessions(for: server),
            SessionRowDisplaySettings.showCliSessionsKey(for: server)
        )
        _showsClaudeCodeSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsClaudeCodeSessions(for: server),
            SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: server)
        )
    }

    var body: some View {
        SettingsCategoryPage(category: .chats) {
            SettingsCard(title: String(localized: "Composer")) {
                SettingsPickerRow(
                    title: String(localized: "Send While Responding"),
                    systemImage: "arrow.up.message",
                    selection: $streamingSendBehaviorRawValue
                ) {
                    ForEach(StreamingSendBehavior.allCases) { behavior in
                        Text(behavior.settingsDescription).tag(behavior.rawValue)
                    }
                }

                SettingsDivider()

                SettingsPickerRow(
                    title: String(localized: "Dictation Provider"),
                    systemImage: "mic",
                    selection: $sttProviderPreferenceRawValue
                ) {
                    ForEach(ComposerSTTProviderPreference.allCases) { preference in
                        Text(preference.title).tag(preference.rawValue)
                    }
                }

                SettingsFootnote(String(localized: "On-device only keeps composer dictation audio off your Hermes server."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Workspace"),
                    systemImage: "folder",
                    isOn: $showsComposerWorkspace
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Profile"),
                    systemImage: "person.crop.circle",
                    isOn: $showsComposerProfile
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Git Branch"),
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsComposerGitBranch
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Context Usage"),
                    systemImage: "gauge.with.dots.needle.67percent",
                    isOn: $showsComposerContextUsage
                )

                SettingsFootnote(String(localized: "Choose which session controls appear below the composer. They hide while you type or read older messages."))
            }

            SettingsCard(title: String(localized: "Conversation")) {
                SettingsToggleRow(
                    title: String(localized: "Thinking & Tools"),
                    systemImage: "brain.head.profile",
                    isOn: $showsThinkingAndToolCards
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Expand Thinking by Default"),
                    systemImage: "rectangle.expand.vertical",
                    isOn: $thinkingCardsStartExpanded
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Expand Tools by Default"),
                    systemImage: "wrench.and.screwdriver",
                    isOn: $toolCardsStartExpanded
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Streamed Text Animation"),
                    systemImage: "sparkles",
                    isOn: $isStreamedTextAnimationEnabled
                )

                SettingsFootnote(String(localized: "Fades words in as a response streams. Turn off to show text instantly."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Response Timestamps"),
                    systemImage: "clock",
                    isOn: $showsAssistantTurnTimestamps
                )

                SettingsFootnote(String(localized: "Adds a small marker and the time above each response so back-to-back replies are easier to tell apart."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Response Speed"),
                    systemImage: "gauge.with.dots.needle.67percent",
                    isOn: $showsResponseSpeed
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Wrap Code Block Lines"),
                    systemImage: "arrow.turn.down.left",
                    isOn: $wrapsCodeBlockLines
                )

                SettingsFootnote(String(localized: "Wraps long lines in code blocks to fit the screen instead of scrolling sideways. You can also tap the wrap button in any code block."))

                SettingsDivider()

                SettingsPickerRow(
                    title: String(localized: "Scroll Button Side"),
                    systemImage: "arrow.down.circle",
                    selection: $scrollToBottomButtonSideRawValue
                ) {
                    ForEach(ChatScrollToBottomButtonSide.allCases) { side in
                        Text(side.title).tag(side.rawValue)
                    }
                }

                SettingsFootnote(String(localized: "Places the jump-to-latest button beside the status chip while you read older messages."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Right-to-Left Chat Layout"),
                    systemImage: "text.alignright",
                    isOn: $rtlChatLayoutEnabled
                )

                // swiftlint:disable:next line_length
                SettingsFootnote(String(localized: "Lays out messages and the composer right-to-left for Arabic, Hebrew, Persian, and Urdu. Code, math, tables, and tool output stay left-to-right. Other screens are unaffected."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Hide Attachment Paths"),
                    systemImage: "eye.slash",
                    isOn: $hidesAttachmentPaths
                )

                SettingsFootnote(String(localized: "Hides the appended file-path line in your sent messages. Attachments still appear as previews, and the server still receives the paths."))

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Files Button"),
                    systemImage: "folder",
                    isOn: $showsChatFilesButton
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Git Actions"),
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsChatGitControls
                )

                // swiftlint:disable:next line_length
                SettingsFootnote(String(localized: "Covers the git menu, composer branch picker, and the turn-end Commit & Push button and File changes recap."))
            }

            SettingsCard(title: String(localized: "Chat List")) {
                SettingsToggleRow(
                    title: String(localized: "Active Profile"),
                    systemImage: "person.crop.circle",
                    isOn: $showsActiveProfileSection
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Projects"),
                    systemImage: "folder.badge.gearshape",
                    isOn: $showsProjectsSection
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Message Count"),
                    systemImage: "number",
                    isOn: $showsSessionMessageCount
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Workspace"),
                    systemImage: "folder",
                    isOn: $showsSessionWorkspace
                )

                SettingsFootnote(String(localized: "Choose which details and filters appear in the chat list."))
            }

            SettingsCard(title: String(localized: "Included Chats")) {
                SettingsToggleRow(
                    title: String(localized: "Cron Sessions"),
                    systemImage: "clock.arrow.2.circlepath",
                    isOn: $showsCronSessions
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Webhook Sessions"),
                    systemImage: "bolt.horizontal.circle",
                    isOn: $showsWebhookSessions
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "CLI Sessions"),
                    systemImage: "terminal",
                    isOn: $showsCliSessions
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Claude Code Sessions"),
                    systemImage: "chevron.left.forwardslash.chevron.right",
                    isOn: $showsClaudeCodeSessions
                )
                .disabled(!showsCliSessions)

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Subagent Sessions"),
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsSubagentSessions
                )
            }

            SettingsCard(title: String(localized: "Archived Chats")) {
                NavigationLink {
                    ArchivedSessionsView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
                } label: {
                    SettingsAccessoryRow(title: String(localized: "Archived Chats"), systemImage: "archivebox")
                }
                .buttonStyle(.plain)
            }
        }
    }
}

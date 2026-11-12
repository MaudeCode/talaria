import SwiftUI
import TalariaKit

struct ChatsSettingsView: View {
    @AppStorage(StreamingSendBehavior.storageKey) private var streamingSendBehaviorRawValue = StreamingSendBehavior.steer.rawValue
    @AppStorage(ComposerSendKey.storageKey) private var sendKeyRawValue = ComposerSendKey.defaultValue.rawValue
    @AppStorage(ChatTranscriptDisplaySettings.showsThinkingAndToolCardsKey) private var showsThinkingAndToolCards = true
    @AppStorage(ChatTranscriptDisplaySettings.thinkingCardsStartExpandedKey) private var thinkingCardsStartExpanded = false
    @AppStorage(ChatTranscriptDisplaySettings.toolCardsStartExpandedKey) private var toolCardsStartExpanded = false
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
    @AppStorage(ChatTranscriptDisplaySettings.opensCompanionPageKey) private var opensCompanionPage = true
    @AppStorage(ComposerVisibilitySettings.workspaceKey) private var showsComposerWorkspace = true
    @AppStorage(ComposerVisibilitySettings.profileKey) private var showsComposerProfile = true
    @AppStorage(ComposerVisibilitySettings.gitBranchKey) private var showsComposerGitBranch = true
    @AppStorage(ComposerVisibilitySettings.contextUsageKey) private var showsComposerContextUsage = true
    var body: some View {
        SettingsCategoryPage(category: .chats) {
            SettingsSection(
                title: String(localized: "Composer"),
                help: [
                    String(localized: "Send With") + ": " + String(localized: """
                    Hardware keyboard only. While a reply runs, Control-Return queues the message, or steers it if \
                    Send While Responding queues.
                    """),
                    [String(localized: "Workspace"), String(localized: "Profile"), String(localized: "Git Branch"),
                     String(localized: "Context Usage")].joined(separator: ", ") + ": " + String(localized: """
                    Choose which session controls appear below the composer. They hide while you type or read older messages.
                    """)
                ].joined(separator: "\n\n")
            ) {
                SettingsPickerRow(
                    title: SettingsIndex.chatSendWhileResponding.title,
                    systemImage: "arrow.up.message",
                    selection: $streamingSendBehaviorRawValue
                ) {
                    ForEach(StreamingSendBehavior.allCases) { behavior in
                        Text(behavior.settingsDescription).tag(behavior.rawValue)
                    }
                }

                SettingsPickerRow(
                    title: SettingsIndex.chatSendWith.title,
                    systemImage: "keyboard",
                    selection: $sendKeyRawValue
                ) {
                    ForEach(ComposerSendKey.allCases) { sendKey in
                        Text(sendKey.title).tag(sendKey.rawValue)
                    }
                }

                SettingsToggleRow(
                    title: SettingsIndex.chatWorkspace.title,
                    systemImage: "folder",
                    isOn: $showsComposerWorkspace
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatProfile.title,
                    systemImage: "person.crop.circle",
                    isOn: $showsComposerProfile
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatGitBranch.title,
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsComposerGitBranch
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatContextUsage.title,
                    systemImage: "gauge.with.dots.needle.67percent",
                    isOn: $showsComposerContextUsage
                )
            }

            SettingsSection(
                title: String(localized: "Conversation"),
                help: [
                    String(localized: "Right-to-Left Chat Layout") + ": " + String(localized: """
                    Lays out messages and the composer right-to-left for Arabic, Hebrew, Persian, and Urdu. Code, math, \
                    tables, and tool output stay left-to-right. Other screens are unaffected.
                    """),
                    String(localized: "Git Actions") + ": " + String(localized: """
                    Covers the git menu, composer branch picker, and the turn-end Commit & Push button and File changes recap.
                    """)
                ].joined(separator: "\n\n")
            ) {
                SettingsToggleRow(
                    title: SettingsIndex.chatThinkingTools.title,
                    systemImage: "brain.head.profile",
                    isOn: $showsThinkingAndToolCards
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatExpandThinkingByDefault.title,
                    systemImage: "rectangle.expand.vertical",
                    isOn: $thinkingCardsStartExpanded
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatExpandToolsByDefault.title,
                    systemImage: "wrench.and.screwdriver",
                    isOn: $toolCardsStartExpanded
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatStreamedTextAnimation.title,
                    systemImage: "sparkles",
                    isOn: $isStreamedTextAnimationEnabled
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatResponseTimestamps.title,
                    systemImage: "clock",
                    isOn: $showsAssistantTurnTimestamps
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatResponseSpeed.title,
                    systemImage: "gauge.with.dots.needle.67percent",
                    isOn: $showsResponseSpeed
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatWrapCodeBlockLines.title,
                    systemImage: "arrow.turn.down.left",
                    isOn: $wrapsCodeBlockLines
                )

                SettingsPickerRow(
                    title: SettingsIndex.chatScrollButtonSide.title,
                    systemImage: "arrow.down.circle",
                    selection: $scrollToBottomButtonSideRawValue
                ) {
                    ForEach(ChatScrollToBottomButtonSide.allCases) { side in
                        Text(side.title).tag(side.rawValue)
                    }
                }

                SettingsToggleRow(
                    title: SettingsIndex.chatRightToLeftChatLayout.title,
                    systemImage: "text.alignright",
                    isOn: $rtlChatLayoutEnabled
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatFilesButton.title,
                    systemImage: "folder",
                    isOn: $showsChatFilesButton
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatOpensAgentFileAutomatically.title,
                    systemImage: "sidebar.trailing",
                    isOn: $opensCompanionPage
                )

                SettingsToggleRow(
                    title: SettingsIndex.chatGitActions.title,
                    systemImage: "arrow.triangle.branch",
                    isOn: $showsChatGitControls
                )
            }
        }
    }
}

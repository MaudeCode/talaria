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
                    title: String(localized: "Send With"),
                    systemImage: "keyboard",
                    selection: $sendKeyRawValue
                ) {
                    ForEach(ComposerSendKey.allCases) { sendKey in
                        Text(sendKey.title).tag(sendKey.rawValue)
                    }
                }

                SettingsFootnote(String(localized: "Hardware keyboard only. While a reply runs, Control-Return queues the message, or steers it if Send While Responding queues."))

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
                    title: String(localized: "Files Button"),
                    systemImage: "folder",
                    isOn: $showsChatFilesButton
                )

                SettingsDivider()

                SettingsToggleRow(
                    title: String(localized: "Open the Agent's File Automatically"),
                    systemImage: "sidebar.trailing",
                    isOn: $opensCompanionPage
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
        }
    }
}

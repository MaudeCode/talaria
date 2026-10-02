import Foundation
import SwiftUI

public enum PrimaryActionTintSettings {
    public static let isEnabledKey = "appearance.tintsPrimaryActionsWithThemeColor"

    /// A primary action adopts the theme color only when the user enabled the
    /// setting *and* the control is currently interactive.
    public static func usesThemeColor(isEnabled: Bool, controlIsEnabled: Bool) -> Bool {
        isEnabled && controlIsEnabled
    }
}

public enum AppHaptics {
    public static let isEnabledKey = "appHaptics.isEnabled"
}

public enum ResponseCompletionNotifications {
    public static let isEnabledKey = "responseCompletionNotifications.isEnabled"
    public static let hasRequestedPermissionKey = "responseCompletionNotifications.hasRequestedPermission"
}

public enum AgentRunLiveActivityPrivacy {
    public static let showsResponseExcerptsKey = "agentRunLiveActivity.showsResponseExcerpts"
}

/// User-facing switch for the streamed-text fade-in (issues #213/#234).
/// Defaults to on; Reduce Motion disables the animation regardless.
public enum StreamedTextAnimationSettings {
    public static let isEnabledKey = "chatTranscript.streamedTextAnimationEnabled"

    /// The fade-window start ordinal the renderer should use. `Int.max`
    /// routes every block into the solid head, so no fade renderer (and no
    /// frame clock) is ever attached — disabling the animation entirely.
    public static func effectiveFirstFadeOrdinal(
        _ firstFadeOrdinal: Int,
        reduceMotion: Bool,
        isEnabled: Bool
    ) -> Int {
        (reduceMotion || !isEnabled) ? Int.max : firstFadeOrdinal
    }
}

public enum FilePreviewDisplaySettings {
    public static let wrapsLinesKey = "filePreview.wrapsLines"
}

/// Which screen edge the chat's scroll-to-latest button sits on, beside the run status chip.
/// Physical sides: the RTL chat layout does not mirror them.
public enum ChatScrollToBottomButtonSide: String, CaseIterable, Identifiable {
    case right
    case left

    public static let storageKey = "chatTranscript.scrollToBottomButtonSide"

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .right:
            String(localized: "Right")
        case .left:
            String(localized: "Left")
        }
    }

    public static func storedValue(_ rawValue: String) -> ChatScrollToBottomButtonSide {
        ChatScrollToBottomButtonSide(rawValue: rawValue) ?? .right
    }

    /// The alignment that puts the button on this side in a view laid out in `layoutDirection`.
    public func alignment(in layoutDirection: LayoutDirection) -> HorizontalAlignment {
        (self == .right) == (layoutDirection == .leftToRight) ? .trailing : .leading
    }
}

public enum ChatTranscriptDisplaySettings {
    public static let showsThinkingAndToolCardsKey = "chatTranscript.showsThinkingAndToolCards"
    public static let thinkingCardsStartExpandedKey = "chatTranscript.thinkingCardsStartExpanded"
    public static let toolCardsStartExpandedKey = "chatTranscript.toolCardsStartExpanded"
    public static let hidesAttachmentPathsKey = "chatTranscript.hidesAttachmentPaths"
    public static let showsAssistantTurnTimestampsKey = "chatTranscript.showsAssistantTurnTimestamps"
    public static let showsResponseSpeedKey = "chatTranscript.showsResponseSpeed"
    public static let wrapsCodeBlockLinesKey = "chatTranscript.wrapsCodeBlockLines"

    /// Backs the Settings → Chat "Right-to-Left Chat Layout" toggle (issue #259).
    /// Local-only: there is no server settings object to mirror an `rtl` flag
    /// through today, so the reporter's optional `settings.rtl` server sync is
    /// deferred rather than guessed at (project hard rule: never invent API shapes).
    public static let rtlChatLayoutEnabledKey = "chatTranscript.rtlChatLayoutEnabled"

    /// The chat-canvas layout direction for a given toggle state. The toggle is a
    /// manual override that persists once tapped; its *default* follows the
    /// device language (see `rtlChatLayoutDefaultEnabled`).
    public static func chatLayoutDirection(rtlEnabled: Bool) -> LayoutDirection {
        rtlEnabled ? .rightToLeft : .leftToRight
    }

    /// Whether the user's primary preferred language reads right-to-left
    /// (Arabic/Hebrew/Persian/Urdu/…). Read from the device language *preference*
    /// — not the app's resolved UI direction — so it still fires for an RTL user
    /// even though Talaria isn't translated into their language yet: the app text
    /// falls back to English (LTR), but the chat layout should not. Only the
    /// primary preference counts (a German-first user with Arabic further down
    /// the list is "using German"). `preferredLanguages` is injectable for tests.
    static func isRightToLeftLanguage(
        preferredLanguages: [String] = Locale.preferredLanguages
    ) -> Bool {
        guard let primary = preferredLanguages.first else { return false }
        return Locale.Language(identifier: primary).characterDirection == .rightToLeft
    }

    /// Default state of the RTL chat toggle: on for RTL-language users so the chat
    /// mirrors automatically, off otherwise. Used as the `@AppStorage` default, so
    /// a user's explicit toggle still overrides it and persists (#259).
    public static var rtlChatLayoutDefaultEnabled: Bool {
        isRightToLeftLanguage()
    }

    /// A card's expansion follows the start-expanded preference until the user
    /// taps it; the per-card tap override then wins for the rest of the session.
    public static func isCardExpanded(userToggled: Bool?, startsExpanded: Bool) -> Bool {
        userToggled ?? startsExpanded
    }

    public static func shouldShowAssistantTypingIndicator(
        hasActiveStream: Bool,
        isCancellingStream: Bool,
        hasStreamingAssistantMessage: Bool,
        hasPendingClarificationPrompt: Bool = false,
        liveReasoningText: String,
        hasLiveToolCalls: Bool,
        showsThinkingAndToolCards: Bool
    ) -> Bool {
        guard hasActiveStream, !isCancellingStream else { return false }
        guard !hasStreamingAssistantMessage else { return false }
        guard !hasPendingClarificationPrompt else { return false }

        guard showsThinkingAndToolCards else {
            return true
        }

        guard liveReasoningText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !hasLiveToolCalls
    }

    public static func shouldUseStreamingBubbleRendering(
        hasActiveStream: Bool,
        messageRole: String?,
        messageID: String?,
        streamingAssistantMessageID: String?
    ) -> Bool {
        hasActiveStream &&
            messageRole == "assistant" &&
            streamingAssistantMessageID != nil &&
            messageID == streamingAssistantMessageID
    }

    /// Whether to draw the per-turn `glyph + timestamp` header above an assistant
    /// turn. The header is a turn *separator*, not an identity, so it is limited
    /// to real assistant turns that carry visible text — never user bubbles,
    /// system/marker cards, tool-call cards, or empty/tool-only assistant rows.
    public static func showsAssistantTurnHeader(
        role: String?,
        hasTextContent: Bool,
        isEnabled: Bool,
        showsResponseSpeed: Bool = false,
        hasResponseSpeed: Bool = false
    ) -> Bool {
        (isEnabled || (showsResponseSpeed && hasResponseSpeed)) &&
            role == "assistant" &&
            hasTextContent
    }
}

/// Visibility of the optional navigation entries, so a user can hide the parts of
/// the app they never use (issue #189): the session-list utility rows and the
/// chat's Files and Git controls. These buttons are the only way into those
/// screens, so hiding one takes it out of reach until the toggle goes back on.
/// Purely a display preference — nothing stops loading or syncing.
public enum SectionVisibilitySettings {
    public static let tasksKey = "sectionVisibility.tasks"
    public static let kanbanKey = "sectionVisibility.kanban"
    public static let skillsKey = "sectionVisibility.skills"
    public static let memoryKey = "sectionVisibility.memory"
    public static let insightsKey = "sectionVisibility.insights"
    public static let activeProfileKey = "sectionVisibility.activeProfile"
    public static let projectsKey = "sectionVisibility.projects"
    public static let chatFilesKey = "sectionVisibility.chatFiles"
    public static let chatGitKey = "sectionVisibility.chatGit"

    /// Every entry defaults to visible, so an install that predates these toggles
    /// looks exactly as it did before.
    public static func isVisible(_ key: String, in defaults: UserDefaults = .standard) -> Bool {
        defaults.object(forKey: key) as? Bool ?? true
    }
}

public enum ProviderQuotaSidebarSettings {
    public static let firstSourceKey = "providerQuotaSidebar.source1"
    public static let secondSourceKey = "providerQuotaSidebar.source2"
    public static let detailKey = "providerQuotaSidebar.detail"
    public static let showsRailKey = "providerQuotaSidebar.showsRail"
    public static let showsMarkerKey = "providerQuotaSidebar.showsMarker"
    public static let showsIconKey = "providerQuotaSidebar.showsIcon"
    public static let colorsByStateKey = "providerQuotaSidebar.colorsByState"

    public static func sourceIDs(first: String, second: String) -> [String] {
        var seen = Set<String>()
        return [first, second].compactMap { value in
            let id = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !id.isEmpty, seen.insert(id).inserted else { return nil }
            return id
        }
    }
}

public enum ProviderQuotaVisibilitySettings {
    public static let storageKey = "providerQuota.hiddenProviders"

    public static func hiddenProviderIDs(from data: Data) -> Set<String> {
        guard let values = try? JSONDecoder().decode([String].self, from: data) else { return [] }
        return Set(values.compactMap(normalizedProviderID))
    }

    public static func data(
        bySetting providerID: String,
        hidden: Bool,
        in data: Data
    ) -> Data {
        guard let providerID = normalizedProviderID(providerID) else { return data }
        var hiddenIDs = hiddenProviderIDs(from: data)
        if hidden {
            hiddenIDs.insert(providerID)
        } else {
            hiddenIDs.remove(providerID)
        }
        return (try? JSONEncoder().encode(hiddenIDs.sorted())) ?? data
    }

    private static func normalizedProviderID(_ value: String) -> String? {
        let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty ? nil : normalized
    }
}

/// Optional session controls shown with the message composer. Core actions such
/// as attachments, model, reasoning, dictation, and send remain available.
public enum ComposerVisibilitySettings {
    public static let workspaceKey = "composerVisibility.workspace"
    public static let profileKey = "composerVisibility.profile"
    public static let gitBranchKey = "composerVisibility.gitBranch"
    public static let contextUsageKey = "composerVisibility.contextUsage"
}

/// Pure helpers for the few *physical* layout values SwiftUI does not mirror on
/// its own under right-to-left layout (issue #294 — app-wide RTL). Semantic edges
/// (`.leading`/`.trailing`) and toolbar placements flip automatically; these cover
/// the exceptions: a manual `.offset(x:)` and a rotating disclosure chevron.
public enum RTLLayout {
    /// Mirror a physical horizontal offset so a corner-anchored overlay stays on
    /// the same visual side as its `.topTrailing`/`.topLeading` anchor: a positive
    /// (rightward) offset becomes leftward under RTL.
    public static func horizontalOffset(_ x: CGFloat, isRightToLeft: Bool) -> CGFloat {
        isRightToLeft ? -x : x
    }

    /// Expand-rotation (degrees) for a disclosure chevron drawn with a mirroring
    /// base glyph (`chevron.forward`): collapsed, the glyph already points toward
    /// the reveal direction, so the rotation must reverse under RTL for the
    /// expanded state to still point *down* rather than up.
    public static func disclosureChevronRotationDegrees(isExpanded: Bool, isRightToLeft: Bool) -> Double {
        guard isExpanded else { return 0 }
        return isRightToLeft ? -90 : 90
    }
}

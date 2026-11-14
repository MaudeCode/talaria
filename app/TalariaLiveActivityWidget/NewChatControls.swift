import AppIntents
import Foundation
import SwiftUI
import TalariaKit
import WidgetKit

// The widget extension and the App both compile this file (TAL-1476, TAL-50): a control's or widget's intent that opens
// the App runs in the App's process, where `ContentView` drains `AppIntentRouter`.

/// "New Chat" — opens Talaria on the New Chat composer, mirroring the in-app "+" button
/// (no server session is created until the first message). Available to the Action button,
/// Shortcuts, Spotlight, and Siri via `TalariaShortcuts`, and to Control Center via `NewChatControl`.
struct NewChatIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat"
    static let description = IntentDescription("Open Talaria on a new, empty chat.")

    /// Foregrounds the app so the navigation can run in-process.
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppIntentRouter.shared.requestDeepLink(TalariaDeepLink.newChatURL)
        return .result()
    }
}

/// "New Chat with Voice" — opens Talaria on the New Chat composer and auto-starts voice
/// dictation, so an Action-button press starts a hands-free chat (no second tap on the mic).
/// Routes through the same `AppIntentRouter`/deep-link plumbing as `NewChatIntent`, but on a
/// distinct host so the composer knows to begin listening once it's on screen (issue #338).
/// Mic/speech permission is handled by the existing dictation path: if access is undetermined
/// the system prompt appears, and if it's denied the composer shows a clear error instead.
struct NewChatVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat with Voice"
    static let description = IntentDescription("Open Talaria on a new chat and start voice dictation.")

    /// Foregrounds the app so the navigation — and the microphone — can run in-process.
    static let openAppWhenRun: Bool = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppIntentRouter.shared.requestDeepLink(TalariaDeepLink.newChatVoiceURL)
        return .result()
    }
}

/// "New Chat in <Profile>" — opens Talaria on a new chat pinned to a specific server profile
/// the user picks when configuring the Shortcut/Siri phrase (issue #339). The chosen
/// `ProfileEntity` is carried through the same `AppIntentRouter`/deep-link plumbing as the
/// other New Chat intents, on its own host (`new-chat-profile`) with the profile name as a
/// query item, so `PendingNewChatView` can create the session pinned to it.
struct NewChatInProfileIntent: AppIntent {
    static let title: LocalizedStringResource = "New Chat in Profile"
    static let description = IntentDescription("Open Talaria on a new chat pinned to a specific profile.")

    /// Foregrounds the app so the navigation can run in-process.
    static let openAppWhenRun: Bool = true

    @Parameter(title: "Profile")
    var profile: ProfileEntity

    init() {}

    init(profile: ProfileEntity) {
        self.profile = profile
    }

    static var parameterSummary: some ParameterSummary {
        Summary("New chat in \(\.$profile)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        AppIntentRouter.shared.requestDeepLink(
            TalariaDeepLink.newChatInProfileURL(profileName: profile.id)
        )
        return .result()
    }
}

/// Control Center, Lock Screen and Action button control for `NewChatIntent`.
struct NewChatControl: ControlWidget {
    static var action: NewChatIntent { NewChatIntent() }

    var body: some ControlWidgetConfiguration {
        newChatControl(kind: "NewChatControl", title: "New Chat", systemImage: "square.and.pencil", action: Self.action)
    }
}

/// Control Center, Lock Screen and Action button control for `NewChatVoiceIntent`.
struct NewChatVoiceControl: ControlWidget {
    static var action: NewChatVoiceIntent { NewChatVoiceIntent() }

    var body: some ControlWidgetConfiguration {
        newChatControl(
            kind: "NewChatVoiceControl", title: "New Chat with Voice", systemImage: "waveform", action: Self.action
        )
    }
}

@MainActor
private func newChatControl(
    kind: String,
    title: LocalizedStringResource,
    systemImage: String,
    action: some AppIntent
) -> some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: kind) {
        ControlWidgetButton(action: action) {
            Label { Text(title) } icon: { Image(systemName: systemImage) }
        }
    }
    .displayName(title)
}

/// Edit Widget options for `NewChatWidget` (TAL-50). No profile opens a plain new chat in the server's active profile.
struct NewChatWidgetConfigurationIntent: WidgetConfigurationIntent {
    static let title: LocalizedStringResource = "New Chat"
    static let description = IntentDescription("Open Talaria on a new chat, optionally in a profile.")

    @Parameter(title: "Profile")
    var profile: ProfileEntity?

    init() {}

    init(profile: ProfileEntity?) {
        self.profile = profile
    }
}

/// What a New Chat widget shows and opens. A configured profile the App no longer lists shows a recovery prompt and
/// opens a plain new chat, so a tap never pins a chat to a profile the server lacks. With no cached list (signed out,
/// or before the App first loads profiles) the profile is kept and the App's own onboarding or errors take over.
struct NewChatWidgetEntry: TimelineEntry {
    let date: Date
    /// The profile the new chat is pinned to; nil opens a plain new chat.
    let profile: ProfileEntity?
    /// The configured profile's name when it is missing from `available`.
    let missingProfileName: String?

    init(date: Date = .now, configuration: NewChatWidgetConfigurationIntent, available: [ProfileEntity]) {
        self.date = date
        let configured = configuration.profile
        let isAvailable = configured.map { profile in
            available.isEmpty || available.contains { $0.id == profile.id }
        } ?? false
        profile = isAvailable ? configured : nil
        missingProfileName = isAvailable ? nil : configured?.name
    }
}

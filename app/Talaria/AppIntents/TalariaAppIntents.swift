import AppIntents
import Foundation
import TalariaKit

/// "New Chat" — opens Talaria on the New Chat composer, mirroring the in-app "+" button
/// (no server session is created until the first message). Available to the Action button,
/// Shortcuts, Spotlight, and Siri via `TalariaShortcuts`.
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

/// "Ask Talaria" — sends a prompt to a new chat and speaks the server's reply without opening the app, so Siri, a
/// Shortcut, or the Action button can ask and hear the answer (TAL-1470). Shortcuts can chain the reply text. It never
/// answers an approval or a question itself: those, and a run still going after a minute, leave the chat running and
/// offer to open it.
struct AskTalariaIntent: AppIntent, ForegroundContinuableIntent {
    static let title: LocalizedStringResource = "Ask Talaria"
    static let description = IntentDescription("Send a prompt to a new chat and hear the reply.")

    static let openAppWhenRun: Bool = false

    @Parameter(title: "Prompt", requestValueDialog: "What do you want to ask?")
    var prompt: String

    /// Nil asks in the server's active profile.
    @Parameter(title: "Profile")
    var profile: ProfileEntity?

    /// The saved server's session; tests substitute a fixture.
    @MainActor static var makeAskSession: () -> AskSession? = { AppIntentServer.saved()?.askSession() }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        guard let session = Self.makeAskSession() else {
            throw AskSession.Failure(message: String(localized: "Add a server in Talaria first."))
        }
        let result = try await session.ask(prompt, profile: profile?.id)
        let openChat: @MainActor () async throws -> Void = { AppIntentRouter.shared.requestDeepLink(result.sessionURL) }
        switch result.status {
        case .replied:
            return .result(value: result.text, dialog: "\(result.text)")
        case .failed:
            throw AskSession.Failure(message: result.text)
        case .needsInput:
            throw needsToContinueInForegroundError("\(result.text) Open Talaria to continue.", continuation: openChat)
        case .stillWorking:
            throw needsToContinueInForegroundError(
                "Talaria is still working on it. Open Talaria to see the reply.",
                continuation: openChat
            )
        }
    }
}

/// Registers Talaria's App Shortcuts. iOS discovers this conformance automatically at build
/// time — it does not need to be referenced from the `App` struct. Exposing the intent here
/// is what makes "New Chat" appear in the Shortcuts app, Spotlight, and Siri, and assignable
/// to the iPhone Action button.
struct TalariaShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AskTalariaIntent(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question"
            ],
            shortTitle: "Ask Talaria",
            systemImageName: "bubble.left.and.text.bubble.right"
        )
        AppShortcut(
            intent: NewChatIntent(),
            phrases: [
                "New chat in \(.applicationName)",
                "New \(.applicationName) chat",
                "Start a new chat in \(.applicationName)"
            ],
            shortTitle: "New Chat",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: NewChatVoiceIntent(),
            phrases: [
                "New voice chat in \(.applicationName)",
                "New \(.applicationName) voice chat",
                "Start a voice chat in \(.applicationName)"
            ],
            shortTitle: "New Chat with Voice",
            systemImageName: "mic.badge.plus"
        )
        AppShortcut(
            intent: NewChatInProfileIntent(),
            phrases: [
                "New \(\.$profile) chat in \(.applicationName)",
                "Start a new \(\.$profile) chat in \(.applicationName)",
                "New chat in \(\.$profile) on \(.applicationName)"
            ],
            shortTitle: "New Chat in Profile",
            systemImageName: "person.crop.circle.badge.plus"
        )
    }
}

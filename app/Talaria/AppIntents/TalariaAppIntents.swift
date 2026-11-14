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
/// Shortcut, or the Action button can ask and hear the answer (TAL-1470). Shortcuts can chain the reply text.
struct AskTalariaIntent: AskingTalariaIntent {
    static let title: LocalizedStringResource = "Ask Talaria"
    static let description = IntentDescription("Send a prompt to a new chat and hear the reply.")

    static let openAppWhenRun: Bool = false

    @Parameter(title: "Prompt", requestValueDialog: "What do you want to ask?")
    var prompt: String

    /// Nil asks in the server's active profile.
    @Parameter(title: "Profile")
    var profile: ProfileEntity?

    /// The saved server's session; tests substitute a fixture. Reply uses it too.
    @MainActor static var makeAskSession: () -> AskSession? = { AppIntentServer.saved()?.askSession() }
    /// App Lock guards the agent too: a locked Talaria asks nothing until it is unlocked in the app.
    @MainActor static var appLock = AppLockModel.shared
    /// Only the App Intents runtime has a background-task context and the intent's progress; tests run the long ask
    /// in place and report to this progress instead.
    @MainActor static var inPlaceProgress: Progress?

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        try await ask(prompt, profile: profile?.id, continuingLastChat: false)
    }
}

/// "Reply to Talaria" — continues the chat the last Ask or Reply on this device used, so a back-and-forth works by
/// voice alone (TAL-2231). With no such chat it asks in a new one, exactly as Ask does; it never picks another chat.
struct ReplyToTalariaIntent: AskingTalariaIntent {
    static let title: LocalizedStringResource = "Reply to Talaria"
    static let description = IntentDescription("Continue the last Talaria chat and hear the reply.")

    static let openAppWhenRun: Bool = false

    @Parameter(title: "Text", requestValueDialog: "What do you want to say?")
    var text: String

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        try await ask(text, profile: nil, continuingLastChat: true)
    }
}

/// What Ask and Reply share. Neither answers an approval or a question itself: those, and a run that outlives the
/// wait, leave the chat running. With App Lock on and Talaria locked they ask nothing.
///
/// On iOS 27 they run in the background only, as long-running intents (TAL-2231): the wait lasts until the run ends,
/// progress carries the server's activity text, and a system cancellation or timeout speaks the still-working
/// dialog while the run goes on. Earlier systems wait a minute and offer to open the chat (TAL-1470).
protocol AskingTalariaIntent: AppIntent, ForegroundContinuableIntent {}

extension AskingTalariaIntent {
    @available(iOS 26, *)
    static var supportedModes: IntentModes {
        if #available(iOS 27, *) { return .background }
        // TAL-1470's modes: what `openAppWhenRun = false` with a foreground continuation declares.
        return .foreground(.dynamic)
    }

    /// `continuingLastChat` replies in the chat the last Ask or Reply used, in that chat's profile.
    @MainActor
    func ask(
        _ prompt: String,
        profile: String?,
        continuingLastChat: Bool
    ) async throws -> some IntentResult & ProvidesDialog & ReturnsValue<String> {
        var inBackground = false
        if #available(iOS 27, *) { inBackground = self is any LongRunningIntent }
        guard !AskTalariaIntent.appLock.locksBackgroundWork() else {
            if inBackground { throw AskSession.Failure(message: String(localized: "Unlock Talaria in the app first.")) }
            throw needsToContinueInForegroundError("Unlock Talaria")
        }
        guard var session = AskTalariaIntent.makeAskSession() else {
            throw AskSession.Failure(message: String(localized: "Add a server in Talaria first."))
        }
        let last = continuingLastChat ? session.last : nil
        let profile = last.map(\.profile) ?? profile

        let result: AskSession.Result?
        if #available(iOS 27, *), let intent = self as? any LongRunningIntent & CancellableIntent {
            session.timeout = nil
            result = try await askInBackground(intent, inPlace: AskTalariaIntent.inPlaceProgress) { [session] progress in
                try await session.ask(prompt, profile: profile, sessionID: last?.sessionID, progress: progress)
            }
        } else {
            result = try await session.ask(prompt, profile: profile, sessionID: last?.sessionID)
        }

        let openChat: @MainActor () async throws -> Void = { AppIntentRouter.shared.requestDeepLink(result?.sessionURL) }
        switch result?.status ?? .stillWorking {
        case .replied:
            let text = result?.text ?? ""
            return .result(value: text, dialog: "\(text)")
        case .failed:
            throw AskSession.Failure(message: result?.text ?? "")
        case .needsInput:
            let text = result?.text ?? ""
            let dialog: IntentDialog = "\(text) Open Talaria to continue."
            guard !inBackground else { return .result(value: text, dialog: dialog) }
            throw needsToContinueInForegroundError(dialog, continuation: openChat)
        case .stillWorking:
            let dialog: IntentDialog = "Talaria is still working on it. Open Talaria to see the reply."
            guard !inBackground else { return .result(value: "", dialog: dialog) }
            throw needsToContinueInForegroundError(dialog, continuation: openChat)
        }
    }
}

@available(iOS 27, *)
extension AskTalariaIntent: LongRunningIntent, CancellableIntent {}

@available(iOS 27, *)
extension ReplyToTalariaIntent: LongRunningIntent, CancellableIntent {}

/// Runs the ask as the intent's background task, reporting to the intent's progress. Nil: the system cancelled the
/// task or ran out of time; the run goes on on the server and no cancel request is sent.
@available(iOS 27, *)
private func askInBackground<Intent: LongRunningIntent & CancellableIntent>(
    _ intent: Intent,
    inPlace: Progress?,
    _ ask: @escaping @Sendable @MainActor (Progress) async throws -> AskSession.Result
) async throws -> AskSession.Result? {
    do {
        if let inPlace { return try await ask(inPlace) }
        return try await intent.performBackgroundTask { try await ask(intent.progress) } onCancel: { _ in }
    } catch where error is CancellationError || Task.isCancelled {
        return nil
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

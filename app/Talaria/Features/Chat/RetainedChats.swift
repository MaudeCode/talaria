import Foundation
import TalariaKit

/// What an open chat keeps while the navigation around it is rebuilt, as opening or closing an iPhone Duo swaps the
/// split view for a stack (TAL-1477): its view model, with the running response, Listen and dictation; the transcript's
/// row state, with expanded disclosures; its Git probe; and the reader's place.
@MainActor
final class RetainedChat {
    let viewModel: ChatViewModel
    /// A pending root adopts its server summary here without replacing its mounted composer.
    var session: SessionSummary?
    var didStartConversation = false
    let rows = ChatTranscriptRowCache()
    var gitAvailability: GitWorkspaceAvailabilityViewModel?
    /// The row at the top of the transcript where the reader last let go of it; nil while it follows the latest message.
    var readingRowID: String?
    /// Registered by the mounted transcript; layout admission calls it before publishing a new wrap width.
    var widthChangePreparation: (owner: ObjectIdentifier, action: () -> Void)?
    /// Whether a view finished the chat's first load. One taken over before then loads it again, since its own was
    /// cancelled with the view it ran in.
    var hasLoaded = false
    private var shownViews = 0
    private var pendingRelease: Task<Void, Never>?

    init(viewModel: ChatViewModel, session: SessionSummary? = nil) {
        self.viewModel = viewModel
        self.session = session
    }

    /// Whether a view shows the chat, or left it this turn and may yet hand it over.
    var isLive: Bool { shownViews > 0 || pendingRelease != nil }

    /// Records a view showing the chat, and returns whether it takes over from one the navigation just replaced, so it
    /// carries on with the live chat instead of starting it again.
    func viewDidAppear() -> Bool {
        let takesOver = isLive
        pendingRelease?.cancel()
        pendingRelease = nil
        shownViews += 1
        return takesOver
    }

    /// Records a view leaving. When none shows the chat by the next turn, `release` stops what it was running; a view the
    /// navigation rebuilt in the same update takes over first.
    func viewDidDisappear(release: @escaping @MainActor () -> Void) {
        shownViews = max(0, shownViews - 1)
        guard shownViews == 0 else { return }
        // Holds the chat until then, so one navigation already dropped is still released.
        pendingRelease = Task { @MainActor in
            await Task.yield()
            guard !Task.isCancelled, shownViews == 0 else { return }
            pendingRelease = nil
            release()
        }
    }
}

/// The open chats the session list keeps above its regular and compact layouts, so both hand the same chat to their
/// `ChatView` (TAL-1477). Only the chat navigation shows stays, so a chat opened again later starts afresh.
@MainActor
final class ChatViewModelCache {
    static let capacity = 3

    private struct Key: Equatable {
        let server: URL
        let sessionID: String
    }

    private var entries: [(key: Key, chat: RetainedChat)] = []

    var count: Int { entries.count }

    /// The kept chat for `session`, made with `make` on first use. A chat on another server is dropped.
    func chat(for session: SessionSummary, server: URL, make: () -> ChatViewModel) -> RetainedChat {
        chat(key: Key(server: server, sessionID: session.id), matchingSessionID: session.sessionId) {
            RetainedChat(viewModel: make(), session: session)
        }
    }

    func pendingChat(for route: PendingNewChatRoute, server: URL,
                     make: (SessionSummary) -> ChatViewModel) -> RetainedChat {
        chat(key: Key(server: server, sessionID: "new:\(route.id)")) {
            let provisional = SessionSummary(title: String(localized: "New Chat"), modelProvider: route.providerID,
                profile: route.profileName)
            return RetainedChat(viewModel: make(provisional), session: provisional)
        }
    }

    private func chat(key: Key, matchingSessionID: String? = nil, make: () -> RetainedChat) -> RetainedChat {
        entries.removeAll { $0.key.server != key.server }
        if let index = entries.firstIndex(where: {
            $0.key == key || (matchingSessionID != nil && $0.chat.session?.sessionId == matchingSessionID)
        }) {
            let entry = entries.remove(at: index)
            entries.insert(entry, at: 0)
            return entry.chat
        }
        let chat = make()
        entries.insert((key, chat), at: 0)
        entries.removeLast(max(0, entries.count - Self.capacity))
        return chat
    }

    func prepareForWidthChange() {
        for entry in entries where entry.chat.isLive {
            entry.chat.widthChangePreparation?.action()
        }
    }

    /// Drops every chat but the one navigation shows: a deleted, archived or closed chat is not kept.
    func keepOnly(sessionID: String?) {
        entries.removeAll { $0.key.sessionID != sessionID && $0.chat.session?.sessionId != sessionID }
    }
}

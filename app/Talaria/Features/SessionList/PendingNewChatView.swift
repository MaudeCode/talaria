import SwiftData
import SwiftUI
import TalariaKit

struct PendingNewChatView: View {
    @Environment(\.modelContext) private var modelContext
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    let server: URL
    let viewModel: SessionListViewModel
    let onAPIError: (Error) -> Void
    let onSessionCreated: (SessionSummary) -> Void
    let initialAttachments: [SharedAttachmentImport]
    let autoStartsVoiceInput: Bool
    let profileName: String?
    let providerID: String?
    let projectID: String?
    let executionMode: ExecutionMode?
    let draftStore: ChatDraftStore
    let splitFilesInspector: SplitFilesInspector?

    @State private var createdSession: SessionSummary?
    @State private var createdDetail: SessionDetail?
    /// One diagnostic creation's identity (TAL-1045): Retry after a lost response gets back the chat the owner made.
    @State private var creationID = UUID().uuidString
    @State private var unconfirmedCreationMessage: String?
    @State private var draftMessage = ""
    @State private var didStartConversation = false
    /// The chat's screen exists before its session (TAL-636): it starts from this placeholder and
    /// takes on the session the server creates, so the composer never changes.
    @State private var provisionalSession = SessionSummary(title: String(localized: "New Chat"))

    init(
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        autoStartsVoiceInput: Bool = false,
        profileName: String? = nil,
        providerID: String? = nil,
        projectID: String? = nil,
        executionMode: ExecutionMode? = nil,
        server: URL,
        viewModel: SessionListViewModel,
        onAPIError: @escaping (Error) -> Void,
        onSessionCreated: @escaping (SessionSummary) -> Void = { _ in },
        draftStore: ChatDraftStore? = nil,
        splitFilesInspector: SplitFilesInspector? = nil
    ) {
        self.server = server
        self.viewModel = viewModel
        self.onAPIError = onAPIError
        self.onSessionCreated = onSessionCreated
        self.initialAttachments = initialAttachments
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
        self.projectID = projectID
        self.executionMode = executionMode
        self.draftStore = draftStore ?? .shared
        self.splitFilesInspector = splitFilesInspector
        _draftMessage = State(initialValue: initialDraft)
    }

    var body: some View {
        ChatView(
            session: provisionalSession,
            server: server,
            onAPIError: onAPIError,
            initialDraft: draftMessage,
            initialAttachments: initialAttachments,
            loadsInitialMessages: false,
            autoStartsVoiceInput: autoStartsVoiceInput,
            draftStore: draftStore,
            restoresDraftSettings: true,
            startSession: createSession,
            onConversationStarted: markConversationStarted,
            splitFilesInspector: splitFilesInspector
        )
        .onChange(of: scenePhase) {
            if scenePhase != .active {
                flushDraftsBestEffort()
            }
        }
        .onDisappear {
            restoreAbandonedDraftIfNeeded()
            flushDraftsBestEffort()
        }
    }

    /// Creates the chat's session for `ChatView`, which takes it on in place and moves the draft
    /// to it. A failure comes back as the message the composer's strip shows with Retry.
    private func createSession() async -> ChatSessionStartResult {
        if let createdSession { return .started(createdSession, detail: createdDetail) }
        if let unconfirmedCreationMessage { return .failed(unconfirmedCreationMessage, canRetry: false) }
        viewModel.clearActionError()
        let result = await viewModel.createSessionResult(
            modelContext: modelContext,
            profile: profileName,
            provider: providerID,
            projectID: projectID,
            executionMode: executionMode,
            requestID: creationID
        )
        guard !Task.isCancelled else { return .failed(String(localized: "Chat creation was cancelled.")) }
        let session: SessionSummary
        switch result {
        case .started(let created, let detail):
            session = created
            createdDetail = detail
        case .failed(var message, let canRetry, let error):
            if let error { onAPIError(error) }
            if !canRetry {
                message += " " + String(localized: "Check Chats before starting another chat.")
                unconfirmedCreationMessage = message
            }
            viewModel.clearActionError()
            return .failed(message, canRetry: canRetry, error: error)
        }
        SessionHaptics.sessionCreated(isEnabled: isHapticsEnabled)
        onSessionCreated(session)
        createdSession = session
        return .started(session, detail: createdDetail)
    }

    private var draftKey: ChatDraftKey {
        .newChat(server: server)
    }

    private func draftKey(for session: SessionSummary) -> ChatDraftKey {
        .session(server: server, session: session)
    }

    private func flushDraftsBestEffort() {
        Task {
            try? await draftStore.flush()
        }
    }

    private func markConversationStarted() {
        didStartConversation = true
    }

    private func restoreAbandonedDraftIfNeeded() {
        guard let createdSession else { return }
        draftMessage = draftStore.restoreAbandonedNewChatDraft(
            from: draftKey(for: createdSession),
            to: draftKey,
            didStartConversation: didStartConversation
        )?.text ?? draftMessage
    }
}

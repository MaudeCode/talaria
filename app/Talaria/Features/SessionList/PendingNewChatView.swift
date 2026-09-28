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
    let draftStore: ChatDraftStore

    @State private var createdSession: SessionSummary?
    @State private var draftMessage = ""
    @State private var didStartCreation = false
    @State private var didStartConversation = false
    @State private var didRequestComposerFocus = false
    @State private var creationErrorMessage: String?
    @FocusState private var composerIsFocused: Bool

    init(
        initialDraft: String = "",
        initialAttachments: [SharedAttachmentImport] = [],
        autoStartsVoiceInput: Bool = false,
        profileName: String? = nil,
        providerID: String? = nil,
        server: URL,
        viewModel: SessionListViewModel,
        onAPIError: @escaping (Error) -> Void,
        onSessionCreated: @escaping (SessionSummary) -> Void = { _ in },
        draftStore: ChatDraftStore? = nil
    ) {
        self.server = server
        self.viewModel = viewModel
        self.onAPIError = onAPIError
        self.onSessionCreated = onSessionCreated
        self.initialAttachments = initialAttachments
        self.autoStartsVoiceInput = autoStartsVoiceInput
        self.profileName = profileName
        self.providerID = providerID
        self.draftStore = draftStore ?? .shared
        _draftMessage = State(initialValue: initialDraft)
    }

    var body: some View {
        Group {
            if let createdSession {
                ChatView(
                    session: createdSession,
                    server: server,
                    onAPIError: onAPIError,
                    initialDraft: draftMessage,
                    initialAttachments: initialAttachments,
                    loadsInitialMessages: false,
                    autoStartsVoiceInput: autoStartsVoiceInput,
                    draftStore: draftStore,
                    restoresDraftSettings: true,
                    onConversationStarted: markConversationStarted
                )
            } else {
                pendingContent
            }
        }
        .background(
            NavigationAppearanceCompletionObserver(action: requestPendingComposerFocus)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
        )
        .task {
            await prepareNewChat()
        }
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

    private var pendingContent: some View {
        ZStack(alignment: .bottom) {
            Color(.systemBackground)
                .ignoresSafeArea()

            ContentUnavailableView {
                Image(systemName: "bubble.left.and.bubble.right")
            } description: {
                Text("Send a message to start the conversation.")
            }
            .contentShape(Rectangle())
            .onTapGesture {
                composerIsFocused = false
            }

            VStack(spacing: 10) {
                if let creationErrorMessage {
                    pendingErrorBanner(creationErrorMessage)
                }

                pendingComposer
            }
            .padding(.horizontal)
            .padding(.bottom, 12)
        }
        .navigationTitle("New Chat")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var pendingComposer: some View {
        HStack(alignment: .bottom, spacing: 10) {
            TextField("Message Talaria", text: persistedDraftBinding, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...5)
                .focused($composerIsFocused)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 22, style: .continuous)
                        .strokeBorder(Color(.separator).opacity(0.18), lineWidth: 0.5)
                }
                .submitLabel(.send)

            Button {} label: {
                Image(systemName: "arrow.up")
                    .font(.headline.weight(.bold))
                    .foregroundStyle(Color(.secondaryLabel))
                    .frame(width: 44, height: 44)
                    .background(Color(.tertiarySystemFill), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(true)
            .accessibilityLabel("Send")
        }
    }

    private func pendingErrorBanner(_ message: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.orange)

            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)

            Spacer(minLength: 0)

            Button("Retry") {
                Task { await retryCreateSession() }
            }
            .font(.footnote.weight(.semibold))
            .disabled(viewModel.isCreatingSession)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private func createSessionIfNeeded() async {
        guard !didStartCreation, createdSession == nil else { return }

        didStartCreation = true
        creationErrorMessage = nil
        let session = await viewModel.createSession(
            modelContext: modelContext,
            profile: profileName,
            provider: providerID
        )
        guard !Task.isCancelled else { return }
        if let lastError = viewModel.lastError {
            onAPIError(lastError)
        }

        if let session {
            let sessionKey = draftKey(for: session)
            draftStore.setDraft(draftMessage, for: draftKey)
            draftMessage = draftStore.moveDraft(from: draftKey, to: sessionKey).text
            SessionHaptics.sessionCreated(isEnabled: isHapticsEnabled)
            onSessionCreated(session)
            createdSession = session
        } else {
            creationErrorMessage = viewModel.actionErrorMessage
                ?? viewModel.lastError?.localizedDescription
                ?? String(localized: "Could not start a new chat.")
            viewModel.clearActionError()
            didStartCreation = false
        }
    }

    private func retryCreateSession() async {
        didStartCreation = false
        creationErrorMessage = nil
        viewModel.clearActionError()
        await createSessionIfNeeded()
    }

    private var draftKey: ChatDraftKey {
        .newChat(server: server)
    }

    private func draftKey(for session: SessionSummary) -> ChatDraftKey {
        .session(server: server, session: session)
    }

    private var persistedDraftBinding: Binding<String> {
        Binding(
            get: { draftMessage },
            set: { newValue in
                draftMessage = newValue
                draftStore.setDraft(newValue, for: draftKey)
            }
        )
    }

    private func prepareNewChat() async {
        await hydrateDraft()
        guard !Task.isCancelled else { return }
        await createSessionIfNeeded()
    }

    private func hydrateDraft() async {
        let textBeforeHydration = draftMessage
        let persistedDraft = await draftStore.draft(for: draftKey)
        guard !Task.isCancelled, draftMessage == textBeforeHydration else { return }

        if textBeforeHydration.isEmpty {
            if let persistedDraft, !persistedDraft.text.isEmpty {
                draftMessage = persistedDraft.text
            }
        } else {
            draftStore.setDraft(textBeforeHydration, for: draftKey)
        }
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

    private func requestPendingComposerFocus() {
        guard !didRequestComposerFocus else { return }
        didRequestComposerFocus = true

        Task { @MainActor in
            await Task.yield()
            guard createdSession == nil else { return }
            composerIsFocused = true
        }
    }
}

import SwiftUI
import Observation

@MainActor
@Observable
final class ChatBottomAccessoryModel {
    private(set) var isVisible = false
    private(set) var showsStop = false
    private(set) var isStopDisabled = false
    private(set) var isVoiceDisabled = false
    private(set) var isAttachmentDisabled = false
    private(set) var isCameraAvailable = false
    private(set) var secondaryControls: ComposerSecondaryControlsState?

    @ObservationIgnored private var owner: UUID?
    @ObservationIgnored private var activateAction: () -> Void = {}
    @ObservationIgnored private var voiceAction: () -> Void = {}
    @ObservationIgnored private var stopAction: () -> Void = {}
    @ObservationIgnored private var attachFileAction: () -> Void = {}
    @ObservationIgnored private var attachPhotoAction: () -> Void = {}
    @ObservationIgnored private var takePhotoAction: () -> Void = {}
    @ObservationIgnored private var chooseWorkspaceAction: () -> Void = {}
    @ObservationIgnored private var selectProfileAction: (ProfileSummary) -> Void = { _ in }
    @ObservationIgnored private var selectGitBranchAction: (GitCheckoutTarget) -> Void = { _ in }
    @ObservationIgnored private var createGitBranchAction: (GitCheckoutTarget) -> Void = { _ in }
    @ObservationIgnored private var refreshGitBranchesAction: () -> Void = {}

    func claim(_ owner: UUID) {
        self.owner = owner
    }

    func update(
        owner: UUID,
        isVisible: Bool,
        showsStop: Bool,
        isStopDisabled: Bool,
        isVoiceDisabled: Bool,
        isAttachmentDisabled: Bool,
        isCameraAvailable: Bool,
        secondaryControls: ComposerSecondaryControlsState?,
        onActivate: @escaping () -> Void,
        onVoice: @escaping () -> Void,
        onStop: @escaping () -> Void,
        onAttachFile: @escaping () -> Void,
        onAttachPhoto: @escaping () -> Void,
        onTakePhoto: @escaping () -> Void,
        onChooseWorkspace: @escaping () -> Void,
        onSelectProfile: @escaping (ProfileSummary) -> Void,
        onSelectGitBranch: @escaping (GitCheckoutTarget) -> Void,
        onCreateGitBranch: @escaping (GitCheckoutTarget) -> Void,
        onRefreshGitBranches: @escaping () -> Void
    ) {
        guard self.owner == owner else { return }
        self.isVisible = isVisible
        self.showsStop = showsStop
        self.isStopDisabled = isStopDisabled
        self.isVoiceDisabled = isVoiceDisabled
        self.isAttachmentDisabled = isAttachmentDisabled
        self.isCameraAvailable = isCameraAvailable
        self.secondaryControls = secondaryControls
        activateAction = onActivate
        voiceAction = onVoice
        stopAction = onStop
        attachFileAction = onAttachFile
        attachPhotoAction = onAttachPhoto
        takePhotoAction = onTakePhoto
        chooseWorkspaceAction = onChooseWorkspace
        selectProfileAction = onSelectProfile
        selectGitBranchAction = onSelectGitBranch
        createGitBranchAction = onCreateGitBranch
        refreshGitBranchesAction = onRefreshGitBranches
    }

    func clear(owner: UUID) {
        guard self.owner == owner else { return }
        self.owner = nil
        isVisible = false
        secondaryControls = nil
        activateAction = {}
        voiceAction = {}
        stopAction = {}
        attachFileAction = {}
        attachPhotoAction = {}
        takePhotoAction = {}
        chooseWorkspaceAction = {}
        selectProfileAction = { _ in }
        selectGitBranchAction = { _ in }
        createGitBranchAction = { _ in }
        refreshGitBranchesAction = {}
    }

    func activate() { activateAction() }
    func startVoiceInput() { voiceAction() }
    func stop() { stopAction() }
    func attachFile() { attachFileAction() }
    func attachPhoto() { attachPhotoAction() }
    func takePhoto() { takePhotoAction() }
    func chooseWorkspace() { chooseWorkspaceAction() }
    func selectProfile(_ profile: ProfileSummary) { selectProfileAction(profile) }
    func selectGitBranch(_ target: GitCheckoutTarget) { selectGitBranchAction(target) }
    func createGitBranch(_ target: GitCheckoutTarget) { createGitBranchAction(target) }
    func refreshGitBranches() { refreshGitBranchesAction() }
}

private struct ChatBottomAccessoryModelKey: EnvironmentKey {
    static let defaultValue: ChatBottomAccessoryModel? = nil
}

extension EnvironmentValues {
    var chatBottomAccessoryModel: ChatBottomAccessoryModel? {
        get { self[ChatBottomAccessoryModelKey.self] }
        set { self[ChatBottomAccessoryModelKey.self] = newValue }
    }
}

struct ContentView: View {
    @Bindable var authManager: AuthManager
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(ResponseCompletionNotifications.isEnabledKey) private var isResponseCompletionNotificationsEnabled = false
    @State private var pendingSharedImport: SharedImport?
    @State private var pendingDeepLinkedSessionID: String?
    @State private var pendingNewChatRequest: NewChatRequest?
    @State private var didCheckInitialPendingShare = false
    @State private var intentRouter = AppIntentRouter.shared
    @State private var selectedTab = RootTab.chats
    @State private var chatBottomAccessoryModel = ChatBottomAccessoryModel()

    var body: some View {
        content
            .onOpenURL(perform: handleOpenURL)
            .task {
                guard !didCheckInitialPendingShare else { return }
                didCheckInitialPendingShare = true
                importPendingSharedDraftIfAvailable()
                // Cold launch: an App Intent may have queued a deep link before this
                // view appeared (e.g. Action button "New Chat"). Drain it now (#337).
                drainPendingIntentDeepLink()
            }
            .onChange(of: intentRouter.pendingDeepLink) {
                // Warm launch: the intent set the deep link after the view appeared.
                drainPendingIntentDeepLink()
            }
            .task {
                // #246: on cold launch, end any Live Activity left "running" by a
                // run that finished while the app was terminated. #248: this is also
                // the one pass allowed to fire a recent run's "response complete"
                // notification, since a relaunch means it finished while not active.
                await reconcileOrphanedLiveActivities(notifiesOnCompletion: true)
            }
            .onChange(of: scenePhase) {
                guard scenePhase == .active else { return }
                importPendingSharedDraftIfAvailable()
                // #248: the foreground pass stays silent — the in-session completion
                // paths own notifications while the app is alive.
                Task { await reconcileOrphanedLiveActivities(notifiesOnCompletion: false) }
            }
    }

    private func reconcileOrphanedLiveActivities(notifiesOnCompletion: Bool) async {
        guard case let .loggedIn(server) = authManager.state else { return }
        await LiveActivityReconciler.reconcileOrphanedActivities(
            server: server,
            notifiesOnCompletion: notifiesOnCompletion,
            preferenceEnabled: isResponseCompletionNotificationsEnabled
        )
    }

    @ViewBuilder
    private var content: some View {
        switch authManager.state {
        case .unconfigured:
            OnboardingView(authManager: authManager)
        case .loggedOut(let server):
            OnboardingView(authManager: authManager, savedServer: server)
        case .loggedIn(let server):
            TabView(selection: $selectedTab) {
                Tab("Chats", systemImage: "bubble.left.and.bubble.right", value: RootTab.chats) {
                    SessionListView(
                        authManager: authManager,
                        server: server,
                        pendingSharedImport: $pendingSharedImport,
                        pendingDeepLinkedSessionID: $pendingDeepLinkedSessionID,
                        requestedNewChat: $pendingNewChatRequest
                    )
                    .environment(\.chatBottomAccessoryModel, chatBottomAccessoryModel)
                }

                Tab("Tasks", systemImage: "calendar.badge.clock", value: RootTab.tasks) {
                    NavigationStack {
                        TasksView(server: server, onAPIError: authManager.handleAPIError)
                            .navigationBarTitleDisplayMode(.inline)
                    }
                }

                Tab("Kanban", systemImage: "rectangle.split.3x1", value: RootTab.kanban) {
                    NavigationStack {
                        KanbanView(server: server, onAPIError: authManager.handleAPIError)
                            .navigationBarTitleDisplayMode(.inline)
                    }
                }

                Tab("More", systemImage: "ellipsis", value: RootTab.more) {
                    NavigationStack {
                        MoreView(authManager: authManager, server: server)
                    }
                }
            }
            .minimizingTabBarOnScroll()
            .chatBottomAccessory(selectedTab: selectedTab, model: chatBottomAccessoryModel)
            // Switching the active server keeps us in `.loggedIn`, so without a
            // per-server identity SwiftUI would reuse server-bound tab content.
            // Keying on the server tears the tab tree down and rebuilds it against
            // the newly active server (#17).
            .id(server)
        }
    }

    private func handleOpenURL(_ url: URL) {
        // A fresh request each time (new `id`) so a repeat invocation re-triggers navigation
        // even if the previous one's value still lingers downstream. The voice variant carries
        // `autoStartsVoiceInput` so the composer begins dictation once it appears (#338).
        if HermesDeepLink.isNewChatVoiceURL(url) {
            selectedTab = .chats
            pendingNewChatRequest = NewChatRequest(autoStartsVoiceInput: true)
            return
        }

        // The profile variant carries the chosen profile name, so the composer creates the
        // session pinned to it (#339). A malformed link with no profile falls back to a
        // plain new chat (server's active profile) rather than failing.
        if HermesDeepLink.isNewChatInProfileURL(url) {
            selectedTab = .chats
            pendingNewChatRequest = NewChatRequest(
                profileName: HermesDeepLink.profileName(fromNewChatInProfile: url)
            )
            return
        }

        if HermesDeepLink.isNewChatURL(url) {
            selectedTab = .chats
            pendingNewChatRequest = NewChatRequest(autoStartsVoiceInput: false)
            return
        }

        if let sessionID = HermesDeepLink.sessionID(from: url) {
            selectedTab = .chats
            pendingDeepLinkedSessionID = sessionID
            return
        }

        guard HermesShareDraft.isShareOpenURL(url) else {
            return
        }

        importPendingSharedDraftIfAvailable()
    }

    /// Routes a deep link queued by an App Intent through the same `handleOpenURL` parser
    /// used for external URLs, then clears it so it routes exactly once (#337).
    private func drainPendingIntentDeepLink() {
        guard let url = intentRouter.pendingDeepLink else { return }
        intentRouter.pendingDeepLink = nil
        handleOpenURL(url)
    }

    private func importPendingSharedDraftIfAvailable() {
        guard let directory = HermesShareDraft.containerURL() else {
            return
        }

        do {
            if let sharedImport = try HermesShareDraft.loadPendingImport(from: directory) {
                selectedTab = .chats
                pendingSharedImport = sharedImport
            }
        } catch {
            pendingSharedImport = nil
        }
    }
}

private extension View {
    @ViewBuilder
    func minimizingTabBarOnScroll() -> some View {
        if #available(iOS 26, *) {
            tabBarMinimizeBehavior(.onScrollDown)
        } else {
            self
        }
    }

    @ViewBuilder
    func chatBottomAccessory(selectedTab: RootTab, model: ChatBottomAccessoryModel) -> some View {
        if #available(iOS 26.1, *) {
            tabViewBottomAccessory(
                isEnabled: selectedTab == .chats && model.isVisible
            ) {
                ChatBottomAccessoryView(model: model)
            }
        } else {
            self
        }
    }
}

private enum RootTab: Hashable {
    case chats
    case tasks
    case kanban
    case more
}

@available(iOS 26, *)
private struct ChatBottomAccessoryView: View {
    @Environment(\.tabViewBottomAccessoryPlacement) private var placement
    let model: ChatBottomAccessoryModel

    var body: some View {
        Group {
            if let secondaryControls = model.secondaryControls {
                if placement == .inline {
                    ComposerSecondaryControlsMenu(
                        state: secondaryControls,
                        onChooseWorkspace: model.chooseWorkspace,
                        onSelectProfile: model.selectProfile,
                        onSelectGitBranch: model.selectGitBranch,
                        onCreateGitBranch: model.createGitBranch,
                        onRefreshGitBranches: model.refreshGitBranches
                    )
                    .padding(.horizontal, 4)
                } else {
                    ComposerSecondaryControlsView(
                        state: secondaryControls,
                        onChooseWorkspace: model.chooseWorkspace,
                        onSelectProfile: model.selectProfile,
                        onSelectGitBranch: model.selectGitBranch,
                        onCreateGitBranch: model.createGitBranch,
                        onRefreshGitBranches: model.refreshGitBranches
                    )
                    .padding(.horizontal, 8)
                }
            } else {
                replyComposer
            }
        }
        .font(AppFont.body())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-bottom-accessory")
    }

    private var replyComposer: some View {
        HStack(spacing: placement == .inline ? 6 : 10) {
            Menu {
                Button("Attach File", systemImage: "paperclip", action: model.attachFile)
                Button("Photos", systemImage: "photo.on.rectangle", action: model.attachPhoto)
                Button("Camera", systemImage: "camera", action: model.takePhoto)
                    .disabled(!model.isCameraAvailable)
            } label: {
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .regular))
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(model.isAttachmentDisabled)
            .accessibilityLabel("Composer options")

            Button(action: model.activate) {
                Text("Reply…")
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .frame(maxWidth: .infinity)
            .accessibilityLabel("Reply")

            Button(action: model.showsStop ? model.stop : model.startVoiceInput) {
                Image(systemName: model.showsStop ? "stop.fill" : "mic")
                    .font(.system(size: 16, weight: .semibold))
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(model.showsStop ? model.isStopDisabled : model.isVoiceDisabled)
            .accessibilityLabel(model.showsStop ? "Stop response" : "Start dictation")
        }
        .padding(.horizontal, placement == .inline ? 4 : 8)
    }
}

private struct MoreView: View {
    @Bindable var authManager: AuthManager
    let server: URL

    var body: some View {
        List {
            NavigationLink {
                SkillsView(server: server, onAPIError: authManager.handleAPIError)
            } label: {
                Label("Skills", systemImage: "hammer")
            }

            NavigationLink {
                MemoryView(server: server, onAPIError: authManager.handleAPIError)
            } label: {
                Label("Memory", systemImage: "brain")
            }

            NavigationLink {
                InsightsView(server: server, onAPIError: authManager.handleAPIError)
            } label: {
                Label("Insights", systemImage: "chart.bar")
            }

            NavigationLink {
                SettingsView(authManager: authManager, server: server)
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
        }
        .navigationTitle("More")
        .navigationBarTitleDisplayMode(.inline)
    }
}

#Preview {
    ContentView(authManager: AuthManager())
}

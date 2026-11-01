import SwiftUI
import SwiftData
import UIKit
import TalariaKit

@MainActor
struct SessionListView: View {
    @Bindable var authManager: AuthManager
    let server: URL
    private let draftStore: ChatDraftStore
    @Binding private var pendingSharedImport: SharedImportReservation?
    private let didRoutePendingSharedImport: (SharedImportReservation) -> Void
    private let hasWaitingSharedImport: Bool
    private let openNextSharedImport: () -> Void
    @Binding private var pendingDeepLinkedSessionID: String?
    @Binding private var pendingQuotaSourceID: String?
    @Binding private var opensProviderQuotaWidgetSettings: Bool
    @Binding private var requestedNewChat: NewChatRequest?

    @Environment(\.modelContext) private var observedModelContext
    @Environment(\.horizontalSizeClass) private var observedHorizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.layoutDirection) private var observedLayoutDirection
    @Environment(\.accessibilityReduceMotion) private var observedReduceMotion
    @Environment(\.scenePhase) private var observedScenePhase
    @State private var viewModel: SessionListViewModel
    // Installed once after State bindings are mounted; its immutable handlers share this list's lifetime.
    @State private var sessionActionContext: SessionActionContext?
    // Cached handlers read current environment inputs through the stable, non-observed context.
    private var modelContext: ModelContext { sessionActionContext?.modelContext ?? observedModelContext }
    private var layoutDirection: LayoutDirection { sessionActionContext?.layoutDirection ?? observedLayoutDirection }
    private var reduceMotion: Bool { sessionActionContext?.reduceMotion ?? observedReduceMotion }
    private var scenePhase: ScenePhase { sessionActionContext?.scenePhase ?? observedScenePhase }
    @State private var quotaViewModel: ProvidersViewModel
    @State private var updateNotificationViewModel: UpdateNotificationCenterViewModel
    @State private var sectionViewModels: SectionViewModels
    /// The open chat, kept above both width layouts so opening or closing an iPhone Duo hands it over (TAL-1477).
    @State private var chats: ChatViewModelCache
    private struct RemovedSessionNavigation {
        let state: SessionNavigationState
        let revision: Int
    }
    @State private var removedSessionNavigation: [String: RemovedSessionNavigation] = [:]
    @State private var navigationState: SessionNavigationState
    @State private var conversationRootHasAppeared = false
    @State private var isPresentingSettings = false
    @State private var isSessionEventStreamLive = false
    /// The monitor id the last run started with, so a restart can tell the list just came back on screen.
    @State private var lastActiveSessionMonitorTaskID: SessionListAutoRefresh.ActiveRowTaskID?
    @State private var settingsPath: [SettingsPane] = []
    @State private var pendingSettingsPath: [SettingsPane]?
    @State private var reopensSidebarAfterModal = false
    @State private var sidebarFeedback: FeedbackComposer?
    /// The regular-width split view's own width, which sizes its columns (TAL-1453).
    @State private var observedSidebarLayout = SidebarLayoutInputs()
    @State private var appliedSidebarLayout: SidebarLayoutInputs?
    @State private var sidebarLayoutSettlement = DivisionRegionSettlement<SidebarLayoutInputs>()
    @State private var sidebarLayoutResumeTask: Task<Void, Never>?
    @State private var isResumingSidebarLayout = false
    @State private var restoredSidebarIsLandscape: Bool?
    private var horizontalSizeClass: UserInterfaceSizeClass? {
        if let sizeClass = appliedSidebarLayout?.sizeClass { return sizeClass }
        if let sessionActionContext { return sessionActionContext.horizontalSizeClass }
        return observedHorizontalSizeClass
    }
    private var splitGeometry: DivisionRegionGeometry { appliedSidebarLayout?.geometry ?? DivisionRegionGeometry() }
    private var regularSplitWidth: CGFloat { splitGeometry.frame.width }
    @Environment(\.chatDivisionFramesForTesting) private var divisionFramesForTesting
    /// Read live by the chat being replaced, whose own environment still says regular (TAL-1477).
    @State private var isCompactWidth = false

    private var foldedSidebarWidth: CGFloat? {
        DivisionRegionLayout.sidebarWidth(in: splitGeometry.frame, divisions: splitGeometry.divisions,
            layoutDirection: layoutDirection)
    }
    /// The native primary includes the hinge gap; its visible sidebar content stays in the usable leading pane.
    private var foldedColumnWidth: CGFloat? {
        guard foldedSidebarWidth != nil else { return nil }
        let chat = DivisionRegionLayout.availableFrame(in: splitGeometry.frame, divisions: splitGeometry.divisions,
            layoutDirection: layoutDirection, avoidsHorizontalDivisions: false)
        return regularSplitWidth - chat.width
    }
    /// The split view's height with its bars and the keyboard: whether a chat's companion page fits beside it reads it
    /// as the page's arrangement measures itself, so the keyboard showing does not bring the sidebar back (TAL-1458).
    private var regularSplitFullSize: CGSize { appliedSidebarLayout?.splitSize ?? .zero }
    private var detailHasVerticalBar: Bool { appliedSidebarLayout?.hasVerticalBar ?? false }
    @State private var nativeFilesInspectorPresented = false
    @State private var detailHasInspectorRoom = false
    @State private var filesInspectorOpeningIsLandscape: Bool?
    @State private var nativeColumnVisibility = NavigationSplitViewVisibility.detailOnly
    @State private var targetChatWidth: CGFloat?
    @State private var measuredSidebarWidth: CGFloat?
    @State private var columnFoldWidth: CGFloat?
    @State private var columnUpdateRevision = 0
    @State private var isPreparingColumn = false
    @State private var isApplyingSidebarLayout = false
    private var regularSplitFullHeight: CGFloat { regularSplitFullSize.height }
    @AppStorage(SessionSidebarDisclosureSettings.regularPortraitVisibilityKey)
    private var portraitSidebarVisibility = ""
    @AppStorage(SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey)
    private var landscapeSidebarVisibility = ""
    @State private var emptyChatRoute = PendingNewChatRoute(isExplicit: false)
    /// Re-reported after unfolding, once the regular chat and its header have mounted.
    @State private var regularWidthChat: SessionSummary?
    @State private var chatShowsEmptyTranscript = true
    @State private var sessionPendingRename: SessionSummary?
    @State private var sessionPendingDeletion: SessionSummary?
    @State private var isConfirmingBulkDelete = false
    @State private var sessionPendingProjectCreation: SessionSummary?
    @State private var sessionExportShareItem: SessionExportShareItem?
    @State private var isPresentingProjectCreation = false
    @State private var isPresentingAddServer = false
    @State private var projectPendingDeletion: ProjectSummary?
    @State private var projectPendingRename: ProjectSummary?
    @State private var appSidebarQuotaSources: [ProviderQuotaWidgetSource] = []
    @AppStorage(ProviderQuotaSidebarSettings.firstSourceKey) private var firstSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaSidebarSettings.secondSourceKey) private var secondSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaVisibilitySettings.storageKey) private var hiddenProviderData = Data()
    @AppStorage(
        ProviderQuotaDisplaySettings.aliasesKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var providerAliasesData = Data()
    @AppStorage(
        ProviderQuotaPercentageMode.storageKey,
        store: ProviderQuotaWidgetSnapshotStore.appGroupDefaults
    ) private var quotaPercentageModeRawValue = ProviderQuotaPercentageMode.defaultValue.rawValue
    @State private var sidebarSearch = SidebarSearchPull()
    private var searchText: String { sidebarSearch.text }
    @State private var selectedProjectID: String?
    @State private var sidebarScrollPosition: String?
    /// The app's one hinge read (TAL-1460), for the tent pose's run cards.
    @State private var observedHingeStatus: SessionRunMonitor.HingeStatus?
    private var hingeStatus: SessionRunMonitor.HingeStatus? {
        if let appliedSidebarLayout { return appliedSidebarLayout.hingeStatus }
        return observedHingeStatus
    }
    @State private var appSidebar = AppSidebarPresentation()
    @State private var isPresentingUpdateNotifications: Bool
    @AccessibilityFocusState private var openNavigationIsFocused: Bool
    @AccessibilityFocusState private var archiveUndoIsFocused: Bool
    @State private var didCompleteInitialLoad = false
    @State private var immediateRefreshID: UUID?
    @AppStorage(SessionSidebarDisclosureSettings.scheduledSessionsAreExpandedKey)
    private var scheduledSessionsAreExpanded = SessionSidebarDisclosureSettings.defaultScheduledSessionsAreExpanded
    @AppStorage(SessionSidebarDisclosureSettings.webhookSessionsAreExpandedKey)
    private var webhookSessionsAreExpanded = SessionSidebarDisclosureSettings.defaultWebhookSessionsAreExpanded
    @AppStorage(SessionRowDisplaySettings.showCronSessionsKey) private var showsCronSessions = true
    @AppStorage(SessionRowDisplaySettings.showWebhookSessionsKey)
    private var showsWebhookSessions = SessionRowDisplaySettings.showsWebhookSessions()
    @AppStorage(SessionRowDisplaySettings.showSubagentSessionsKey)
    private var showsSubagentSessions = SessionRowDisplaySettings.defaultShowsSubagentSessions
    @AppStorage(SectionVisibilitySettings.tasksKey) private var showsTasksSection = true
    @AppStorage(SectionVisibilitySettings.kanbanKey) private var showsKanbanSection = true
    @AppStorage(SectionVisibilitySettings.skillsKey) private var showsSkillsSection = true
    @AppStorage(SectionVisibilitySettings.memoryKey) private var showsMemorySection = true
    @AppStorage(SectionVisibilitySettings.insightsKey) private var showsInsightsSection = true
    @AppStorage(SectionVisibilitySettings.sidebarFeedbackKey)
    private var showsSidebarFeedbackButton = SectionVisibilitySettings.defaultShowsSidebarFeedbackButton
    @AppStorage(ProviderQuotaRefreshInterval.storageKey)
    private var quotaRefreshIntervalSeconds = ProviderQuotaRefreshInterval.defaultValue.rawValue
    // Per-server key (#19): the CLI toggle mirrors the active server's
    // `show_cli_sessions`, so its cached value must not leak across servers.
    // Configured in `init`, where the server URL is known.
    @AppStorage private var showsCliSessions: Bool
    @AppStorage private var showsClaudeCodeSessions: Bool
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex
    @AppStorage(PrimaryActionTintSettings.isEnabledKey) private var tintsPrimaryActions = false
    @AppStorage(AppHaptics.isEnabledKey) private var isHapticsEnabled = true

    init(
        authManager: AuthManager,
        server: URL,
        modelContext: ModelContext? = nil,
        pendingSharedImport: Binding<SharedImportReservation?> = .constant(nil),
        didRoutePendingSharedImport: @escaping (SharedImportReservation) -> Void = { _ in },
        hasWaitingSharedImport: Bool = false,
        openNextSharedImport: @escaping () -> Void = {},
        pendingDeepLinkedSessionID: Binding<String?> = .constant(nil),
        pendingQuotaSourceID: Binding<String?> = .constant(nil),
        opensProviderQuotaWidgetSettings: Binding<Bool> = .constant(false),
        requestedNewChat: Binding<NewChatRequest?> = .constant(nil),
        draftStore: ChatDraftStore? = nil,
        chats: ChatViewModelCache? = nil,
        viewModel: SessionListViewModel? = nil
    ) {
        self.authManager = authManager
        self.server = server
        _pendingSharedImport = pendingSharedImport
        self.didRoutePendingSharedImport = didRoutePendingSharedImport
        self.hasWaitingSharedImport = hasWaitingSharedImport
        self.openNextSharedImport = openNextSharedImport
        self.draftStore = draftStore ?? .shared
        _pendingDeepLinkedSessionID = pendingDeepLinkedSessionID
        _pendingQuotaSourceID = pendingQuotaSourceID
        _opensProviderQuotaWidgetSettings = opensProviderQuotaWidgetSettings
        _requestedNewChat = requestedNewChat
        var archiveUndoLifetime = SessionListViewModel.defaultArchiveUndoLifetime
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.holdArchiveUndoArgument) {
            archiveUndoLifetime = .seconds(24 * 60 * 60)
        }
        #endif
        let list = viewModel ?? SessionListViewModel(
            server: server,
            responseCache: .app(server: server),
            archiveUndoLifetime: archiveUndoLifetime
        )
        if let modelContext { list.paintCachedStateIfEmpty(modelContext: modelContext) }
        _viewModel = State(initialValue: list)
        _quotaViewModel = State(initialValue: ProvidersViewModel(server: server))
        _updateNotificationViewModel = State(initialValue: UpdateNotificationCenterViewModel(server: server))
        _sectionViewModels = State(initialValue: SectionViewModels(server: server))
        _chats = State(initialValue: chats ?? ChatViewModelCache())
        #if DEBUG
        _isPresentingUpdateNotifications = State(
            initialValue: ProcessInfo.processInfo.arguments.contains(UITestFixtureEnvironment.updateNotificationsArgument)
        )
        #else
        _isPresentingUpdateNotifications = State(initialValue: false)
        #endif
        var navigation = SessionNavigationState(lastSelectedSessionID: SessionNavigationPersistence.load(for: server))
        let hasExplicitRoute = pendingSharedImport.wrappedValue != nil
            || requestedNewChat.wrappedValue != nil || pendingQuotaSourceID.wrappedValue != nil
            || opensProviderQuotaWidgetSettings.wrappedValue || hasWaitingSharedImport
            || AppIntentRouter.shared.pendingDeepLink != nil
        if let session = navigation.sessionToRestore(
            from: list.sessions,
            allowsAutomaticRestore: !hasExplicitRoute,
            clearsMissingSelection: false,
            pendingDeepLinkedSessionID: pendingDeepLinkedSessionID.wrappedValue
        ) {
            navigation.select(session)
        }
        _navigationState = State(initialValue: navigation)
        _showsCliSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsCliSessions(for: server),
            SessionRowDisplaySettings.showCliSessionsKey(for: server)
        )
        _showsClaudeCodeSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsClaudeCodeSessions(for: server),
            SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: server)
        )
    }

    private var sessionListWithPresentations: some View {
        sidebarLayout
            .environment(\.sessionActions, sessionActionContext)
            .onReceive(NotificationCenter.default.publisher(for: .talariaSessionRemovalsChanged, object: viewModel)) { notification in
                guard let ids = notification.userInfo?[SessionListViewModel.removalSessionIDsKey] as? Set<String> else { return }
                reconcileRemovedSessionNavigation(ids)
            }
            .onChange(of: retainedChatSessionIDs) { _, sessionIDs in
                chats.keepOnly(sessionIDs: sessionIDs)
            }
            .onChange(of: viewModel.activeProfileName) {
                sectionViewModels = SectionViewModels(server: server)
            }
            .modifier(SessionListHingeReader(status: $observedHingeStatus))
            .safeAreaInset(edge: .top, spacing: 0) {
                if hasWaitingSharedImport { waitingSharedImportBanner }
            }
            .sheet(isPresented: $isPresentingSettings, onDismiss: settingsDidDismiss) {
                settingsNavigationStack
                    .presentationDetents([.large])
                    .adaptivePagePresentation(width: horizontalSizeClass == .regular && regularSplitWidth > 0
                        ? min(650, max(0, regularSplitWidth - 48)) : nil)
                    .presentationCompactAdaptation(.fullScreenCover)
            }
            .feedbackPresentation(sidebarFeedback, isEnabled: !isPresentingSettings && !isPresentingUpdateNotifications,
                                  onDismiss: sidebarModalDidDismiss)
            // The sign-in sheet presents from the app root, which cannot stack it over these sheets: close them so a
            // session loss or a Settings "Sign In Again" (TAL-48) always reaches it.
            .onChange(of: authManager.pendingReauthentication) { _, server in
                guard server != nil else { return }
                isPresentingSettings = false
                isPresentingUpdateNotifications = false
                sidebarFeedback?.isPresented = false
            }
            .sheet(isPresented: $isPresentingUpdateNotifications, onDismiss: {
                guard let path = pendingSettingsPath else { return }
                pendingSettingsPath = nil
                presentSettings(path: path)
            }) {
                UpdateNotificationsSheet(
                    viewModel: updateNotificationViewModel,
                    onAPIError: { authManager.handleAPIError($0, server: server) },
                    openDestination: openNotificationDestination
                )
                .presentationDetents([.large])
                .presentationDragIndicator(.visible)
                .adaptiveFormPresentation()
            }
            .sheet(item: $sessionExportShareItem) { item in
                SessionExportShareSheet(fileURL: item.fileURL)
                    .presentationDetents([.medium, .large])
                    .adaptiveFormPresentation()
                    .ignoresSafeArea()
                    // The temp file lives in its own UUID directory (see
                    // SessionListViewModel.export); remove the directory once
                    // the share sheet is gone, shared and cancelled alike.
                    .onDisappear {
                        try? FileManager.default.removeItem(
                            at: item.fileURL.deletingLastPathComponent()
                        )
                    }
            }
            .sheet(item: $sessionPendingRename) { session in
                SessionRenameSheet(
                    initialTitle: SessionRowPresentation.displayTitle(for: session),
                    isSaving: viewModel.isMutating(session)
                ) {
                    sessionPendingRename = nil
                } onSave: { title in
                    Task {
                        guard let session = sessionPendingRename else { return }

                        let didRename = await rename(session, to: title)
                        if didRename {
                            sessionPendingRename = nil
                        }
                    }
                }
                .presentationDetents([.height(180), .medium])
            }
            .sheet(item: $sessionPendingProjectCreation) { session in
                ProjectCreationSheet(
                    existingProjectCount: viewModel.projects.count,
                    isSaving: viewModel.isCreatingProject || viewModel.isMovingSession
                ) {
                    sessionPendingProjectCreation = nil
                } onSave: { name, color in
                    Task {
                        let didMove = await viewModel.createProject(
                            named: name,
                            color: color,
                            moving: session,
                            modelContext: modelContext
                        )
                        handleLastError()

                        if didMove {
                            sessionPendingProjectCreation = nil
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .sheet(isPresented: $isPresentingProjectCreation) {
                ProjectCreationSheet(
                    existingProjectCount: viewModel.projects.count,
                    isSaving: viewModel.isCreatingProject
                ) {
                    isPresentingProjectCreation = false
                } onSave: { name, color in
                    Task {
                        let didCreate = await viewModel.createEmptyProject(
                            named: name,
                            color: color,
                            modelContext: modelContext
                        )
                        handleLastError()

                        if didCreate {
                            isPresentingProjectCreation = false
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .sheet(item: $projectPendingRename) { project in
                ProjectRenameSheet(
                    project: project,
                    isSaving: viewModel.pendingChange(for: project) != nil
                ) {
                    projectPendingRename = nil
                } onSave: { name, color in
                    Task {
                        let didRename = await viewModel.rename(project, named: name, color: color)
                        handleLastError()

                        if didRename {
                            projectPendingRename = nil
                        }
                    }
                }
                .presentationDetents([.medium])
            }
            .sheet(isPresented: $isPresentingAddServer) {
                // Reuse #17's add-server flow directly as a power-user shortcut.
                // On success `addServer` switches the active server, which
                // rebuilds this stack via ContentView's `.id(server)` (#283).
                AddServerView(authManager: authManager)
            }
    }

    var body: some View {
        refreshSessionActionInputs()
        return sessionListWithPresentations
            .task {
                // Start the normal refresh immediately so a slow direct session
                // request cannot leave the sidebar empty. The launch root was already
                // resolved from local data; only explicit deep links can navigate here.
                await SessionListInitialLoad.run(
                    resolvePendingDeepLink: {
                        await openPendingDeepLinkedSessionIfNeeded()
                    },
                    refreshSessionsAndActiveProfile: {
                        await refreshSessionsAndActiveProfile()
                    }
                )
                guard !Task.isCancelled else { return }
                didCompleteInitialLoad = true
            }
            .task(id: remoteSearchTaskID) {
                await viewModel.searchSessions(
                    query: searchText,
                    selectedProjectID: selectedProjectID,
                    automatedVisibility: automatedSessionVisibility,
                    content: true,
                    depth: 5
                )
            }
            .task(id: activeSessionMonitorTaskID) {
                let taskID = activeSessionMonitorTaskID
                let previous = lastActiveSessionMonitorTaskID
                lastActiveSessionMonitorTaskID = taskID
                await SessionListAutoRefresh.monitorActiveRows(taskID, resumingFrom: previous) {
                    let refreshResult = await viewModel.refreshActiveSessionStatesIfNeeded(
                        streamIDs: taskID.streamIDs,
                        modelContext: modelContext
                    )
                    if refreshResult == .reloaded || refreshResult == .failed {
                        handleLastError()
                    }
                }
            }
            .task(id: providerQuotaRefreshTaskID) {
                guard scenePhase == .active else { return }
                await quotaViewModel.refreshQuotasPeriodically(
                    every: ProviderQuotaRefreshInterval.storedValue(quotaRefreshIntervalSeconds).duration
                )
            }
            .task(id: immediateRefreshID) {
                guard immediateRefreshID != nil else { return }
                await refreshSessionsAndActiveProfile()
            }
            .task(id: executionModesTaskID) {
                guard scenePhase == .active else { return }
                await viewModel.loadExecutionModes()
            }
            .task(id: sessionEventsTaskID) {
                guard scenePhase == .active else { return }
                // The app's one subscription to server-announced changes (TAL-434): the list
                // refreshes itself, and every open screen hears it through `refreshesLive`.
                await SessionEventsMonitor.run(
                    url: Endpoint.sessionEvents.url(relativeTo: server),
                    client: SessionEventStreamClient(),
                    onChange: { change in
                        NotificationCenter.default.post(
                            name: .talariaSessionsChanged,
                            object: server,
                            userInfo: [SessionsChange.userInfoKey: change]
                        )
                        Task { await refreshSessionsAndActiveProfile() }
                    },
                    onLiveChange: { isSessionEventStreamLive = $0 }
                )
            }
            .task(id: autoRefreshTaskID) {
                guard autoRefreshTaskID.isEnabled else { return }
                await SessionListAutoRefresh.run(
                    // The cold-start task already owns the first request; a
                    // later restart means the app foregrounded or the list came
                    // back on screen, which both want fresh rows right away.
                    refreshesImmediately: didCompleteInitialLoad,
                    refresh: { await refreshSessionsAndActiveProfile() }
                )
            }
            .onAppear {
                if sessionActionContext == nil {
                    sessionActionContext = SessionActionContext(
                        viewModel: viewModel, actions: makeSessionRowActions(),
                        onAPIError: { authManager.handleAPIError($0, server: server) },
                        filesInspector: makeSplitFilesInspector()
                    )
                    refreshSessionActionInputs()
                }
                // TAL-437: the last-known chats, projects and profile show at once; the initial
                // load then replaces them.
                viewModel.paintCachedStateIfEmpty(modelContext: modelContext)
                reloadAppSidebarQuotaSources()
                openPendingSharedImportIfNeeded()
                openPendingQuotaSourceIfNeeded()
                openProviderQuotaWidgetSettingsIfNeeded()
                openRequestedNewChatIfNeeded()
                refreshAfterReturningIfNeeded()
            }
            .onReceive(NotificationCenter.default.publisher(for: .talariaReauthenticated)) { notification in
                guard notification.object as? URL == server else { return }
                Task { await refreshSessionsAndActiveProfile() }
            }
            .onChange(of: pendingSharedImport) {
                openPendingSharedImportIfNeeded()
            }
            .onChange(of: pendingDeepLinkedSessionID) {
                Task { await openPendingDeepLinkedSessionIfNeeded() }
            }
            .onChange(of: pendingQuotaSourceID) {
                openPendingQuotaSourceIfNeeded()
            }
            .onChange(of: opensProviderQuotaWidgetSettings) {
                openProviderQuotaWidgetSettingsIfNeeded()
            }
            .onChange(of: requestedNewChat) {
                openRequestedNewChatIfNeeded()
            }
            .onChange(of: navigationState.filesInspectorPresented) { _, presented in
                if !presented { setFilesInspectorPresented(false) }
            }
            .onChange(of: nativeFilesInspectorPresented) { _, presented in
                if !presented || !sidebarPresentation.showsFilesInspector { setFilesInspectorPresented(false) }
            }
            .onReceive(
                NotificationCenter.default.publisher(for: .talariaSessionNotificationArrived)
            ) { _ in
                refreshForSessionNotification()
            }
            .onChange(of: navigationState.destination) { oldValue, newValue in
                SessionListReturnRefresh.run(
                    from: oldValue,
                    to: newValue,
                    suppressEmptyPlaceholders: viewModel.removeEmptySidebarPlaceholders,
                    refreshSessions: refreshAfterReturningIfNeeded
                )
            }
            .modifier(
                SessionActionConfirmations(
                    viewModel: viewModel,
                    sessionPendingDeletion: $sessionPendingDeletion,
                    isConfirmingBulkDelete: $isConfirmingBulkDelete,
                    projectPendingDeletion: $projectPendingDeletion,
                    deleteSession: { session in
                        Task { await delete(session) }
                    },
                    deleteSelectedSessions: {
                        Task { await performBulkAction(.delete) }
                    },
                    deleteProject: { project in
                        Task { await delete(project) }
                    }
                )
            )
            .focusedSceneValue(\.talariaSceneActions, sceneActions)
            .task(id: updateNotificationRefreshTaskID) {
                await refreshUpdateNotificationsWhileActive()
            }
    }

    private var sidebarLayout: some View {
        AppSidebarContainer(
            presentation: appSidebar,
            fillsSafeArea: isDuoOuterSidebar,
            isEnabled: sidebarDrawerIsEnabled,
            overlaysContent: sidebarPresentation.overlaysContent,
            collapsesNativeSidebar: !sidebarPresentation.tiled,
            onPresentationChange: appSidebarPresentationChanged
        ) { presented in
            if !sidebarPresentation.tiled {
                sharedSidebar(isPresented: presented, isDrawer: true)
            }
        } content: {
            navigationSurface
        }
        .onGeometryChange(for: CGSize.self) { geometry in
            CGSize(width: geometry.size.width + geometry.safeAreaInsets.leading + geometry.safeAreaInsets.trailing,
                   height: geometry.sizeIncludingSafeArea.height)
        } action: { size in
            observeSidebarLayout { $0.splitSize = size }
        }
        .onAppear { observeSidebarLayout() }
        .onChange(of: observedHorizontalSizeClass) { observeSidebarLayout() }
        .onChange(of: observedHingeStatus) { previous, status in
            // A fold always closes Files. Dismiss the native inspector as soon as the hinge leaves fully open,
            // before the collapsing split can carry the presentation onto the outer display as an empty sheet;
            // layout admission settles too late for that.
            if previous == .fullyOpen, status != .fullyOpen, nativeFilesInspectorPresented {
                withTransaction(.unanimated) {
                    navigationState.filesInspectorPresented = false
                    navigationState.chatShowsFilesInspector = false
                    nativeFilesInspectorPresented = false
                }
            }
            observeSidebarLayout()
        }
        .onChange(of: scenePhase, initial: true) {
            sidebarLayoutResumeTask?.cancel()
            columnUpdateRevision += 1
            isPreparingColumn = false
            if scenePhase == .active { observeSidebarLayout() }
            else { isResumingSidebarLayout = appliedSidebarLayout != nil }
        }
        .onChange(of: sidebarPresentation, initial: true) { updateSidebarColumn() }
        .onDisappear { sidebarLayoutResumeTask?.cancel() }
    }

    private var sidebarDrawerIsEnabled: Bool { sidebarPresentation.drawerEnabled }

    /// A hinge context is present on the Duo, including its folded outer display.
    private var isDuoOuterSidebar: Bool {
        horizontalSizeClass == .compact && hingeStatus != nil
    }

    private var navigationSurface: some View {
        ZStack {
            Color(.systemBackground)
            navigationContainer
                .environment(\.divisionRegionGeometry, splitGeometry)
                .environment(\.holdsForegroundLayout, scenePhase != .active || isResumingSidebarLayout)
                .environment(\.targetChatLayoutWidth, targetChatWidth)
                .onSettledGeometryChange(for: DivisionRegionGeometry.self, hingeStatus: hingeStatus,
                    requiresSettlement: { $1.needsHingeSettlement(comparedTo: $0) }) { geometry in
                    DivisionRegionGeometry(geometry, divisions: divisionFramesForTesting)
                } action: { geometry in
                    observeSidebarLayout { $0.geometry = geometry }
                }
        }
    }

    private func sharedSidebar(isPresented: Bool = false, isDrawer: Bool = false) -> some View {
        AppSidebar(
            presentation: appSidebar,
            searchPull: sidebarSearch,
            searchUsesBottomBar: horizontalSizeClass == .compact,
            isActive: isDrawer ? sidebarPresentation.drawerEnabled && appSidebar.isVisible : sidebarPresentation.showsColumn,
            quotaSources: appSidebarQuotaSources,
            selectedQuotaSourceID: insightsQuotaSourceID,
            selection: navigationState.section,
            sectionVisibility: appSidebarSectionVisibility,
            select: openSection
        ) { header, searchPull in
            sessionListSurface(sidebarHeader: header, searchPull: searchPull)
        } actions: { isSearching in
            if #available(iOS 27.1, *) {
                if !isSearching {
                    ToolbarItem(placement: .principal) { sidebarWordmark }
                        .sharedBackgroundVisibility(.hidden)
                        .axisBehavior(.horizontalOnly)
                }
            } else {
                if !isSearching {
                    if #available(iOS 26.0, *) {
                        ToolbarItem(placement: .principal) { sidebarWordmark }
                            .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .principal) { sidebarWordmark }
                    }
                }
            }
            if !detailHostsSidebarActions {
                sidebarSettingsActions(placement: horizontalSizeClass == .compact ? .bottomBar : .topBarTrailing,
                                       prefersVertical: horizontalSizeClass == .compact)
            }
            if sidebarDrawerIsEnabled {
                ToolbarItem(placement: .topBarLeading) { sidebarButton(isPresented: isPresented) }
                    .overflowPriority(.drawer, includesHorizontal: true)
            }
            if viewModel.isSelectingSessions {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: viewModel.endSelectingSessions)
                        .disabled(viewModel.isPerformingBulkAction)
                }
                .overflowPriority(.done, includesHorizontal: true)
            } else if !detailHostsSidebarActions {
                ToolbarItem(placement: .topBarTrailing) {
                    regularNewChatButton
                        .buttonStyle(.borderedProminent)
                        .tint(newSessionButtonUsesThemeColor ? selectedHeaderLogoColor : .accentColor)
                }
                .overflowPriority(.newChat, includesHorizontal: true)
            }
            ToolbarItem(placement: .topBarTrailing) {
                sidebarFilters
            }
            .overflowPriority(.filters, includesHorizontal: true)
        }
        .environment(\.sessionRowStyle, .sidebar)
        .onChange(of: quotaViewModel.quotaSources) { reloadAppSidebarQuotaSources() }
        .onChange(of: quotaViewModel.quotaProfileID) { reloadAppSidebarQuotaSources() }
        .onChange(of: firstSidebarQuotaSourceID) { reloadAppSidebarQuotaSources() }
        .onChange(of: secondSidebarQuotaSourceID) { reloadAppSidebarQuotaSources() }
        .onChange(of: hiddenProviderData) { reloadAppSidebarQuotaSources() }
    }

    private func reloadAppSidebarQuotaSources() {
        let selectedIDs = ProviderQuotaSidebarSettings.sourceIDs(
            first: firstSidebarQuotaSourceID, second: secondSidebarQuotaSourceID
        )
        // The shared quota owner writes this snapshot; never show another server/profile's accounts.
        let sources: [ProviderQuotaWidgetSource]
        if let snapshot = ProviderQuotaWidgetSnapshotStore().load(),
           let profileID = quotaViewModel.quotaProfileID,
           snapshot.serverID == ResponseCache.serverIdentity(for: server), snapshot.profileID == profileID {
            sources = snapshot.sources
        } else {
            sources = []
        }
        let hiddenProviderIDs = ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: hiddenProviderData)
        let byID = Dictionary(uniqueKeysWithValues: sources.map { ($0.sourceID, $0) })
        let quotaSources = selectedIDs.compactMap { byID[$0] }.filter { source in
            guard let providerID = source.providerID?.lowercased() else { return true }
            return !hiddenProviderIDs.contains(providerID)
        }
        if appSidebarQuotaSources != quotaSources { appSidebarQuotaSources = quotaSources }
    }

    private var sidebarWordmark: some View {
        Image("TalariaWordmark")
            .resizable()
            .scaledToFit()
            .frame(width: 90, height: 22)
            .accessibilityLabel("Talaria")
    }

    private var sidebarFilters: some View {
        SessionFilterControls(
            viewModel: viewModel,
            selectedProjectID: $selectedProjectID,
            projectPendingDeletion: $projectPendingDeletion,
            projectPendingRename: $projectPendingRename,
            switchActiveProfile: { profile in
                Task { await switchActiveProfile(profile) }
            },
            presentProjectCreation: {
                isPresentingProjectCreation = true
            }
        )
    }

    private var waitingSharedImportBanner: some View {
        HStack(spacing: 12) {
            Image(systemName: "square.and.arrow.down")
                .foregroundStyle(.secondary)

            VStack(alignment: .leading, spacing: 2) {
                Text("Another shared item is waiting")
                    .font(.subheadline.weight(.semibold))
                Text("Open it when you are done with this draft.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 0)

            Button("Open Next", action: openNextSharedImport)
                .font(.subheadline.weight(.semibold))
                .buttonStyle(.bordered)
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder
    private var navigationContainer: some View {
        if horizontalSizeClass == .regular {
            NavigationSplitView(columnVisibility: regularColumnVisibility) {
                sharedSidebar()
                    .frame(width: foldedSidebarWidth)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color(.systemBackground))
                    .clipped()
                    .toolbar(removing: .sidebarToggle)
                    .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width in
                        guard scenePhase == .active, !isResumingSidebarLayout,
                              foldedSidebarWidth == nil, columnFoldWidth == nil,
                              width > 0, width <= regularSplitWidth - RegularSplitLayout.detailMinWidth,
                              measuredSidebarWidth != width else { return }
                        measuredSidebarWidth = width
                        updateSidebarColumn()
                    }
                    .navigationSplitViewColumnWidth(
                        min: columnFoldWidth ?? RegularSplitLayout.sidebarMinWidth,
                        ideal: columnFoldWidth ?? sidebarColumnWidth,
                        max: columnFoldWidth ?? RegularSplitLayout.sidebarMaxWidth
                    )
            } detail: {
                conversationStack
                    // The live size class, not the admitted layout: a fold that is still settling must not let the
                    // collapsing split re-present the inspector as an empty sheet on the outer display.
                    .inspector(isPresented: Binding(
                        get: { nativeFilesInspectorPresented && observedHorizontalSizeClass == .regular },
                        set: { nativeFilesInspectorPresented = $0 }
                    )) {
                        if let regularWidthChat {
                            FilesInspectorContent(
                                session: regularWidthChat,
                                server: server,
                                onAPIError: { authManager.handleAPIError($0, server: server) },
                                onClose: { splitFilesInspector.isPresented.wrappedValue = false },
                                isPresented: sidebarPresentation.showsFilesInspector
                            )
                            .id(regularWidthChat.id)
                            .background(Color(.secondarySystemBackground).ignoresSafeArea())
                            .ignoresSafeArea(.container, edges: [.top, .bottom])
                            .presentationBackground(Color(.secondarySystemBackground))
                            .presentationCornerRadius(0)
                            .inspectorColumnWidth(min: 280, ideal: 340, max: 520)
                        }
                    }
                    .onGeometryChange(for: Bool?.self, of: { geometry in
                        geometry.size.width > 0 ? geometry.size.width >= RegularSplitLayout.filesInspectorChatWidth : nil
                    }) { hasRoom in
                        guard let hasRoom, scenePhase == .active, !isResumingSidebarLayout else { return }
                        detailHasInspectorRoom = hasRoom
                        reconcileFilesInspector()
                    }
                    .foldAvoidingPlacement(avoidsHorizontalDivisions: false,
                        isEnabled: !hidesSidebarColumn && foldedSidebarWidth == nil)
                    .navigationSplitViewColumnWidth(
                        min: RegularSplitLayout.detailMinWidth,
                        ideal: RegularSplitLayout.detailMinWidth
                    )
            }
            .navigationSplitViewStyle(.balanced)
        } else {
            conversationStack
        }
    }

    /// Both widths show the selected root and push only its inner pages.
    private var conversationStack: some View {
        let sizeClass = horizontalSizeClass
        return NavigationStack(path: sectionPath) {
            withDrawerButton(ZStack {
                navigationDestination(navigationState.destination ?? .newChat(emptyChatRoute),
                                      rootHasAppeared: conversationRootHasAppeared)
                    .id(navigationState.chatRootRevision)
            })
                .background {
                    NavigationAppearanceCompletionObserver(action: {
                        if sizeClass == horizontalSizeClass { conversationRootHasAppeared = true }
                    }, rootReplacementRevision: navigationState.chatRootRevision,
                       rootPathIsEmpty: sectionPath.wrappedValue.isEmpty)
                }
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    if showsDetailNewChatButton {
                        ToolbarItem(placement: .topBarTrailing) { regularNewChatButton }
                            .overflowPriority(.newChat)
                    }
                    updateNotificationsToolbar
                    if #available(iOS 27.1, *), detailHostsSidebarActions {
                        sidebarSettingsActions(placement: .bottomBar, prefersVertical: true)
                    }
                }
                .navigationDestination(for: CompactPage.self) { page in sectionStackPage(page) }
        }
        .environment(\.navigationHasVerticalToolbar, detailHasVerticalBar)
        .onToolbarVerticalEdgeChange { hasVerticalBar in
            observeSidebarLayout { $0.hasVerticalBar = hasVerticalBar }
        }
    }

    @ViewBuilder
    private func sectionStackPage(_ page: CompactPage) -> some View {
        Group {
            switch page {
            case .item(let item): sectionItemPage(item)
            case .session(let session):
                navigationDestination(.session(session))
                    .toolbar { updateNotificationsToolbar }
            }
        }
    }

    @ToolbarContentBuilder
    private var updateNotificationsToolbar: some ToolbarContent {
        if updateNotificationViewModel.supportsNotifications {
            if #available(iOS 27.1, *) {
                ToolbarItem(placement: detailHasVerticalBar ? .bottomBar : .topBarTrailing) {
                    updateNotificationsButton
                }
                .axisBehavior(.verticalPreferred)
                .overflowPriority(.notifications, includesHorizontal: true)
            } else {
                ToolbarItem(placement: .topBarTrailing) { updateNotificationsButton }
            }
        }
    }

    /// Admit geometry and toolbar traits together; app-switch snapshots cannot choose a layout or save a preference.
    private func observeSidebarLayout(_ update: (inout SidebarLayoutInputs) -> Void = { _ in }) {
        update(&observedSidebarLayout)
        observedSidebarLayout.sizeClass = observedHorizontalSizeClass
        observedSidebarLayout.hingeStatus = observedHingeStatus
        sidebarLayoutResumeTask?.cancel()
        guard scenePhase == .active, observedSidebarLayout.isValid else { return }
        let now = ProcessInfo.processInfo.systemUptime
        _ = sidebarLayoutSettlement.observe(observedSidebarLayout, at: now)
        guard isResumingSidebarLayout, appliedSidebarLayout != nil else {
            _ = sidebarLayoutSettlement.settle(at: now, hingeIsSettled: true)
            applySidebarLayout(observedSidebarLayout)
            return
        }
        sidebarLayoutResumeTask = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(DivisionRegionSettlement<SidebarLayoutInputs>.quietPeriod)) }
            catch { return }
            guard !Task.isCancelled, scenePhase == .active, observedSidebarLayout.isValid else { return }
            _ = sidebarLayoutSettlement.settle(at: ProcessInfo.processInfo.systemUptime)
            guard let layout = sidebarLayoutSettlement.applied, layout == observedSidebarLayout else { return }
            isResumingSidebarLayout = false
            withTransaction(.unanimated) { applySidebarLayout(layout) }
        }
    }

    private func applySidebarLayout(_ layout: SidebarLayoutInputs) {
        let previouslyTiled = sidebarPresentation.tiled
        if splitGeometry.frame.width != layout.geometry.frame.width || splitGeometry.divisions != layout.geometry.divisions {
            chats.prepareForWidthChange()
        }
        isApplyingSidebarLayout = true
        defer { isApplyingSidebarLayout = false }
        withTransaction(.unanimated) {
            if let appliedSidebarLayout, appliedSidebarLayout.sizeClass != layout.sizeClass {
                conversationRootHasAppeared = false
            }
            appliedSidebarLayout = layout
            isCompactWidth = layout.sizeClass == .compact
            if isCompactWidth {
                splitFilesInspector.isPresented.wrappedValue = false
                regularWidthChat = nil
                restoredSidebarIsLandscape = nil
            } else {
                let isLandscape = SidebarPresentation.isLandscape(layout.splitSize)
                // Tiling consumes drawer intent, not the user's per-orientation choice.
                if sidebarPresentation.tiled {
                    appSidebar.isPresented = false
                } else if restoredSidebarIsLandscape != isLandscape || previouslyTiled {
                    appSidebar.isPresented = regularSidebarIsShown
                }
                restoredSidebarIsLandscape = isLandscape
            }
            reconcileSidebarColumn(previouslyTiled: previouslyTiled)
            reconcileFilesInspector()
        }
        updateSidebarColumn()
    }

    private var regularSidebarIsLandscape: Bool { SidebarPresentation.isLandscape(regularSplitFullSize) }

    private var sidebarPresentation: SidebarPresentation { sidebarPresentation(storedChoice: regularSidebarIsShown) }

    private func sidebarPresentation(storedChoice: Bool) -> SidebarPresentation {
        SidebarPresentation(
            isRegularWidth: horizontalSizeClass == .regular,
            splitSize: regularSplitFullSize,
            hasVerticalBar: detailHasVerticalBar,
            storedChoice: storedChoice,
            drawerIsPresented: appSidebar.isPresented,
            columnIsVisible: nativeColumnVisibility != .detailOnly,
            hidesSidebarColumn: navigationState.chatShowsCompanionPage && widensForCompanionPage,
            hasVerticalDivision: foldedSidebarWidth != nil,
            filesInspectorPresented: navigationState.filesInspectorPresented,
            filesInspectorIsEligible: regularWidthChat != nil
                && (navigationState.section == .chats || navigationState.selectedSectionSession != nil)
                && !(navigationState.chatShowsCompanionPage && RegularSplitLayout.splitsCompanionPage(
                    width: regularSplitWidth, height: regularSplitFullHeight)),
            filesInspectorOpeningIsLandscape: filesInspectorOpeningIsLandscape
        )
    }

    private var regularSidebarIsShown: Bool {
        let stored = regularSidebarIsLandscape ? landscapeSidebarVisibility : portraitSidebarVisibility
        return stored.isEmpty
            ? regularSidebarIsLandscape && UIDevice.current.userInterfaceIdiom == .pad && hingeStatus == nil
            : stored == "all"
    }

    private var regularColumnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding {
            sidebarPresentation.tiled ? nativeColumnVisibility : .detailOnly
        } set: { visibility in
            if sidebarPresentation.tiled { updateSidebarColumn(observedVisibility: visibility) }
            else { reconcileSidebarColumn() }
        }
    }

    private func reconcileSidebarColumn(previouslyTiled: Bool = false) {
        guard sidebarPresentation.requiresColumnCollapse(
            previouslyTiled: previouslyTiled, nativeColumnIsVisible: nativeColumnVisibility != .detailOnly
        ) else { return }
        // Cancel a queued landscape toggle before admitting the portrait layout in this same transaction.
        columnUpdateRevision += 1
        isPreparingColumn = false
        nativeColumnVisibility = .detailOnly
    }

    /// Native layout feedback and reader choices use the same transaction in both directions.
    private func updateSidebarColumn(storedChoice: Bool? = nil,
                                     observedVisibility: NavigationSplitViewVisibility? = nil) {
        guard scenePhase == .active, !isResumingSidebarLayout, appliedSidebarLayout != nil else { return }
        // A native callback during preparation must not put the previous target back.
        guard !isPreparingColumn || observedVisibility == nil || storedChoice != nil else { return }
        if let observedVisibility { nativeColumnVisibility = observedVisibility }
        withTransaction(.unanimated) {
            if storedChoice == true, widensForFilesInspector {
                navigationState.filesInspectorPresented = false
                navigationState.chatShowsFilesInspector = false
            }
            // The column takes the companion page's room, as it does Files'; the chat hides its page (TAL-1539).
            if storedChoice == true, navigationState.chatShowsCompanionPage, widensForCompanionPage {
                navigationState.companionPageHideRequest += 1
                navigationState.chatShowsCompanionPage = false
            }
            reconcileFilesInspector()
        }
        let presentation = sidebarPresentation(storedChoice: storedChoice ?? regularSidebarIsShown)
        let visibility: NavigationSplitViewVisibility = presentation.showsColumn ? .all : .detailOnly
        let width = regularChatLayoutWidth(for: presentation)
        let foldWidth = foldedColumnWidth
        // A hiding column keeps its folded width: a narrower column would snap its edge ahead of the sliding chat.
        let columnWidth = visibility == .detailOnly ? columnFoldWidth : foldWidth
        guard targetChatWidth != width || columnFoldWidth != columnWidth
                || nativeColumnVisibility != visibility || storedChoice != nil else { return }
        columnUpdateRevision += 1
        let revision = columnUpdateRevision
        // Render one destination layout before UIKit moves the pane. Its leading placement carries the fixed
        // transcript and composer together; interpolating their width would re-wrap text during the move.
        // The transcript preserves its reader when its viewport width lands, not before: a hold armed ahead of
        // the re-wrap left the old offset on screen for several frames and then corrected it (TAL-1532).
        withTransaction(.unanimated) {
            isPreparingColumn = true
            targetChatWidth = width
        }
        // Render the final chat once; only the next turn moves the native boundary.
        DispatchQueue.main.async {
            guard columnUpdateRevision == revision, scenePhase == .active, !isResumingSidebarLayout else { return }
            var transition = Transaction(animation: reduceMotion ? nil : SessionListMotion.foldAnimation(reduceMotion: false))
            transition.disablesAnimations = reduceMotion
            withTransaction(transition) {
                if let storedChoice, !presentation.columnIsForced {
                    let stored = storedChoice ? "all" : "detailOnly"
                    if regularSidebarIsLandscape { landscapeSidebarVisibility = stored }
                    else { portraitSidebarVisibility = stored }
                }
                columnFoldWidth = columnWidth
                nativeColumnVisibility = visibility
                isPreparingColumn = false
            }
            // The column hide is what makes room for a pending Files presentation; admit it on the following turn.
            if visibility == .detailOnly, navigationState.filesInspectorPresented, !nativeFilesInspectorPresented {
                DispatchQueue.main.async {
                    guard columnUpdateRevision == revision else { return }
                    reconcileFilesInspector()
                }
            }
        }
    }

    private func regularChatLayoutWidth(for presentation: SidebarPresentation) -> CGFloat? {
        guard presentation.tiled, regularSplitWidth > 0,
              !navigationState.filesInspectorPresented, !navigationState.chatShowsCompanionPage else { return nil }
        if let foldedColumnWidth { return regularSplitWidth - foldedColumnWidth }
        return max(0, regularSplitWidth - (presentation.showsColumn
            ? sidebarColumnWidth : 0))
    }

    private var sidebarColumnWidth: CGFloat {
        measuredSidebarWidth ?? RegularSplitLayout.sidebarIdealWidth(splitWidth: regularSplitWidth)
    }

    private var detailHostsSidebarActions: Bool { sidebarPresentation.hostsSidebarActionsInDetail }

    /// A chat takes the whole width while its Files inspector or companion page needs the room.
    private var hidesSidebarColumn: Bool {
        (sidebarPresentation.showsFilesInspector && widensForFilesInspector)
            || (navigationState.chatShowsCompanionPage && widensForCompanionPage)
    }

    /// Whether hiding the sidebar column is what lets a chat's companion page split beside it (TAL-1458).
    private var widensForCompanionPage: Bool {
        horizontalSizeClass == .regular
            && RegularSplitLayout.hidesSidebarForCompanionPage(splitWidth: regularSplitWidth, splitHeight: regularSplitFullHeight)
    }

    /// Whether hiding the sidebar column is what puts a chat's Files inspector beside it.
    private var widensForFilesInspector: Bool {
        horizontalSizeClass == .regular && RegularSplitLayout.hidesSidebarForFilesInspector(splitWidth: regularSplitWidth)
    }

    private var splitFilesInspector: SplitFilesInspector {
        var inspector = sessionActionContext?.filesInspector ?? makeSplitFilesInspector()
        inspector.widensChat = sidebarPresentation.filesInspectorFits
        inspector.offersCompanionPage = horizontalSizeClass == .regular
        inspector.widensForCompanionPage = widensForCompanionPage
        inspector.companionPageHideRequest = navigationState.companionPageHideRequest
        return inspector
    }

    private func makeSplitFilesInspector() -> SplitFilesInspector {
        SplitFilesInspector(
            isPresented: Binding {
                navigationState.filesInspectorPresented
            } set: { presented in
                setFilesInspectorPresented(presented)
            },
            widensChat: sidebarPresentation.filesInspectorFits,
            reportShown: { navigationState.chatShowsFilesInspector = $0 },
            reportSession: { session in
                navigationState.reportDisplayedSession(session)
                if horizontalSizeClass == .regular { regularWidthChat = session }
            },
            offersCompanionPage: horizontalSizeClass == .regular,
            reportCompanionPage: { navigationState.chatShowsCompanionPage = $0 },
            reportEmptyTranscript: { chatShowsEmptyTranscript = $0 }
        )
    }

    /// UIKit keeps the same inspector content mounted while its presentation closes across a rotation.
    /// Intent, the chat's report, and the split width target are reconciled before the native boundary moves.
    private func setFilesInspectorPresented(_ presented: Bool) {
        withTransaction(.unanimated) {
            navigationState.filesInspectorPresented = presented
            filesInspectorOpeningIsLandscape = presented ? regularSidebarIsLandscape : nil
            if !presented { navigationState.chatShowsFilesInspector = false }
            reconcileFilesInspector()
            updateSidebarColumn()
        }
    }

    private func reconcileFilesInspector() {
        let presentation = sidebarPresentation
        if presentation.dismissesFilesInspector {
            navigationState.filesInspectorPresented = false
            navigationState.chatShowsFilesInspector = false
        }
        if !navigationState.filesInspectorPresented { filesInspectorOpeningIsLandscape = nil }
        // Admit only after the column is hidden and the detail has widened; once shown, the inspector itself narrows
        // that measurement. A room measurement left over from before a fold must not present over a visible column:
        // UIKit dismisses that presentation at once, which reads as the tap doing nothing.
        nativeFilesInspectorPresented = presentation.showsFilesInspector
            && (nativeFilesInspectorPresented || !widensForFilesInspector
                || (detailHasInspectorRoom && nativeColumnVisibility == .detailOnly))
    }

    private var regularSidebarToggleButton: some View {
        Button {
            guard !sidebarPresentation.columnIsForced else { return }
            switch sidebarPresentation.toggleTarget {
            case .column:
                let opensColumn = (navigationState.filesInspectorPresented && widensForFilesInspector)
                    || (navigationState.chatShowsCompanionPage && widensForCompanionPage)
                updateSidebarColumn(storedChoice: opensColumn || !regularSidebarIsShown)
            case .drawer:
                if sidebarPresentation.drawerEnabled { appSidebar.isPresented.toggle() }
            }
        } label: {
            Image(systemName: "sidebar.leading")
        }
        .accessibilityLabel("Sidebar")
    }

    @ToolbarContentBuilder
    private var drawerToolbarItem: some ToolbarContent {
        if !sidebarPresentation.columnIsForced && sectionPath.wrappedValue.isEmpty {
            if horizontalSizeClass == .regular {
                if #available(iOS 27.1, *) {
                    ToolbarItem(placement: .topBarLeading) { regularSidebarToggleButton }
                        .axisBehavior(.verticalPreferred)
                        .visibilityPriority(.high)
                } else {
                    ToolbarItem(placement: .topBarLeading) { regularSidebarToggleButton }
                }
            } else {
                ToolbarItem(placement: .topBarLeading) { sidebarButton() }
                    .overflowPriority(.drawer)
            }
        }
    }

    private func withDrawerButton(_ content: some View) -> some View {
        content.toolbar { drawerToolbarItem }
    }

    private func sessionListSurface(sidebarHeader: some View, searchPull: SidebarSearchPull) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Color(.systemBackground)
                .ignoresSafeArea()

            content(sidebarHeader: sidebarHeader, searchPull: searchPull)

            VStack(alignment: .trailing, spacing: 12) {
                if let archiveUndo = viewModel.archiveUndo {
                    SessionArchiveUndoToast(
                        undo: archiveUndo,
                        undoArchive: { Task { await undoArchive() } },
                        dismiss: viewModel.dismissArchiveUndo
                    )
                    .accessibilityFocused($archiveUndoIsFocused)
                    .padding(.horizontal, 16)
                    .transition(SessionListMotion.toastTransition(reduceMotion: reduceMotion))
                }
            }
            .padding(.bottom, 12)
            .animation(SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion), value: viewModel.archiveUndo)
        }
    }

    private var regularNewChatButton: some View {
        HapticButton(feedbackStyle: .medium) {
            openNewChat()
        } label: {
            Label("New Chat", systemImage: "square.and.pencil")
        }
        .disabled(isNewChatDisabled)
        .accessibilityLabel("New Chat")
        .newChatModeMenu(viewModel.newChatExecutionModes, isDisabled: isNewChatDisabled) { mode in
            openNewChat(in: mode)
        }
    }

    private var isNewChatDisabled: Bool {
        viewModel.isViewingCachedData
    }

    /// An empty chat needs no compose button, even after its session has been created.
    private var showsDetailNewChatButton: Bool {
        let showsChat = navigationState.section == .chats || navigationState.selectedSectionSession != nil
        return !(showsChat && chatShowsEmptyTranscript)
            && (horizontalSizeClass != .regular || !sidebarPresentation.showsColumn || detailHostsSidebarActions)
    }

    @ViewBuilder
    private func navigationDestination(_ destination: SessionNavigationDestination, rootHasAppeared: Bool = false) -> some View {
        switch destination {
        case .session(let session):
            let retained = chats.chat(for: session, server: server) {
                ChatView.makeViewModel(session: session, server: server, sessionListOwner: viewModel)
            }
            SessionChatDestination(
                session: session, server: server, authManager: authManager,
                draftStore: draftStore, viewModel: viewModel, context: sessionActionContext,
                inspectorFits: sidebarPresentation.filesInspectorFits,
                offersCompanionPage: horizontalSizeClass == .regular,
                widensForCompanionPage: widensForCompanionPage,
                companionPageHideRequest: navigationState.companionPageHideRequest,
                retained: retained
            )
            .id(session.id)
            .environment(\.appearedNavigationRoot, rootHasAppeared ? retained : nil)
        case .newChat(let route):
            let retained = chats.pendingChat(for: route, server: server) { provisional in
                ChatView.makeViewModel(session: provisional, server: server, sessionListOwner: viewModel)
            }
            PendingNewChatView(
                initialDraft: route.initialDraft,
                initialAttachments: route.initialAttachments,
                isExplicit: route.isExplicit,
                autoStartsVoiceInput: route.autoStartsVoiceInput,
                profileName: route.profileName,
                providerID: route.providerID,
                projectID: route.projectID,
                executionMode: route.executionMode,
                server: server,
                viewModel: viewModel,
                onAPIError: sessionActionContext?.onAPIError ?? { authManager.handleAPIError($0, server: server) },
                onSessionCreated: rememberCreatedSession,
                draftStore: draftStore,
                splitFilesInspector: splitFilesInspector,
                retained: retained,
                routeID: route.id
            )
            .id(route.id)
            .environment(\.appearedNavigationRoot, rootHasAppeared ? retained : nil)
        case .utility(let destination):
            if let section = AppSection(destination) { sectionRoot(section) }
        }
    }

    /// A sidebar destination replaces the root at either width.
    @ViewBuilder
    private func sectionRoot(_ section: AppSection) -> some View {
        Group {
            switch section {
            case .chats:
                // The sessions list is its own surface in both width branches.
                EmptyView()
            case .memory:
                MemoryView(viewModel: sectionViewModels.memory, selection: sectionSelection, onAPIError: handleAPIError)
            case .skills:
                SkillsView(viewModel: sectionViewModels.skills, selection: sectionSelection, onAPIError: handleAPIError)
            case .tasks:
                TasksView(viewModel: sectionViewModels.tasks, selection: sectionSelection, onAPIError: handleAPIError)
            case .kanban:
                KanbanView(server: server, onAPIError: handleAPIError)
            case .insights:
                InsightsView(
                    server: server,
                    quotaViewModel: quotaViewModel,
                    initialQuotaSourceID: insightsQuotaSourceID,
                    selection: sectionSelection,
                    openProviderSettings: {
                        openSection(.settings(.providerQuotas))
                    },
                    onAPIError: handleAPIError
                )
            case .archived:
                ArchivedSessionsView(
                    server: server,
                    onAPIError: handleAPIError,
                    selectedSessionID: navigationState.selectedSectionSession?.sessionId
                )
                .environment(\.openArchivedSession) { session in navigationState.pushSectionSession(session) }
            case .scheduled:
                GroupedSessionsView(
                    title: String(localized: "Scheduled sessions"),
                    isEnabled: showsCronSessions,
                    emptySystemImage: "calendar.badge.clock",
                    includes: { $0.isCronSession && !$0.isWebhookSession },
                    viewModel: viewModel,
                    selectedSessionID: navigationState.selectedSectionSession?.sessionId,
                    actions: sessionRowActions(in: .scheduled)
                )
            case .webhook:
                GroupedSessionsView(
                    title: String(localized: "Webhook sessions"),
                    isEnabled: showsWebhookSessions,
                    emptySystemImage: "bolt.horizontal.circle",
                    includes: { $0.isWebhookSession },
                    viewModel: viewModel,
                    selectedSessionID: navigationState.selectedSectionSession?.sessionId,
                    actions: sessionRowActions(in: .webhook)
                )
            }
        }
        // Each screen reads its profile's data; a switch rebuilds it for the new profile (TAL-553).
        .id(viewModel.activeProfileName)
        .adaptiveSecondaryNavigationTitle(title: section == .kanban ? nil : section.title)
    }

    /// A selected section item, pushed above its list at either width.
    @ViewBuilder
    private func sectionItemPage(_ item: SectionItem) -> some View {
        Group {
            switch item {
            case .memory(let file):
                MemoryFileView(viewModel: sectionViewModels.memory, file: file, onAPIError: handleAPIError)
            case .skill(let id):
                if let skill = sectionViewModels.skills.skills.first(where: { $0.id == id }) {
                    SkillDetailView(skill: skill, server: server, onAPIError: handleAPIError)
                } else {
                    ContentUnavailableView("Select a Skill", systemImage: "hammer")
                }
            case .task(let id):
                let tasks = sectionViewModels.tasks
                if let job = tasks.jobs.first(where: { $0.id == id }) {
                    TaskDetailView(
                        job: job,
                        runningElapsed: tasks.runningElapsed(for: job),
                        isRunning: tasks.isRunning(job),
                        server: server,
                        onAPIError: handleAPIError,
                        onMutation: { tasks.apply($0) }
                    )
                } else {
                    ContentUnavailableView("Select a Task", systemImage: "calendar.badge.clock")
                }
            case .quotaSource(let id):
                if let source = quotaViewModel.quotaSources.first(where: { $0.id == id }) {
                    quotaSourcePage(source)
                } else {
                    ContentUnavailableView("Loading quota…", systemImage: "gauge.with.dots.needle.33percent")
                }
            }
        }
        .id(viewModel.activeProfileName)
        .adaptiveSecondaryNavigationTitle()
    }

    /// One quota account above the Insights Quotas tab (TAL-1750); pins and hiding write the same stores the sidebar reads.
    private func quotaSourcePage(_ source: ProviderQuotaSource) -> some View {
        let pinnedIDs = ProviderQuotaSidebarSettings.sourceIDs(first: firstSidebarQuotaSourceID, second: secondSidebarQuotaSourceID)
        return ProviderQuotaDetailView(
            source: source,
            scopeID: quotaViewModel.quotaScopeID ?? "",
            displayName: ProviderQuotaDisplaySettings.displayName(
                providerID: source.providerID, fallback: source.providerLabel, aliasesData: providerAliasesData
            ),
            percentageMode: ProviderQuotaPercentageMode(rawValue: quotaPercentageModeRawValue) ?? .defaultValue,
            isRefreshing: quotaViewModel.refreshingQuotaSourceIDs.contains(source.id),
            isPinned: pinnedIDs.contains(source.id),
            canPin: quotaViewModel.hasStableQuotaSources && pinnedIDs.count < 2,
            refresh: {
                Task {
                    if quotaViewModel.hasStableQuotaSources {
                        await quotaViewModel.refreshQuota(sourceID: source.id)
                    } else {
                        await quotaViewModel.loadQuotas(refresh: true)
                    }
                }
            },
            togglePin: {
                let slots = ProviderQuotaSidebarSettings.toggled(
                    first: firstSidebarQuotaSourceID, second: secondSidebarQuotaSourceID, sourceID: source.id
                )
                firstSidebarQuotaSourceID = slots.first
                secondSidebarQuotaSourceID = slots.second
            },
            hide: {
                hiddenProviderData = ProviderQuotaVisibilitySettings.data(bySetting: source.providerID, hidden: true, in: hiddenProviderData)
                navigationState.selectedItem = nil
            },
            openProviderSettings: { openSection(.settings(.providerQuotas)) }
        )
    }

    private var sectionSelection: Binding<SectionItem?> {
        Binding(get: { navigationState.selectedItem }, set: { navigationState.selectedItem = $0 })
    }

    private var sectionPath: Binding<[CompactPage]> {
        let revision = navigationState.rootRevision
        let chatRevision = navigationState.chatRootRevision
        let compact = horizontalSizeClass != .regular
        return Binding {
            guard case .utility = navigationState.destination else { return [] }
            var path: [CompactPage] = []
            if let item = navigationState.selectedItem { path.append(.item(item)) }
            if let session = navigationState.selectedSectionSession { path.append(.session(session)) }
            return path
        } set: { path in
            guard revision == navigationState.rootRevision, chatRevision == navigationState.chatRootRevision,
                  compact == isCompactWidth else { return }
            navigationState.selectedItem = path.compactMap { page in
                if case .item(let item) = page { return item }
                return nil
            }.first
            navigationState.selectedSectionSession = path.compactMap { page in
                if case .session(let session) = page { return session }
                return nil
            }.first
        }
    }

    private var insightsQuotaSourceID: String? {
        guard case .utility(.providers(let sourceID)) = navigationState.destination else { return nil }
        return sourceID
    }

    private func handleAPIError(_ error: Error) {
        authManager.handleAPIError(error, server: server)
    }

    /// The Duo's tent pose with a run going (TAL-1460).
    private var monitorsRuns: Bool {
        SessionRunMonitor.isActive(
            horizontalSizeClassIsCompact: horizontalSizeClass == .compact,
            verticalSizeClassIsCompact: verticalSizeClass == .compact,
            hinge: hingeStatus,
            sessions: viewModel.sessions
        )
    }

    private func content(sidebarHeader: some View, searchPull: SidebarSearchPull) -> some View {
        let groups = scheduledSessionGroups
        let showsScheduled = groups.showsDisclosure(isSearchActive: hasSearchQuery)
        let showsWebhook = groups.showsWebhookDisclosure(isSearchActive: hasSearchQuery)
        return SidebarList {
            if !searchPull.isSearchPresented {
                sidebarHeader
                    .sessionsScreenListRow()
            }

            if let reason = viewModel.cachedDataReason {
                CachedDataBanner(reason: reason)
                    .padding(.top, 16)
                    .sessionsScreenListRow()
            }

            AgentStorageBanner(storage: viewModel.agentStorage)
                .padding(.top, 16)
                .sessionsScreenListRow()

            SessionListRowsSection(
                viewModel: viewModel,
                sessions: groups.ordinary,
                emptyTitle: emptySessionsTitle,
                emptyDescription: emptySessionsDescription,
                isSearchActive: hasSearchQuery,
                searchText: searchText,
                selectedSessionID: navigationState.selectedSessionID,
                actions: sessionRowActions(),
                suppressEmptyState: !groups.scheduled.isEmpty
                    || !groups.webhook.isEmpty,
                showsHeading: !searchPull.isSearchPresented
            )

            if showsScheduled {
                GroupedSessionsDisclosure(
                    title: String(localized: "Scheduled sessions"),
                    assetImage: "LucideCalendarClock",
                    systemImage: nil,
                    expandAccessibilityLabel: String(localized: "Expand scheduled sessions"),
                    collapseAccessibilityLabel: String(localized: "Collapse scheduled sessions"),
                    viewModel: viewModel,
                    sessions: groups.scheduled,
                    totalCount: groups.totalScheduledCount,
                    countIsPartial: groups.scheduledCountIsPartial,
                    isSearchActive: searchPull.isSearchPresented || hasSearchQuery,
                    searchText: searchText,
                    selectedSessionID: navigationState.selectedSessionID,
                    userIsExpanded: $scheduledSessionsAreExpanded,
                    actions: sessionRowActions(),
                    viewAll: { openSection(.scheduled) },
                    showsHeading: !searchPull.isSearchPresented
                )
            }

            if showsWebhook {
                GroupedSessionsDisclosure(
                    title: String(localized: "Webhook sessions"),
                    assetImage: nil,
                    systemImage: "bolt.horizontal.circle",
                    expandAccessibilityLabel: String(localized: "Expand webhook sessions"),
                    collapseAccessibilityLabel: String(localized: "Collapse webhook sessions"),
                    viewModel: viewModel,
                    sessions: groups.webhook,
                    totalCount: groups.totalWebhookCount,
                    countIsPartial: groups.webhookCountIsPartial,
                    isSearchActive: searchPull.isSearchPresented || hasSearchQuery,
                    searchText: searchText,
                    selectedSessionID: navigationState.selectedSessionID,
                    userIsExpanded: $webhookSessionsAreExpanded,
                    actions: sessionRowActions(),
                    viewAll: { openSection(.webhook) },
                    showsHeading: !searchPull.isSearchPresented
                )
            }

            if !searchPull.isSearchPresented {
                NavigationLink {
                    GroupedSessionsView(
                        title: String(localized: "Recents"),
                        isEnabled: true,
                        emptySystemImage: "bubble.left",
                        includes: { _ in true },
                        viewModel: viewModel,
                        selectedSessionID: navigationState.selectedSessionID,
                        actions: sessionRowActions()
                    )
                    .environment(\.sessionRowStyle, .regular)
                } label: {
                    HStack {
                        Text("See all…")
                        Spacer()
                        Image(systemName: "chevron.forward")
                            .font(.caption.weight(.semibold))
                    }
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 24)
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .navigationLinkIndicatorVisibility(.hidden)
                .sessionsScreenListRow()
            }

        }
        .contentMargins(.top, 0, for: .scrollContent)
        .scrollPosition(id: $sidebarScrollPosition)
        .environment(\.sessionRowsMonitorRuns, monitorsRuns)
        .animation(SessionListMotion.rowStyleAnimation(reduceMotion: reduceMotion), value: monitorsRuns)
        .scrollDismissesKeyboard(.interactively)
        .onScrollGeometryChange(for: CGFloat.self) { geometry in
            max(0, -(geometry.contentOffset.y + geometry.contentInsets.top))
        } action: { _, distance in
            searchPull.update(distance: distance)
        }
        .onScrollPhaseChange { oldPhase, newPhase in
            if searchPull.phaseChanged(from: oldPhase, to: newPhase, reduceMotion: reduceMotion), !searchPull.isSearchPresented {
                HapticButtonHaptics.tap(style: .medium, isEnabled: isHapticsEnabled)
                searchPull.isSearchPresented = true
            }
        }
        .animation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion), value: scheduledSessionsAreExpanded)
        .animation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion), value: webhookSessionsAreExpanded)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if viewModel.isSelectingSessions {
                SessionSelectionBar(
                    viewModel: viewModel,
                    sessions: groups.ordinary,
                    archive: { Task { await performBulkAction(.archive) } },
                    delete: { isConfirmingBulkDelete = true }
                )
            }
        }
    }

    private func openSidebarSettings() {
        openSection(.settings(nil))
    }

    private func openSidebarFeedback() {
        guard sidebarFeedback?.isSending != true else { return }
        let model = FeedbackComposer(server: server, clientMetadata: .current)
        presentSidebarModal {
            sidebarFeedback = model
            model.isPresented = true
        }
    }

    @ToolbarContentBuilder
    private func sidebarSettingsActions(placement: ToolbarItemPlacement, prefersVertical: Bool) -> some ToolbarContent {
        if #available(iOS 27.1, *) {
            if showsSidebarFeedbackAction {
                ToolbarItem(placement: placement) { sidebarFeedbackButton }
                    .axisBehavior(prefersVertical ? .verticalPreferred : .horizontalOnly)
                    .visibilityPriority(.high)
            }
            ToolbarItem(placement: placement) { settingsButton }
                .axisBehavior(prefersVertical ? .verticalPreferred : .horizontalOnly)
                .visibilityPriority(.high)
        } else {
            ToolbarItemGroup(placement: placement) {
                if showsSidebarFeedbackAction { sidebarFeedbackButton }
                settingsButton
            }
        }
    }

    private var showsSidebarFeedbackAction: Bool {
        showsSidebarFeedbackButton && (appSidebar.isVisible || sidebarPresentation.showsColumn)
    }

    private var sidebarFeedbackButton: some View {
        HapticButton(feedbackStyle: .medium, action: openSidebarFeedback) {
            Image(systemName: FeedbackSheet.systemImage)
        }
        .accessibilityLabel(FeedbackSheet.title)
        .accessibilityIdentifier("sidebar-send-feedback")
        .disabled(sidebarFeedback?.isSending == true)
    }

    private var settingsButton: some View {
        HapticButton(feedbackStyle: .medium, action: openSidebarSettings) {
            Image(systemName: "gearshape")
        }
        .accessibilityLabel("Settings")
        .accessibilityValue(appSidebarServerName)
        .accessibilityHint("Long press to switch servers.")
        .contextMenu {
            AvatarServerSwitcherMenu(
                model: avatarServerSwitcherModel,
                switchToServer: { account in authManager.switchActiveServer(to: account) },
                addServer: { isPresentingAddServer = true },
                manageServers: { openSection(.settings(.servers)) }
            )
        }
    }

    private var updateNotificationsButton: some View {
        Button {
            isPresentingUpdateNotifications = true
        } label: {
            Label("Notifications", systemImage: updateNotificationViewModel.unreadCount > 0 ? "bell.badge.fill" : "bell")
                .symbolRenderingMode(.hierarchical)
        }
        .accessibilityLabel("Notifications")
        .accessibilityValue(updateNotificationViewModel.unreadCount > 0 ? "\(updateNotificationViewModel.unreadCount) unread" : "No unread notifications")
    }

    private var updateNotificationRefreshTaskID: String {
        "\(server.absoluteString)|\(scenePhase == .active)"
    }

    private func handleUpdateNotificationError() {
        if let error = updateNotificationViewModel.lastError {
            authManager.handleAPIError(error, server: server)
        }
    }

    private func openNotificationDestination(_ destination: UpdateNotificationDestination) {
        guard destination.key == "settings.system" else { return }
        openSection(.settings(.system))
    }

    private func refreshUpdateNotificationsWhileActive() async {
        guard scenePhase == .active else { return }
        while !Task.isCancelled {
            let continuePolling = await updateNotificationViewModel.refresh()
            handleUpdateNotificationError()
            guard continuePolling else {
                isPresentingUpdateNotifications = false
                return
            }
            try? await Task.sleep(for: .seconds(5))
        }
    }

    private func sidebarButton(isPresented: Bool = false) -> some View {
        Button {
            appSidebar.isPresented.toggle()
        } label: {
            Image(systemName: isPresented ? "xmark" : "sidebar.leading")
                .font(.body.weight(.semibold))
        }
        .accessibilityLabel(isPresented ? "Close navigation" : "Open navigation")
        .accessibilityFocused($openNavigationIsFocused)
    }

    private var avatarServerSwitcherModel: AvatarServerSwitcherModel {
        AvatarServerSwitcherModel(
            servers: authManager.servers,
            activeServerID: authManager.activeServerID
        )
    }

    private var appSidebarServerName: String {
        avatarServerSwitcherModel.entries.first(where: \.isActive)?.displayName
            ?? server.host
            ?? server.absoluteString
    }

    private var appSidebarSectionVisibility: SidebarSectionVisibility {
        SidebarSectionVisibility(
            tasks: showsTasksSection,
            kanban: showsKanbanSection,
            skills: showsSkillsSection,
            memory: showsMemorySection,
            insights: showsInsightsSection
        )
    }

    /// Commit the destination beneath an open drawer before starting its own slide (TAL-477).
    /// A tiled column keeps the navigation stack's normal push animation.
    private func closeAppSidebar(then navigate: () -> Void) {
        isPresentingSettings = false
        sidebarFeedback?.isPresented = false
        reopensSidebarAfterModal = false
        pendingSettingsPath = nil
        guard sidebarDrawerIsEnabled, appSidebar.isPresented else {
            navigate()
            return
        }
        withTransaction(.unanimated) { navigate() }
        DispatchQueue.main.async { appSidebar.isPresented = false }
    }

    private func appSidebarPresentationChanged(_ isPresented: Bool) {
        guard scenePhase == .active, !isResumingSidebarLayout else { return }
        if isPresented {
            reloadAppSidebarQuotaSources()
            splitFilesInspector.isPresented.wrappedValue = false
        }
        if !isApplyingSidebarLayout, horizontalSizeClass == .regular, sidebarPresentation.drawerEnabled, regularSplitFullSize != .zero {
            updateSidebarColumn(storedChoice: isPresented)
        }
        if isPresented { return }
        Task { @MainActor in
            await Task.yield()
            guard !appSidebar.isPresented else { return }
            openNavigationIsFocused = true
        }
    }

    private var providerQuotaRefreshTaskID: String {
        "\(server.absoluteString)|\(quotaRefreshIntervalSeconds)|\(scenePhase == .active)"
    }

    private var autoRefreshTaskID: SessionListAutoRefresh.TaskID {
        SessionListAutoRefresh.TaskID(
            server: server,
            isSceneActive: scenePhase == .active,
            isListVisible: isSessionListVisible
        )
    }

    /// One answer for both polling loops, so they agree on when the list is on screen.
    private var isSessionListVisible: Bool {
        SessionListAutoRefresh.isListVisible(
            sidebar: sidebarPresentation,
            drawerIsPresented: appSidebar.isPresented,
            destination: navigationState.destination
        )
    }

    /// Rereads New Chat's modes for each profile, and when the app returns, so a started or stopped gateway shows.
    private var executionModesTaskID: String {
        "\(server.absoluteString)|\(viewModel.activeProfileName ?? "")|\(scenePhase == .active)"
    }

    /// Restarts the session-change subscription when the scene's activity or the server changes.
    private var sessionEventsTaskID: String {
        "\(server.absoluteString)|\(scenePhase == .active)"
    }

    private var visibleSessions: [SessionSummary] {
        viewModel.visibleSessions(
            searchText: searchText,
            selectedProjectID: selectedProjectID,
            automatedVisibility: automatedSessionVisibility
        )
    }

    private var scheduledSessionGroups: ScheduledSessionGroups {
        viewModel.scheduledSessionGroups(
            searchText: searchText,
            selectedProjectID: selectedProjectID,
            automatedVisibility: automatedSessionVisibility
        )
    }

    private var automatedSessionVisibility: AutomatedSessionVisibility {
        AutomatedSessionVisibility(
            showsCron: showsCronSessions,
            showsCli: showsCliSessions,
            showsWebhook: showsWebhookSessions,
            showsClaudeCode: showsClaudeCodeSessions,
            showsSubagents: showsSubagentSessions
        )
    }

    private var emptySessionsTitle: String {
        if hasActiveSessionFilter {
            return String(localized: "No matching sessions")
        }

        return String(localized: "No sessions yet")
    }

    private var emptySessionsDescription: String? {
        if hasActiveSessionFilter {
            return String(localized: "Try another search or project filter.")
        }

        return String(localized: "Tap Chat to start.")
    }

    private var hasActiveSessionFilter: Bool {
        selectedProjectID != nil || !normalizedSearchText.isEmpty
    }

    private var selectedHeaderLogoColor: Color {
        HeaderLogoColor.color(for: headerLogoColorHex)
    }

    private var newSessionButtonUsesThemeColor: Bool {
        PrimaryActionTintSettings.usesThemeColor(
            isEnabled: tintsPrimaryActions,
            controlIsEnabled: !viewModel.isViewingCachedData
        )
    }

    private var normalizedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var hasSearchQuery: Bool {
        !normalizedSearchText.isEmpty
    }

    private var remoteSearchTaskID: SessionSearchTaskID {
        SessionSearchTaskID(
            query: normalizedSearchText,
            projectID: selectedProjectID,
            visibility: automatedSessionVisibility,
            isViewingCachedData: viewModel.isViewingCachedData
        )
    }

    private var activeSessionMonitorTaskID: SessionListAutoRefresh.ActiveRowTaskID {
        let activeSessions = visibleSessions.filter(SessionRowPresentation.isActiveStreaming)
        return SessionListAutoRefresh.ActiveRowTaskID(
            streamIDs: SessionListViewModel.activeStreamIDs(in: activeSessions),
            hasActiveRows: !activeSessions.isEmpty,
            isViewingCachedData: viewModel.isViewingCachedData,
            isEventStreamLive: isSessionEventStreamLive,
            isListVisible: isSessionListVisible,
            isSceneActive: scenePhase == .active
        )
    }

    /// Sidebar rows replace the root; section-owned lists push their chats above the list.
    private func sessionRowActions(in list: AppSection = .chats) -> SessionListRowActions {
        if list == .chats, let sessionActionContext { return sessionActionContext.actions }
        return makeSessionRowActions(in: list)
    }

    private func makeSessionRowActions(in list: AppSection = .chats) -> SessionListRowActions {
        SessionListRowActions(
            retryLoad: {
                Task { await refreshSessionsAndActiveProfile() }
            },
            open: { session in
                Task { await openSession(session, in: list) }
            },
            togglePinned: { session in
                Task { await togglePinned(session) }
            },
            archive: { session in
                Task { await archive(session) }
            },
            delete: { session in
                sessionPendingDeletion = session
            },
            rename: { session in
                sessionPendingRename = session
            },
            duplicate: { session in
                Task { await duplicate(session) }
            },
            move: { session, projectID in
                Task { await move(session, to: projectID) }
            },
            createProject: { session in
                sessionPendingProjectCreation = session
            },
            refreshProjects: {
                Task { await viewModel.loadProjects() }
            },
            export: { session, format in
                Task { await export(session, format: format) }
            },
            stopRun: { session in
                Task { await viewModel.stopRun(session, modelContext: modelContext) }
            }
        )
    }

    /// The one path every full-list trigger takes — initial load,
    /// pull-to-refresh, the return refresh, and the automatic refresh loop.
    /// `SessionListViewModel.load` serializes the list request itself through
    /// its refresh queue, and `loadProjects` and `loadActiveProfile` fence their
    /// own responses, so nothing here has to coordinate them.
    private func refreshSessionsAndActiveProfile() async {
        await loadSessions()
        guard !Task.isCancelled else { return }
        await viewModel.loadActiveProfile()
        guard !Task.isCancelled else { return }
        // Not awaited: restore and pull-to-refresh must not wait on transcripts. The view model
        // claims each run before its request, so overlapping refreshes never fetch one twice.
        Task { await viewModel.prefetchRunningTranscripts(modelContext: modelContext) }
    }

    private var sceneActions: TalariaSceneActions {
        TalariaSceneActions(
            canCreateNewChat: !isNewChatDisabled,
            createNewChat: openNewChatFromKeyboard,
            searchSessions: openSearchFromKeyboard
        )
    }

    private func openNewChatFromKeyboard() {
        guard !isNewChatDisabled else { return }
        openNewChat()
    }

    private func openSearchFromKeyboard() {
        if sidebarDrawerIsEnabled { appSidebar.isPresented = true }
        else { updateSidebarColumn(storedChoice: true) }

        Task { @MainActor in
            await Task.yield()
            appSidebar.searchRequested = true
        }
    }

    /// Unlike the return refresh this is not width-specific: the notification can
    /// arrive whatever the user is looking at, and the list behind them should be
    /// current when they get back to it.
    private func refreshForSessionNotification() {
        guard didCompleteInitialLoad else { return }
        immediateRefreshID = UUID()
    }

    private func refreshAfterReturningIfNeeded() {
        guard didCompleteInitialLoad else { return }
        // In compact width a return also brings the list back on screen, which
        // restarts the automatic refresh loop with an immediate refresh of its
        // own. Scheduling here as well would reload sessions, projects and the
        // active profile twice for one transition. In regular width the sidebar
        // never leaves the screen, so that loop does not restart and this is the
        // only trigger a session switch has.
        guard horizontalSizeClass == .regular else { return }
        immediateRefreshID = UUID()
    }

    @MainActor
    private func switchActiveProfile(_ profile: ProfileSummary) async {
        let didSwitch = await viewModel.switchActiveProfile(profile)
        handleLastError()

        guard didSwitch else { return }

        await loadSessions()
    }

    private func refreshSessionActionInputs() {
        sessionActionContext?.modelContext = observedModelContext
        sessionActionContext?.layoutDirection = observedLayoutDirection
        sessionActionContext?.reduceMotion = observedReduceMotion
        sessionActionContext?.scenePhase = observedScenePhase
        sessionActionContext?.horizontalSizeClass = observedHorizontalSizeClass
    }

    private var retainedChatSessionIDs: Set<String> {
        Set([navigationState.lastSelectedSessionID, navigationState.selectedSessionID,
             navigationState.selectedSectionSession?.sessionId].compactMap { $0 })
    }

    private var sessionActionAnimation: Animation? {
        SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
    }

    private func loadSessions() async {
        // Rows carry `sessionRowTransition`, but it only plays when the array is
        // replaced inside an animation. The first population has nothing to move,
        // so it stays unanimated and later refreshes slide a new row into its
        // sorted place instead of popping it in.
        let animation = viewModel.sessions.isEmpty
            ? nil
            : sessionActionAnimation
        await viewModel.load(modelContext: modelContext, animation: animation)
        guard !Task.isCancelled else { return }
        handleLastError()

        if !viewModel.isViewingCachedData {
            await viewModel.loadProjects(silently: true)
            guard !Task.isCancelled else { return }
            handleLastError()
        }
    }

    private func togglePinned(_ session: SessionSummary) async {
        let didChangePinState = await viewModel.setPinned(
            !(session.pinned ?? false),
            for: session,
            modelContext: modelContext,
            animation: sessionActionAnimation
        )
        handleLastError()

        if didChangePinState {
            SessionHaptics.pinStateChanged(isEnabled: isHapticsEnabled)
        }
    }

    private func archive(_ session: SessionSummary) async {
        let didArchive = await viewModel.archive(
            session,
            modelContext: modelContext,
            animation: sessionActionAnimation
        )
        handleLastError()

        if didArchive {
            removeSessionFromNavigation(session)
            SessionHaptics.archiveStateChanged(isEnabled: isHapticsEnabled)
        }
        if viewModel.archiveUndo != nil {
            archiveUndoIsFocused = true
        }
    }

    private func undoArchive() async {
        _ = await viewModel.undoArchive(
            modelContext: modelContext,
            animation: sessionActionAnimation
        )
        handleLastError()
    }

    private func delete(_ session: SessionSummary) async {
        let didDelete = await viewModel.delete(
            session,
            modelContext: modelContext,
            animation: sessionActionAnimation
        )
        handleLastError()

        if didDelete {
            await draftStore.discardDraft(for: draftKey(for: session))
            removeSessionFromNavigation(session)
            SessionHaptics.sessionDeleted(isEnabled: isHapticsEnabled)
        }
    }

    /// One server call for every selected chat (TAL-627); the chats it changed leave navigation.
    private func performBulkAction(_ action: SessionBulkAction) async {
        let changed = await viewModel.performBulkAction(
            action,
            modelContext: modelContext,
            animation: sessionActionAnimation
        )
        handleLastError()
        guard !changed.isEmpty else { return }

        for session in changed {
            if action == .delete {
                await draftStore.discardDraft(for: draftKey(for: session))
            }
            removeSessionFromNavigation(session)
        }
        if action == .delete {
            SessionHaptics.sessionDeleted(isEnabled: isHapticsEnabled)
        } else {
            SessionHaptics.archiveStateChanged(isEnabled: isHapticsEnabled)
        }
    }

    private func draftKey(for session: SessionSummary) -> ChatDraftKey {
        .session(server: server, session: session)
    }

    private func rename(_ session: SessionSummary, to title: String) async -> Bool {
        let didChangeTitle = normalizedTitle(title) != normalizedTitle(session.title)
        let didRename = await viewModel.rename(session, to: title, modelContext: modelContext)
        handleLastError()

        if didRename, didChangeTitle {
            SessionHaptics.sessionRenamed(isEnabled: isHapticsEnabled)
        }

        return didRename
    }

    private func duplicate(_ session: SessionSummary) async {
        let duplicatedSession = await viewModel.duplicate(session, modelContext: modelContext)
        handleLastError()

        if let duplicatedSession {
            selectSession(duplicatedSession)
        }
    }

    private func move(_ session: SessionSummary, to projectID: String?) async {
        await viewModel.move(session, to: projectID, modelContext: modelContext)
        handleLastError()
    }

    private func export(_ session: SessionSummary, format: SessionExportFormat) async {
        let fileURL = await viewModel.export(session, format: format)
        handleLastError()

        if let fileURL {
            sessionExportShareItem = SessionExportShareItem(fileURL: fileURL)
        }
    }

    private func delete(_ project: ProjectSummary) async {
        let deletedProjectID = project.projectId
        let didDelete = await viewModel.delete(project, modelContext: modelContext)
        handleLastError()

        if didDelete, selectedProjectID == deletedProjectID {
            selectedProjectID = nil
        }
    }

    private func normalizedTitle(_ title: String?) -> String? {
        guard let title else { return nil }
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func handleLastError() {
        if let lastError = viewModel.lastError {
            authManager.handleAPIError(lastError, server: server)
        }
    }

    private func openPendingSharedImportIfNeeded() {
        guard let reservation = pendingSharedImport else {
            return
        }

        let sharedImport = reservation.sharedImport
        let draft = TalariaShareDraft.composerDraft(from: sharedImport.draft)
        guard !draft.isEmpty || !sharedImport.attachments.isEmpty else {
            didRoutePendingSharedImport(reservation)
            return
        }

        openNewChat(
            PendingNewChatRoute(
                initialDraft: draft,
                initialAttachments: sharedImport.attachments
            )
        )
        didRoutePendingSharedImport(reservation)
    }

    /// Awaited while the sidebar refreshes. Launch restoration is already resolved, so only this explicit route navigates.
    private func openPendingDeepLinkedSessionIfNeeded() async {
        guard !Task.isCancelled else { return }

        while let sessionID = navigationState.beginDeepLinkedSessionLoad(
            id: pendingDeepLinkedSessionID
        ) {
            pendingDeepLinkedSessionID = nil
            await openDeepLinkedSession(id: sessionID)
            navigationState.finishDeepLinkedSessionLoad(id: sessionID)
            guard !Task.isCancelled else { return }
        }
    }

    private func openDeepLinkedSession(id sessionID: String) async {
        if let loadedSession = viewModel.sessions.first(where: { $0.sessionId == sessionID }) {
            await openSession(loadedSession)
            return
        }

        // A deep-linked external session needs the same server-side import a
        // tapped row does before it can be continued.
        await openSession {
            let session = await viewModel.loadSessionForDeepLink(id: sessionID, modelContext: modelContext)
            // Re-checked post-await: the view (and this task) may have been torn down —
            // e.g. dismissed, or the active server changed under `.id(server)` — while
            // the network load was in flight. Selecting or persisting for a session
            // whose owning view no longer exists is stale work, not a real navigation.
            return Task.isCancelled ? nil : session
        }
    }

    /// Opens the New Chat composer in response to the "New Chat" App Intents (#337/#338),
    /// mirroring the "+" button. Carries `autoStartsVoiceInput` so the voice variant begins
    /// dictation once the composer appears. The request is cleared so it fires once per
    /// invocation.
    private func openRequestedNewChatIfNeeded() {
        guard let request = requestedNewChat else { return }
        requestedNewChat = nil
        openNewChat(
            PendingNewChatRoute(
                autoStartsVoiceInput: request.autoStartsVoiceInput,
                profileName: request.profileName,
                providerID: request.providerID
            )
        )
    }

    private func openPendingQuotaSourceIfNeeded() {
        guard let sourceID = pendingQuotaSourceID else { return }
        pendingQuotaSourceID = nil
        openSection(.providers(sourceID))
    }

    private func openProviderQuotaWidgetSettingsIfNeeded() {
        guard opensProviderQuotaWidgetSettings else { return }
        opensProviderQuotaWidgetSettings = false
        openSection(.providerQuotaWidgetSettings)
    }

    /// Every sidebar, notification and deep-link utility route enters here.
    private func openSection(_ utility: SessionListUtilityDestination) {
        switch utility {
        case .settings(let anchor):
            presentSettings(path: anchor.map { [.category($0.category)] } ?? [])
        case .providerQuotaWidgetSettings:
            presentSettings(path: [.category(.liveActivitiesAndWidgets), .providerQuotaWidget])
        default:
            closeAppSidebar { navigationState.select(utility) }
        }
    }

    private func presentSettings(path: [SettingsPane]) {
        // Modal navigation supersedes a session load/import without replacing the underlying root.
        _ = navigationState.beginOpen()
        if isPresentingUpdateNotifications {
            pendingSettingsPath = path
            isPresentingUpdateNotifications = false
            return
        }
        if isPresentingSettings {
            settingsPath = path
            return
        }
        presentSidebarModal {
            settingsPath = path
            isPresentingSettings = true
        }
    }

    private func presentSidebarModal(_ present: @escaping () -> Void) {
        let reopensSidebar = appSidebar.isPresented
        closeAppSidebar {
            reopensSidebarAfterModal = reopensSidebar
            present()
        }
    }

    private func settingsDidDismiss() {
        guard !isPresentingSettings else { return }
        settingsPath = []
        sidebarModalDidDismiss()
    }

    private func sidebarModalDidDismiss() {
        if reopensSidebarAfterModal, sidebarDrawerIsEnabled {
            DispatchQueue.main.async { appSidebar.isPresented = true }
        }
        reopensSidebarAfterModal = false
    }

    private var settingsNavigationStack: some View {
        NavigationStack(path: $settingsPath) {
            settingsModalPage(SettingsView(server: server, selection: Binding {
                settingsPath.first
            } set: { pane in
                settingsPath = pane.map { [$0] } ?? []
            }))
            .navigationDestination(for: SettingsPane.self) { pane in
                settingsModalPage(SettingsPaneView(authManager: authManager, server: server, pane: pane))
            }
        }
    }

    /// NavigationStack does not install a toolbar on its hosted pages; the root and pushed pages share this wrapper.
    private func settingsModalPage<Content: View>(_ content: Content) -> some View {
        content.adaptiveSecondaryNavigationTitle().toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button { isPresentingSettings = false } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("Close")
            }
            .overflowPriority(.done, includesHorizontal: true)
        }
    }

    private func openNewChat(_ route: PendingNewChatRoute) {
        closeAppSidebar { navigationState.select(route) }
    }

    private func openNewChat() {
        openNewChat(PendingNewChatRoute(projectID: selectedProjectID))
    }

    /// Carries the chosen mode to the first Send or Files request (TAL-1045).
    private func openNewChat(in mode: ExecutionMode) {
        openNewChat(viewModel.diagnosticChatRoute(mode, projectID: selectedProjectID))
    }

    private func openSession(_ session: SessionSummary, in list: AppSection = .chats) async {
        await openSession(in: list) { session }
    }

    /// A failed load or import stays on the list and surfaces through the
    /// action-error alert; a destination chosen meanwhile is never replaced.
    private func openSession(in list: AppSection = .chats,
                             load: () async -> SessionSummary?) async {
        let outcome = await SessionListOpen.resolve(
            beginOpen: { navigationState.beginOpen() },
            openRevision: { navigationState.openRevision },
            load: load,
            importSession: { await viewModel.sessionToOpen(for: $0, modelContext: modelContext) }
        )
        switch outcome {
        case let .open(session):
            // Sidebar rows replace the root; section-owned lists push a chat above their list.
            selectSession(session, in: list)
        case .failed:
            guard !Task.isCancelled else { return }
            // Forwards an expired session/cookie to the auth manager the same way
            // every other network-backed session-list action does.
            handleLastError()
        case .superseded:
            break
        }
    }

    private func selectSession(_ session: SessionSummary, in list: AppSection = .chats) {
        closeAppSidebar {
            if list != .chats, case .utility = navigationState.destination {
                navigationState.pushSectionSession(session)
            } else {
                navigationState.select(session)
            }
        }
        persistLastSelectedSession()
    }

    private func rememberCreatedSession(_ session: SessionSummary) {
        navigationState.remember(session)
        persistLastSelectedSession()
    }

    private func reconcileRemovedSessionNavigation(_ removingSessionIDs: Set<String>) {
        for id in removingSessionIDs {
            guard removedSessionNavigation[id] == nil,
                  navigationState.selectedSessionID == id || navigationState.selectedSectionSession?.sessionId == id
                    || navigationState.lastSelectedSessionID == id else { continue }
            let previous = navigationState
            navigationState.remove(sessionID: id)
            removedSessionNavigation[id] = RemovedSessionNavigation(state: previous, revision: navigationState.openRevision)
            persistLastSelectedSession()
        }
        for (id, removed) in removedSessionNavigation where !removingSessionIDs.contains(id) {
            if viewModel.shouldRestoreSessionAfterRemoval(id) {
                navigationState.restoreAfterRemoval(removed.state, ifUnchangedAt: removed.revision)
                persistLastSelectedSession()
            }
            removedSessionNavigation.removeValue(forKey: id)
        }
    }

    private func removeSessionFromNavigation(_ session: SessionSummary) {
        navigationState.remove(sessionID: session.sessionId)
        persistLastSelectedSession()
    }

    private func persistLastSelectedSession() {
        SessionNavigationPersistence.save(navigationState.lastSelectedSessionID, for: server)
    }

}

/// The existing-session sibling of PendingNewChatView; it has no session-creation lifecycle.
/// Explicit inputs keep list-only updates from constructing the retained chat again.
@MainActor
private struct SessionChatDestination: View {
    let session: SessionSummary
    let server: URL
    let authManager: AuthManager
    let draftStore: ChatDraftStore
    let viewModel: SessionListViewModel
    let context: SessionActionContext?
    let inspectorFits: Bool
    let offersCompanionPage: Bool
    let widensForCompanionPage: Bool
    let companionPageHideRequest: Int
    let retained: RetainedChat

    var body: some View {
        var inspector = context?.filesInspector
        inspector?.widensChat = inspectorFits
        inspector?.offersCompanionPage = offersCompanionPage
        inspector?.widensForCompanionPage = widensForCompanionPage
        inspector?.companionPageHideRequest = companionPageHideRequest
        return ChatView(
            session: session, server: server,
            onAPIError: context?.onAPIError ?? { authManager.handleAPIError($0, server: server) },
            draftStore: draftStore, sessionListOwner: viewModel,
            splitFilesInspector: inspector, retained: retained
        )
    }
}

private struct SessionSearchTaskID: Hashable {
    let query: String
    let projectID: String?
    let visibility: AutomatedSessionVisibility
    let isViewingCachedData: Bool
}

/// A section root and its pushed pages share one load at both widths (TAL-643).
/// Rebuilt when the active profile changes, with the screens (TAL-553).
@MainActor
private struct SectionViewModels {
    let memory: MemoryViewModel
    let skills: SkillsViewModel
    let tasks: TasksViewModel

    init(server: URL) {
        memory = MemoryViewModel(server: server, responseCache: .app(server: server))
        skills = SkillsViewModel(server: server, responseCache: .app(server: server))
        tasks = TasksViewModel(server: server, responseCache: .app(server: server))
    }
}

private enum CompactPage: Hashable {
    case session(SessionSummary)
    case item(SectionItem)
}

extension View {
    @ViewBuilder
    func minimizingSearchToolbar() -> some View {
        if #available(iOS 26, *) {
            searchToolbarBehavior(.minimize)
                .searchPresentationToolbarBehavior(.avoidHidingContent)
        } else {
            self
        }
    }
}

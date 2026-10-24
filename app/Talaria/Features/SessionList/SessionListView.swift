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

    @Environment(\.modelContext) private var modelContext
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: SessionListViewModel
    @State private var quotaViewModel: ProvidersViewModel
    @State private var updateNotificationViewModel: UpdateNotificationCenterViewModel
    @State private var sectionViewModels: SectionViewModels
    /// The open chat, kept above both width layouts so opening or closing an iPhone Duo hands it over (TAL-1477).
    @State private var chats: ChatViewModelCache
    @State private var navigationState: SessionNavigationState
    @State private var isPresentingSettings = false
    @State private var settingsPath: [SettingsPane] = []
    @State private var pendingSettingsPath: [SettingsPane]?
    @State private var reopensSidebarAfterSettings = false
    /// The regular-width split view's own width, which sizes its columns (TAL-1453).
    @State private var splitGeometry = DivisionRegionGeometry()
    private var regularSplitWidth: CGFloat { splitGeometry.frame.width }
#if DEBUG
    @Environment(\.chatDivisionFramesForTesting) private var divisionFramesForTesting
#endif
    /// Read live by the chat being replaced, whose own environment still says regular (TAL-1477).
    @State private var isCompactWidth = false

    private var foldedSidebarWidth: CGFloat? {
        DivisionRegionLayout.sidebarWidth(in: splitGeometry.frame, divisions: splitGeometry.divisions,
            layoutDirection: layoutDirection)
    }
    /// The split view's height with its bars and the keyboard: whether a chat's companion page fits beside it reads it
    /// as the page's arrangement measures itself, so the keyboard showing does not bring the sidebar back (TAL-1458).
    @State private var regularSplitFullSize: CGSize = .zero
    @State private var detailHasVerticalBar = false
    private var regularSplitFullHeight: CGFloat { regularSplitFullSize.height }
    @AppStorage(SessionSidebarDisclosureSettings.regularPortraitVisibilityKey)
    private var portraitSidebarVisibility = ""
    @AppStorage(SessionSidebarDisclosureSettings.regularLandscapeVisibilityKey)
    private var landscapeSidebarVisibility = ""
    @State private var emptyChatRoute = PendingNewChatRoute()
    /// Persists `navigationState.filesInspectorPresented` for the window (TAL-479).
    @SceneStorage(SplitFilesInspector.storageKey) private var storedFilesInspectorPresented = false
    /// Re-reported after unfolding, once the regular chat and its header have mounted.
    @State private var regularWidthChat: SessionSummary?
    @State private var sessionPendingRename: SessionSummary?
    @State private var sessionPendingDeletion: SessionSummary?
    @State private var isConfirmingBulkDelete = false
    @State private var sessionPendingProjectCreation: SessionSummary?
    @State private var sessionExportShareItem: SessionExportShareItem?
    @State private var isPresentingProjectCreation = false
    @State private var isPresentingAddServer = false
    @State private var projectPendingDeletion: ProjectSummary?
    @State private var projectPendingRename: ProjectSummary?
    @State private var searchText = ""
    @State private var selectedProjectID: String?
    @State private var sidebarScrollPosition: String?
    /// The app's one hinge read (TAL-1460), for the tent pose's run cards.
    @State private var hingeStatus: SessionRunMonitor.HingeStatus?
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
    @AppStorage(SessionRowDisplaySettings.showMessageCountKey) private var showsSessionMessageCount = true
    @AppStorage(SessionRowDisplaySettings.showWorkspaceKey) private var showsSessionWorkspace = true
    @AppStorage(SessionRowDisplaySettings.showCronSessionsKey) private var showsCronSessions = true
    @AppStorage(SessionRowDisplaySettings.showWebhookSessionsKey)
    private var showsWebhookSessions = SessionRowDisplaySettings.showsWebhookSessions()
    @AppStorage(SessionRowDisplaySettings.showSubagentSessionsKey)
    private var showsSubagentSessions = SessionRowDisplaySettings.defaultShowsSubagentSessions
    @AppStorage(SectionVisibilitySettings.activeProfileKey) private var showsActiveProfileSection = true
    @AppStorage(SectionVisibilitySettings.projectsKey) private var showsProjectsSection = true
    @AppStorage(SectionVisibilitySettings.tasksKey) private var showsTasksSection = true
    @AppStorage(SectionVisibilitySettings.kanbanKey) private var showsKanbanSection = true
    @AppStorage(SectionVisibilitySettings.skillsKey) private var showsSkillsSection = true
    @AppStorage(SectionVisibilitySettings.memoryKey) private var showsMemorySection = true
    @AppStorage(SectionVisibilitySettings.insightsKey) private var showsInsightsSection = true
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
        pendingSharedImport: Binding<SharedImportReservation?> = .constant(nil),
        didRoutePendingSharedImport: @escaping (SharedImportReservation) -> Void = { _ in },
        hasWaitingSharedImport: Bool = false,
        openNextSharedImport: @escaping () -> Void = {},
        pendingDeepLinkedSessionID: Binding<String?> = .constant(nil),
        pendingQuotaSourceID: Binding<String?> = .constant(nil),
        opensProviderQuotaWidgetSettings: Binding<Bool> = .constant(false),
        requestedNewChat: Binding<NewChatRequest?> = .constant(nil),
        draftStore: ChatDraftStore? = nil,
        chats: ChatViewModelCache? = nil
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
        _viewModel = State(initialValue: SessionListViewModel(
            server: server,
            responseCache: .app(server: server),
            archiveUndoLifetime: archiveUndoLifetime
        ))
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
        _navigationState = State(
            initialValue: SessionNavigationState(
                lastSelectedSessionID: SessionNavigationPersistence.load(for: server)
            )
        )
        _showsCliSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsCliSessions(for: server),
            SessionRowDisplaySettings.showCliSessionsKey(for: server)
        )
        _showsClaudeCodeSessions = AppStorage(
            wrappedValue: SessionRowDisplaySettings.showsClaudeCodeSessions(for: server),
            SessionRowDisplaySettings.showClaudeCodeSessionsKey(for: server)
        )
    }

    var body: some View {
        sidebarLayout
            .onChange(of: navigationState.lastSelectedSessionID) { _, sessionID in
                chats.keepOnly(sessionID: sessionID)
            }
            .onChange(of: horizontalSizeClass, initial: true) { _, sizeClass in
                isCompactWidth = sizeClass == .compact
                if isCompactWidth { regularWidthChat = nil }
                appSidebar.isPresented = false
            }
            .onChange(of: viewModel.activeProfileName) {
                sectionViewModels = SectionViewModels(server: server)
            }
            .modifier(SessionListHingeReader(status: $hingeStatus))
            .safeAreaInset(edge: .top, spacing: 0) {
                if hasWaitingSharedImport { waitingSharedImportBanner }
            }
            .fullScreenCover(isPresented: settingsPresentation(compact: true), onDismiss: settingsDidDismiss) {
                settingsNavigationStack
            }
            .sheet(isPresented: settingsPresentation(compact: false), onDismiss: settingsDidDismiss) {
                settingsNavigationStack
                    .presentationDetents([.large])
                    .adaptivePagePresentation()
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
            .task {
                // Start the normal refresh immediately so a slow direct session
                // request cannot leave the sidebar empty. Deep-link resolution still
                // owns navigation precedence and is awaited before stored selection
                // restoration.
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
                // Ordered after the deep link so the restore sees the explicit
                // destination and leaves the stored selection alone.
                await restoreLastSelectedSessionIfNeeded()
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
                await monitorActiveSessionRows()
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
                    client: SessionEventStreamClient()
                ) { change in
                    NotificationCenter.default.post(
                        name: .talariaSessionsChanged,
                        object: server,
                        userInfo: [SessionsChange.userInfoKey: change]
                    )
                    Task { await refreshSessionsAndActiveProfile() }
                }
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
                // TAL-437: the last-known chats, projects and profile show at once; the initial
                // load then replaces them.
                viewModel.paintCachedStateIfEmpty(modelContext: modelContext)
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
            .onAppear { navigationState.filesInspectorPresented = storedFilesInspectorPresented }
            .onChange(of: navigationState.filesInspectorPresented) { _, presented in
                storedFilesInspectorPresented = presented
            }
            .onChange(of: showsProjectsSection) {
                // The "All" button that clears a project filter lives in the
                // Projects header, so hiding the section mid-filter would strand
                // the list on one project with no way back (#189).
                guard !showsProjectsSection else { return }
                selectedProjectID = nil
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
            overlaysContent: horizontalSizeClass == .regular,
            onPresentationChange: appSidebarPresentationChanged
        ) { presented in
            sharedSidebar(isPresented: presented, isDrawer: true)
        } content: {
            navigationSurface
        }
        .onChange(of: regularDrawerMode, initial: true) {
            guard horizontalSizeClass == .regular, regularSplitFullSize != .zero else { return }
            appSidebar.isPresented = !regularSidebarTiles && regularSidebarIsShown
        }
    }

    private var sidebarDrawerIsEnabled: Bool {
        horizontalSizeClass != .regular || !regularSidebarTiles
    }

    private var regularDrawerMode: String {
        guard horizontalSizeClass == .regular, regularSplitFullSize != .zero else { return "compact" }
        return regularSidebarTiles ? "column" : regularSidebarIsLandscape ? "landscape" : "portrait"
    }

    /// A hinge context is present on the Duo, including its folded outer display.
    private var isDuoOuterSidebar: Bool {
        horizontalSizeClass == .compact && hingeStatus != nil
    }

    private var navigationSurface: some View {
        ZStack {
            Color(.systemBackground)
            navigationContainer
                .environment(\.divisionRegionGeometry, splitGeometry)
                .onGeometryChange(for: DivisionRegionGeometry.self) { geometry in
#if DEBUG
                    DivisionRegionGeometry(geometry, divisions: divisionFramesForTesting)
#else
                    DivisionRegionGeometry(geometry)
#endif
                } action: { splitGeometry = $0 }
        }
    }

    private func sharedSidebar(isPresented: Bool = false, isDrawer: Bool = false) -> some View {
        AppSidebar(
            searchText: $searchText,
            presentation: appSidebar,
            searchUsesBottomBar: horizontalSizeClass == .compact,
            isActive: isDrawer ? isPresented : regularColumnVisibility.wrappedValue == .all,
            selection: navigationState.section,
            sectionVisibility: appSidebarSectionVisibility,
            select: openSection
        ) { header, searchPull in
            sessionListSurface(sidebarHeader: header, searchPull: searchPull)
        } actions: { isSearching in
            if #available(iOS 27.1, *) {
                if !isSearching {
                    ToolbarItem(placement: .topBarLeading) { sidebarWordmark }
                        .sharedBackgroundVisibility(.hidden)
                        .axisBehavior(.horizontalOnly)
                }
                if !detailHostsSidebarActions {
                    ToolbarItem(placement: horizontalSizeClass == .compact ? .bottomBar : .topBarTrailing) { settingsButton }
                        .axisBehavior(horizontalSizeClass == .compact ? .verticalPreferred : .horizontalOnly)
                        .visibilityPriority(.high)
                }
            } else {
                if !isSearching {
                    if #available(iOS 26.0, *) {
                        ToolbarItem(placement: .topBarLeading) { sidebarWordmark }
                            .sharedBackgroundVisibility(.hidden)
                    } else {
                        ToolbarItem(placement: .topBarLeading) { sidebarWordmark }
                    }
                }
                ToolbarItem(placement: horizontalSizeClass == .compact ? .bottomBar : .topBarTrailing) { settingsButton }
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
            ToolbarItem(placement: .secondaryAction) { sidebarFilters }
                .overflowPriority(.filters, includesHorizontal: true)
            if updateNotificationViewModel.supportsNotifications {
                ToolbarItem(placement: .secondaryAction) { updateNotificationsButton }
                    .overflowPriority(.notifications, includesHorizontal: true)
            }
        }
        .environment(\.sessionRowStyle, .sidebar)
    }

    private var sidebarWordmark: some View {
        Image("TalariaWordmark")
            .resizable()
            .scaledToFit()
            .frame(width: 105, height: 22)
            .accessibilityLabel("Talaria")
    }

    private var sidebarFilters: some View {
        SessionFilterControls(
            viewModel: viewModel,
            showsProfile: showsActiveProfileSection,
            showsProjects: showsProjectsSection,
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
                    .toolbar(removing: .sidebarToggle)
                    .navigationSplitViewColumnWidth(
                        min: foldedSidebarWidth ?? RegularSplitLayout.sidebarMinWidth,
                        ideal: foldedSidebarWidth ?? RegularSplitLayout.sidebarIdealWidth(splitWidth: regularSplitWidth),
                        max: foldedSidebarWidth ?? RegularSplitLayout.sidebarMaxWidth
                    )
            } detail: {
                conversationStack
                    .foldAvoidingPlacement(avoidsHorizontalDivisions: false, isEnabled: !hidesSidebarColumn)
                    .navigationSplitViewColumnWidth(
                        min: RegularSplitLayout.detailMinWidth,
                        ideal: RegularSplitLayout.detailMinWidth
                    )
            }
            .navigationSplitViewStyle(.balanced)
            .inspector(isPresented: regularFilesInspectorIsPresented) {
                if regularFilesInspectorIsPresented.wrappedValue, let regularWidthChat {
                    FilesInspectorContent(
                        session: regularWidthChat,
                        server: server,
                        onAPIError: { authManager.handleAPIError($0, server: server) },
                        onClose: { splitFilesInspector.isPresented.wrappedValue = false }
                    )
                    .id(regularWidthChat.id)
                    .ignoresSafeArea(.container, edges: .top)
                    .inspectorColumnWidth(min: 280, ideal: 340, max: 520)
                }
            }
            .onGeometryChange(for: CGSize.self) { geometry in
                CGSize(width: geometry.size.width + geometry.safeAreaInsets.leading + geometry.safeAreaInsets.trailing,
                       height: geometry.sizeIncludingSafeArea.height)
            } action: { regularSplitFullSize = $0 }
        } else {
            conversationStack
        }
    }

    /// Both widths show the selected root and push only its inner pages.
    private var conversationStack: some View {
        NavigationStack(path: sectionPath) {
            withDrawerButton(navigationDestination(navigationState.destination ?? .newChat(emptyChatRoute)))
                .toolbar {
                    if horizontalSizeClass != .regular || regularColumnVisibility.wrappedValue == .detailOnly
                        || detailHostsSidebarActions {
                        ToolbarItem(placement: .topBarTrailing) { regularNewChatButton }
                            .overflowPriority(.newChat)
                    }
                    if #available(iOS 27.1, *), detailHostsSidebarActions {
                        ToolbarItem(placement: .bottomBar) { settingsButton }
                            .axisBehavior(.verticalPreferred)
                            .visibilityPriority(.high)
                    }
                }
                .navigationDestination(for: CompactPage.self) { page in sectionStackPage(page) }
        }
        .id(regularDetailIdentity)
        .onToolbarVerticalEdgeChange { detailHasVerticalBar = horizontalSizeClass == .regular && $0 }
    }

    @ViewBuilder
    private func sectionStackPage(_ page: CompactPage) -> some View {
        withDrawerButton(Group {
            switch page {
            case .item(let item): sectionItemPage(item)
            case .session(let session): navigationDestination(.session(session))
            }
        })
    }

    private var regularDetailIdentity: Int { navigationState.chatRootRevision }

    private var regularSidebarIsLandscape: Bool {
        regularSplitFullSize.width > regularSplitFullHeight && regularSplitFullHeight > 0
    }

    private var regularSidebarTiles: Bool {
        regularSidebarIsLandscape && regularSplitFullSize.width >= 900
    }

    private var regularSidebarIsShown: Bool {
        let stored = regularSidebarIsLandscape ? landscapeSidebarVisibility : portraitSidebarVisibility
        return stored.isEmpty
            ? regularSidebarIsLandscape && UIDevice.current.userInterfaceIdiom == .pad && hingeStatus == nil
            : stored == "all"
    }

    private func storeRegularSidebarVisibility(_ shown: Bool) {
        let stored = shown ? "all" : "detailOnly"
        if regularSidebarIsLandscape { landscapeSidebarVisibility = stored }
        else { portraitSidebarVisibility = stored }
    }

    private var regularColumnVisibility: Binding<NavigationSplitViewVisibility> {
        Binding {
            regularSidebarTiles && !hidesSidebarColumn && regularSidebarIsShown ? .all : .detailOnly
        } set: { _ in
            // UIKit's automatic layout changes are not reader toggles. Our button owns the stored choice.
        }
    }

    /// Only the trailing column owns the vertical bar, so these two sidebar actions join it while tiled.
    private var detailHostsSidebarActions: Bool {
        horizontalSizeClass == .regular && detailHasVerticalBar && regularSidebarTiles
            && regularColumnVisibility.wrappedValue == .all
    }

    /// A chat takes the whole width while its Files inspector or companion page needs the room.
    private var hidesSidebarColumn: Bool {
        (navigationState.chatShowsFilesInspector && widensForFilesInspector)
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
        SplitFilesInspector(
            isPresented: Binding {
                navigationState.filesInspectorPresented
            } set: { presented in
                // Closing an iPhone Duo collapses the inspector without the reader closing Files; it shows again once
                // there is room (TAL-1477).
                guard presented || !isCompactWidth else { return }
                navigationState.filesInspectorPresented = presented
            },
            widensChat: horizontalSizeClass == .regular && regularSplitWidth >= RegularSplitLayout.filesInspectorChatWidth,
            reportShown: { navigationState.chatShowsFilesInspector = $0 },
            reportSession: { session in
                if horizontalSizeClass == .regular { regularWidthChat = session }
            },
            offersCompanionPage: horizontalSizeClass == .regular,
            reportCompanionPage: { navigationState.chatShowsCompanionPage = $0 }
        )
    }

    /// Presentation belongs outside the detail stack so Files gets a full-height column and its own bar.
    private var regularFilesInspectorIsPresented: Binding<Bool> {
        Binding {
            let availableWidth = regularSplitWidth - (regularColumnVisibility.wrappedValue == .all
                ? RegularSplitLayout.sidebarIdealWidth(splitWidth: regularSplitWidth) : 0)
            let companionFits = navigationState.chatShowsCompanionPage
                && RegularSplitLayout.splitsCompanionPage(width: availableWidth, height: regularSplitFullHeight)
            return horizontalSizeClass == .regular
                && !companionFits
                && navigationState.chatShowsFilesInspector
                && regularWidthChat != nil
                && (navigationState.section == .chats || navigationState.selectedSectionSession != nil)
                && availableWidth >= RegularSplitLayout.filesInspectorChatWidth
        } set: { presented in
            splitFilesInspector.isPresented.wrappedValue = presented
        }
    }

    private var regularSidebarToggleButton: some View {
        Button {
            if regularSidebarTiles {
                storeRegularSidebarVisibility(!regularSidebarIsShown)
            } else {
                appSidebar.isPresented.toggle()
            }
        } label: {
            Image(systemName: "sidebar.leading")
        }
        .accessibilityLabel("Sidebar")
    }

    @ToolbarContentBuilder
    private var drawerToolbarItem: some ToolbarContent {
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
        viewModel.isViewingCachedData || navigationState.isCreatingNewChat
    }

    @ViewBuilder
    private func navigationDestination(_ destination: SessionNavigationDestination) -> some View {
        switch destination {
        case .session(let session):
            ChatView(
                session: session,
                server: server,
                onAPIError: { authManager.handleAPIError($0, server: server) },
                draftStore: draftStore,
                sessionListOwner: viewModel,
                splitFilesInspector: splitFilesInspector,
                retained: chats.chat(for: session, server: server) {
                    ChatView.makeViewModel(session: session, server: server, sessionListOwner: viewModel)
                }
            )
                .id(session.id)
        case .newChat(let route):
            PendingNewChatView(
                initialDraft: route.initialDraft,
                initialAttachments: route.initialAttachments,
                autoStartsVoiceInput: route.autoStartsVoiceInput,
                profileName: route.profileName,
                providerID: route.providerID,
                projectID: route.projectID,
                executionMode: route.executionMode,
                server: server,
                viewModel: viewModel,
                onAPIError: { authManager.handleAPIError($0, server: server) },
                onSessionCreated: rememberCreatedSession,
                draftStore: draftStore,
                splitFilesInspector: splitFilesInspector
            )
            .id(route.id)
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
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
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
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
                    selectedSessionID: navigationState.selectedSectionSession?.sessionId,
                    actions: sessionRowActions(in: .webhook)
                )
            }
        }
        // Each screen reads its profile's data; a switch rebuilds it for the new profile (TAL-553).
        .id(viewModel.activeProfileName)
        .adaptiveSecondaryNavigationTitle()
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
            }
        }
        .id(viewModel.activeProfileName)
        .adaptiveSecondaryNavigationTitle()
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
                showsMessageCount: showsSessionMessageCount,
                showsWorkspace: showsSessionWorkspace,
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
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
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
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
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
                        showsMessageCount: showsSessionMessageCount,
                        showsWorkspace: showsSessionWorkspace,
                        selectedSessionID: navigationState.selectedSessionID,
                        actions: sessionRowActions()
                    )
                    .environment(\.sessionRowStyle, .regular)
                } label: {
                    Text("See all…")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .sidebarRowPadding()
                }
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
            Image(systemName: updateNotificationViewModel.unreadCount > 0 ? "bell.badge.fill" : "bell")
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
            insights: showsInsightsSection,
            activeProfile: showsActiveProfileSection,
            projects: showsProjectsSection
        )
    }

    /// Commit the destination beneath an open drawer before starting its own slide (TAL-477).
    /// A tiled column keeps the navigation stack's normal push animation.
    private func closeAppSidebar(then navigate: () -> Void) {
        guard sidebarDrawerIsEnabled, appSidebar.isPresented else {
            navigate()
            return
        }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { navigate() }
        DispatchQueue.main.async { appSidebar.isPresented = false }
    }

    private func appSidebarPresentationChanged(_ isPresented: Bool) {
        if horizontalSizeClass == .regular, !regularSidebarTiles, regularSplitFullSize != .zero {
            storeRegularSidebarVisibility(isPresented)
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
            // Compact width refreshes the conversation list while its drawer is open.
            isListVisible: horizontalSizeClass == .regular
                || appSidebar.isPresented
                || navigationState.destination == nil
                || navigationState.destination?.showsSessionListRows == true
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

    private var activeSessionMonitorTaskID: ActiveSessionMonitorTaskID {
        let activeSessions = visibleSessions.filter(SessionRowPresentation.isActiveStreaming)
        return ActiveSessionMonitorTaskID(
            streamIDs: SessionListViewModel.activeStreamIDs(in: activeSessions),
            hasActiveRows: !activeSessions.isEmpty,
            isViewingCachedData: viewModel.isViewingCachedData
        )
    }

    /// `list` is the chat list the rows belong to; a chat opened from it keeps it in the sidebar.
    private func sessionRowActions(in list: AppSection = .chats) -> SessionListRowActions {
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
            canCreateNewChat: !viewModel.isViewingCachedData && !navigationState.isCreatingNewChat,
            createNewChat: openNewChatFromKeyboard,
            searchSessions: openSearchFromKeyboard
        )
    }

    private func openNewChatFromKeyboard() {
        guard !viewModel.isViewingCachedData, !navigationState.isCreatingNewChat else { return }
        openNewChat()
    }

    private func openSearchFromKeyboard() {
        if sidebarDrawerIsEnabled { appSidebar.isPresented = true }
        else { storeRegularSidebarVisibility(true) }

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

    private func monitorActiveSessionRows() async {
        while !Task.isCancelled {
            let taskID = activeSessionMonitorTaskID
            guard taskID.hasActiveRows, !taskID.isViewingCachedData else { return }

            do {
                try await Task.sleep(nanoseconds: 1_000_000_000)
            } catch {
                return
            }

            guard !Task.isCancelled else { return }

            let refreshResult = await viewModel.refreshActiveSessionStatesIfNeeded(
                streamIDs: taskID.streamIDs,
                modelContext: modelContext
            )
            if refreshResult == .reloaded || refreshResult == .failed {
                handleLastError()
            }
        }
    }

    @MainActor
    private func switchActiveProfile(_ profile: ProfileSummary) async {
        let didSwitch = await viewModel.switchActiveProfile(profile)
        handleLastError()

        guard didSwitch else { return }

        await loadSessions()
    }

    private func loadSessions() async {
        // Rows carry `sessionRowTransition`, but it only plays when the array is
        // replaced inside an animation. The first population has nothing to move,
        // so it stays unanimated and later refreshes slide a new row into its
        // sorted place instead of popping it in.
        let animation = viewModel.sessions.isEmpty
            ? nil
            : SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
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
            animation: SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
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
            animation: SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
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
            animation: SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
        )
        handleLastError()
    }

    private func delete(_ session: SessionSummary) async {
        let didDelete = await viewModel.delete(
            session,
            modelContext: modelContext,
            animation: SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
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
            animation: SessionListMotion.sessionMutationAnimation(reduceMotion: reduceMotion)
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

    /// Awaited (not fire-and-forget) so the cold-start `.task` can resolve it before
    /// `restoreLastSelectedSessionIfNeeded()` — otherwise the restore races the deep
    /// link's network load and wins with the previous session.
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
        if isPresentingUpdateNotifications {
            pendingSettingsPath = path
            isPresentingUpdateNotifications = false
            return
        }
        reopensSidebarAfterSettings = reopensSidebarAfterSettings || appSidebar.isPresented
        closeAppSidebar {
            settingsPath = path
            isPresentingSettings = true
        }
    }

    private func settingsPresentation(compact: Bool) -> Binding<Bool> {
        Binding {
            isPresentingSettings && (horizontalSizeClass != .regular) == compact
        } set: { presented in
            // A width handoff dismisses the old presentation without closing Settings.
            guard compact == isCompactWidth else { return }
            isPresentingSettings = presented
        }
    }

    private func settingsDidDismiss() {
        guard !isPresentingSettings else { return }
        settingsPath = []
        if reopensSidebarAfterSettings, sidebarDrawerIsEnabled {
            DispatchQueue.main.async { appSidebar.isPresented = true }
        }
        reopensSidebarAfterSettings = false
    }

    private var settingsNavigationStack: some View {
        NavigationStack(path: $settingsPath) {
            SettingsView(server: server, selection: Binding {
                settingsPath.first
            } set: { pane in
                settingsPath = pane.map { [$0] } ?? []
            })
            .adaptiveSecondaryNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { isPresentingSettings = false } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("Close")
                }
                .overflowPriority(.done, includesHorizontal: true)
            }
            .navigationDestination(for: SettingsPane.self) { pane in
                SettingsPaneView(authManager: authManager, server: server, pane: pane)
                    .adaptiveSecondaryNavigationTitle()
            }
        }
    }

    private func openNewChat(_ route: PendingNewChatRoute) {
        closeAppSidebar { navigationState.select(route) }
    }

    private func openNewChat() {
        openNewChat(PendingNewChatRoute(projectID: selectedProjectID))
    }

    /// The server creates the chat in `mode` as it opens (TAL-1045).
    private func openNewChat(in mode: ExecutionMode) {
        openNewChat(viewModel.diagnosticChatRoute(mode, projectID: selectedProjectID))
    }

    private func openSession(_ session: SessionSummary, in list: AppSection = .chats,
                             preservesSidebar: Bool = false) async {
        await openSession(in: list, preservesSidebar: preservesSidebar) { session }
    }

    /// A failed load or import stays on the list and surfaces through the
    /// action-error alert; a destination chosen meanwhile is never replaced.
    private func openSession(in list: AppSection = .chats, preservesSidebar: Bool = false,
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
            selectSession(session, in: list,
                          preservesSidebar: preservesSidebar)
        case .failed:
            guard !Task.isCancelled else { return }
            // Forwards an expired session/cookie to the auth manager the same way
            // every other network-backed session-list action does.
            handleLastError()
        case .superseded:
            break
        }
    }

    private func selectSession(_ session: SessionSummary, in list: AppSection = .chats,
                               preservesSidebar: Bool = false) {
        let navigate = {
            if list != .chats, case .utility = navigationState.destination {
                navigationState.pushSectionSession(session)
            } else {
                navigationState.select(session)
            }
        }
        if preservesSidebar { navigate() }
        else { closeAppSidebar(then: navigate) }
        persistLastSelectedSession()
    }

    private func rememberCreatedSession(_ session: SessionSummary) {
        navigationState.remember(session)
        persistLastSelectedSession()
    }

    private func removeSessionFromNavigation(_ session: SessionSummary) {
        navigationState.remove(sessionID: session.sessionId)
        persistLastSelectedSession()
    }

    /// The restored row takes the same path as a tapped one, so an external session
    /// is imported before it is shown instead of opening with the list's stale
    /// writability. A failed import leaves the list showing, like a failed tap.
    private func restoreLastSelectedSessionIfNeeded() async {
        let session = navigationState.sessionToRestore(
            from: viewModel.sessions,
            allowsAutomaticRestore: true,
            clearsMissingSelection: viewModel.sessionLoadError == nil,
            pendingDeepLinkedSessionID: pendingDeepLinkedSessionID
        )
        persistLastSelectedSession()
        guard let session else { return }
        // Restoring the chat must retain the reader's saved sidebar visibility.
        await openSession(session, preservesSidebar: true)
    }

    private func persistLastSelectedSession() {
        SessionNavigationPersistence.save(navigationState.lastSelectedSessionID, for: server)
    }

}

private struct SessionSearchTaskID: Hashable {
    let query: String
    let projectID: String?
    let visibility: AutomatedSessionVisibility
    let isViewingCachedData: Bool
}

private struct ActiveSessionMonitorTaskID: Hashable {
    let streamIDs: [String]
    let hasActiveRows: Bool
    let isViewingCachedData: Bool
}

/// View models a section's list and its item page share, so both columns at regular width read
/// one load (TAL-643). Rebuilt when the active profile changes, with the screens (TAL-553).
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

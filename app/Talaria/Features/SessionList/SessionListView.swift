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
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.layoutDirection) private var layoutDirection
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: SessionListViewModel
    @State private var quotaViewModel: ProvidersViewModel
    @State private var updateNotificationViewModel: UpdateNotificationCenterViewModel
    @State private var navigationState: SessionNavigationState
    @State private var sessionPendingRename: SessionSummary?
    @State private var sessionPendingDeletion: SessionSummary?
    @State private var sessionPendingProjectCreation: SessionSummary?
    @State private var sessionExportShareItem: SessionExportShareItem?
    @State private var isPresentingProjectCreation = false
    @State private var isPresentingAddServer = false
    @State private var projectPendingDeletion: ProjectSummary?
    @State private var projectPendingRename: ProjectSummary?
    @State private var searchText = ""
    @State private var isSearchPresented = false
    @State private var selectedProjectID: String?
    @State private var sidebarScrollPosition: String?
    @State private var isAppSidebarPresented = false
    @State private var isPresentingUpdateNotifications: Bool
    @AccessibilityFocusState private var openNavigationIsFocused: Bool
    @State private var didCompleteInitialLoad = false
    @State private var immediateRefreshID: UUID?
    @State private var appSidebarQuotaSources: [ProviderQuotaWidgetSource] = []
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
    @AppStorage(ProviderQuotaSidebarSettings.firstSourceKey) private var firstSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaSidebarSettings.secondSourceKey) private var secondSidebarQuotaSourceID = ""
    @AppStorage(ProviderQuotaVisibilitySettings.storageKey) private var hiddenProviderData = Data()
    @AppStorage(ProviderQuotaRefreshInterval.storageKey)
    private var quotaRefreshIntervalSeconds = ProviderQuotaRefreshInterval.defaultValue.rawValue
    // Per-server key (#19): the CLI toggle mirrors the active server's
    // `show_cli_sessions`, so its cached value must not leak across servers.
    // Configured in `init`, where the server URL is known.
    @AppStorage private var showsCliSessions: Bool
    @AppStorage private var showsClaudeCodeSessions: Bool
    @AppStorage(HeaderLogoColor.storageKey) private var headerLogoColorHex = HeaderLogoColor.defaultHex
    @AppStorage(PrimaryActionTintSettings.isEnabledKey) private var tintsPrimaryActions = false
    @AppStorage(GlassPreference.isEnabledKey) private var isGlassEnabled = GlassPreference.defaultIsEnabled
    @AppStorage(SessionIdentitySettings.displayNameKey) private var identityDisplayName = ""
    @AppStorage(SessionIdentitySettings.initialsKey) private var identityInitials = ""
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
        draftStore: ChatDraftStore? = nil
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
        _viewModel = State(initialValue: SessionListViewModel(server: server, responseCache: .app(server: server)))
        _quotaViewModel = State(initialValue: ProvidersViewModel(server: server))
        _updateNotificationViewModel = State(initialValue: UpdateNotificationCenterViewModel(server: server))
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
        AppSidebarContainer(isPresented: $isAppSidebarPresented) {
            AppSidebarDrawer(
                isPresented: isAppSidebarPresented,
                selection: appSidebarSelection,
                sectionVisibility: appSidebarSectionVisibility,
                serverName: appSidebarServerName,
                activeProfileName: appSidebarProfileName,
                quotaSources: appSidebarQuotaSources,
                newChat: {
                    isAppSidebarPresented = false
                    openNewChat()
                },
                select: selectAppSidebarDestination,
                close: { isAppSidebarPresented = false }
            )
        } content: {
            ZStack {
                Color(.systemBackground)
                navigationContainer
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if hasWaitingSharedImport { waitingSharedImportBanner }
        }
            .fullScreenCover(isPresented: $isPresentingUpdateNotifications) {
                UpdateNotificationsPresentation(
                    viewModel: updateNotificationViewModel,
                    onAPIError: { authManager.handleAPIError($0, server: server) },
                    openDestination: openNotificationDestination
                )
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
                    isSaving: viewModel.isRenamingSession
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
                    isSaving: viewModel.isRenamingProject
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
            .onChange(of: isAppSidebarPresented) { _, isPresented in
                if isPresented {
                    reloadAppSidebarQuotaSources()
                    return
                }
                Task { @MainActor in
                    await Task.yield()
                    guard !isAppSidebarPresented else { return }
                    openNavigationIsFocused = true
                }
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
                    projectPendingDeletion: $projectPendingDeletion,
                    deleteSession: { session in
                        Task { await delete(session) }
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
            // The App drawer button is the sessions column's only sidebar control, so the
            // column stays visible instead of offering the system toggle beside it (TAL-482).
            NavigationSplitView(columnVisibility: .constant(.all)) {
                sessionListSurface
                    .toolbar(removing: .sidebarToggle)
                    // 340pt is the narrowest width where "Scheduled sessions", a "200+" count
                    // and the chevron fit at default Dynamic Type.
                    .navigationSplitViewColumnWidth(min: 340, ideal: 380, max: 440)
            } detail: {
                NavigationStack {
                    regularWidthDetail
                }
            }
            .navigationSplitViewStyle(.balanced)
            .id(navigationState.rootRevision)
        } else if let utility = navigationState.destination?.compactRootUtility {
            NavigationStack {
                utilityDestination(utility)
                    .background(NavigationBarLeadingMarginObserver())
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            sidebarButton
                        }
                    }
            }
        } else {
            NavigationStack {
                sessionListSurface
                    .background(NavigationBarLeadingMarginObserver())
                    .navigationDestination(item: navigationDestinationBinding) { destination in
                        navigationDestination(destination)
                    }
            }
        }
    }

    private var sessionListSurface: some View {
        ZStack(alignment: .bottomTrailing) {
            Color(.systemBackground)
                .ignoresSafeArea()

            content

            if showsFloatingNewChatButton {
                newSessionButton
                    .padding(.trailing, 24)
                    .padding(.bottom, 22)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .navigationTitle("Chats")
        .searchable(
            text: $searchText,
            isPresented: $isSearchPresented,
            prompt: "Search sessions"
        )
        .minimizingSearchToolbar()
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                sidebarButton
            }

            if updateNotificationViewModel.supportsNotifications {
                ToolbarItem(placement: .topBarTrailing) {
                    updateNotificationsButton
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                settingsButton
            }

            // In regular width the floating button would cover rows in the narrow
            // column, so New Chat moves to the column's bottom bar (TAL-482).
            if horizontalSizeClass == .regular {
                ToolbarItemGroup(placement: .bottomBar) {
                    Spacer()

                    HapticButton(feedbackStyle: .medium) {
                        openNewChat()
                    } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .disabled(isNewChatDisabled)
                    .accessibilityLabel("New Chat")
                }
            }

            // iOS 26 minimizes search into the bottom bar, so New Chat joins that row instead
            // of floating above the list (TAL-461).
            if #available(iOS 26, *) {
                if horizontalSizeClass != .regular {
                    DefaultToolbarItem(kind: .search, placement: .bottomBar)
                    ToolbarSpacer(.flexible, placement: .bottomBar)

                    ToolbarItem(placement: .bottomBar) {
                        newChatToolbarButton
                    }
                }
            }
        }
    }

    private var isNewChatDisabled: Bool {
        viewModel.isViewingCachedData || navigationState.isCreatingNewChat
    }

    private var showsFloatingNewChatButton: Bool {
        if #available(iOS 26, *) { return false }
        return !isSearchingSessions && horizontalSizeClass != .regular
    }

    @ViewBuilder
    private var regularWidthDetail: some View {
        if let destination = navigationState.destination {
            navigationDestination(destination)
        } else {
            ContentUnavailableView {
                Label("Select a Chat", systemImage: "bubble.left.and.bubble.right")
            } description: {
                Text("Choose a session from the sidebar or start a new chat.")
            } actions: {
                Button("New Chat", action: openNewChat)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    @ViewBuilder
    private func navigationDestination(_ destination: SessionNavigationDestination) -> some View {
        switch destination {
        case .session(let session):
            ChatView(
                session: session,
                server: server,
                onAPIError: { authManager.handleAPIError($0, server: server) },
                draftStore: draftStore
            )
                .id(session.id)
        case .newChat(let route):
            PendingNewChatView(
                initialDraft: route.initialDraft,
                initialAttachments: route.initialAttachments,
                autoStartsVoiceInput: route.autoStartsVoiceInput,
                profileName: route.profileName,
                providerID: route.providerID,
                server: server,
                viewModel: viewModel,
                onAPIError: { authManager.handleAPIError($0, server: server) },
                onSessionCreated: rememberCreatedSession,
                draftStore: draftStore
            )
            .id(route.id)
        case .utility(let destination):
            utilityDestination(destination)
        }
    }

    @ViewBuilder
    private func utilityDestination(_ destination: SessionListUtilityDestination) -> some View {
        Group {
            switch destination {
            case .settings(let scrollTo):
                SettingsView(authManager: authManager, server: server, initialScrollTarget: scrollTo)
            case .providers(let sourceID):
                InsightsView(
                    server: server,
                    quotaViewModel: quotaViewModel,
                    initialQuotaSourceID: sourceID,
                    openProviderSettings: {
                        navigationState.select(.settings(.providerQuotas))
                    },
                    onAPIError: { authManager.handleAPIError($0, server: server) }
                )
                    .id(viewModel.activeProfileName)
            case .providerQuotaWidgetSettings:
                ProviderQuotaWidgetAppearanceView()
            case .tasks:
                TasksView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
            case .kanban:
                KanbanView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
            case .skills:
                SkillsView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
            case .memory:
                MemoryView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
            case .insights:
                InsightsView(
                    server: server,
                    quotaViewModel: quotaViewModel,
                    openProviderSettings: {
                        navigationState.select(.settings(.providerQuotas))
                    },
                    onAPIError: { authManager.handleAPIError($0, server: server) }
                )
                    .id(viewModel.activeProfileName)
            case .archived:
                ArchivedSessionsView(server: server, onAPIError: { authManager.handleAPIError($0, server: server) })
            case .scheduled:
                GroupedSessionsView(
                    title: String(localized: "Scheduled sessions"),
                    isEnabled: showsCronSessions,
                    emptySystemImage: "calendar.badge.clock",
                    includes: { $0.isCronSession && !$0.isWebhookSession },
                    viewModel: viewModel,
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
                    selectedSessionID: horizontalSizeClass == .regular
                        ? navigationState.selectedSessionID
                        : nil,
                    actions: sessionRowActions
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
                    selectedSessionID: horizontalSizeClass == .regular
                        ? navigationState.selectedSessionID
                        : nil,
                    actions: sessionRowActions
                )
            }
        }
        .adaptiveSecondaryNavigationTitle()
    }

    private var navigationDestinationBinding: Binding<SessionNavigationDestination?> {
        Binding(
            get: { navigationState.destination?.compactPushedDestination },
            set: { destination in
                guard destination == nil else { return }
                navigationState.clearDestination()
            }
        )
    }

    private var content: some View {
        List {
            if viewModel.isViewingCachedData {
                OfflineCacheBanner()
                    .padding(.top, 16)
                    .sessionsScreenListRow()
            }

            if !hasSearchQuery {
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

            if scheduledSessionGroups.showsDisclosure(isSearchActive: hasSearchQuery) {
                GroupedSessionsDisclosure(
                    title: String(localized: "Scheduled sessions"),
                    assetImage: "LucideCalendarClock",
                    systemImage: nil,
                    expandAccessibilityLabel: String(localized: "Expand scheduled sessions"),
                    collapseAccessibilityLabel: String(localized: "Collapse scheduled sessions"),
                    viewModel: viewModel,
                    sessions: scheduledSessionGroups.scheduled,
                    totalCount: scheduledSessionGroups.totalScheduledCount,
                    countIsPartial: scheduledSessionGroups.scheduledCountIsPartial,
                    isSearchActive: hasSearchQuery,
                    searchText: searchText,
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
                    selectedSessionID: horizontalSizeClass == .regular
                        ? navigationState.selectedSessionID
                        : nil,
                    userIsExpanded: $scheduledSessionsAreExpanded,
                    actions: sessionRowActions,
                    viewAll: { navigationState.select(.scheduled) }
                )
            }

            if scheduledSessionGroups.showsWebhookDisclosure(isSearchActive: hasSearchQuery) {
                GroupedSessionsDisclosure(
                    title: String(localized: "Webhook sessions"),
                    assetImage: nil,
                    systemImage: "bolt.horizontal.circle",
                    expandAccessibilityLabel: String(localized: "Expand webhook sessions"),
                    collapseAccessibilityLabel: String(localized: "Collapse webhook sessions"),
                    viewModel: viewModel,
                    sessions: scheduledSessionGroups.webhook,
                    totalCount: scheduledSessionGroups.totalWebhookCount,
                    countIsPartial: scheduledSessionGroups.webhookCountIsPartial,
                    isSearchActive: hasSearchQuery,
                    searchText: searchText,
                    showsMessageCount: showsSessionMessageCount,
                    showsWorkspace: showsSessionWorkspace,
                    selectedSessionID: horizontalSizeClass == .regular
                        ? navigationState.selectedSessionID
                        : nil,
                    userIsExpanded: $webhookSessionsAreExpanded,
                    actions: sessionRowActions,
                    viewAll: { navigationState.select(.webhook) }
                )
            }

            SessionListRowsSection(
                viewModel: viewModel,
                sessions: scheduledSessionGroups.ordinary,
                emptyTitle: emptySessionsTitle,
                emptyDescription: emptySessionsDescription,
                isSearchActive: hasSearchQuery,
                searchText: searchText,
                showsMessageCount: showsSessionMessageCount,
                showsWorkspace: showsSessionWorkspace,
                selectedSessionID: horizontalSizeClass == .regular
                    ? navigationState.selectedSessionID
                    : nil,
                actions: sessionRowActions,
                suppressEmptyState: !scheduledSessionGroups.scheduled.isEmpty
                    || !scheduledSessionGroups.webhook.isEmpty
            )

            if showsArchivedEntry {
                archivedEntryRow
                    .sessionsScreenListRow()
            }

            Color.clear
                .frame(height: 104)
                .sessionsScreenListRow()
                .accessibilityHidden(true)
        }
        .listStyle(.plain)
        // Let rows hug their content instead of the 44pt default minimum, so the
        // single-line utility/disclosure rows aren't padded out and stay aligned
        // with the tightly-packed navigation rows.
        .environment(\.defaultMinListRowHeight, 0)
        .scrollContentBackground(.hidden)
        .scrollPosition(id: $sidebarScrollPosition)
        .background(Color(.systemBackground))
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await refreshSessionsAndActiveProfile()
        }
        .animation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion), value: scheduledSessionsAreExpanded)
        .animation(SessionListMotion.disclosureAnimation(reduceMotion: reduceMotion), value: webhookSessionsAreExpanded)
    }

    private var settingsButton: some View {
        HapticButton(feedbackStyle: .medium) {
            navigationState.select(.settings(nil))
        } label: {
            Text(settingsInitials)
                .font(.caption.weight(.semibold))
                .foregroundStyle(initialsAvatarForegroundColor)
                .frame(width: 28, height: 28)
                .background(selectedHeaderLogoColor, in: Circle())
                .overlay(Circle().stroke(.white.opacity(0.18), lineWidth: 1))
        }
        .accessibilityLabel("Settings")
        .accessibilityHint("Opens Settings. Long press to switch servers.")
        // Keep the existing long-press server switcher while the avatar moves
        // into the native toolbar.
        .contextMenu {
            AvatarServerSwitcherMenu(
                model: avatarServerSwitcherModel,
                switchToServer: { account in
                    authManager.switchActiveServer(to: account)
                },
                addServer: { isPresentingAddServer = true },
                manageServers: { navigationState.select(.settings(.servers)) }
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
        isPresentingUpdateNotifications = false
        navigationState.select(.settings(.system))
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

    private var sidebarButton: some View {
        Button {
            isAppSidebarPresented = true
        } label: {
            Image(systemName: "sidebar.left")
                .font(.body.weight(.semibold))
        }
        .accessibilityLabel("Open navigation")
        .accessibilityFocused($openNavigationIsFocused)
    }

    private var appSidebarSelection: AppSidebarDestination {
        guard case .utility(let destination) = navigationState.destination else {
            return .chats
        }

        switch destination {
        case .tasks: return .tasks
        case .kanban: return .kanban
        case .skills: return .skills
        case .memory: return .memory
        case .insights: return .insights
        case .settings, .providerQuotaWidgetSettings: return .settings
        case .providers(let sourceID): return sourceID.map(AppSidebarDestination.quota) ?? .insights
        case .archived, .scheduled, .webhook: return .chats
        }
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

    private var appSidebarProfileName: String? {
        let profileName = (viewModel.activeProfileDisplayName ?? viewModel.activeProfileName)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return profileName?.isEmpty == false ? profileName : nil
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

    private func selectAppSidebarDestination(_ destination: AppSidebarDestination) {
        switch destination {
        case .chats:
            navigationState.clearDestination()
        case .tasks:
            navigationState.select(.tasks)
        case .kanban:
            navigationState.select(.kanban)
        case .skills:
            navigationState.select(.skills)
        case .memory:
            navigationState.select(.memory)
        case .insights:
            navigationState.select(.insights)
        case .quota(let sourceID):
            navigationState.select(.providers(sourceID))
        case .settings:
            navigationState.select(.settings(nil))
        }

        isAppSidebarPresented = false
    }

    private func reloadAppSidebarQuotaSources() {
        let selectedIDs = ProviderQuotaSidebarSettings.sourceIDs(
            first: firstSidebarQuotaSourceID,
            second: secondSidebarQuotaSourceID
        )
        let sources = ProviderQuotaWidgetSnapshotStore().load()?.sources ?? []
        let hiddenProviderIDs = ProviderQuotaVisibilitySettings.hiddenProviderIDs(from: hiddenProviderData)
        let byID = Dictionary(uniqueKeysWithValues: sources.map { ($0.sourceID, $0) })
        appSidebarQuotaSources = selectedIDs
            .compactMap { byID[$0] }
            .filter { source in
                guard let providerID = source.providerID?.lowercased() else { return true }
                return !hiddenProviderIDs.contains(providerID)
            }
    }

    private var providerQuotaRefreshTaskID: String {
        "\(server.absoluteString)|\(quotaRefreshIntervalSeconds)|\(scenePhase == .active)"
    }

    private var autoRefreshTaskID: SessionListAutoRefresh.TaskID {
        SessionListAutoRefresh.TaskID(
            server: server,
            isSceneActive: scenePhase == .active,
            // In regular width the sidebar stays beside the detail column, so
            // the list is only off screen when a compact destination has
            // replaced or covered it.
            isListVisible: horizontalSizeClass == .regular
                || navigationState.destination == nil
                || navigationState.destination?.showsSessionListRows == true
        )
    }

    /// Restarts the session-change subscription when the scene's activity or the server changes.
    private var sessionEventsTaskID: String {
        "\(server.absoluteString)|\(scenePhase == .active)"
    }

    private var newSessionButton: some View {
        HapticButton(feedbackStyle: .medium) {
            openNewChat()
        } label: {
            Image(systemName: "square.and.pencil")
                .font(.title3.weight(.semibold))
                .foregroundStyle(newSessionButtonForegroundColor)
                .frame(width: 52, height: 52)
                .contentShape(Circle())
                .background {
                    if let fill = newSessionButtonSolidThemeFill {
                        Circle().fill(fill)
                    }
                }
                .sessionsChromeGlass(
                    isInteractive: true,
                    tint: newSessionButtonGlassTint,
                    fallbackMaterial: .regularMaterial,
                    in: Circle()
                )
        }
        .buttonStyle(SessionListFloatingChatButtonStyle())
        .disabled(isNewChatDisabled)
        .opacity(viewModel.isViewingCachedData ? 0.45 : 1)
        .accessibilityLabel("New Chat")
    }

    @available(iOS 26, *)
    private var newChatToolbarButton: some View {
        HapticButton(feedbackStyle: .medium) {
            openNewChat()
        } label: {
            Image(systemName: "square.and.pencil")
                .foregroundStyle(newSessionButtonForegroundColor)
        }
        .buttonStyle(.glassProminent)
        .tint(newSessionButtonGlassTint)
        .disabled(isNewChatDisabled)
        .opacity(viewModel.isViewingCachedData ? 0.45 : 1)
        .accessibilityLabel("New Chat")
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

    /// Bottom-of-list entry to the Archived screen (issue #17). Hidden once a
    /// search query is typed, offline (cached data cannot fetch archived rows),
    /// and when the server reports zero archived sessions or omits
    /// `archived_count` (older server) — so the list is unchanged for users
    /// with nothing archived.
    private var showsArchivedEntry: Bool {
        guard !hasSearchQuery, !viewModel.isViewingCachedData else { return false }
        return (viewModel.archivedCount ?? 0) > 0
    }

    private var archivedEntryRow: some View {
        HapticButton {
            navigationState.select(.archived)
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "archivebox")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .frame(width: 24)
                    .accessibilityHidden(true)

                Text("Archived Chats")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                if let archivedCount = viewModel.archivedCount {
                    Text("\(archivedCount)")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(.thinMaterial, in: Capsule())
                }

                Spacer(minLength: 0)

                Image(systemName: "chevron.forward")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
            .padding(.horizontal, 24)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.top, 12)
        .accessibilityHint("Shows archived sessions.")
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

    private func isActiveProfile(_ profile: ProfileSummary) -> Bool {
        guard let profileName = profile.normalizedName else { return false }

        if let activeProfileName = viewModel.activeProfileName {
            return profileName == activeProfileName
        }

        return profile.isActive == true
    }

    private var settingsInitials: String {
        SessionIdentitySettings.displayInitials(
            displayName: identityDisplayName,
            storedInitials: identityInitials,
            fallbackFullName: NSFullUserName()
        )
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

    private var newSessionButtonSurface: AdaptiveGlassSurface {
        AdaptiveGlassSurface.resolve(
            liquidGlassAvailable: GlassPreference.isLiquidGlassSupported,
            isGlassEnabled: isGlassEnabled,
            reduceTransparency: reduceTransparency
        )
    }

    // The glass tint is dropped on the material/opaque fallback surfaces, so a
    // themed button would otherwise show its contrast-picked foreground over a
    // neutral material (e.g. black-on-dark for a light theme color). Draw a
    // solid header-color fill there so the button stays themed and readable;
    // the liquid-glass surface keeps tinting via `newSessionButtonGlassTint`.
    private var newSessionButtonSolidThemeFill: Color? {
        guard newSessionButtonUsesThemeColor, newSessionButtonSurface != .liquidGlass else {
            return nil
        }

        return selectedHeaderLogoColor
    }

    private var newSessionButtonGlassTint: Color {
        if newSessionButtonUsesThemeColor {
            return selectedHeaderLogoColor
        }

        return colorScheme == .dark ? .white : .black
    }

    private var newSessionButtonForegroundColor: Color {
        if newSessionButtonUsesThemeColor {
            return HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
        }

        return colorScheme == .dark ? .black : .white
    }

    private var initialsAvatarForegroundColor: Color {
        HeaderLogoColor.prefersDarkForeground(for: headerLogoColorHex) ? .black : .white
    }

    private var normalizedSearchText: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var isSearchingSessions: Bool {
        isSearchPresented || hasSearchQuery
    }

    /// The list reshapes for results only once there is a query, so opening an
    /// empty search leaves it in place (TAL-461).
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

    private var sessionRowActions: SessionListRowActions {
        SessionListRowActions(
            retryLoad: {
                Task { await refreshSessionsAndActiveProfile() }
            },
            open: { session in
                Task { await openSession(session) }
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
        if horizontalSizeClass != .regular {
            navigationState.clearDestination()
        }

        Task { @MainActor in
            await Task.yield()
            isSearchPresented = true
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

        navigationState.select(
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

        let session = await viewModel.loadSessionForDeepLink(id: sessionID, modelContext: modelContext)
        // Re-checked post-await: the view (and this task) may have been torn down —
        // e.g. dismissed, or the active server changed under `.id(server)` — while
        // the network load was in flight. Selecting or persisting for a session
        // whose owning view no longer exists is stale work, not a real navigation.
        guard !Task.isCancelled else { return }
        guard let session else {
            handleLastError()
            return
        }

        // A deep-linked external session needs the same server-side import a
        // tapped row does before it can be continued.
        await openSession(session)
    }

    /// Opens the New Chat composer in response to the "New Chat" App Intents (#337/#338),
    /// mirroring the "+" button. Carries `autoStartsVoiceInput` so the voice variant begins
    /// dictation once the composer appears. The request is cleared so it fires once per
    /// invocation.
    private func openRequestedNewChatIfNeeded() {
        guard let request = requestedNewChat else { return }
        requestedNewChat = nil
        navigationState.select(
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
        navigationState.select(.providers(sourceID))
    }

    private func openProviderQuotaWidgetSettingsIfNeeded() {
        guard opensProviderQuotaWidgetSettings else { return }
        opensProviderQuotaWidgetSettings = false
        navigationState.select(.providerQuotaWidgetSettings)
    }

    private func openNewChat() {
        navigationState.select(PendingNewChatRoute())
    }

    /// External sessions are imported (or refreshed) server-side before navigation,
    /// so the opened session carries the server's authoritative writability. A failed
    /// import stays on the list and surfaces through the action-error alert.
    private func openSession(_ session: SessionSummary) async {
        let navigationRevision = navigationState.rootRevision
        guard let resolvedSession = await viewModel.sessionToOpen(
            for: session,
            modelContext: modelContext
        ) else {
            // Forwards an expired session/cookie to the auth manager the same way
            // every other network-backed session-list action does.
            handleLastError()
            return
        }

        // Any destination chosen while the import was in flight — New Chat, a
        // utility, another row — is newer than this one and must not be replaced.
        guard navigationRevision == navigationState.rootRevision else { return }
        selectSession(resolvedSession)
    }

    private func selectSession(_ session: SessionSummary) {
        navigationState.select(session)
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
            allowsAutomaticRestore: horizontalSizeClass == .regular,
            clearsMissingSelection: viewModel.sessionLoadError == nil,
            pendingDeepLinkedSessionID: pendingDeepLinkedSessionID
        )
        persistLastSelectedSession()
        guard let session else { return }
        await openSession(session)
    }

    private func persistLastSelectedSession() {
        SessionNavigationPersistence.save(navigationState.lastSelectedSessionID, for: server)
    }

}

private extension View {
    @ViewBuilder
    func minimizingSearchToolbar() -> some View {
        if #available(iOS 26, *) {
            // Keeping the navigation bar up stops the list jumping under the search field.
            searchToolbarBehavior(.minimize)
                .searchPresentationToolbarBehavior(.avoidHidingContent)
        } else {
            self
        }
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

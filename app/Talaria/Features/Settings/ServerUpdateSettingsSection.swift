import SwiftUI
import TalariaKit
import UniformTypeIdentifiers

struct ServerUpdateSettingsSection: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    @Environment(ServerSettingsStore.self) private var settingsStore: ServerSettingsStore?
    @Environment(UpdateNotificationCenterViewModel.self) private var sharedNotifications: UpdateNotificationCenterViewModel?
    @Bindable var authManager: AuthManager
    let server: URL
    var feedback: FeedbackComposer?
    @AppStorage(SectionVisibilitySettings.chatScreenKey) private var showsScreen = true
    @AppStorage(SectionVisibilitySettings.feedbackOnScreenshotKey)
    private var feedbackOnScreenshot = SectionVisibilitySettings.defaultFeedbackOnScreenshot

    @State private var model: ServerUpdateModel
    @State private var localNotifications: UpdateNotificationCenterViewModel
    @State private var updateTarget: UpdateTarget?
    @State private var agentConfirmation: UpdatesApplyResponse.AgentConfirmation?
    @State private var agentConfirmationMessage = ""
    @State private var interruptConfirmation: UpdatesApplyResponse.InterruptConfirmation?
    @State private var isPresentingForcedCheckResult = false
    @State private var summaryRequest: UpdateSummaryRequest?
    @State private var backup = AgentBackupSettings()
    @State private var backupConfirmation: AgentBackupStatus?
    @State private var restore = AgentRestoreSettings()
    @State private var restoreConfirmation: AgentRestoreStatus?
    @State private var showsRestoreImporter = false
    @State private var isReplacingRecoveryBackup = false
    @State private var archiveDownload = AgentArchiveDownload()

    init(authManager: AuthManager, server: URL, feedback: FeedbackComposer? = nil) {
        self.authManager = authManager
        self.server = server
        self.feedback = feedback
        let client = APIClient(baseURL: server)
        _model = State(initialValue: ServerUpdateModel(client: client))
        _localNotifications = State(initialValue: UpdateNotificationCenterViewModel(server: server, client: client))
    }

    /// Owns the System page so its sheet, alerts and loads attach once, to the page. On a `Group` or `Section` of rows,
    /// SwiftUI copies them onto every row, and a copy that never presented dismisses Settings itself (TAL-2248).
    var body: some View {
        @Bindable var archiveDownload = archiveDownload
        SettingsCategoryPage(category: .system) {
            ServerSettingsSections(page: .updates)
            SettingsSection(title: String(localized: "System")) {
                ServerSettingsSections(page: .titles)
                SettingsValueRow(title: SettingsIndex.systemStatus.title, systemImage: "server.rack") {
                    serverStatusPill
                }

                SettingsValueRow(title: SettingsIndex.systemVersion.title, systemImage: "number", hasInteractiveTrailingContent: true) {
                    HStack(spacing: 12) {
                        serverVersionContent
                        updateControl(for: .webui, available: webUpdateAvailable)
                    }
                }

                AgentBackupSettingsRow(backup: backup, archiveDownload: archiveDownload, server: server) { backupConfirmation = $0 }
                AgentRestoreSettingsRow(restore: restore, archiveDownload: archiveDownload, server: server) {
                    if restore.status?.job?.recoveryUrl != nil {
                        isReplacingRecoveryBackup = true
                    } else {
                        showsRestoreImporter = true
                    }
                } confirm: { restoreConfirmation = $0 }
                serverUpdateCheckAction
                serverUpdateNote
                UpdateSummaryButton(info: model.updateTargets?.webui) {
                    summaryRequest = UpdateSummaryRequest(target: .webui)
                }
                updateProblem(for: .webui)
                agentUpdateRows
                if scrollAnchor == .setting(.systemUpdateSummary),
                   model.updateTargets?.webui?.offersSummary != true, model.updateTargets?.agent?.offersSummary != true {
                    SettingsInfoRow(title: SettingsIndex.systemUpdateSummary.title,
                                    value: String(localized: "Not Available on This Server"))
                }
                SettingsToggleRow(title: SettingsIndex.systemScreen.title, systemImage: "display", isOn: $showsScreen,
                                  accessibilityIdentifier: SettingsIndex.systemScreen.id)
            }

            SettingsSection(title: String(localized: "Feedback")) {
                FeedbackSettingsRow(feedback: feedback, entry: .systemSendFeedback)
                SettingsToggleRow(title: SettingsIndex.systemFeedbackOnScreenshot.title, systemImage: "camera.viewfinder",
                                  isOn: $feedbackOnScreenshot, accessibilityIdentifier: SettingsIndex.systemFeedbackOnScreenshot.id)
            }
        }
        .task(id: notifications.completedUpdateID) {
            await model.load(settingsStore: settingsStore, postUpdate: notifications.completedUpdateID != nil, onAPIError: handleAPIError)
        }
        .updatingPresentation(localNotifications, isEnabled: sharedNotifications == nil, onAPIError: handleAPIError)
        .task(id: sharedNotifications == nil && localNotifications.needsFastPolling) {
            guard sharedNotifications == nil, localNotifications.needsFastPolling else { return }
            await localNotifications.refreshWhileActive(onRefresh: {})
        }
        .task { await backup.load(on: server) }
        .task(id: backup.poll) { await backup.pollStatus(on: server) }
        .task { await restore.load(on: server) }
        .task(id: restore.shouldPoll) { await restore.pollStatus(on: server) }
        .onDisappear {
            archiveDownload.stop()
            interruptConfirmation = nil
            agentConfirmation = nil
            model.discardConfirmation()
        }
        .sheet(item: $summaryRequest) { request in
            UpdateSummarySheet(
                model: UpdateSummaryModel(target: request.target, client: APIClient(baseURL: server)),
                name: request.name
            )
        }
        .sheet(item: $archiveDownload.shareItem) { item in
            SessionExportShareSheet(fileURL: item.fileURL)
                .presentationDetents([.medium, .large])
                .ignoresSafeArea()
        }
        .alert("Create Agent-home backup?", isPresented: isConfirmingBackup, presenting: backupConfirmation) { status in
            Button("Cancel", role: .cancel) {}
            Button("Create Backup") {
                Task { await backup.apply(.create, on: server, confirmed: status) }
            }
        } message: { status in
            Text("Server: \(status.server)\nOwning profile: \(status.profile)\n\nThe backup includes every profile and can contain credentials. Keep the archive private.")
        }
        .fileImporter(isPresented: $showsRestoreImporter, allowedContentTypes: [.zip]) { result in
            switch result {
            case let .success(archive): Task { await restore.stage(archive, on: server) }
            case let .failure(error): restore.failedToOpenArchive(error)
            }
        }
        .alert("Replace recovery backup?", isPresented: $isReplacingRecoveryBackup) {
            Button("Cancel", role: .cancel) {}
            Button("Choose Archive") { showsRestoreImporter = true }
        } message: {
            Text("Staging a new archive removes the current recovery backup from the server. Download it first if you need to keep it.")
        }
        .alert("Restore Agent home?", isPresented: isConfirmingRestore, presenting: restoreConfirmation) { status in
            Button("Cancel", role: .cancel) {}
            Button("Restore", role: .destructive) { Task { await restore.confirm(status, on: server) } }
        } message: { status in
            if let job = status.job {
                Text("Restore \(job.fileName) to \(status.profile) on \(status.server)? Files and sessions can be overwritten.")
            }
        }
        .refreshesLive(showsStatus: false) {
            await loadServerSettings()
            async let backupStatus: Void = backup.load(on: server)
            async let restoreStatus: Void = restore.load(on: server)
            _ = await (backupStatus, restoreStatus)
        }
        .alert(updateTarget == .agent ? String(localized: "Update Hermes Agent?") : String(localized: "Update server?"),
               isPresented: isConfirmingUpdate, presenting: updateTarget) { target in
            Button("Cancel", role: .cancel) {}
            Button("Update") {
                Task { await applyServerUpdate(target: target) }
            }
        } message: { target in
            if target == .agent {
                Text("This installs the available Hermes Agent update on the server.")
            } else {
                // swiftlint:disable:next line_length
                Text("This pulls the latest Hermes server version and restarts it. Active chats may be interrupted briefly; the app reconnects when the server is back.")
            }
        }
        .alert("Install Hermes Agent update?", isPresented: isConfirmingAgent(refresh: false), presenting: agentConfirmation) { confirmation in
            agentConsentActions(confirmation, title: "Install")
        } message: { _ in
            Text(agentConfirmationMessage)
        }
        .alert("Refresh dashboards and update?", isPresented: isConfirmingAgent(refresh: true), presenting: agentConfirmation) { confirmation in
            agentConsentActions(confirmation, title: "Refresh and update")
        } message: { confirmation in
            Text(agentConsentMessage(confirmation))
        }
        .alert("Interrupt chats and update?", isPresented: isConfirmingInterrupt, presenting: interruptConfirmation) { confirmation in
            Button("Cancel", role: .cancel) { interruptConfirmation = nil }
            Button("Update anyway", role: .destructive) {
                interruptConfirmation = nil
                Task { await applyServerUpdate(interrupting: confirmation) }
            }
        } message: { confirmation in
            Text("This interrupts \(confirmation.runs) running chats to update Talaria Web.")
        }
        .alert(forcedCheckAlertTitle, isPresented: $isPresentingForcedCheckResult) {
            if case .updateAvailable = model.forcedCheckOutcome {
                Button("Update") {
                    Task { await applyServerUpdate() }
                }
                Button("Dismiss", role: .cancel) {}
            } else {
                Button("OK", role: .cancel) {}
            }
        } message: {
            Text(forcedCheckAlertMessage)
        }
    }

    private var isConfirmingBackup: Binding<Bool> {
        Binding(get: { backupConfirmation != nil }, set: { if !$0 { backupConfirmation = nil } })
    }

    private var notifications: UpdateNotificationCenterViewModel { sharedNotifications ?? localNotifications }

    private var webUpdateAvailable: Bool {
        model.status.version != nil && model.updateTargets?.webui?.canApply == true
    }

    private var isConfirmingUpdate: Binding<Bool> {
        Binding(get: { updateTarget != nil }, set: { if !$0 { updateTarget = nil } })
    }

    private func isConfirmingAgent(refresh: Bool) -> Binding<Bool> {
        func isThisOffer() -> Bool {
            switch agentConfirmation {
            case .refresh: refresh
            case .revision: !refresh
            case nil: false
            }
        }
        // The revision alert can be dismissing as the server offers a dashboard refresh.
        return Binding(get: isThisOffer, set: { if !$0, isThisOffer() { agentConfirmation = nil } })
    }

    @ViewBuilder
    private func agentConsentActions(_ confirmation: UpdatesApplyResponse.AgentConfirmation, title: LocalizedStringKey) -> some View {
        Button("Cancel", role: .cancel) { model.discardConfirmation() }
        Button(title, role: .destructive) {
            agentConfirmation = nil
            Task { await applyServerUpdate(target: .agent, confirming: confirmation) }
        }
    }

    private func agentConsentMessage(_ confirmation: UpdatesApplyResponse.AgentConfirmation) -> String {
        guard case let .refresh(_, services, revision) = confirmation else { return agentConfirmationMessage }
        return [agentConfirmationMessage, services.joined(separator: ", "), revision]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }

    private var isConfirmingInterrupt: Binding<Bool> {
        Binding(get: { interruptConfirmation != nil }, set: { if !$0 { interruptConfirmation = nil } })
    }

    private var isConfirmingRestore: Binding<Bool> {
        Binding(get: { restoreConfirmation != nil }, set: { if !$0 { restoreConfirmation = nil } })
    }
}

private extension ServerUpdateSettingsSection {
    @ViewBuilder
    private var serverVersionContent: some View {
        if model.isLoading {
            ProgressView()
        } else if let serverVersion = model.status.version {
            Text(serverVersion)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        } else {
            Text(serverStatusLabel)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var serverStatusPill: some View {
        SettingsStatusPill(label: serverStatusLabel, tint: model.isLoading || model.status.version != nil ? .secondary : .orange)
    }

    private var serverStatusLabel: String {
        if model.isLoading { return String(localized: "Loading") }
        switch model.status {
        case .connected: return String(localized: "Connected")
        case .unavailable: return String(localized: "Unavailable")
        case .unknown: return String(localized: "Unknown")
        }
    }

    @ViewBuilder
    private var serverUpdateCheckAction: some View {
        if model.isCheckingForUpdates {
            updateProgressRow(String(localized: "Checking for updates…"))
        } else {
            SettingsButton(SettingsIndex.systemCheckNow.title) {
                Task { await checkForUpdatesManually() }
            }
            .disabled(model.isApplying || notifications.isFollowingUpdate)
            .padding(.top, 4)
        }
    }

    private var forcedCheckAlertTitle: String {
        switch model.forcedCheckOutcome {
        case let .updateAvailable(behind): Self.updateAvailableText(behind: behind)
        case .upToDate: String(localized: "You're up to date")
        case .manual: String(localized: "Update on the server")
        case .disabled: String(localized: "Update checks are off")
        case .error, .none: String(localized: "Couldn't check for updates")
        }
    }

    private var forcedCheckAlertMessage: String {
        switch model.forcedCheckOutcome {
        case .updateAvailable:
            String(localized: "This pulls the latest Hermes server version and restarts it. Active chats may be interrupted briefly; the app reconnects when the server is back.")
        case .upToDate:
            String(localized: "The Hermes server is running the latest version.")
        case .manual:
            String(localized: "This server can't update itself from the app. Update it where it's installed.")
        case .disabled:
            String(localized: "Update checks are turned off on this server.")
        case .error, .none:
            String(localized: "Something went wrong reaching the server. Try again in a moment.")
        }
    }

    @ViewBuilder
    private var serverUpdateNote: some View {
        if model.status.version != nil, let updateState = model.updateTargets?.webuiUpdateState {
            switch updateState {
            case .upToDate:
                updateNoteRow(systemImage: "checkmark.circle", tint: .secondary, text: String(localized: "Up to date"))
            case let .updateAvailable(behind):
                updateNoteRow(systemImage: "arrow.up.circle", tint: .blue, text: Self.updateAvailableText(behind: behind))
            case .unavailable:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private var agentUpdateRows: some View {
        let agent = model.updateTargets?.agent
        if agent != nil || model.agentVersion != nil {
            SettingsValueRow(title: SettingsIndex.systemHermesAgent.title, hasInteractiveTrailingContent: true) {
                HStack(spacing: 12) {
                    Text(model.agentVersion ?? agent?.currentVersion ?? String(localized: "Unknown"))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                    updateControl(for: .agent, available: agent?.canApply == true)
                }
            }
            if let agent {
                let status = UpdateNote(agent: agent)
                updateNoteRow(systemImage: status.systemImage, tint: status.tint, text: status.text,
                              identifier: "settings-system-status-agent")
                UpdateSummaryButton(info: agent) {
                    summaryRequest = UpdateSummaryRequest(target: .agent)
                }
            }
            updateProblem(for: .agent)
        } else if scrollAnchor == .setting(.systemHermesAgent) {
            SettingsInfoRow(title: SettingsIndex.systemHermesAgent.title, value: String(localized: "Not Available on This Server"))
        }
    }

    /// A finish step leaves nothing behind, so it has no count.
    private static func updateAvailableText(behind: Int) -> String {
        behind > 0 ? String(localized: "Update available · \(behind) behind") : String(localized: "Update available")
    }

    private func updateNoteRow(systemImage: String, tint: Color, text: String,
                               identifier: String = "settings-system-status-web") -> some View {
        SettingsStatusRow(title: SettingsIndex.systemStatus.title, systemImage: systemImage, status: text, tone: tint,
                          accessibilityIdentifier: identifier)
    }

    @ViewBuilder
    private func updateControl(for target: UpdateTarget, available: Bool) -> some View {
        if available {
            switch updatePhase(for: target) {
            case .applying, .idle, .agentConfirmation:
                updateActionButton(title: target == .webui ? SettingsIndex.systemUpdate.title : String(localized: "Update Hermes Agent"),
                                   target: target)
            case .blocked, .failed:
                EmptyView()
            }
        }
    }

    private func updatePhase(for target: UpdateTarget) -> ServerUpdateModel.ApplyPhase {
        model.lastTarget == target ? model.applyPhase : .idle
    }

    @ViewBuilder
    private func updateProblem(for target: UpdateTarget) -> some View {
        switch updatePhase(for: target) {
        case let .blocked(message, confirmation):
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(
                    message.isEmpty ? String(localized: "The server is busy with active work. Wait for it to finish, then retry.") : message,
                    systemImage: "clock", tint: .secondary
                )
                HStack {
                    updateActionButton(title: String(localized: "Retry update"), target: target)
                    if let confirmation {
                        SettingsButton(String(localized: "Update anyway"), systemImage: "exclamationmark.triangle") {
                            interruptConfirmation = confirmation
                        }
                        .disabled(model.isCheckingForUpdates)
                        .padding(.top, 4)
                    }
                }
            }
        case let .failed(failure):
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(failureMessage(failure), systemImage: "exclamationmark.triangle", tint: .orange)
                updateActionButton(title: String(localized: "Retry update"), target: target)
            }
        case .applying, .idle, .agentConfirmation:
            if target == .webui, !webUpdateAvailable, scrollAnchor == .setting(.systemUpdate) {
                SettingsInfoRow(title: SettingsIndex.systemUpdate.title, value: String(localized: "Not Available on This Server"))
            }
        }
    }

    @ViewBuilder
    private func updateActionButton(title: String, target: UpdateTarget) -> some View {
        let button = SettingsButton(title, systemImage: "arrow.up.circle", isLoading: model.isApplying && model.lastTarget == target) {
            updateTarget = target
        }
        .disabled(model.isCheckingForUpdates || model.isApplying || notifications.isFollowingUpdate)
        .environment(\.settingsIndexPage, nil)
        if target == .webui {
            button.indexedSettingsRow(title: title, identifier: SettingsIndex.systemUpdate.id)
        } else {
            button
        }
    }

    private func updateProgressRow(_ text: String) -> some View {
        SettingsStatusRow(title: SettingsIndex.systemStatus.title, systemImage: "arrow.triangle.2.circlepath",
                          status: text, isLoading: true, accessibilityIdentifier: "settings-system-status-update")
    }

    private func updateMessageRow(_ message: String, systemImage: String, tint: Color) -> some View {
        SettingsStatusRow(title: SettingsIndex.systemStatus.title, systemImage: systemImage,
                          status: message, tone: tint, accessibilityIdentifier: "settings-system-status-update")
    }

    private func failureMessage(_ failure: ServerUpdateModel.Failure) -> String {
        switch failure {
        case .couldNotStart:
            String(localized: "Could not reach the server to start the update.")
        case let .server(message):
            message.isEmpty ? String(localized: "The update could not be applied.") : message
        }
    }

    private func loadServerSettings() async {
        await model.load(settingsStore: settingsStore, onAPIError: handleAPIError)
    }

    private func applyServerUpdate(
        target: UpdateTarget = .webui,
        interrupting confirmation: UpdatesApplyResponse.InterruptConfirmation? = nil,
        confirming agentConsent: UpdatesApplyResponse.AgentConfirmation? = nil
    ) async {
        await model.apply(target: target, interrupting: confirmation, confirming: agentConsent,
                          notifications: notifications, onAPIError: handleAPIError)
        if case let .agentConfirmation(offer, message) = model.applyPhase {
            agentConfirmationMessage = message
            agentConfirmation = offer
        }
    }

    private func checkForUpdatesManually() async {
        if await model.checkForUpdates(onAPIError: handleAPIError) {
            isPresentingForcedCheckResult = true
        }
    }

    private func handleAPIError(_ error: Error) {
        authManager.handleAPIError(error, server: server)
    }
}

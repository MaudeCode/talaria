import SwiftUI
import TalariaKit
import UniformTypeIdentifiers

struct ServerUpdateSettingsSection: View {
    @Environment(\.settingsScrollAnchor) private var scrollAnchor
    @Environment(ServerSettingsStore.self) private var settingsStore: ServerSettingsStore?
    @Bindable var authManager: AuthManager
    let server: URL
    var feedback: FeedbackComposer?
    @AppStorage(SectionVisibilitySettings.chatScreenKey) private var showsScreen = true
    @AppStorage(SectionVisibilitySettings.feedbackOnScreenshotKey)
    private var feedbackOnScreenshot = SectionVisibilitySettings.defaultFeedbackOnScreenshot

    @State private var model: ServerUpdateModel
    @State private var isConfirmingUpdate = false
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
        _model = State(initialValue: ServerUpdateModel(client: APIClient(baseURL: server)))
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

                SettingsValueRow(title: SettingsIndex.systemVersion.title, systemImage: "number") {
                    serverVersionContent
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
                serverUpdateAction
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
        .task { await loadServerSettings() }
        .task { await backup.load(on: server) }
        .task(id: backup.poll) { await backup.pollStatus(on: server) }
        .task { await restore.load(on: server) }
        .task(id: restore.shouldPoll) { await restore.pollStatus(on: server) }
        .onDisappear(perform: archiveDownload.stop)
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
        .alert("Update server?", isPresented: $isConfirmingUpdate) {
            Button("Cancel", role: .cancel) {}
            Button("Update") {
                Task { await applyServerUpdate() }
            }
        } message: {
            // swiftlint:disable:next line_length
            Text("This pulls the latest Hermes server version and restarts it. Active chats may be interrupted briefly; the app reconnects when the server is back.")
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
            .disabled(model.isApplying)
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

    /// The server's pending Agent update, read-only: installed version, status, and its summary.
    @ViewBuilder
    private var agentUpdateRows: some View {
        if let agent = model.updateTargets?.agent {
            let status = UpdateNote(agent: agent)
            SettingsValueRow(title: SettingsIndex.systemHermesAgent.title) {
                Text(
                    versionRange(agent.currentVersion, agent.targetVersion)
                        ?? agent.currentVersion ?? String(localized: "Unknown")
                )
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
            updateNoteRow(systemImage: status.systemImage, tint: status.tint, text: status.text,
                          identifier: "settings-system-status-agent")
            UpdateSummaryButton(info: agent) {
                summaryRequest = UpdateSummaryRequest(target: .agent)
            }
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
    private var serverUpdateAction: some View {
        switch model.applyPhase {
        case .idle:
            if model.status.version != nil, case .updateAvailable = model.updateTargets?.webuiUpdateState {
                updateActionButton(title: SettingsIndex.systemUpdate.title)
            } else if scrollAnchor == .setting(.systemUpdate) {
                SettingsInfoRow(title: SettingsIndex.systemUpdate.title, value: String(localized: "Not Available on This Server"))
            }
        case .applying:
            updateProgressRow(String(localized: "Starting update…"))
        case .recovering:
            updateProgressRow(String(localized: "Updating & restarting…"))
        case let .blocked(message):
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(
                    message.isEmpty ? String(localized: "The server is busy with active work. Wait for it to finish, then retry.") : message,
                    systemImage: "clock", tint: .secondary
                )
                updateActionButton(title: String(localized: "Retry update"))
            }
        case let .failed(failure):
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(failureMessage(failure), systemImage: "exclamationmark.triangle", tint: .orange)
                updateActionButton(title: String(localized: "Retry update"))
            }
        }
    }

    private func updateActionButton(title: String) -> some View {
        SettingsButton(title) {
            isConfirmingUpdate = true
        }
        .disabled(model.isCheckingForUpdates)
        .padding(.top, 4)
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
        case let .timedOut(serverReachable):
            serverReachable
                ? String(localized: "The update is taking longer than expected to finish. Try again in a moment.")
                : String(localized: "The server didn't come back after the update. Check the server, then retry.")
        }
    }

    private func loadServerSettings() async {
        await model.load(settingsStore: settingsStore, onAPIError: handleAPIError)
    }

    private func applyServerUpdate() async {
        await model.apply(settingsStore: settingsStore, onAPIError: handleAPIError)
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

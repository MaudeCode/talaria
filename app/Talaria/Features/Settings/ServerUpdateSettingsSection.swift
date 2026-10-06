import SwiftUI
import TalariaKit

struct ServerUpdateSettingsSection: View {
    @Bindable var authManager: AuthManager
    let server: URL

    @State private var isLoading = false
    @State private var serverVersion: String?
    @State private var serverSettingsError: String?
    @State private var serverUpdateState: UpdatesCheckResponse.WebUIUpdateState?
    @State private var updateApplyPhase: ServerUpdateApplyPhase = .idle
    @State private var isConfirmingUpdate = false
    @State private var updateApplyMessage: String?
    @State private var isCheckingForUpdates = false
    @State private var forcedCheckOutcome: UpdatesCheckResponse.ForcedCheckOutcome?
    @State private var isPresentingForcedCheckResult = false

    var body: some View {
        Group {
            SettingsValueRow(title: String(localized: "Status")) {
                serverStatusPill
            }

            SettingsDivider()

            NavigationLink {
                CustomHeadersSettingsView(authManager: authManager)
            } label: {
                SettingsAccessoryRow(
                    title: String(localized: "Connection Headers"),
                    systemImage: "list.bullet.rectangle"
                )
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the custom request headers editor.")

            SettingsValueRow(title: String(localized: "Version")) {
                serverVersionContent
            }

            serverUpdateCheckAction
            serverUpdateNote
            serverUpdateAction
        }
        .task { await loadServerSettings() }
        .refreshesLive(showsStatus: false) { await loadServerSettings() }
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
            if case .updateAvailable = forcedCheckOutcome {
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
}

private extension ServerUpdateSettingsSection {
    @ViewBuilder
    private var serverVersionContent: some View {
        if isLoading {
            ProgressView()
        } else if let serverVersion {
            Text(serverVersion)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        } else {
            Text(serverSettingsError ?? String(localized: "Unknown"))
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var serverStatusPill: some View {
        if isLoading {
            SettingsStatusPill(label: String(localized: "Loading"))
        } else if serverSettingsError == nil, serverVersion != nil {
            SettingsStatusPill(label: String(localized: "Connected"))
        } else {
            SettingsStatusPill(label: serverSettingsError ?? String(localized: "Unknown"), tint: .orange)
        }
    }

    private var isUpdateApplyInFlight: Bool {
        switch updateApplyPhase {
        case .applying, .recovering: true
        case .idle, .blocked, .failed: false
        }
    }

    @ViewBuilder
    private var serverUpdateCheckAction: some View {
        if isCheckingForUpdates {
            updateProgressRow(String(localized: "Checking for updates…"))
        } else {
            SettingsButton(String(localized: "Check for updates")) {
                Task { await checkForUpdatesManually() }
            }
            .disabled(isUpdateApplyInFlight)
            .padding(.top, 4)
        }
    }

    private var forcedCheckAlertTitle: String {
        switch forcedCheckOutcome {
        case let .updateAvailable(behind): String(localized: "Update available · \(behind) behind")
        case .upToDate: String(localized: "You're up to date")
        case .disabled: String(localized: "Update checks are off")
        case .error, .none: String(localized: "Couldn't check for updates")
        }
    }

    private var forcedCheckAlertMessage: String {
        switch forcedCheckOutcome {
        case .updateAvailable:
            String(localized: "This pulls the latest Hermes server version and restarts it. Active chats may be interrupted briefly; the app reconnects when the server is back.")
        case .upToDate:
            String(localized: "The Hermes server is running the latest version.")
        case .disabled:
            String(localized: "Update checks are turned off on this server.")
        case .error, .none:
            String(localized: "Something went wrong reaching the server. Try again in a moment.")
        }
    }

    @ViewBuilder
    private var serverUpdateNote: some View {
        if serverVersion != nil, let serverUpdateState {
            switch serverUpdateState {
            case .upToDate:
                updateNoteRow(systemImage: "checkmark.circle", tint: .secondary, text: String(localized: "Up to date"))
            case let .updateAvailable(behind):
                updateNoteRow(systemImage: "arrow.up.circle", tint: .blue, text: String(localized: "Update available · \(behind) behind"))
            case .unavailable:
                EmptyView()
            }
        }
    }

    private func updateNoteRow(systemImage: String, tint: Color, text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            Text(text)
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var serverUpdateAction: some View {
        switch updateApplyPhase {
        case .idle:
            if serverVersion != nil, case .updateAvailable = serverUpdateState {
                updateActionButton(title: String(localized: "Update"))
            }
        case .applying:
            updateProgressRow(String(localized: "Starting update…"))
        case .recovering:
            updateProgressRow(String(localized: "Updating & restarting…"))
        case .blocked:
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(systemImage: "clock", tint: .secondary)
                updateActionButton(title: String(localized: "Retry update"))
            }
        case .failed:
            VStack(alignment: .leading, spacing: 10) {
                updateMessageRow(systemImage: "exclamationmark.triangle", tint: .orange)
                updateActionButton(title: String(localized: "Retry update"))
            }
        }
    }

    private func updateActionButton(title: String) -> some View {
        SettingsButton(title) {
            isConfirmingUpdate = true
        }
        .disabled(isCheckingForUpdates)
        .padding(.top, 4)
    }

    private func updateProgressRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(text)
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
        }
        .padding(.top, 4)
        .accessibilityElement(children: .combine)
    }

    private func updateMessageRow(systemImage: String, tint: Color) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: systemImage)
                .foregroundStyle(tint)
            Text(updateApplyMessage ?? String(localized: "The update could not be applied."))
                .font(AppFont.footnote())
                .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    @MainActor
    private func loadServerSettings() async {
        guard !isLoading else { return }
        isLoading = true
        serverSettingsError = nil
        serverUpdateState = nil
        let client = APIClient(baseURL: server)

        do {
            let settings = try await client.settings()
            serverVersion = settings.webuiVersion
            if serverVersion == nil {
                serverSettingsError = String(localized: "Unknown")
            }
        } catch {
            authManager.handleAPIError(error, server: server)
            serverSettingsError = String(localized: "Unavailable")
        }
        isLoading = false

        do {
            serverUpdateState = try await client.updatesCheck().webuiUpdateState
        } catch {
            serverUpdateState = nil
        }
    }

    @MainActor
    private func checkForUpdatesManually() async {
        guard !isCheckingForUpdates, !isUpdateApplyInFlight else { return }
        isCheckingForUpdates = true
        do {
            let response = try await APIClient(baseURL: server).updatesCheckForced()
            serverUpdateState = response.webuiUpdateState
            forcedCheckOutcome = response.forcedCheckOutcome
        } catch {
            authManager.handleAPIError(error, server: server)
            forcedCheckOutcome = .error
        }
        isCheckingForUpdates = false
        isPresentingForcedCheckResult = true
    }

    @MainActor
    private func applyServerUpdate() async {
        guard !isCheckingForUpdates else { return }
        switch updateApplyPhase {
        case .idle, .blocked, .failed: break
        case .applying, .recovering: return
        }

        updateApplyPhase = .applying
        updateApplyMessage = nil
        let client = APIClient(baseURL: server)
        let response: UpdatesApplyResponse
        do {
            response = try await client.applyUpdate(target: "webui")
        } catch {
            authManager.handleAPIError(error, server: server)
            updateApplyMessage = String(localized: "Could not reach the server to start the update.")
            updateApplyPhase = .failed
            return
        }

        switch response.outcome {
        case .applying:
            updateApplyPhase = .recovering
            if let notificationID = response.notificationId {
                await finishServerUpdate(client.followUpdate(notificationID: notificationID))
            } else {
                await finishServerUpdate(.untracked)
            }
        case .restartBlocked:
            updateApplyMessage = response.displayMessage(
                default: String(localized: "The server is busy with active work. Wait for it to finish, then retry.")
            )
            updateApplyPhase = .blocked
        case .failed:
            updateApplyMessage = response.displayMessage(default: String(localized: "The update could not be applied."))
            updateApplyPhase = .failed
        }
    }

    @MainActor
    private func finishServerUpdate(_ completion: ServerUpdateCompletion) async {
        await loadServerSettings()
        switch completion {
        case .succeeded, .untracked:
            updateApplyMessage = nil
            updateApplyPhase = .idle
        case let .blocked(message):
            updateApplyMessage = message
            updateApplyPhase = .blocked
        case let .failed(message):
            updateApplyMessage = message
            updateApplyPhase = .failed
        case .timedOut:
            updateApplyMessage = serverSettingsError != nil
                ? String(localized: "The server didn't come back after the update. Check the server, then retry.")
                : String(localized: "The update is taking longer than expected to finish. Try again in a moment.")
            updateApplyPhase = .failed
        }
    }
}

private enum ServerUpdateApplyPhase: Equatable {
    case idle
    case applying
    case recovering
    case blocked
    case failed
}

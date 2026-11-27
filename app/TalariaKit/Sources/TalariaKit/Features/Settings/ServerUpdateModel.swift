import Foundation
import Observation

/// Owns the System page's update action and the server snapshot it displays.
@MainActor
@Observable
public final class ServerUpdateModel {
    public enum Status: Equatable {
        case unknown
        case connected(version: String)
        case unavailable

        public var version: String? {
            guard case let .connected(version) = self else { return nil }
            return version
        }
    }

    public enum ApplyPhase: Equatable {
        case idle
        case applying
        case recovering
        case blocked(message: String, confirmation: UpdatesApplyResponse.InterruptConfirmation? = nil)
        case failed(Failure)
    }

    public enum Failure: Equatable {
        case couldNotStart
        case server(message: String)
        case timedOut(serverReachable: Bool)
    }

    public private(set) var status: Status = .unknown
    public private(set) var isLoading = false
    public private(set) var updateTargets: UpdatesCheckResponse?
    public private(set) var applyPhase: ApplyPhase = .idle
    public private(set) var isCheckingForUpdates = false
    public private(set) var forcedCheckOutcome: UpdatesCheckResponse.ForcedCheckOutcome?
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var confirmationGeneration = 0
    @ObservationIgnored private var offeredProfileSwitch: Int?
    @ObservationIgnored private var isReconciling = false
    @ObservationIgnored private let client: APIClient
    @ObservationIgnored private let follow: (String?, String?) async -> ServerUpdateCompletion

    public convenience init(client: APIClient) {
        self.init(client: client, follow: { await client.followUpdate(notificationID: $0, tabID: $1) })
    }

    init(client: APIClient, follow: @escaping (String?, String?) async -> ServerUpdateCompletion) {
        self.client = client
        self.follow = follow
    }

    public var isApplying: Bool {
        applyPhase == .applying || applyPhase == .recovering
    }

    public func load(settingsStore: ServerSettingsStore? = nil, onAPIError: (Error) -> Void = { _ in }) async {
        guard !isReconciling else { return }
        await load(settingsStore: settingsStore, postUpdate: false, onAPIError: onAPIError)
    }

    @discardableResult
    private func load(
        settingsStore: ServerSettingsStore?, postUpdate: Bool, onAPIError: (Error) -> Void
    ) async -> Status? {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }

        let loadedStatus: Status
        do {
            let settings: SettingsResponse?
            if let settingsStore, postUpdate {
                settings = await settingsStore.reloadSettings()
            } else if let settingsStore {
                await settingsStore.loadIfNeeded()
                settings = settingsStore.settings
            } else {
                settings = try await client.settings()
            }
            loadedStatus = Self.status(for: settings)
        } catch {
            guard generation == loadGeneration, !APIError.isCancellation(error) else { return nil }
            onAPIError(error)
            loadedStatus = .unavailable
        }
        guard generation == loadGeneration, !Task.isCancelled else { return nil }
        status = loadedStatus
        isLoading = false

        let targets = try? await client.updatesCheck()
        guard generation == loadGeneration, !Task.isCancelled else { return nil }
        updateTargets = targets
        return loadedStatus
    }

    public func checkForUpdates(onAPIError: (Error) -> Void) async -> Bool {
        guard !isCheckingForUpdates, !isApplying else { return false }
        isCheckingForUpdates = true
        defer { isCheckingForUpdates = false }
        do {
            let response = try await client.updatesCheckForced()
            updateTargets = response
            forcedCheckOutcome = response.forcedCheckOutcome
        } catch {
            onAPIError(error)
            forcedCheckOutcome = .error
        }
        return true
    }

    /// Consent belongs to this visit to System settings, even if the blocked reply is still in flight.
    public func discardInterruptConfirmation() {
        confirmationGeneration += 1
        offeredProfileSwitch = nil
        if case let .blocked(message, .some) = applyPhase {
            applyPhase = .blocked(message: message)
        }
    }

    public func apply(
        interrupting confirmation: UpdatesApplyResponse.InterruptConfirmation? = nil,
        settingsStore: ServerSettingsStore? = nil,
        onAPIError: (Error) -> Void = { _ in }
    ) async {
        guard !isCheckingForUpdates, !isApplying else { return }
        let profileSwitch = ActiveServerProfile.switchCount(for: client.baseURL)
        if let confirmation {
            guard case let .blocked(_, offered) = applyPhase, offered == confirmation else { return }
            guard offeredProfileSwitch == profileSwitch else {
                discardInterruptConfirmation()
                return
            }
        }
        let generation = confirmationGeneration
        offeredProfileSwitch = nil
        loadGeneration += 1
        isLoading = false
        applyPhase = .applying
        let tabID = UUID().uuidString

        let response: UpdatesApplyResponse
        do {
            response = try await client.applyUpdate(target: UpdateTarget.webui.rawValue, interruptToken: confirmation?.token, tabID: tabID)
        } catch {
            if APIError.isDefinitiveWriteFailure(error) {
                onAPIError(error)
                applyPhase = .failed(.couldNotStart)
            } else {
                await reconcile(notificationID: nil, tabID: tabID, settingsStore: settingsStore, onAPIError: onAPIError)
            }
            return
        }

        switch response.outcome {
        case .applying:
            await reconcile(notificationID: response.notificationId, tabID: nil, settingsStore: settingsStore, onAPIError: onAPIError)
        case .restartBlocked:
            let message = response.displayMessage(default: "")
            if generation == confirmationGeneration,
               profileSwitch == ActiveServerProfile.switchCount(for: client.baseURL),
               let offered = response.interruptConfirmation, offered.token != confirmation?.token {
                offeredProfileSwitch = profileSwitch
                applyPhase = .blocked(message: message, confirmation: offered)
            } else {
                applyPhase = .blocked(message: message)
            }
        case .failed:
            applyPhase = .failed(.server(message: response.displayMessage(default: "")))
        }
    }

    private func reconcile(
        notificationID: String?, tabID: String?, settingsStore: ServerSettingsStore?, onAPIError: (Error) -> Void
    ) async {
        applyPhase = .recovering
        let completion = await follow(notificationID, tabID)
        await finish(completion, settingsStore: settingsStore, onAPIError: onAPIError)
    }

    private func finish(_ completion: ServerUpdateCompletion, settingsStore: ServerSettingsStore?, onAPIError: (Error) -> Void) async {
        // Foreground reads can overlap the restart, but only this read can publish during reconciliation.
        isReconciling = true
        defer { isReconciling = false }
        let freshStatus = await load(settingsStore: settingsStore, postUpdate: true, onAPIError: onAPIError)
        switch completion {
        case .succeeded, .untracked:
            applyPhase = .idle
        case let .blocked(message):
            applyPhase = .blocked(message: message)
        case let .failed(message):
            applyPhase = .failed(.server(message: message))
        case .timedOut:
            applyPhase = .failed(.timedOut(serverReachable: freshStatus?.version != nil))
        }
    }

    private static func status(for settings: SettingsResponse?) -> Status {
        guard let settings else { return .unavailable }
        return settings.webuiVersion.map { .connected(version: $0) } ?? .unknown
    }
}

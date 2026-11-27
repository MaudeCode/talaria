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
        case blocked(message: String, confirmation: UpdatesApplyResponse.InterruptConfirmation? = nil)
        case agentConfirmation(UpdatesApplyResponse.AgentConfirmation, message: String)
        case failed(Failure)
    }

    public enum Failure: Equatable {
        case couldNotStart
        case server(message: String)
    }

    public private(set) var status: Status = .unknown
    public private(set) var agentVersion: String?
    public private(set) var isLoading = false
    public private(set) var updateTargets: UpdatesCheckResponse?
    public private(set) var applyPhase: ApplyPhase = .idle
    public private(set) var lastTarget: UpdateTarget?
    public private(set) var isCheckingForUpdates = false
    public private(set) var forcedCheckOutcome: UpdatesCheckResponse.ForcedCheckOutcome?
    @ObservationIgnored private var loadGeneration = 0
    @ObservationIgnored private var confirmationGeneration = 0
    @ObservationIgnored private var offeredProfileSwitch: Int?
    @ObservationIgnored private let client: APIClient
    public init(client: APIClient) {
        self.client = client
    }

    public var isApplying: Bool {
        applyPhase == .applying
    }

    public func load(
        settingsStore: ServerSettingsStore? = nil, postUpdate: Bool = false, onAPIError: (Error) -> Void = { _ in }
    ) async {
        loadGeneration += 1
        let generation = loadGeneration
        isLoading = true
        defer { if generation == loadGeneration { isLoading = false } }

        let settings: SettingsResponse?
        do {
            if let settingsStore, postUpdate {
                settings = await settingsStore.reloadSettings()
            } else if let settingsStore {
                await settingsStore.loadIfNeeded()
                settings = settingsStore.settings
            } else {
                settings = try await client.settings()
            }
        } catch {
            guard generation == loadGeneration, !APIError.isCancellation(error) else { return }
            onAPIError(error)
            settings = nil
        }
        guard generation == loadGeneration, !Task.isCancelled else { return }
        status = Self.status(for: settings)
        agentVersion = settings?.agentVersion
        isLoading = false

        let targets = try? await client.updatesCheck()
        guard generation == loadGeneration, !Task.isCancelled else { return }
        updateTargets = targets
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
    public func discardConfirmation() {
        confirmationGeneration += 1
        offeredProfileSwitch = nil
        if case let .blocked(message, .some) = applyPhase {
            applyPhase = .blocked(message: message)
        } else if case .agentConfirmation = applyPhase {
            applyPhase = .idle
        }
    }

    public func apply(
        target: UpdateTarget = .webui,
        interrupting confirmation: UpdatesApplyResponse.InterruptConfirmation? = nil,
        confirming agentConfirmation: UpdatesApplyResponse.AgentConfirmation? = nil,
        notifications: UpdateNotificationCenterViewModel,
        onAPIError: (Error) -> Void = { _ in }
    ) async {
        guard !isCheckingForUpdates, !isApplying, !notifications.isFollowingUpdate else { return }
        let profileSwitch = ActiveServerProfile.switchCount(for: client.baseURL)
        if let confirmation {
            guard target == .webui, case let .blocked(_, offered) = applyPhase, offered == confirmation else { return }
            guard offeredProfileSwitch == profileSwitch else {
                discardConfirmation()
                return
            }
        }
        if let agentConfirmation {
            guard target == .agent, case let .agentConfirmation(offered, _) = applyPhase, offered == agentConfirmation else { return }
            guard offeredProfileSwitch == profileSwitch else { discardConfirmation(); return }
        }
        let confirmedRevision: String?
        let refreshToken: String?
        switch agentConfirmation {
        case let .revision(revision): (confirmedRevision, refreshToken) = (revision, nil)
        case let .refresh(token, _, _): (confirmedRevision, refreshToken) = (nil, token)
        case nil: (confirmedRevision, refreshToken) = (nil, nil)
        }
        let generation = confirmationGeneration
        offeredProfileSwitch = nil
        loadGeneration += 1
        isLoading = false
        lastTarget = target
        applyPhase = .applying
        let tabID = notifications.beginUpdate()

        let response: UpdatesApplyResponse
        do {
            response = try await client.applyUpdate(
                target: target.rawValue, interruptToken: confirmation?.token, tabID: tabID,
                confirmedAgentRevision: confirmedRevision, agentRefreshToken: refreshToken
            )
        } catch {
            guard profileSwitch == ActiveServerProfile.switchCount(for: client.baseURL) else {
                notifications.stopTracking(tabID: tabID)
                applyPhase = .idle
                return
            }
            if APIError.isDefinitiveWriteFailure(error) {
                notifications.stopTracking(tabID: tabID)
                onAPIError(error)
                applyPhase = .failed(.couldNotStart)
            } else {
                applyPhase = .idle
                await notifications.followUpdate(tabID: tabID, notificationID: nil)
            }
            return
        }

        guard profileSwitch == ActiveServerProfile.switchCount(for: client.baseURL) else {
            notifications.stopTracking(tabID: tabID)
            applyPhase = .idle
            return
        }
        if response.outcome == .applying || (response.outcome == .failed && response.notificationId != nil) {
            applyPhase = .idle
            await notifications.followUpdate(tabID: tabID, notificationID: response.notificationId)
            return
        }
        notifications.stopTracking(tabID: tabID)
        switch response.outcome {
        case .applying:
            break
        case .needsAgentConfirmation:
            if generation == confirmationGeneration, let offered = response.agentConfirmation {
                offeredProfileSwitch = profileSwitch
                applyPhase = .agentConfirmation(offered, message: response.displayMessage(default: ""))
            } else {
                applyPhase = .idle
            }
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

    private static func status(for settings: SettingsResponse?) -> Status {
        guard let settings else { return .unavailable }
        return settings.webuiVersion.map { .connected(version: $0) } ?? .unknown
    }
}

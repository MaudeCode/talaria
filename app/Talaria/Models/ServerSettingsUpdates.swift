import Foundation

struct SettingsResponse: Decodable, Equatable {
    let botName: String?
    let webuiVersion: String?
    let agentVersion: String?
    let theme: String?
    let checkForUpdates: Bool?
    let maxTokens: Int?
    let maxTokensEffective: Int?
    let authEnabled: Bool?
    let passwordAuthEnabled: Bool?
    let passkeysEnabled: Bool?
    let passwordlessEnabled: Bool?

    private enum CodingKeys: String, CodingKey {
        case botName
        case webuiVersion
        case agentVersion
        case theme
        case checkForUpdates
        case maxTokens
        case maxTokensEffective
        case authEnabled
        case passwordAuthEnabled
        case passkeysEnabled
        case passwordlessEnabled
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        botName = container.decodeLossyStringIfPresent(forKey: .botName)
        webuiVersion = container.decodeLossyStringIfPresent(forKey: .webuiVersion)
        agentVersion = container.decodeLossyStringIfPresent(forKey: .agentVersion)
        theme = container.decodeLossyStringIfPresent(forKey: .theme)
        checkForUpdates = container.decodeLossyBoolIfPresent(forKey: .checkForUpdates)
        maxTokens = container.decodeLossyIntIfPresent(forKey: .maxTokens)
        maxTokensEffective = container.decodeLossyIntIfPresent(forKey: .maxTokensEffective)
        authEnabled = container.decodeLossyBoolIfPresent(forKey: .authEnabled)
        passwordAuthEnabled = container.decodeLossyBoolIfPresent(forKey: .passwordAuthEnabled)
        passkeysEnabled = container.decodeLossyBoolIfPresent(forKey: .passkeysEnabled)
        passwordlessEnabled = container.decodeLossyBoolIfPresent(forKey: .passwordlessEnabled)
    }
}

struct DefaultModelResponse: Decodable, Equatable {
    let ok: Bool?
    let model: String?
}

/// `GET /api/updates/check`. Every field is optional: older servers, the
/// `{ "disabled": true }` opt-out payload, and failed/`stale_check` responses
/// all omit different keys, and we never crash on a shape we don't expect.
struct UpdatesCheckResponse: Decodable, Equatable {
    let webui: UpdateTargetInfo?
    let agent: UpdateTargetInfo?
    let checkedAt: Double?
    let disabled: Bool?
}

struct UpdateTargetInfo: Decodable, Equatable {
    let name: String?
    let behind: Int?
    let currentSha: String?
    let latestSha: String?
    let branch: String?
    let repoUrl: String?
    let compareUrl: String?
    let error: String?
    let staleCheck: Bool?
}

extension UpdatesCheckResponse {
    /// What the Settings screen should show for the webui repo. `.unavailable`
    /// means "show the version only, no indicator" — the server turned the check
    /// off, errored, returned a stale result, or omitted the webui block.
    enum WebUIUpdateState: Equatable {
        case upToDate
        case updateAvailable(behind: Int)
        case unavailable
    }

    /// The fully-distinguished result of a *manual* (forced) update check (#308).
    /// Unlike `webuiUpdateState`, this keeps `disabled` and `error` apart so the
    /// "Check for updates" popup can word each case for the user — the passive
    /// inline note treats both as "no indicator" and collapses them together.
    enum ForcedCheckOutcome: Equatable {
        case updateAvailable(behind: Int)
        case upToDate
        /// Update checks are turned off on this server (`{ "disabled": true }`).
        case disabled
        /// The check failed, returned a stale result, or omitted the webui block.
        case error
    }

    var forcedCheckOutcome: ForcedCheckOutcome {
        if disabled == true {
            return .disabled
        }

        guard let webui else {
            return .error
        }

        if webui.error != nil || webui.staleCheck == true {
            return .error
        }

        if let behind = webui.behind, behind > 0 {
            return .updateAvailable(behind: behind)
        }

        return .upToDate
    }

    /// The passive inline indicator's coarser view of the same check. Derived from
    /// `forcedCheckOutcome` so the two never drift: both "off" and "errored"
    /// collapse to `.unavailable` (show the version only, with no indicator).
    var webuiUpdateState: WebUIUpdateState {
        switch forcedCheckOutcome {
        case let .updateAvailable(behind):
            return .updateAvailable(behind: behind)
        case .upToDate:
            return .upToDate
        case .disabled, .error:
            return .unavailable
        }
    }
}

/// `POST /api/updates/apply`. Tolerant: every field is optional because the
/// server returns a different mix of keys per outcome — success (`ok`,
/// `restart_scheduled`), restart-blocked (`restart_blocked` + active counts),
/// merge conflict (`conflict`), diverged history (`diverged`), or a generic
/// failure — and may add more over time. We never crash on an unexpected shape.
struct UpdatesApplyResponse: Decodable, Equatable {
    let ok: Bool?
    let message: String?
    let target: String?
    let conflict: Bool?
    let diverged: Bool?
    let restartBlocked: Bool?
    let restartScheduled: Bool?
    let stashConflict: Bool?
    let activeStreams: Int?
    let activeRuns: Int?
    let notificationId: String?
}

struct UpdateNotificationsResponse: Decodable, Equatable {
    let scopeId: String
    let notifications: [UpdateNotificationRecord]
    let unreadCount: Int
    let clearableCount: Int
    let canClear: Bool
}

struct UpdateNotificationDismissResponse: Decodable, Equatable {
    let ok: Bool
}

struct UpdateNotificationRecord: Decodable, Equatable, Identifiable {
    let id: String
    let kind: String
    let target: String?
    let phase: String
    let severity: String
    let persistent: Bool
    let requiresAcknowledgement: Bool
    let actions: [UpdateNotificationAction]
    let destination: UpdateNotificationDestination?
    let title: String
    let message: String
    let createdAt: String
    let updatedAt: String
    let readAt: String?
    let acknowledgedAt: String?
    let acknowledgedActionId: String?
    let verifiedRevision: String?
    let verifiedVersion: String?
    let unread: Bool
    let active: Bool
    let requiresInteraction: Bool
    let canDismiss: Bool
}

struct UpdateNotificationAction: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let style: String
    let acknowledges: Bool
}

struct UpdateNotificationDestination: Decodable, Equatable {
    let key: String
    let label: String
}

enum UpdateNotificationTimestamp {
    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static func date(from value: String) -> Date? {
        fractional.date(from: value) ?? standard.date(from: value)
    }
}

extension UpdatesApplyResponse {
    /// How the Settings screen should react to an apply attempt.
    enum Outcome: Equatable {
        /// Server accepted the update and is restarting; poll until it returns.
        case applying
        /// Active chat/agent work blocked the restart. Not a failure — surface
        /// the server's message and let the user retry once work finishes.
        case restartBlocked
        /// The update could not be applied (merge conflict, diverged history,
        /// unreachable remote, or a generic `ok: false`).
        case failed
    }

    var outcome: Outcome {
        // A restart-blocked response always carries `ok: false`, so check the
        // blocked flag first to avoid mislabelling it as a hard failure.
        if restartBlocked == true {
            return .restartBlocked
        }

        if ok == true {
            return .applying
        }

        return .failed
    }

    /// The server's human-readable message, or `fallback` when it omitted one.
    func displayMessage(default fallback: String) -> String {
        guard let trimmed = message?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else {
            return fallback
        }

        return trimmed
    }
}

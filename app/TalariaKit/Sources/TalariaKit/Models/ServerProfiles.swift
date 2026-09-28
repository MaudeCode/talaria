import Foundation

public struct ReasoningStatusResponse: Decodable, Equatable {
    let ok: Bool?
    let showReasoning: Bool?
    let reasoningEffort: String?
    let effort: String?
    /// Model-aware effort vocabulary from `GET /api/reasoning` (`supported_efforts`).
    /// `nil` on older servers that don't send the field — callers must fall back
    /// to the static effort list (issue #18).
    let supportedEfforts: [String]?
    /// `supports_reasoning_effort` — `false` means the resolved model has no
    /// effort control at all (hide the picker). `nil` on older servers.
    public let supportsReasoningEffort: Bool?
    let error: String?

    public var effectiveEffort: String? {
        reasoningEffort ?? effort
    }

    /// `supported_efforts` trimmed, lowercased, de-duplicated, order preserved.
    /// Stays `nil` when the server omitted the field (legacy fallback signal).
    public var normalizedSupportedEfforts: [String]? {
        guard let supportedEfforts else { return nil }
        var seen = Set<String>()
        return supportedEfforts
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

public struct PersonalitiesResponse: Decodable, Equatable {
    public let personalities: [PersonalitySummary]?
}

extension PersonalitiesResponse {
    public var slashAutocompleteNames: [String] {
        var seen = Set<String>()
        return (["none"] + (personalities ?? []).compactMap { personality in
            guard let name = personality.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty
            else {
                return nil
            }

            return name
        })
        .filter { seen.insert($0).inserted }
    }
}

public struct PersonalitySummary: Decodable, Equatable, Hashable, Identifiable {
    public var id: String { name ?? UUID().uuidString }

    public let name: String?
    public let description: String?
}

public struct PersonalitySetResponse: Decodable, Equatable {
    let ok: Bool?
    public let personality: String?
    let prompt: String?
    public let error: String?
}

public struct ProfilesResponse: Decodable, Equatable {
    public let profiles: [ProfileSummary]?
    public let active: String?
    public let singleProfileMode: Bool?

    public init(profiles: [ProfileSummary]?, active: String?, singleProfileMode: Bool? = nil) {
        self.profiles = profiles
        self.active = active
        self.singleProfileMode = singleProfileMode
    }
}

public struct ProfileCreateResponse: Decodable, Equatable {
    let ok: Bool?
    public let profile: ProfileSummary?
    public let error: String?
}

/// Mirrors the upstream profile-name rule (`^[a-z0-9][a-z0-9_-]{0,63}$`) so the
/// create form can validate before hitting the server.
public enum ProfileNameRules {
    public static func isValid(_ name: String) -> Bool {
        guard let first = name.first, name.count <= 64 else { return false }
        guard isLowercaseAlphanumeric(first) else { return false }
        return name.allSatisfy { isLowercaseAlphanumeric($0) || $0 == "-" || $0 == "_" }
    }

    private static func isLowercaseAlphanumeric(_ character: Character) -> Bool {
        ("a"..."z").contains(character) || ("0"..."9").contains(character)
    }

    /// Mirrors the upstream base-URL rule for profile creation: when provided,
    /// the value must start with `http://` or `https://` (server 400s otherwise).
    public static func isValidBaseURL(_ value: String) -> Bool {
        value.hasPrefix("http://") || value.hasPrefix("https://")
    }
}

public struct ProfileSwitchResponse: Decodable, Equatable {
    public let profiles: [ProfileSummary]?
    public let active: String?
    public let defaultModel: String?
    public let defaultWorkspace: String?
    public let error: String?
}

public struct ProfileSummary: Decodable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String { name ?? path ?? UUID().uuidString }

    public let name: String?
    public let path: String?
    public let isDefault: Bool?
    public let isActive: Bool?
    let gatewayRunning: Bool?
    public let model: String?
    public let provider: String?
    let hasEnv: Bool?
    public let skillCount: Int?

    public var displayName: String {
        guard let name, !name.isEmpty else { return String(localized: "Profile") }
        return name == "default" ? String(localized: "Default") : name
    }

    public var normalizedName: String? {
        guard let name else { return nil }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

extension ProfilesResponse {
    public var effectiveDefaultProfileName: String? {
        if let active = normalizedProfileName(active) {
            return active
        }

        if let activeProfile = profiles?.first(where: { $0.isActive == true })?.normalizedName {
            return activeProfile
        }

        if let defaultProfile = profiles?.first(where: { $0.isDefault == true })?.normalizedName {
            return defaultProfile
        }

        return profiles?.compactMap(\.normalizedName).first
    }

    public func displayName(for profileName: String?) -> String? {
        guard let profileName = normalizedProfileName(profileName) else { return nil }

        return profile(matching: profileName)?.displayName
            ?? (profileName == "default" ? String(localized: "Default") : profileName)
    }

    public func profile(matching profileName: String?) -> ProfileSummary? {
        guard let profileName = normalizedProfileName(profileName) else { return nil }
        return profiles?.first { $0.normalizedName == profileName }
    }

    private func normalizedProfileName(_ profileName: String?) -> String? {
        guard let profileName else { return nil }
        let trimmed = profileName.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

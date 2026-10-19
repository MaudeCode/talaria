import Foundation

/// TAL-1045: how a chat's Agent runs, frozen by the server when the chat is created (TAL-1040). `ignoreConfig` runs
/// without the profile's config; `safe` also leaves out plugins, MCP, hooks, rules, skills and memory. The server
/// decides what each mode disables; this is troubleshooting isolation, not a security sandbox.
public enum ExecutionMode: String, Codable, Sendable, CaseIterable {
    case normal
    case ignoreConfig = "ignore_config"
    case safe

    /// The server field's value, or nil for an absent or unknown one.
    init?(serverValue: String?) {
        guard let serverValue else { return nil }
        self.init(rawValue: serverValue)
    }

    public var title: String {
        switch self {
        case .normal: String(localized: "Normal")
        case .ignoreConfig: String(localized: "Ignore Profile Config")
        case .safe: String(localized: "Safe Mode")
        }
    }

    /// Any mode but normal: the ones a chat names in its header and New Chat offers in its menu.
    public var isDiagnostic: Bool { self != .normal }
}

/// One mode a new chat in the active profile can start in, from `GET /api/session/execution-modes`.
public struct ExecutionModeOption: Decodable, Equatable, Sendable, Identifiable {
    public let mode: ExecutionMode
    public let available: Bool
    /// Why the server cannot start this mode now; the App words each code.
    public let reason: String?

    public var id: ExecutionMode { mode }

    public init(mode: ExecutionMode, available: Bool, reason: String? = nil) {
        self.mode = mode
        self.available = available
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey {
        case mode, available, reason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let mode = ExecutionMode(serverValue: container.decodeLossyStringIfPresent(forKey: .mode)) else {
            throw DecodingError.dataCorruptedError(forKey: .mode, in: container, debugDescription: "Unknown execution mode.")
        }
        self.mode = mode
        // A missing availability is a refusal.
        available = container.decodeLossyBoolIfPresent(forKey: .available) ?? false
        reason = container.decodeLossyStringIfPresent(forKey: .reason)
    }

    /// The server's reason code, worded for the menu.
    public var reasonTitle: String? {
        guard !available else { return nil }
        switch reason {
        case "agent_unsupported": return String(localized: "Not supported by this Agent")
        case "served_profile": return String(localized: "Needs the profile's own gateway")
        case "gateway_stopped": return String(localized: "Start the gateway first")
        default: return String(localized: "Gateway unavailable")
        }
    }
}

public struct ExecutionModesResponse: Decodable, Equatable, Sendable {
    /// Rows with a mode this App does not know are dropped.
    public let modes: [ExecutionModeOption]

    enum CodingKeys: String, CodingKey {
        case modes
    }

    public init(modes: [ExecutionModeOption]) {
        self.modes = modes
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        modes = container.decodeLossyArrayIfPresent(ExecutionModeOption.self, forKey: .modes) ?? []
    }
}

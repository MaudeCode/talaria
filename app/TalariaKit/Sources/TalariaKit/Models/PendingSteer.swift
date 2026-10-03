import Foundation

/// TAL-426: a steer the Agent has not taken yet, owned by the server (session `pending_steers`, SSE `steer_pending`).
/// The server decides which actions a client may offer. Decoded with `convertFromSnakeCase`.
public struct PendingSteer: Decodable, Equatable {
    public enum State: String, Equatable {
        case pending
        /// A Send now is delivering it after the running tools yield.
        case sendingNow = "sending_now"
    }

    public struct Actions: Decodable, Equatable {
        public let edit: Bool
        public let cancel: Bool
        public let sendNow: Bool

        public static let none = Actions(edit: false, cancel: false, sendNow: false)

        public init(edit: Bool, cancel: Bool, sendNow: Bool) {
            self.edit = edit
            self.cancel = cancel
            self.sendNow = sendNow
        }

        public var any: Bool { edit || cancel || sendNow }

        enum CodingKeys: String, CodingKey {
            case edit, cancel, sendNow
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            edit = container.decodeLossyBoolIfPresent(forKey: .edit) ?? false
            cancel = container.decodeLossyBoolIfPresent(forKey: .cancel) ?? false
            sendNow = container.decodeLossyBoolIfPresent(forKey: .sendNow) ?? false
        }
    }

    public let steerId: String
    public let text: String
    public let submittedAt: Double?
    public let state: State
    public let actions: Actions

    public init(steerId: String, text: String, submittedAt: Double? = nil, state: State = .pending, actions: Actions = .none) {
        self.steerId = steerId
        self.text = text
        self.submittedAt = submittedAt
        self.state = state
        self.actions = actions
    }

    enum CodingKeys: String, CodingKey {
        case steerId, text, submittedAt, state, actions
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let steerId = container.decodeLossyStringIfPresent(forKey: .steerId), !steerId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .steerId, in: container, debugDescription: "A pending steer needs its id")
        }
        self.steerId = steerId
        text = container.decodeLossyStringIfPresent(forKey: .text) ?? ""
        submittedAt = container.decodeLossyDoubleIfPresent(forKey: .submittedAt)
        state = container.decodeLossyStringIfPresent(forKey: .state).flatMap(State.init(rawValue:)) ?? .pending
        actions = (try? container.decodeIfPresent(Actions.self, forKey: .actions)) ?? .none
    }
}

/// TAL-426: a pending steer is no longer pending without the Agent taking it (SSE `steer_withdrawn`).
public struct SteerWithdrawnEvent: Decodable, Equatable {
    public enum Reason: String, Equatable {
        case edit, cancel, stopped, followup, other
    }

    /// Nil for text another surface queued with the Agent.
    public let steerId: String?
    public let reason: Reason
    public let text: String

    public init(steerId: String?, reason: Reason, text: String) {
        self.steerId = steerId
        self.reason = reason
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case steerId, reason, text
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        steerId = container.decodeLossyStringIfPresent(forKey: .steerId)
        reason = container.decodeLossyStringIfPresent(forKey: .reason).flatMap(Reason.init(rawValue:)) ?? .other
        text = container.decodeLossyStringIfPresent(forKey: .text) ?? ""
    }
}

public struct SteerWithdrawResponse: Decodable, Equatable {
    public let withdrawn: Bool
    public let text: String?
}

public struct SteerSendNowResponse: Decodable, Equatable {
    public let redirected: Bool
}

public enum PendingSteerWithdrawReason: String {
    case edit, cancel
}

/// The steers this device sent, so a Stop that withdraws one gives its text back here only. Kept across relaunches.
enum OwnSteerStore {
    private static let key = "talaria.ownSteerIDs"
    private static let limit = 100

    static func remember(_ id: String) {
        var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
        ids.removeAll { $0 == id }
        ids.append(id)
        UserDefaults.standard.set(Array(ids.suffix(limit)), forKey: key)
    }

    /// True when this device sent it; it is forgotten either way.
    @discardableResult
    static func forget(_ id: String) -> Bool {
        var ids = UserDefaults.standard.stringArray(forKey: key) ?? []
        guard let index = ids.firstIndex(of: id) else { return false }
        ids.remove(at: index)
        UserDefaults.standard.set(ids, forKey: key)
        return true
    }
}

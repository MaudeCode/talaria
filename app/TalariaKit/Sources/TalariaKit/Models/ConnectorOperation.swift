import Foundation

/// TAL-1321: a connection operation, as the server's `ConnectorOperationViewSchema` states it: the `connect_card` frame,
/// the owner attachment's `connection` and every read and answer of `/api/connectors/operations/{op_id}`. The server
/// decides each target's state, its authorization link and the moves it offers; the App renders them and echoes `owner`.
/// Never cached: it carries a live authorization link, and an offline copy would offer moves nobody can answer.
public struct ConnectorOperationView: Decodable, Equatable, Sendable, Identifiable {
    public enum Action: String, Sendable {
        case skip, retry, approve
    }

    public enum Outcome: String, Sendable {
        case connected
        case notConnected = "not_connected"
    }

    /// The canonical owner a native operation belongs to; absent on a direct operation.
    public struct Owner: Decodable, Equatable, Sendable {
        public let sessionId: String
        public let authorityEpoch: Int
    }

    /// What an MCP target will run or contact (TAL-1907), shown as the server words it; absent on an older server.
    public struct Launch: Decodable, Equatable, Sendable {
        public let kind: String
        public let target: String
        public let env: [String]
        public let cwd: String?

        enum CodingKeys: String, CodingKey {
            case kind, target, env, cwd
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            kind = try container.decode(String.self, forKey: .kind)
            target = try container.decode(String.self, forKey: .target)
            env = (try? container.decodeIfPresent([String].self, forKey: .env)) ?? []
            cwd = container.decodeLossyStringIfPresent(forKey: .cwd)
        }
    }

    /// A credential an `approve` or `retry` sends. Only its name and label ever come back from the server.
    public struct EnvField: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let label: String
        public let required: Bool
        public let secret: Bool

        public var id: String { name }

        enum CodingKeys: String, CodingKey {
            case name, label, required, secret
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = try container.decode(String.self, forKey: .name)
            label = container.decodeLossyStringIfPresent(forKey: .label) ?? name
            required = container.decodeLossyBoolIfPresent(forKey: .required) ?? false
            // A field the server does not classify stays masked.
            secret = container.decodeLossyBoolIfPresent(forKey: .secret) ?? true
        }
    }

    public struct Target: Decodable, Equatable, Sendable, Identifiable {
        public let name: String
        public let title: String
        public let kind: String
        public let state: String
        public let detail: String
        public let connectUrl: URL?
        public let launch: Launch?
        public let actions: [Action]
        public let envFields: [EnvField]

        public var id: String { name }

        enum CodingKeys: String, CodingKey {
            case name, title, kind, state, detail, connectUrl, launch, actions, envFields
        }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            name = try container.decode(String.self, forKey: .name)
            title = container.decodeLossyStringIfPresent(forKey: .title) ?? name
            kind = container.decodeLossyStringIfPresent(forKey: .kind) ?? ""
            state = container.decodeLossyStringIfPresent(forKey: .state) ?? ""
            detail = container.decodeLossyStringIfPresent(forKey: .detail) ?? ""
            connectUrl = container.decodeLossyStringIfPresent(forKey: .connectUrl).flatMap(URL.init(string:))
            launch = try? container.decodeIfPresent(Launch.self, forKey: .launch)
            // A move this build does not know is not offered.
            actions = ((try? container.decodeIfPresent([JSONValue].self, forKey: .actions)) ?? [])
                .compactMap { if case .string(let name) = $0 { Action(rawValue: name) } else { nil } }
            envFields = container.decodeLossyArrayIfPresent(EnvField.self, forKey: .envFields) ?? []
        }

        /// The row as the user's own skip shows it before the server confirms.
        func skipped() -> Target {
            Target(name: name, title: title, kind: kind, state: "skipped", detail: detail, connectUrl: nil, launch: nil, actions: [], envFields: [])
        }

        /// The row while an unknown answer waits on a read: nothing to send until the server says what landed.
        func withoutMoves() -> Target {
            Target(name: name, title: title, kind: kind, state: state, detail: detail, connectUrl: connectUrl, launch: launch, actions: [], envFields: envFields)
        }

        private init(name: String, title: String, kind: String, state: String, detail: String, connectUrl: URL?, launch: Launch?, actions: [Action], envFields: [EnvField]) {
            self.name = name
            self.title = title
            self.kind = kind
            self.state = state
            self.detail = detail
            self.connectUrl = connectUrl
            self.launch = launch
            self.actions = actions
            self.envFields = envFields
        }
    }

    public let opId: String
    public let settled: Bool
    public let outcome: Outcome?
    public let canContinue: Bool
    public let toolCallId: String?
    public let owner: Owner?
    public let canWake: Bool
    public let targets: [Target]

    public var id: String { opId }

    enum CodingKeys: String, CodingKey {
        case opId, settled, outcome, canContinue, toolCallId, owner, canWake, targets
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        opId = try container.decode(String.self, forKey: .opId)
        settled = container.decodeLossyBoolIfPresent(forKey: .settled) ?? false
        outcome = container.decodeLossyStringIfPresent(forKey: .outcome).flatMap(Outcome.init(rawValue:))
        canContinue = container.decodeLossyBoolIfPresent(forKey: .canContinue) ?? false
        toolCallId = container.decodeLossyStringIfPresent(forKey: .toolCallId)
        owner = try? container.decodeIfPresent(Owner.self, forKey: .owner)
        canWake = container.decodeLossyBoolIfPresent(forKey: .canWake) ?? false
        targets = container.decodeLossyArrayIfPresent(Target.self, forKey: .targets) ?? []
    }

    /// This view with `targets` replaced, and Continue offered only when `canContinue` says so.
    func with(targets: [Target], canContinue: Bool) -> ConnectorOperationView {
        ConnectorOperationView(opId: opId, settled: settled, outcome: outcome, canContinue: canContinue, toolCallId: toolCallId, owner: owner, canWake: canWake, targets: targets)
    }

    private init(opId: String, settled: Bool, outcome: Outcome?, canContinue: Bool, toolCallId: String?, owner: Owner?, canWake: Bool, targets: [Target]) {
        self.opId = opId
        self.settled = settled
        self.outcome = outcome
        self.canContinue = canContinue
        self.toolCallId = toolCallId
        self.owner = owner
        self.canWake = canWake
        self.targets = targets
    }
}

/// One answer to an operation: a row's move, or Continue, which ends the wait for the rest of it.
public enum ConnectorOperationMove: Equatable, Hashable, Sendable {
    case row(ConnectorOperationView.Action, target: String)
    case continueWithoutTheRest

    var action: String {
        switch self {
        case .row(let action, _): action.rawValue
        case .continueWithoutTheRest: "continue"
        }
    }

    var target: String? {
        if case .row(_, let target) = self { target } else { nil }
    }
}

import Foundation

/// TAL-372: one piece of background work a session owns (a delegated agent, a notified process, or a `/background`
/// task), as the server records it for every client. Decoded with `convertFromSnakeCase`; unknown values decode leniently.
public struct BackgroundWorkTask: Decodable, Equatable, Identifiable, Sendable {
    public enum Kind: String, Equatable, Sendable {
        case delegation, process
        case backgroundCommand = "background_command"
    }

    public enum Status: String, Equatable, Sendable {
        case running, attention, completed, failed, cancelled, unknown
    }

    public struct Agents: Decodable, Equatable, Sendable {
        public let total: Int
        public let completed: Int
        public let failed: Int
        public let running: Int

        public init(total: Int, completed: Int, failed: Int, running: Int) {
            self.total = total
            self.completed = completed
            self.failed = failed
            self.running = running
        }

        enum CodingKeys: String, CodingKey { case total, completed, failed, running }

        public init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            total = container.decodeLossyIntIfPresent(forKey: .total) ?? 0
            completed = container.decodeLossyIntIfPresent(forKey: .completed) ?? 0
            failed = container.decodeLossyIntIfPresent(forKey: .failed) ?? 0
            running = container.decodeLossyIntIfPresent(forKey: .running) ?? 0
        }
    }

    public var id: String { taskId }
    public let taskId: String
    public let kind: Kind
    public let status: Status
    public let title: String
    public let agents: Agents?
    public let exitCode: Int?
    public let resultAvailable: Bool
    public let pinned: Bool
    public let dismissible: Bool
    /// Not settled yet (running, attention or unknown): the App keeps refreshing while any record is active.
    public let active: Bool
    /// TAL-1172: confirmed running work this session may stop. TAL-1336: an owner chat's row stops through its owner;
    /// a rebuilt parent's child is listed without it.
    public let canStop: Bool
    /// TAL-1336: an owner chat's subagent that takes a steering message now.
    public let canSteer: Bool

    public init(taskId: String, kind: Kind, status: Status, title: String, agents: Agents? = nil, exitCode: Int? = nil, resultAvailable: Bool = false, pinned: Bool = false, dismissible: Bool = false, active: Bool = false, canStop: Bool = false, canSteer: Bool = false) {
        self.taskId = taskId
        self.kind = kind
        self.status = status
        self.title = title
        self.agents = agents
        self.exitCode = exitCode
        self.resultAvailable = resultAvailable
        self.pinned = pinned
        self.dismissible = dismissible
        self.active = active
        self.canStop = canStop
        self.canSteer = canSteer
    }

    enum CodingKeys: String, CodingKey {
        case taskId, kind, status, title, agents, exitCode, resultAvailable, pinned, dismissible, active, canStop, canSteer
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard let taskId = container.decodeLossyStringIfPresent(forKey: .taskId), !taskId.isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .taskId, in: container, debugDescription: "A background task needs its id")
        }
        self.taskId = taskId
        kind = container.decodeLossyStringIfPresent(forKey: .kind).flatMap(Kind.init(rawValue:)) ?? .backgroundCommand
        status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(Status.init(rawValue:)) ?? .unknown
        title = container.decodeLossyStringIfPresent(forKey: .title) ?? ""
        agents = try? container.decodeIfPresent(Agents.self, forKey: .agents)
        exitCode = container.decodeLossyIntIfPresent(forKey: .exitCode)
        resultAvailable = container.decodeLossyBoolIfPresent(forKey: .resultAvailable) ?? false
        pinned = container.decodeLossyBoolIfPresent(forKey: .pinned) ?? false
        dismissible = container.decodeLossyBoolIfPresent(forKey: .dismissible) ?? false
        active = container.decodeLossyBoolIfPresent(forKey: .active) ?? false
        canStop = container.decodeLossyBoolIfPresent(forKey: .canStop) ?? false
        canSteer = container.decodeLossyBoolIfPresent(forKey: .canSteer) ?? false
    }
}

/// TAL-372: a delegation tool row's link to the work it started, updated in place (scene `tool.background`).
public struct BackgroundLink: Decodable, Equatable, Sendable {
    public let taskIds: [String]
    public let status: BackgroundWorkTask.Status
    public let agents: BackgroundWorkTask.Agents

    public init(taskIds: [String], status: BackgroundWorkTask.Status, agents: BackgroundWorkTask.Agents) {
        self.taskIds = taskIds
        self.status = status
        self.agents = agents
    }

    enum CodingKeys: String, CodingKey { case taskIds, status, agents }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        taskIds = (try? container.decodeIfPresent([String].self, forKey: .taskIds)) ?? []
        status = container.decodeLossyStringIfPresent(forKey: .status).flatMap(BackgroundWorkTask.Status.init(rawValue:)) ?? .unknown
        agents = try container.decode(BackgroundWorkTask.Agents.self, forKey: .agents)
    }
}

public struct BackgroundTasksResponse: Decodable, Equatable, Sendable {
    /// TAL-1336, on an owner chat only: its owner's processes and subagents are in `tasks` (`available`), run in a
    /// worker the owner cannot show (`unsupported`), or could not be read now (`unavailable`).
    public enum OwnerWork: String, Equatable, Sendable { case available, unsupported, unavailable }
    public let tasks: [BackgroundWorkTask]
    public let agentAvailable: Bool
    public let activityPhase: String?
    public let ownerWork: OwnerWork?

    enum CodingKeys: String, CodingKey { case tasks, agentAvailable, activityPhase, ownerWork }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = container.decodeLossyArrayIfPresent(BackgroundWorkTask.self, forKey: .tasks) ?? []
        activityPhase = container.decodeLossyStringIfPresent(forKey: .activityPhase)
        agentAvailable = container.decodeLossyBoolIfPresent(forKey: .agentAvailable) ?? true
        ownerWork = container.decodeLossyStringIfPresent(forKey: .ownerWork).flatMap(OwnerWork.init(rawValue:))
    }
}

public struct BackgroundTaskResult: Decodable, Equatable, Sendable {
    public let taskId: String
    public let text: String
}

public struct BackgroundDismissResponse: Decodable, Equatable, Sendable {
    public let ok: Bool
}

/// TAL-1337: what the server said a Stop or Steer did. `unconfirmed` is an answer that never arrived or a server that could
/// not confirm it (5xx, network loss): the control is never resent, and the next roster read shows what happened.
public enum BackgroundControlOutcome: Equatable, Sendable {
    case stopped, queued, notRunning, rejected, notFound, unconfirmed
    /// The server refused the request itself, with its message.
    case failed(String)

    init(serverOutcome: String?) {
        switch serverOutcome {
        case "stopped": self = .stopped
        case "queued": self = .queued
        case "not_running": self = .notRunning
        case "rejected": self = .rejected
        case "not_found": self = .notFound
        default: self = .unconfirmed
        }
    }
}

/// The body of `POST /api/background/stop` and `/api/background/steer`.
public struct BackgroundControlResponse: Decodable, Equatable, Sendable {
    public let outcome: String?
}

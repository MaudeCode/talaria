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
    /// TAL-1531: how many of `tasks` the server pins. Nil from a server older than the field.
    public let pinnedCount: Int?
    /// TAL-1579: the server's delegation delivery summary. Nil from a server older than the field.
    public let delegationStatus: DelegationStatus?

    enum CodingKeys: String, CodingKey { case tasks, agentAvailable, activityPhase, ownerWork, pinnedCount, delegationStatus }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        tasks = container.decodeLossyArrayIfPresent(BackgroundWorkTask.self, forKey: .tasks) ?? []
        activityPhase = container.decodeLossyStringIfPresent(forKey: .activityPhase)
        agentAvailable = container.decodeLossyBoolIfPresent(forKey: .agentAvailable) ?? true
        ownerWork = container.decodeLossyStringIfPresent(forKey: .ownerWork).flatMap(OwnerWork.init(rawValue:))
        pinnedCount = container.decodeLossyIntIfPresent(forKey: .pinnedCount).flatMap { $0 >= 0 ? $0 : nil }
        delegationStatus = try? container.decodeIfPresent(DelegationStatus.self, forKey: .delegationStatus)
    }
}

/// TAL-1579: the server's advisory summary of a session's delegations, never a promise that nothing arrives later.
/// Counts are exact only when `availability` is `available`; otherwise they are nil and never read as zero. `visible` and
/// `refresh` are the server's decisions: show the summary, and keep rereading while it may change.
public struct DelegationStatus: Decodable, Equatable, Sendable {
    public enum Availability: Equatable, Sendable {
        /// The counts are exact, zero included.
        case available
        /// The delegation ledger could not be read now.
        case unknown
        /// An owner chat, whose owner does not report delivery.
        case unsupported
        /// A value from a newer server, kept as sent.
        case unrecognized(String)

        init(_ value: String) {
            switch value {
            case "available": self = .available
            case "unknown": self = .unknown
            case "unsupported": self = .unsupported
            default: self = .unrecognized(value)
            }
        }
    }

    public let availability: Availability
    /// Delegations still running.
    public let runningCount: Int?
    /// Finished delegations whose completion has not reached the session yet.
    public let awaitingDeliveryCount: Int?
    /// The Agent's live registry holds running work for the session; nil when it cannot say. Never part of the counts.
    public let memoryLive: Bool?
    public let visible: Bool
    public let refresh: Bool

    public init(availability: Availability, runningCount: Int?, awaitingDeliveryCount: Int?, memoryLive: Bool?, visible: Bool, refresh: Bool) {
        self.availability = availability
        self.runningCount = runningCount
        self.awaitingDeliveryCount = awaitingDeliveryCount
        self.memoryLive = memoryLive
        self.visible = visible
        self.refresh = refresh
    }

    enum CodingKeys: String, CodingKey { case availability, runningCount, awaitingDeliveryCount, memoryLive, visible, refresh }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        availability = container.decodeLossyStringIfPresent(forKey: .availability).map(Availability.init) ?? .unknown
        runningCount = container.decodeLossyIntIfPresent(forKey: .runningCount).flatMap { $0 >= 0 ? $0 : nil }
        awaitingDeliveryCount = container.decodeLossyIntIfPresent(forKey: .awaitingDeliveryCount).flatMap { $0 >= 0 ? $0 : nil }
        memoryLive = container.decodeLossyBoolIfPresent(forKey: .memoryLive)
        visible = container.decodeLossyBoolIfPresent(forKey: .visible) ?? false
        refresh = container.decodeLossyBoolIfPresent(forKey: .refresh) ?? false
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
